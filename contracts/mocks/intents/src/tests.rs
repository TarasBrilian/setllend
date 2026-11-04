//! Signed payloads through `execute_intents` and `simulate_intents`, signed here with real
//! secp256k1 and ed25519 keys. Cross-contract calls (`mt_on_transfer`, `on_auth`) are covered by
//! the sandbox tests in `contracts/tests`.

use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::serde_json::{Value, json};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{AccountId, NearToken, testing_env};
use secp256k1::{Message, Secp256k1, SecretKey};
use sha2::Digest as _;
use sha3::Keccak256;

use super::signed::{hex, nep413_bytes, parse_rfc3339};
use super::*;

const USDC: &str = "nep141:usdc";
const SETLLEND: &str = "setllend.near";
/// 2026-11-04T12:00:00Z.
const NOW: u64 = 1_793_793_600_000_000_000;
const DEADLINE: &str = "2026-11-04T12:10:00.000Z";
const DEADLINE_NS: u64 = NOW + 600_000_000_000;

fn intents_id() -> AccountId {
    "intents.near".parse().unwrap()
}

fn set_env(predecessor: &str, deposit: u128) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(intents_id())
            .predecessor_account_id(predecessor.parse().unwrap())
            .block_timestamp(NOW)
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .build()
    );
}

