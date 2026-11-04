//! Intents payloads signed like a wallet: ERC-191 (`personal_sign`) for a `0x` account and
//! NEP-413 for a NEAR account, as `backend/src/shared/intents.ts` builds them, for the mock's
//! `execute_intents` (`SOT/dry-run.md`).

use base64::Engine;
use ed25519_dalek::{Signer as _, SigningKey};
use secp256k1::{Message, Secp256k1, SecretKey};
use serde_json::{Value, json};
use sha2::Digest as _;
use sha3::Keccak256;

/// The mock's salt (`current_salt`).
pub const SALT: [u8; 4] = [0x5e, 0x77, 0x11, 0xe0];

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A versioned nonce expiring with the payload.
fn nonce(deadline_ns: u64, random: u8) -> String {
    let mut bytes = [random; 32];
    bytes[..4].copy_from_slice(&[0x56, 0x28, 0xf6, 0xc6]);
    bytes[4] = 0;
    bytes[5..9].copy_from_slice(&SALT);
    bytes[9..17].copy_from_slice(&(deadline_ns as i64).to_le_bytes());
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Nanoseconds to `YYYY-MM-DDTHH:MM:SS.mmmZ`, as `Date.toISOString()` writes them.
pub fn rfc3339(ns: u64) -> String {
    let secs = (ns / 1_000_000_000) as i64;
    let millis = (ns / 1_000_000) % 1000;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // H. Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// An EVM wallet: its Intents account is the lowercase `0x` address.
pub struct EvmSigner(SecretKey);

impl EvmSigner {
    pub fn new(seed: u8) -> Self {
        Self(SecretKey::from_slice(&[seed; 32]).unwrap())
    }

    pub fn account(&self) -> String {
        let public = self
            .0
            .public_key(&Secp256k1::new())
            .serialize_uncompressed();
        format!("0x{}", hex(&Keccak256::digest(&public[1..])[12..]))
    }

    /// One `erc191` element of `execute_intents({signed: [...]})`.
    pub fn sign(
        &self,
        intents: Value,
        verifying_contract: &str,
        deadline_ns: u64,
        random: u8,
    ) -> Value {
        let payload = json!({
            "signer_id": self.account(),
            "verifying_contract": verifying_contract,
            "deadline": rfc3339(deadline_ns),
            "nonce": nonce(deadline_ns, random),
            "intents": intents,
        })
        .to_string();
        let message = format!("\x19Ethereum Signed Message:\n{}{payload}", payload.len());
        let hash = Keccak256::digest(message.as_bytes());
        let (recovery, compact) = Secp256k1::new()
            .sign_ecdsa_recoverable(&Message::from_slice(&hash).unwrap(), &self.0)
            .serialize_compact();
        let mut signature = compact.to_vec();
        signature.push(recovery.to_i32() as u8);
        json!({
            "standard": "erc191",
            "payload": payload,
            "signature": format!("secp256k1:{}", bs58::encode(signature).into_string()),
        })
    }
}

/// A NEAR key, signing for its implicit account (the hex of the key).
pub struct NearSigner(SigningKey);

impl NearSigner {
    pub fn new(seed: u8) -> Self {
        Self(SigningKey::from_bytes(&[seed; 32]))
    }

    pub fn account(&self) -> String {
        hex(self.0.verifying_key().as_bytes())
    }

    /// One `nep413` element of `execute_intents({signed: [...]})`.
    pub fn sign(
        &self,
        intents: Value,
        verifying_contract: &str,
        deadline_ns: u64,
        random: u8,
    ) -> Value {
        let message = json!({ "signer_id": self.account(), "deadline": rfc3339(deadline_ns), "intents": intents }).to_string();
        let nonce_text = nonce(deadline_ns, random);
        let nonce_bytes = base64::engine::general_purpose::STANDARD
            .decode(&nonce_text)
            .unwrap();
        // NEP-413 bytes: tag, borsh message, nonce, borsh recipient, no callback URL.
        let mut bytes = ((1u32 << 31) + 413).to_le_bytes().to_vec();
        for (i, part) in [
            message.as_bytes(),
            &nonce_bytes,
            verifying_contract.as_bytes(),
        ]
        .iter()
        .enumerate()
        {
            if i != 1 {
                bytes.extend_from_slice(&(part.len() as u32).to_le_bytes());
            }
            bytes.extend_from_slice(part);
        }
        bytes.push(0);
        let signature = self.0.sign(&sha2::Sha256::digest(&bytes));
        json!({
            "standard": "nep413",
            "payload": { "message": message, "nonce": nonce_text, "recipient": verifying_contract },
            "public_key": format!("ed25519:{}", bs58::encode(self.0.verifying_key().as_bytes()).into_string()),
            "signature": format!("ed25519:{}", bs58::encode(signature.to_bytes()).into_string()),
        })
    }
}
