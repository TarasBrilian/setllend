//! Signed payloads through the mock's `execute_intents` and `simulate_intents` into Setllend, as
//! the backend relays them in the local dry run (`SOT/dry-run.md`, D62).

use serde_json::{Value, json};

use setllend_tests::signed::{EvmSigner, NearSigner};
use setllend_tests::{Env, ONE_USDC, USDC, placed_order_id};

const MINUTE_NS: u64 = 60 * 1_000_000_000;

fn lend(env: &Env, amount: u128) -> Value {
    let msg = json!({"action": "lend", "data": {
        "maturity": env.maturity.to_string(), "min_rate_bps": 700, "expires_at": null
    }});
    json!([{ "intent": "transfer", "receiver_id": env.setllend.id(), "tokens": { USDC: amount.to_string() }, "msg": msg.to_string() }])
}

fn cancel(env: &Env, order_id: u64) -> Value {
    let msg = json!({"action": "cancel", "data": {"order_id": order_id.to_string()}});
    json!([{ "intent": "auth_call", "contract_id": env.setllend.id(), "msg": msg.to_string(), "min_gas": "100000000000000" }])
}

async fn deadline(env: &Env) -> anyhow::Result<u64> {
    Ok(env.sandbox.view_block().await?.timestamp() + 10 * MINUTE_NS)
}

#[tokio::test]
async fn erc191_lend_and_cancel_reach_setllend() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let relayer = env.sandbox.dev_create_account().await?;
    let user = EvmSigner::new(1);
    env.deposit(&user.account(), USDC, 1_000 * ONE_USDC).await?;
    let intents = env.intents.id().as_str();
    let until = deadline(&env).await?;

    let placed = env
        .execute_intents(
            &relayer,
            vec![user.sign(lend(&env, 400 * ONE_USDC), intents, until, 1)],
        )
        .await?;
    assert!(placed.is_success(), "{:?}", placed.failures());
    let order_id = placed_order_id(&placed);
    let account = user.account().parse()?;
    assert_eq!(env.balance(&account, USDC).await?, 600 * ONE_USDC);

    let cancelled = env
        .execute_intents(
            &relayer,
            vec![user.sign(cancel(&env, order_id), intents, until, 2)],
        )
        .await?;
    assert!(
        cancelled.receipt_failures().is_empty(),
        "{:?}",
        cancelled.failures()
    );
    assert_eq!(env.balance(&account, USDC).await?, 1_000 * ONE_USDC);
    Ok(())
}

#[tokio::test]
async fn nep413_implicit_account_lends_once_per_nonce() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let relayer = env.sandbox.dev_create_account().await?;
    let user = NearSigner::new(2);
    env.deposit(&user.account(), USDC, 100 * ONE_USDC).await?;
    let signed = user.sign(
        lend(&env, 50 * ONE_USDC),
        env.intents.id().as_str(),
        deadline(&env).await?,
        1,
    );

    let placed = env.execute_intents(&relayer, vec![signed.clone()]).await?;
    assert!(placed.is_success(), "{:?}", placed.failures());
    placed_order_id(&placed);

    let replay = env.execute_intents(&relayer, vec![signed]).await?;
    assert!(format!("{:?}", replay.failures()).contains("nonce was already used"));
    assert_eq!(
        env.balance(&user.account().parse()?, USDC).await?,
        50 * ONE_USDC
    );
    Ok(())
}

#[tokio::test]
async fn simulate_reports_the_relayer_reason_without_moving_funds() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let user = EvmSigner::new(3);
    env.deposit(&user.account(), USDC, 100 * ONE_USDC).await?;
    let intents = env.intents.id().as_str();
    let until = deadline(&env).await?;

    let ok = env
        .simulate_intents(vec![user.sign(
            lend(&env, 10 * ONE_USDC),
            intents,
            until,
            1,
        )])
        .await;
    assert_eq!(
        ok.expect("a valid payload simulates")["invariant_violated"],
        Value::Null
    );

    let mut tampered = user.sign(lend(&env, 10 * ONE_USDC), intents, until, 2);
    tampered["signature"] =
        EvmSigner::new(4).sign(lend(&env, 10 * ONE_USDC), intents, until, 2)["signature"].clone();
    let refused = env
        .simulate_intents(vec![tampered])
        .await
        .expect_err("a tampered payload fails");
    assert!(refused.contains("invalid signature"), "{refused}");

    let too_much = env
        .simulate_intents(vec![user.sign(
            lend(&env, 101 * ONE_USDC),
            intents,
            until,
            3,
        )])
        .await;
    assert!(
        too_much
            .expect_err("over the balance")
            .contains("insufficient balance or overflow")
    );
    assert_eq!(
        env.balance(&user.account().parse()?, USDC).await?,
        100 * ONE_USDC
    );
    Ok(())
}
