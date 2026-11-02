//! End-to-end flows through the mock `intents.near`.

use near_workspaces::AccountId;
use serde_json::{Value, json};
use setllend_tests::{ETH_ARB, Env, ONE_USDC, USDC, events};

fn as_u128(value: &Value) -> u128 {
    value.as_str().unwrap().parse().unwrap()
}

/// `redemption_pool + Σ debt_face ≥ V`, and the shares of `accounts` add up to `S`. Also
/// that Setllend's Intents balance of each token is exactly what it owes: open lend escrow,
/// the redemption pool, and free balances in USDC; borrow escrow, position collateral, and
/// free balances in collateral. `accounts` must list every account involved.
async fn assert_invariants(env: &Env, accounts: &[&AccountId]) -> anyhow::Result<()> {
    let maturity = env.maturity.to_string();
    let pool = env
        .view("get_pool", json!({ "maturity": maturity }))
        .await?;
    let mut debt = 0;
    let mut shares = 0;
    let mut owed_usdc = as_u128(&pool["redemption_pool"]);
    let mut owed_eth = 0;
    for account in accounts {
        let positions = env
            .view("get_positions_by_account", json!({ "account_id": account }))
            .await?;
        for position in positions.as_array().unwrap() {
            debt += as_u128(&position["debt_face"]);
            assert_eq!(position["collateral_token"], ETH_ARB);
            owed_eth += as_u128(&position["collateral"]);
        }
        let notes = env
            .view("get_notes", json!({ "account_id": account }))
            .await?;
        if let Some(note) = notes.get(&maturity) {
            shares += as_u128(&note["free_shares"]) + as_u128(&note["locked_shares"]);
        }
        let free = env
            .view("get_free_balances", json!({ "account_id": account }))
            .await?;
        owed_usdc += free.get(USDC).map_or(0, as_u128);
        owed_eth += free.get(ETH_ARB).map_or(0, as_u128);
    }
    let orders = env
        .view("get_orders", json!({ "maturity": maturity }))
        .await?;
    for order in orders.as_array().unwrap() {
        match order["kind"].as_str().unwrap() {
            "lend" => owed_usdc += as_u128(&order["remaining"]),
            "borrow" => owed_eth += as_u128(&order["collateral_remaining"]),
            _ => {}
        }
    }
    assert!(as_u128(&pool["redemption_pool"]) + debt >= as_u128(&pool["total_value"]));
    assert_eq!(shares, as_u128(&pool["total_shares"]));
    assert_eq!(env.balance(env.setllend.id(), USDC).await?, owed_usdc);
    assert_eq!(env.balance(env.setllend.id(), ETH_ARB).await?, owed_eth);
    Ok(())
}

#[tokio::test]
async fn lend_buys_notes_from_sell_note() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let alice = env.user(0).await?;
    let bob = env.user(0).await?;
    let carol = env.user(1_000 * ONE_USDC).await?;
    env.patch_loan(&alice, &bob, 1_000 * ONE_USDC).await?;

    let ask = env.sell_note(&alice, 500 * ONE_USDC, 900).await?;
    let bid = env.lend(&carol, 300 * ONE_USDC, 800).await?;
    // The lend escrow moved into Setllend's Intents balance.
    assert_eq!(env.balance(carol.id(), USDC).await?, 700 * ONE_USDC);
    assert_eq!(env.balance(env.setllend.id(), USDC).await?, 300 * ONE_USDC);

    let result = env
        .match_orders(&carol, &[(bid, ask, 200 * ONE_USDC)])
        .await?;
    assert!(result.is_success(), "{:?}", result.failures());
    let filled = &events(&result, "order_filled")[0];
    assert_eq!(filled["rate_bps"], 900, "the older ask sets the rate");
    let face = as_u128(&filled["face"]);
    assert!(face > 200 * ONE_USDC);

    // The seller got the bid's USDC in their Intents balance.
    assert_eq!(env.balance(alice.id(), USDC).await?, 200 * ONE_USDC);
    assert_eq!(env.balance(env.setllend.id(), USDC).await?, 100 * ONE_USDC);
    let maturity = env.maturity.to_string();
    let carol_notes = env
        .view("get_notes", json!({ "account_id": carol.id() }))
        .await?;
    // V = S, so the shares moved equal the note face.
    assert_eq!(as_u128(&carol_notes[&maturity]["free_shares"]), face);
    let bid_view = env
        .view("get_order", json!({ "order_id": bid.to_string() }))
        .await?;
    assert_eq!(as_u128(&bid_view["remaining"]), 100 * ONE_USDC);
    let ask_view = env
        .view("get_order", json!({ "order_id": ask.to_string() }))
        .await?;
    assert_eq!(as_u128(&ask_view["remaining"]), 500 * ONE_USDC - face);
    assert_invariants(&env, &[alice.id(), bob.id(), carol.id()]).await
}

