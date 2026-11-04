//! Signed payloads as `intents.near` takes them in `execute_intents` and `simulate_intents`
//! (`SOT/intents-primitives.md`, near/intents `d340060`), for the local dry run (`SOT/dry-run.md`):
//!
//! - `erc191`: `{standard, payload, signature}`. The payload is the JSON string
//!   `{signer_id, verifying_contract, deadline, nonce, intents}`; the signature is
//!   `secp256k1:` + base58 of `r ‖ s ‖ v` with `v` 0 or 1, over keccak-256 of the
//!   `personal_sign` message. The recovered address must be the `0x` signer.
//! - `nep413`: `{standard, payload: {message, nonce, recipient, callbackUrl?}, public_key,
//!   signature}`. `message` is the JSON `{signer_id, deadline, intents}`, `recipient` the verifying
//!   contract; the key signs SHA-256 of the NEP-413 bytes.
//! - The nonce is versioned: magic `5628f6c6`, version 0, the salt, the nonce's deadline (ns, i64
//!   LE), and 15 random bytes. The payload's deadline must not be later than the nonce's.

use base64::Engine;
use near_sdk::serde_json::{Map, Value};
use near_sdk::{AccountId, Gas, env};

const NONCE_MAGIC: [u8; 4] = [0x56, 0x28, 0xf6, 0xc6];
const NONCE_VERSION: u8 = 0;
/// 2^31 + 413, so a NEP-413 message can never be a valid transaction.
const NEP413_TAG: u32 = (1 << 31) + 413;

/// A payload whose signature, verifying contract, deadline, and nonce format passed.
pub struct Verified {
    pub signer_id: AccountId,
    pub nonce: [u8; 32],
    pub intents: Vec<Intent>,
}

pub enum Intent {
    /// With a `msg` the receiver gets `mt_on_transfer`; without one it is a plain balance move.
    Transfer {
        receiver_id: AccountId,
        tokens: Vec<(String, u128)>,
        msg: Option<String>,
        min_gas: Option<Gas>,
    },
    AuthCall {
        contract_id: AccountId,
        msg: String,
        min_gas: Option<Gas>,
    },
}

/// What the verifier needs from the contract.
pub struct Context<'a> {
    pub contract_id: &'a AccountId,
    pub salt: [u8; 4],
    pub now_ns: u64,
    /// Whether `public_key` (`ed25519:<base58>`) is registered for the account.
    pub has_key: &'a dyn Fn(&AccountId, &str) -> bool,
}

type Result<T> = core::result::Result<T, String>;