fn nonce(deadline_ns: u64, salt: [u8; 4], random: u8) -> String {
    let mut bytes = [random; 32];
    bytes[..4].copy_from_slice(&[0x56, 0x28, 0xf6, 0xc6]);
    bytes[4] = 0;
    bytes[5..9].copy_from_slice(&salt);
    bytes[9..17].copy_from_slice(&(deadline_ns as i64).to_le_bytes());
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

struct Evm(SecretKey);

impl Evm {
    fn new(seed: u8) -> Self {
        Self(SecretKey::from_slice(&[seed; 32]).unwrap())
    }

    fn account(&self) -> String {
        let public = self
            .0
            .public_key(&Secp256k1::new())
            .serialize_uncompressed();
        format!("0x{}", hex(&Keccak256::digest(&public[1..])[12..]))
    }

    /// `personal_sign` of the payload: `secp256k1:` + base58 of `r ‖ s ‖ v`, `v` 0 or 1.
    fn sign(&self, payload: &str) -> String {
        let message = format!("\x19Ethereum Signed Message:\n{}{payload}", payload.len());
        let hash = Keccak256::digest(message.as_bytes());
        let (recovery, compact) = Secp256k1::new()
            .sign_ecdsa_recoverable(&Message::from_slice(&hash).unwrap(), &self.0)
            .serialize_compact();
        let mut bytes = compact.to_vec();
        bytes.push(recovery.to_i32() as u8);
        format!("secp256k1:{}", bs58::encode(bytes).into_string())
    }

    fn payload(&self, intents: Value, nonce_text: &str) -> String {
        json!({
            "signer_id": self.account(),
            "verifying_contract": "intents.near",
            "deadline": DEADLINE,
            "nonce": nonce_text,
            "intents": intents,
        })
        .to_string()
    }

    fn signed(&self, intents: Value, random: u8) -> Value {
        let payload = self.payload(intents, &nonce(DEADLINE_NS, SALT, random));
        json!({ "standard": "erc191", "signature": self.sign(&payload), "payload": payload })
    }
}

struct Near(SigningKey);

impl Near {
    fn new(seed: u8) -> Self {
        Self(SigningKey::from_bytes(&[seed; 32]))
    }

    fn implicit(&self) -> String {
        hex(self.0.verifying_key().as_bytes())
    }

    fn public_key(&self) -> String {
        format!(
            "ed25519:{}",
            bs58::encode(self.0.verifying_key().as_bytes()).into_string()
        )
    }

    fn signed_as(&self, signer: &str, intents: Value, random: u8, recipient: &str) -> Value {
        let message =
            json!({ "signer_id": signer, "deadline": DEADLINE, "intents": intents }).to_string();
        let nonce_text = nonce(DEADLINE_NS, SALT, random);
        let nonce_bytes: [u8; 32] = base64::engine::general_purpose::STANDARD
            .decode(&nonce_text)
            .unwrap()
            .try_into()
            .unwrap();
        let hash = sha2::Sha256::digest(nep413_bytes(&message, &nonce_bytes, recipient, None));
        let signature = self.0.sign(&hash);
        json!({
            "standard": "nep413",
            "payload": { "message": message, "nonce": nonce_text, "recipient": recipient },
            "public_key": self.public_key(),
            "signature": format!("ed25519:{}", bs58::encode(signature.to_bytes()).into_string()),
        })
    }

    fn signed(&self, intents: Value, random: u8) -> Value {
        self.signed_as(&self.implicit(), intents, random, "intents.near")
    }
}

fn lend_transfer(amount: &str) -> Value {
    json!([{ "intent": "transfer", "receiver_id": SETLLEND, "tokens": { USDC: amount }, "msg": "{\"lend\":{}}", "min_gas": "30000000000000" }])
}

fn funded(account: &str, amount: u128) -> MockIntents {
    set_env("relayer.near", 0);
    let mut contract = MockIntents::default();
    contract.deposit(account.parse().unwrap(), USDC.into(), U128(amount));
    contract
}

fn error(contract: &MockIntents, signed: Vec<Value>) -> String {
    contract
        .run(&signed)
        .err()
        .expect("the payload should fail")
}

fn balance(contract: &MockIntents, account: &str) -> u128 {
    contract
        .mt_balance_of(account.parse().unwrap(), USDC.into())
        .0
}

#[test]
fn erc191_transfer_moves_funds_and_uses_the_nonce() {
    let user = Evm::new(1);
    let mut contract = funded(&user.account(), 1_000);
    let signed = user.signed(lend_transfer("400"), 1);
    contract.execute_intents(vec![signed.clone()]);
    assert_eq!(balance(&contract, &user.account()), 600);
    assert_eq!(balance(&contract, SETLLEND), 400);
    assert_eq!(error(&contract, vec![signed]), "nonce was already used");
}

#[test]
fn a_transfer_without_msg_is_a_plain_move() {
    let user = Evm::new(2);
    let mut contract = funded(&user.account(), 1_000);
    let deposit = "968a88446330f4b76be618af38ca2b8b971407953928f1205b425f97eb6d3723";
    let intents =
        json!([{ "intent": "transfer", "receiver_id": deposit, "tokens": { USDC: "1000" } }]);
    contract.execute_intents(vec![user.signed(intents, 1)]);
    assert_eq!(balance(&contract, deposit), 1_000);
}

#[test]
fn nep413_implicit_account_needs_no_registered_key() {
    let user = Near::new(3);
    let contract = funded(&user.implicit(), 1_000);
    let auth = json!([{ "intent": "auth_call", "contract_id": SETLLEND, "msg": "{\"cancel\":{}}", "min_gas": "100000000000000" }]);
    let (_, effects) = contract.run(&[user.signed(auth, 1)]).unwrap();
    assert!(
        matches!(effects.as_slice(), [Effect::AuthCall { contract_id, .. }] if contract_id.as_str() == SETLLEND)
    );
}

#[test]
fn nep413_named_account_needs_its_key_registered() {
    let user = Near::new(4);
    let mut contract = funded("alice.near", 1_000);
    let signed = user.signed_as("alice.near", lend_transfer("10"), 1, "intents.near");
    assert!(error(&contract, vec![signed.clone()]).contains("doesn't exist for alice.near"));
    // dev_add_public_key is #[private]: the mock's own account calls it.
    set_env("intents.near", 0);
    contract.dev_add_public_key("alice.near".parse().unwrap(), user.public_key());
    assert!(contract.has_public_key("alice.near".parse().unwrap(), user.public_key()));
    assert!(contract.run(&[signed]).is_ok());
}

#[test]
fn add_public_key_takes_one_yocto_and_registers_the_caller() {
    let user = Near::new(5);
    set_env("bob.near", 1);
    let mut contract = MockIntents::default();
    contract.add_public_key(user.public_key());
    assert!(contract.has_public_key("bob.near".parse().unwrap(), user.public_key()));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn add_public_key_without_deposit_fails() {
    set_env("bob.near", 0);
    MockIntents::default().add_public_key(Near::new(5).public_key());
}

#[test]
fn bad_signatures_are_refused() {
    let user = Evm::new(6);
    let contract = funded(&user.account(), 1_000);
    let mut tampered = user.signed(lend_transfer("10"), 1);
    // Same signature over another payload: the recovered address is someone else.
    tampered["payload"] = json!(user.payload(lend_transfer("11"), &nonce(DEADLINE_NS, SALT, 1)));
    assert_eq!(error(&contract, vec![tampered]), "invalid signature");
    let other = Evm::new(7);
    let mut stolen = user.signed(lend_transfer("10"), 2);
    stolen["signature"] = json!(other.sign(stolen["payload"].as_str().unwrap()));
    assert_eq!(error(&contract, vec![stolen]), "invalid signature");

    let near = Near::new(8);
    let mut forged = near.signed(lend_transfer("10"), 1);
    forged["public_key"] = json!(Near::new(9).public_key());
    assert_eq!(error(&contract, vec![forged]), "invalid signature");
}

#[test]
fn checks_contract_deadline_and_nonce() {
    let user = Evm::new(10);
    let contract = funded(&user.account(), 1_000);
    let sign = |payload: String| json!({ "standard": "erc191", "signature": user.sign(&payload), "payload": payload });
    let with = |field: &str, value: Value| {
        let mut payload: Value = near_sdk::serde_json::from_str(
            &user.payload(lend_transfer("10"), &nonce(DEADLINE_NS, SALT, 1)),
        )
        .unwrap();
        payload[field] = value;
        sign(payload.to_string())
    };
    assert_eq!(
        error(
            &contract,
            vec![with("verifying_contract", json!("evil.near"))]
        ),
        "wrong verifying_contract"
    );
    assert_eq!(
        error(
            &contract,
            vec![with("deadline", json!("2026-11-04T11:59:59.000Z"))]
        ),
        "deadline has expired"
    );
    assert_eq!(
        error(
            &contract,
            vec![with("deadline", json!("2026-11-04T12:20:00.000Z"))]
        ),
        "invalid nonce"
    );
    assert_eq!(
        error(
            &contract,
            vec![with("nonce", json!(nonce(DEADLINE_NS, [0; 4], 1)))]
        ),
        "invalid nonce"
    );
    assert_eq!(
        error(&contract, vec![with("nonce", json!(nonce(NOW, SALT, 1)))]),
        "invalid nonce"
    );
    let near = Near::new(11);
    assert_eq!(
        error(
            &contract,
            vec![near.signed_as(&near.implicit(), lend_transfer("10"), 1, "evil.near")]
        ),
        "wrong verifying_contract"
    );
}

#[test]
fn one_failing_payload_fails_the_batch_and_moves_nothing() {
    let user = Evm::new(12);
    let contract = funded(&user.account(), 100);
    let ok = user.signed(lend_transfer("60"), 1);
    let too_much = user.signed(lend_transfer("60"), 2);
    assert_eq!(
        error(&contract, vec![ok.clone(), too_much]),
        "insufficient balance or overflow"
    );
    assert_eq!(
        error(&contract, vec![ok.clone(), ok]),
        "nonce was already used"
    );
    assert_eq!(balance(&contract, &user.account()), 100);
}

#[test]
fn only_transfer_and_auth_call() {
    let user = Evm::new(13);
    let contract = funded(&user.account(), 100);
    let withdraw = json!([{ "intent": "ft_withdraw", "token": "usdc", "receiver_id": "a.near", "amount": "1" }]);
    assert_eq!(
        error(&contract, vec![user.signed(withdraw, 1)]),
        "unsupported intent: ft_withdraw"
    );
    let deposit = json!([{ "intent": "auth_call", "contract_id": SETLLEND, "msg": "{}", "attached_deposit": "1" }]);
    assert_eq!(
        error(&contract, vec![user.signed(deposit, 2)]),
        "the mock takes no attached_deposit"
    );
}

#[test]
fn simulate_changes_nothing() {
    let user = Evm::new(14);
    let contract = funded(&user.account(), 1_000);
    let signed = user.signed(lend_transfer("400"), 1);
    let answer = contract.simulate_intents(vec![signed.clone()]);
    assert_eq!(answer["invariant_violated"], Value::Null);
    assert_eq!(balance(&contract, &user.account()), 1_000);
    assert!(contract.run(&[signed]).is_ok());
}

#[test]
#[should_panic(expected = "invalid signature")]
fn simulate_panics_with_the_reason() {
    let user = Evm::new(15);
    let contract = funded(&user.account(), 1_000);
    let mut signed = user.signed(lend_transfer("400"), 1);
    signed["signature"] = json!(Evm::new(16).sign(signed["payload"].as_str().unwrap()));
    contract.simulate_intents(vec![signed]);
}

#[test]
fn views_for_the_backend() {
    let contract = funded("a.near", 5);
    let tokens = vec![USDC.to_string(), "nep141:other".to_string()];
    assert_eq!(
        contract.mt_batch_balance_of("a.near".parse().unwrap(), tokens),
        vec![U128(5), U128(0)]
    );
    assert_eq!(contract.current_salt(), "5e7711e0");
}

/// Vectors from `backend/src/shared/intents.ts` (`versionedNonce`, `nep413SigningBytes`) for the
/// same inputs, so the mock checks exactly what the backend and UI build.
#[test]
fn matches_the_typescript_builders() {
    let nonce_text = "Vij2xgBedxHgAGJfogPH5RgHBwcHBwcHBwcHBwcHBwc=";
    let deadline = parse_rfc3339("2026-11-07T13:40:45.000Z").unwrap();
    assert_eq!(nonce(deadline, SALT, 7), nonce_text);
    let nonce_bytes: [u8; 32] = base64::engine::general_purpose::STANDARD
        .decode(nonce_text)
        .unwrap()
        .try_into()
        .unwrap();
    assert_eq!(&nonce_bytes[17..], &[7; 15]);
    let bytes = nep413_bytes("{\"a\":1}", &nonce_bytes, "intents.near", None);
    assert_eq!(
        hex(&bytes),
        "9d010080070000007b2261223a317d5628f6c6005e7711e000625fa203c7e5180707070707070707070707070707070c000000696e74656e74732e6e65617200"
    );
    assert_eq!(
        hex(&sha2::Sha256::digest(&bytes)),
        "c4aeb0d4d8ddd3504da295900584d380fd25d951eee0d63431d588d6e5fffe68"
    );
}

#[test]
fn parses_rfc3339() {
    assert_eq!(parse_rfc3339("1970-01-01T00:00:00Z").unwrap(), 0);
    assert_eq!(
        parse_rfc3339("2026-11-07T13:40:45.000Z").unwrap(),
        1_794_058_845_000_000_000
    );
    assert_eq!(
        parse_rfc3339("2000-02-29T23:59:59.123456789Z").unwrap(),
        951_868_799_123_456_789
    );
    assert_eq!(parse_rfc3339(DEADLINE).unwrap(), DEADLINE_NS);
    for bad in [
        "2026-11-07 13:40:45Z",
        "2026-11-07T13:40:45",
        "2026-13-01T00:00:00Z",
        "2026-11-07T13:40:45.1234567890Z",
    ] {
        assert!(parse_rfc3339(bad).is_err(), "{bad}");
    }
}