#[tokio::test]
async fn cancel_refunds_escrow() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let carol = env.user(1_000 * ONE_USDC).await?;
    let mallory = env.user(0).await?;
    let bid = env.lend(&carol, 300 * ONE_USDC, 800).await?;
    let cancel = json!({"action": "cancel", "data": {"order_id": bid.to_string()}});

    // `auth_call` is detached: the intent succeeds even though `on_auth` fails.
    let result = env.auth_call(&mallory, cancel.clone()).await?;
    assert!(result.is_success());
    let failure = format!("{:?}", result.receipt_failures());
    assert!(failure.contains("Not the order owner"), "{failure}");
    assert!(
        !env.view("get_order", json!({ "order_id": bid.to_string() }))
            .await?
            .is_null()
    );

    let result = env.auth_call(&carol, cancel).await?;
    assert!(
        result.receipt_failures().is_empty(),
        "{:?}",
        result.failures()
    );
    assert_eq!(
        events(&result, "order_cancelled"),
        vec![
            json!({"order_id": bid.to_string(), "owner": carol.id(), "refunded": (300 * ONE_USDC).to_string()})
        ]
    );
    assert_eq!(env.balance(carol.id(), USDC).await?, 1_000 * ONE_USDC);
    assert!(
        env.view("get_order", json!({ "order_id": bid.to_string() }))
            .await?
            .is_null()
    );

    // The cancel emptied the book, so its index set was removed. A new order in the same
    // maturity starts a new set under the same storage prefix, read back from storage here.
    let maturity = env.maturity.to_string();
    let count = json!({ "maturity": maturity });
    assert_eq!(env.view("get_order_count", count.clone()).await?, 0);
    let again = env.lend(&carol, 100 * ONE_USDC, 800).await?;
    let ids = |orders: Value| -> Vec<String> {
        orders
            .as_array()
            .unwrap()
            .iter()
            .map(|order| order["order_id"].as_str().unwrap().to_string())
            .collect()
    };
    let book = env
        .view("get_orders", json!({ "maturity": maturity }))
        .await?;
    assert_eq!(ids(book), vec![again.to_string()]);
    let mine = env
        .view("get_orders_by_account", json!({ "account_id": carol.id() }))
        .await?;
    assert_eq!(ids(mine), vec![again.to_string()]);
    assert_eq!(env.view("get_order_count", count).await?, 1);
    assert_invariants(&env, &[carol.id(), mallory.id()]).await
}

#[tokio::test]
async fn failed_payout_lands_in_free_balance_and_withdraw_recovers_it() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let carol = env.user(1_000 * ONE_USDC).await?;
    let bid = env.lend(&carol, 300 * ONE_USDC, 800).await?;

    env.intents
        .call("set_fail_transfers")
        .args_json(json!({ "fail": true }))
        .transact()
        .await?
        .into_result()?;
    let cancel = json!({"action": "cancel", "data": {"order_id": bid.to_string()}});
    let result = env.auth_call(&carol, cancel).await?;
    assert_eq!(
        events(&result, "payout_failed"),
        vec![
            json!({"account": carol.id(), "token_id": USDC, "amount": (300 * ONE_USDC).to_string()})
        ]
    );
    assert_eq!(env.balance(carol.id(), USDC).await?, 700 * ONE_USDC);
    assert_eq!(
        env.view("get_free_balances", json!({ "account_id": carol.id() }))
            .await?,
        json!({ (USDC): (300 * ONE_USDC).to_string() })
    );

    // The failed payout is still owed, now through the free balance.
    assert_invariants(&env, &[carol.id()]).await?;

    env.intents
        .call("set_fail_transfers")
        .args_json(json!({ "fail": false }))
        .transact()
        .await?
        .into_result()?;
    let withdraw = json!({"action": "withdraw", "data": {"token_id": USDC, "amount": null}});
    let result = env.auth_call(&carol, withdraw).await?;
    assert!(
        result.receipt_failures().is_empty(),
        "{:?}",
        result.failures()
    );
    assert_eq!(events(&result, "withdrawn").len(), 1);
    assert!(events(&result, "payout_failed").is_empty());
    assert_eq!(env.balance(carol.id(), USDC).await?, 1_000 * ONE_USDC);
    assert_eq!(
        env.view("get_free_balances", json!({ "account_id": carol.id() }))
            .await?,
        json!({})
    );
    assert_invariants(&env, &[carol.id()]).await
}