pub fn verify(signed: &Value, ctx: &Context) -> Result<Verified> {
    let signed = signed
        .as_object()
        .ok_or("signed payload must be an object")?;
    let (inner, nonce_text) = match str_field(signed, "standard")? {
        "erc191" => {
            let payload = str_field(signed, "payload")?;
            let signature = decode_prefixed(str_field(signed, "signature")?, "secp256k1:", 65)?;
            let message = [
                format!("\x19Ethereum Signed Message:\n{}", payload.len()).as_bytes(),
                payload.as_bytes(),
            ]
            .concat();
            let hash = env::keccak256_array(&message);
            let public_key = env::ecrecover(&hash, &signature[..64], signature[64], true)
                .ok_or("invalid signature")?;
            let address = &env::keccak256_array(public_key)[12..];
            let inner = parse_object(payload, "payload")?;
            if str_field(&inner, "verifying_contract")? != ctx.contract_id.as_str() {
                return Err("wrong verifying_contract".into());
            }
            if str_field(&inner, "signer_id")? != format!("0x{}", hex(address)) {
                return Err("invalid signature".into());
            }
            let nonce = str_field(&inner, "nonce")?.to_string();
            (inner, nonce)
        }
        "nep413" => {
            let payload = signed
                .get("payload")
                .and_then(Value::as_object)
                .ok_or("payload must be {message, nonce, recipient}")?;
            let message = str_field(payload, "message")?;
            let nonce_text = str_field(payload, "nonce")?.to_string();
            let recipient = str_field(payload, "recipient")?;
            if recipient != ctx.contract_id.as_str() {
                return Err("wrong verifying_contract".into());
            }
            let callback_url = payload.get("callbackUrl").and_then(Value::as_str);
            let public_key_text = str_field(signed, "public_key")?;
            let public_key = decode_prefixed(public_key_text, "ed25519:", 32)?;
            let signature = decode_prefixed(str_field(signed, "signature")?, "ed25519:", 64)?;
            let bytes = nep413_bytes(
                message,
                &decode_nonce(&nonce_text)?,
                recipient,
                callback_url,
            );
            let hash = env::sha256_array(&bytes);
            let signature: [u8; 64] = signature.try_into().map_err(|_| "invalid signature")?;
            let key: [u8; 32] = public_key.try_into().map_err(|_| "invalid public key")?;
            if !env::ed25519_verify(&signature, hash, &key) {
                return Err("invalid signature".into());
            }
            let inner = parse_object(message, "message")?;
            let signer_id = account(&inner, "signer_id")?;
            // An implicit account's own key needs no registration.
            if signer_id.as_str() != hex(&key) && !(ctx.has_key)(&signer_id, public_key_text) {
                return Err(format!(
                    "public key {public_key_text} doesn't exist for {signer_id}"
                ));
            }
            (inner, nonce_text)
        }
        other => return Err(format!("unsupported standard: {other}")),
    };

    let signer_id = account(&inner, "signer_id")?;
    let deadline = parse_rfc3339(str_field(&inner, "deadline")?)?;
    if deadline <= ctx.now_ns {
        return Err("deadline has expired".into());
    }
    let nonce = decode_nonce(&nonce_text)?;
    if nonce[..4] != NONCE_MAGIC || nonce[4] != NONCE_VERSION || nonce[5..9] != ctx.salt {
        return Err("invalid nonce".into());
    }
    let nonce_deadline = i64::from_le_bytes(nonce[9..17].try_into().unwrap());
    if nonce_deadline <= ctx.now_ns as i64 || (deadline as i64) > nonce_deadline {
        return Err("invalid nonce".into());
    }
    let intents = inner
        .get("intents")
        .and_then(Value::as_array)
        .ok_or("intents must be a list")?
        .iter()
        .map(parse_intent)
        .collect::<Result<Vec<_>>>()?;
    Ok(Verified {
        signer_id,
        nonce,
        intents,
    })
}

fn parse_intent(intent: &Value) -> Result<Intent> {
    let intent = intent.as_object().ok_or("intent must be an object")?;
    let min_gas = match intent.get("min_gas") {
        None => None,
        Some(value) => Some(Gas::from_gas(
            value
                .as_str()
                .and_then(|g| g.parse().ok())
                .ok_or("min_gas must be a decimal string")?,
        )),
    };
    match str_field(intent, "intent")? {
        "transfer" => {
            let tokens = intent
                .get("tokens")
                .and_then(Value::as_object)
                .ok_or("tokens must be an object")?
                .iter()
                .map(|(token, amount)| {
                    let amount = amount
                        .as_str()
                        .and_then(|a| a.parse::<u128>().ok())
                        .filter(|a| *a > 0)
                        .ok_or("amounts must be positive decimal strings")?;
                    Ok((token.clone(), amount))
                })
                .collect::<Result<Vec<_>>>()?;
            if tokens.is_empty() {
                return Err("tokens must not be empty".into());
            }
            let msg = match intent.get("msg") {
                None => None,
                Some(msg) => Some(msg.as_str().ok_or("msg must be a string")?.to_string()),
            };
            Ok(Intent::Transfer {
                receiver_id: account(intent, "receiver_id")?,
                tokens,
                msg,
                min_gas,
            })
        }
        "auth_call" => {
            match intent.get("attached_deposit") {
                None => {}
                Some(Value::String(deposit)) if deposit == "0" => {}
                Some(_) => return Err("the mock takes no attached_deposit".into()),
            }
            Ok(Intent::AuthCall {
                contract_id: account(intent, "contract_id")?,
                msg: str_field(intent, "msg")?.to_string(),
                min_gas,
            })
        }
        other => Err(format!("unsupported intent: {other}")),
    }
}

