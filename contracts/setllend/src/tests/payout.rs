//! Payout promises and `on_payout` (D21).

use near_sdk::PromiseError;
use near_sdk::test_utils::get_created_receipts;

use super::*;

/// `#[private]` and `#[callback_result]` live in the wasm wrapper, so unit tests pass the
/// promise result directly. The sandbox tests cover both.
fn on_payout(c: &mut Setllend, result: Result<(), PromiseError>) {
    context(CONTRACT);
    c.on_payout(
        account("alice.near"),
        USDC.into(),
        U128(5 * ONE_USDC),
        result,
    );
}

#[test]
fn payout_calls_mt_transfer_with_one_yocto() {
    let mut c = setup();
    let id = lend(&mut c, "alice.near", 5 * ONE_USDC, 700);
    auth(
        &mut c,
        "alice.near",
        json!({"action": "cancel", "data": {"order_id": id.to_string()}}),
    );
    let receipts = get_created_receipts();
    let transfer = receipts
        .iter()
        .find(|receipt| receipt.receiver_id == account(INTENTS))
        .expect("mt_transfer receipt");
    let action = format!("{:?}", transfer.actions);
    assert!(
        action.contains(&format!("method_name: {:?}", b"mt_transfer")),
        "{action}"
    );
    assert!(
        action.contains("attached_deposit: NearToken { inner: 1 }"),
        "{action}"
    );
    let args = format!(
        "{}",
        near_sdk::serde_json::json!({
            "receiver_id": "alice.near", "token_id": USDC,
            "amount": (5 * ONE_USDC).to_string(), "approval": null, "memo": null
        })
    );
    assert!(
        action.contains(&format!("args: {:?}", args.as_bytes())),
        "{action}"
    );
    assert!(receipts.iter().any(|receipt| {
        receipt.receiver_id == account(CONTRACT)
            && format!("{:?}", receipt.actions).contains(&format!("{:?}", b"on_payout"))
    }));
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
fn successful_payout_changes_nothing() {
    let mut c = setup();
    on_payout(&mut c, Ok(()));
    assert!(events("payout_failed").is_empty());
    assert!(c.get_free_balances(account("alice.near")).is_empty());
    assert_invariants(&c, &ACCOUNTS);
}

#[test]
fn failed_payout_lands_in_the_free_balance() {
    let mut c = setup();
    on_payout(&mut c, Err(PromiseError::Failed));
    assert_eq!(
        events("payout_failed"),
        vec![
            json!({"account": "alice.near", "token_id": USDC, "amount": (5 * ONE_USDC).to_string()})
        ]
    );
    on_payout(&mut c, Err(PromiseError::Failed));
    assert_eq!(
        c.get_free_balances(account("alice.near")),
        [(USDC.to_string(), U128(10 * ONE_USDC))].into()
    );
    assert_invariants(&c, &ACCOUNTS);
}