#[tokio::test]
async fn transfers_refund_invalid_orders_and_overpayment() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let alice = env.user(0).await?;
    let bob = env.user(150 * ONE_USDC).await?;

    // Collateral sent with a `lend` msg: Setllend panics, so the mock refunds in full.
    env.deposit(bob.id().as_str(), ETH_ARB, 1_000).await?;
    let lend = json!({"action": "lend", "data": {
        "maturity": env.maturity.to_string(), "min_rate_bps": 700, "expires_at": null
    }});
    let result = env.transfer(&bob, ETH_ARB, 1_000, lend).await?;
    let failure = format!("{:?}", result.receipt_failures());
    assert!(failure.contains("Wrong token"), "{failure}");
    assert_eq!(env.balance(bob.id(), ETH_ARB).await?, 1_000);

    // Repay 150 USDC on 100 USDC of debt: 50 comes back through the return value.
    env.patch_loan(&alice, &bob, 100 * ONE_USDC).await?;
    let repay = json!({"action": "repay", "data": {
        "maturity": env.maturity.to_string(), "collateral_token": ETH_ARB, "borrower": null
    }});
    let result = env.transfer(&bob, USDC, 150 * ONE_USDC, repay).await?;
    assert!(result.is_success(), "{:?}", result.failures());
    assert_eq!(env.balance(bob.id(), USDC).await?, 50 * ONE_USDC);
    let pool = env
        .view("get_pool", json!({ "maturity": env.maturity.to_string() }))
        .await?;
    assert_eq!(as_u128(&pool["redemption_pool"]), 100 * ONE_USDC);
    assert_invariants(&env, &[alice.id(), bob.id()]).await
}

#[tokio::test]
async fn on_payout_and_entry_points_reject_other_callers() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let mallory = env.user(0).await?;
    let result = mallory
        .call(env.setllend.id(), "on_payout")
        .args_json(json!({"account_id": mallory.id(), "token_id": USDC, "amount": "1"}))
        .transact()
        .await?;
    assert!(format!("{:?}", result.failures()).contains("Method on_payout is private"));

    let result = mallory
        .call(env.setllend.id(), "on_auth")
        .args_json(json!({"signer_id": mallory.id(), "msg": "{}"}))
        .transact()
        .await?;
    assert!(format!("{:?}", result.failures()).contains("Caller must be the intents contract"));
    Ok(())
}

/// Gas of `match_orders` with sell_note fills. Prints the numbers recorded in
/// `SOT/contract-interface.md` ("Still open"); run with `--nocapture` to see them.
#[tokio::test]
async fn match_orders_gas_per_sell_note_fill() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let alice = env.user(0).await?;
    let bob = env.user(1_000 * ONE_USDC).await?;
    let carol = env.user(1_000 * ONE_USDC).await?;
    env.patch_loan(&alice, &bob, 10_000 * ONE_USDC).await?;
    let ask = env.sell_note(&alice, 5_000 * ONE_USDC, 900).await?;
    let plain_bid = env.lend(&carol, 1_000 * ONE_USDC, 800).await?;
    // Bob has debt in this maturity, so every fill he buys also nets (D20).
    let netting_bid = env.lend(&bob, 1_000 * ONE_USDC, 800).await?;

    let mut report = Vec::new();
    for (label, bid) in [("plain", plain_bid), ("netting", netting_bid)] {
        for count in [1usize, 10] {
            let fills = vec![(bid, ask, ONE_USDC); count];
            let result = env.match_orders(&carol, &fills).await?;
            assert!(result.is_success(), "{:?}", result.failures());
            assert_eq!(events(&result, "order_filled").len(), count);
            let tgas = |gas: near_workspaces::types::Gas| gas.as_gas() as f64 / 1e12;
            let call = tgas(result.receipt_outcomes()[0].gas_burnt);
            let total = tgas(result.total_gas_burnt);
            report.push((label, count, call, total));
        }
    }
    for (label, count, call, total) in &report {
        println!("match_orders {label} x{count}: call {call:.2} Tgas, total {total:.2} Tgas");
    }
    assert_invariants(&env, &[alice.id(), bob.id(), carol.id()]).await
}