/// The bytes a NEP-413 key signs the SHA-256 of: the tag (u32 LE), then borsh of `message`, the
/// 32-byte nonce, `recipient`, and the optional callback URL.
pub fn nep413_bytes(
    message: &str,
    nonce: &[u8; 32],
    recipient: &str,
    callback_url: Option<&str>,
) -> Vec<u8> {
    let mut bytes = NEP413_TAG.to_le_bytes().to_vec();
    push_string(&mut bytes, message);
    bytes.extend_from_slice(nonce);
    push_string(&mut bytes, recipient);
    match callback_url {
        None => bytes.push(0),
        Some(url) => {
            bytes.push(1);
            push_string(&mut bytes, url);
        }
    }
    bytes
}

/// Borsh `String`: u32 LE length, then the bytes.
fn push_string(bytes: &mut Vec<u8>, s: &str) {
    bytes.extend_from_slice(&(s.len() as u32).to_le_bytes());
    bytes.extend_from_slice(s.as_bytes());
}

fn decode_nonce(text: &str) -> Result<[u8; 32]> {
    base64::engine::general_purpose::STANDARD
        .decode(text)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| "nonce must be 32 bytes of base64".into())
}

fn decode_prefixed(text: &str, prefix: &str, len: usize) -> Result<Vec<u8>> {
    text.strip_prefix(prefix)
        .and_then(|b58| bs58::decode(b58).into_vec().ok())
        .filter(|bytes| bytes.len() == len)
        .ok_or_else(|| format!("expected {prefix}<base58 of {len} bytes>"))
}

fn str_field<'a>(object: &'a Map<String, Value>, field: &str) -> Result<&'a str> {
    object
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{field} must be a string"))
}

fn account(object: &Map<String, Value>, field: &str) -> Result<AccountId> {
    str_field(object, field)?
        .parse()
        .map_err(|_| format!("{field} must be an account ID"))
}

fn parse_object(text: &str, what: &str) -> Result<Map<String, Value>> {
    match near_sdk::serde_json::from_str(text) {
        Ok(Value::Object(object)) => Ok(object),
        _ => Err(format!("{what} must be a JSON object")),
    }
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `YYYY-MM-DDTHH:MM:SS[.fraction]Z`, as `Date.toISOString()` writes it, to nanoseconds.
pub fn parse_rfc3339(text: &str) -> Result<u64> {
    let bad = || format!("deadline must be an RFC 3339 UTC time, got {text}");
    let rest = text.strip_suffix('Z').ok_or_else(bad)?;
    let (date, time) = rest.split_once('T').ok_or_else(bad)?;
    let num = |s: &str| s.parse::<i64>().map_err(|_| bad());
    let mut d = date.splitn(3, '-');
    let (y, m, day) = (
        num(d.next().ok_or_else(bad)?)?,
        num(d.next().ok_or_else(bad)?)?,
        num(d.next().ok_or_else(bad)?)?,
    );
    let (clock, fraction) = time.split_once('.').unwrap_or((time, ""));
    let mut t = clock.splitn(3, ':');
    let (h, min, s) = (
        num(t.next().ok_or_else(bad)?)?,
        num(t.next().ok_or_else(bad)?)?,
        num(t.next().ok_or_else(bad)?)?,
    );
    if !(1..=12).contains(&m) || !(1..=31).contains(&day) || h > 23 || min > 59 || s > 60 {
        return Err(bad());
    }
    if fraction.len() > 9 || !fraction.bytes().all(|b| b.is_ascii_digit()) {
        return Err(bad());
    }
    let nanos = if fraction.is_empty() {
        0
    } else {
        num(fraction)? * 10i64.pow(9 - fraction.len() as u32)
    };
    // Days since 1970-01-01 (H. Hinnant's days_from_civil).
    let yy = if m <= 2 { y - 1 } else { y };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let doy = (153 * ((m + 9) % 12) + 2) / 5 + day - 1;
    let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
    let ns = ((days * 86_400 + h * 3600 + min * 60 + s) * 1_000_000_000) + nanos;
    u64::try_from(ns).map_err(|_| bad())
}
