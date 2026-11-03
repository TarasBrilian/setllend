//! End-to-end flows through the mock `intents.near` and the mock oracle.

use near_workspaces::types::Gas;
use near_workspaces::{Account, AccountId};
use serde_json::{Value, json};
use std::collections::BTreeMap;

use setllend_tests::{
    BTC, BTC_FEED, COLLATERAL_TOKENS, ETH_ARB, ETH_FEED, Env, ONE_BTC, ONE_ETH, ONE_USDC, USDC,
    events,
};

fn as_u128(value: &Value) -> u128 {
    value.as_str().unwrap().parse().unwrap()
}

/// Adds every `{token_id: amount}` entry of `amounts` to `owed`.
fn add_amounts(owed: &mut BTreeMap<String, u128>, amounts: &Value) {
    for (token_id, amount) in amounts.as_object().unwrap() {
        *owed.entry(token_id.clone()).or_default() += as_u128(amount);
    }
}

/// `redemption_pool + Σ debt_face ≥ V`, and the shares of `accounts` add up to `S`. Also
/// that Setllend's Intents balance of each token is exactly what it owes: open lend escrow,
/// the redemption pool, and free balances in USDC; borrow escrow, loan collateral, and free
/// balances in each collateral token. And that the loan index (D45) lists exactly the loans
/// of `accounts`. `accounts` must list every account involved.
async fn assert_invariants(env: &Env, accounts: &[&AccountId]) -> anyhow::Result<()> {
    let maturity = env.maturity.to_string();
    let pool = env
        .view("get_pool", json!({ "maturity": maturity }))
        .await?;
    let mut debt = 0;
    let mut shares = 0;
    let mut loans = 0;
    let mut owed = BTreeMap::from([(USDC.to_string(), as_u128(&pool["redemption_pool"]))]);
    for account in accounts {
        let account_loans = env
            .view("get_loans_by_account", json!({ "account_id": account }))
            .await?;
        for loan in account_loans.as_array().unwrap() {
            debt += as_u128(&loan["debt_face"]);
            add_amounts(&mut owed, &loan["collateral"]);
            loans += 1;
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
        add_amounts(&mut owed, &free);
    }
    let orders = env
        .view("get_orders", json!({ "maturity": maturity }))
        .await?;
    for order in orders.as_array().unwrap() {
        match order["kind"].as_str().unwrap() {
            "lend" => *owed.get_mut(USDC).unwrap() += as_u128(&order["remaining"]),
            "borrow" => add_amounts(&mut owed, &order["collateral"]),
            _ => {}
        }
    }
    assert!(as_u128(&pool["redemption_pool"]) + debt >= as_u128(&pool["total_value"]));
    assert_eq!(shares, as_u128(&pool["total_shares"]));
    let tokens = std::iter::once(USDC).chain(COLLATERAL_TOKENS.iter().map(|(id, _, _)| *id));
    for token_id in tokens {
        let held = env.balance(env.setllend.id(), token_id).await?;
        assert_eq!(held, owed.get(token_id).copied().unwrap_or(0), "{token_id}");
    }
    assert_eq!(env.view("get_loan_count", json!({})).await?, loans);
    let page = env.view("get_loans", json!({})).await?;
    assert_eq!(page.as_array().unwrap().len(), loans);
    Ok(())
}

#[tokio::test]
async fn lend_buys_notes_from_sell_note() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let alice = env.user(0).await?;
    let bob = env.user(0).await?;
    let carol = env.user(1_000 * ONE_USDC).await?;
    env.zero_rate_loan(&alice, &bob, 1_000 * ONE_USDC).await?;

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
        vec![json!({"order_id": bid.to_string(), "owner": carol.id(),
            "refunded": {USDC: (300 * ONE_USDC).to_string()}, "unlocked_shares": null})]
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
    let bob = env.user(50 * ONE_USDC).await?;

    // Collateral sent with a `lend` msg: Setllend panics, so the mock refunds in full.
    env.deposit(bob.id().as_str(), ETH_ARB, 1_000).await?;
    let lend = json!({"action": "lend", "data": {
        "maturity": env.maturity.to_string(), "min_rate_bps": 700, "expires_at": null
    }});
    let result = env.transfer(&bob, ETH_ARB, 1_000, lend).await?;
    let failure = format!("{:?}", result.receipt_failures());
    assert!(failure.contains("Wrong token"), "{failure}");
    assert_eq!(env.balance(bob.id(), ETH_ARB).await?, 1_000);

    // Repay 150 USDC on 100 USDC of debt: 50 comes back through the return value. Bob holds
    // his 50 plus the 100 he borrowed.
    env.zero_rate_loan(&alice, &bob, 100 * ONE_USDC).await?;
    let repay = json!({"action": "repay", "data": {
        "maturity": env.maturity.to_string(), "borrower": null
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
    env.zero_rate_loan(&alice, &bob, 10_000 * ONE_USDC).await?;
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

fn tgas(gas: Gas) -> f64 {
    gas.as_gas() as f64 / 1e12
}

/// `min_gas` the keeper and relayer set for intents that reach the oracle.
const ORACLE_MIN_GAS: Gas = Gas::from_tgas(100);

/// Alice lends Bob `principal` USDC on 1 ETH at 10% APR, through an oracle-priced fill.
/// Returns the gas of `match_orders` in Tgas: (the call itself, all receipts).
async fn open_loan(
    env: &Env,
    alice: &Account,
    bob: &Account,
    principal: u128,
) -> anyhow::Result<(f64, f64)> {
    let ask = env.borrow(bob, ONE_ETH, principal, 1_000).await?;
    let bid = env.lend(alice, principal, 1_000).await?;
    let result = env.match_orders(alice, &[(bid, ask, principal)]).await?;
    assert!(result.is_success(), "{:?}", result.failures());
    assert_eq!(
        events(&result, "order_filled").len(),
        1,
        "logs: {:?}",
        result.logs()
    );
    Ok((
        tgas(result.receipt_outcomes()[0].gas_burnt),
        tgas(result.total_gas_burnt),
    ))
}

async fn bob_loan(env: &Env, bob: &Account) -> anyhow::Result<Value> {
    env.view(
        "get_loan",
        json!({ "account_id": bob.id(), "maturity": env.maturity.to_string() }),
    )
    .await
}

fn liquidate_msg(env: &Env, borrower: &Account) -> Value {
    json!({"action": "liquidate", "data": {
        "borrower": borrower.id(), "maturity": env.maturity.to_string()
    }})
}

/// Gas of a one-fill `borrow` batch, oracle round trip included. Run with `--nocapture`.
#[tokio::test]
async fn borrow_fill_prices_through_the_oracle() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let alice = env.user(1_000 * ONE_USDC).await?;
    let bob = env.user(0).await?;
    let (call, total) = open_loan(&env, &alice, &bob, 1_000 * ONE_USDC).await?;

    // The borrower got the principal in their Intents balance.
    assert_eq!(env.balance(bob.id(), USDC).await?, 1_000 * ONE_USDC);
    let loan = bob_loan(&env, &bob).await?;
    assert_eq!(loan["collateral"], json!({ ETH_ARB: ONE_ETH.to_string() }));
    assert!(as_u128(&loan["debt_face"]) > 1_000 * ONE_USDC);
    println!("match_orders borrow x1: call {call:.2} Tgas, total {total:.2} Tgas");
    assert_invariants(&env, &[alice.id(), bob.id()]).await
}

#[tokio::test]
async fn stale_price_skips_borrow_fills() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let alice = env.user(1_000 * ONE_USDC).await?;
    let bob = env.user(0).await?;
    let ask = env.borrow(&bob, ONE_ETH, 1_000 * ONE_USDC, 1_000).await?;
    let bid = env.lend(&alice, 1_000 * ONE_USDC, 1_000).await?;
    let now_s = (env.sandbox.view_block().await?.timestamp() / 1_000_000_000) as i64;
    env.set_price(ETH_FEED, 2_000 * 100_000_000, Some(now_s - 120))
        .await?;

    let result = env
        .match_orders(&alice, &[(bid, ask, 1_000 * ONE_USDC)])
        .await?;
    assert!(result.is_success(), "{:?}", result.failures());
    assert_eq!(events(&result, "fill_skipped")[0]["reason"], "no_price");
    assert_eq!(env.balance(bob.id(), USDC).await?, 0);

    // A fresh price lets the same fill through.
    env.set_eth_price(2_000).await?;
    let result = env
        .match_orders(&alice, &[(bid, ask, 1_000 * ONE_USDC)])
        .await?;
    assert_eq!(events(&result, "order_filled").len(), 1);
    assert_eq!(env.balance(bob.id(), USDC).await?, 1_000 * ONE_USDC);
    assert_invariants(&env, &[alice.id(), bob.id()]).await
}

/// Gas of `liquidate`, oracle round trip included. Run with `--nocapture`.
#[tokio::test]
async fn keeper_liquidates_an_unhealthy_loan() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let alice = env.user(1_000 * ONE_USDC).await?;
    let bob = env.user(0).await?;
    let keeper = env.user(2_000 * ONE_USDC).await?;
    open_loan(&env, &alice, &bob, 1_000 * ONE_USDC).await?;
    let debt = as_u128(&bob_loan(&env, &bob).await?["debt_face"]);

    // Healthy at $2,000: the callback panics and the keeper is refunded in full.
    let msg = liquidate_msg(&env, &bob);
    let result = env
        .transfer_with_gas(
            &keeper,
            USDC,
            2_000 * ONE_USDC,
            msg.clone(),
            Some(ORACLE_MIN_GAS),
        )
        .await?;
    let failure = format!("{:?}", result.receipt_failures());
    assert!(failure.contains("Loan is not liquidatable"), "{failure}");
    assert_eq!(env.balance(keeper.id(), USDC).await?, 2_000 * ONE_USDC);

    env.set_eth_price(1_200).await?;
    let result = env
        .transfer_with_gas(&keeper, USDC, 2_000 * ONE_USDC, msg, Some(ORACLE_MIN_GAS))
        .await?;
    assert!(
        result.receipt_failures().is_empty(),
        "{:?}",
        result.failures()
    );
    let liquidated = &events(&result, "liquidated")[0];
    assert_eq!(as_u128(&liquidated["repaid"]), debt);
    let seized = as_u128(&liquidated["seized"][ETH_ARB]);
    // $1,008.22 × 1.05 / $1,200 ≈ 0.8822 ETH.
    assert!(seized > ONE_ETH * 88 / 100 && seized < ONE_ETH * 89 / 100);
    assert_eq!(
        env.balance(keeper.id(), USDC).await?,
        2_000 * ONE_USDC - debt
    );
    assert_eq!(env.balance(keeper.id(), ETH_ARB).await?, seized);
    let loan = bob_loan(&env, &bob).await?;
    assert_eq!(as_u128(&loan["debt_face"]), 0);
    assert_eq!(as_u128(&loan["collateral"][ETH_ARB]), ONE_ETH - seized);
    println!("liquidate: total {:.2} Tgas", tgas(result.total_gas_burnt));
    assert_invariants(&env, &[alice.id(), bob.id(), keeper.id()]).await
}

#[tokio::test]
async fn liquidation_realizes_bad_debt() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let alice = env.user(1_000 * ONE_USDC).await?;
    let bob = env.user(0).await?;
    let keeper = env.user(2_000 * ONE_USDC).await?;
    open_loan(&env, &alice, &bob, 1_000 * ONE_USDC).await?;
    let debt = as_u128(&bob_loan(&env, &bob).await?["debt_face"]);

    env.set_eth_price(1_000).await?;
    let msg = liquidate_msg(&env, &bob);
    let result = env
        .transfer_with_gas(&keeper, USDC, 2_000 * ONE_USDC, msg, Some(ORACLE_MIN_GAS))
        .await?;
    assert!(
        result.receipt_failures().is_empty(),
        "{:?}",
        result.failures()
    );
    let repaid = as_u128(&events(&result, "liquidated")[0]["repaid"]);
    let bad_debt = &events(&result, "bad_debt_realized")[0];
    assert_eq!(as_u128(&bad_debt["amount"]), debt - repaid);
    assert_eq!(env.balance(keeper.id(), ETH_ARB).await?, ONE_ETH);
    assert!(bob_loan(&env, &bob).await?.is_null());
    let pool = env
        .view("get_pool", json!({ "maturity": env.maturity.to_string() }))
        .await?;
    assert_eq!(as_u128(&pool["bad_debt_total"]), debt - repaid);
    assert_eq!(as_u128(&pool["redemption_pool"]), repaid);
    assert_invariants(&env, &[alice.id(), bob.id(), keeper.id()]).await
}

#[tokio::test]
async fn withdraw_collateral_with_debt_checks_the_oracle() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let alice = env.user(1_000 * ONE_USDC).await?;
    let bob = env.user(0).await?;
    open_loan(&env, &alice, &bob, 1_000 * ONE_USDC).await?;
    let withdraw = |amount: u128| {
        json!({"action": "withdraw_collateral", "data": {
            "maturity": env.maturity.to_string(), "collateral_token": ETH_ARB,
            "amount": amount.to_string()
        }})
    };

    // About 1,008.22 USDC of face at 70% LTV needs 0.7202 ETH at $2,000.
    let result = env
        .auth_call_with_gas(&bob, withdraw(ONE_ETH / 2), Some(ORACLE_MIN_GAS))
        .await?;
    let failure = format!("{:?}", result.receipt_failures());
    assert!(failure.contains("Withdrawal exceeds max LTV"), "{failure}");

    let result = env
        .auth_call_with_gas(&bob, withdraw(ONE_ETH / 4), Some(ORACLE_MIN_GAS))
        .await?;
    assert!(
        result.receipt_failures().is_empty(),
        "{:?}",
        result.failures()
    );
    assert_eq!(env.balance(bob.id(), ETH_ARB).await?, ONE_ETH / 4);
    println!(
        "withdraw_collateral with debt: total {:.2} Tgas",
        tgas(result.total_gas_burnt)
    );

    assert_invariants(&env, &[alice.id(), bob.id()]).await
}

/// Gas of a 10-fill `borrow` batch, the matcher's batch limit (`SOT/risk-params.md`). Run with
/// `--nocapture`.
#[tokio::test]
async fn match_orders_gas_for_ten_borrow_fills() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let alice = env.user(100 * ONE_USDC).await?;
    let bob = env.user(0).await?;
    let mut asks = Vec::new();
    for _ in 0..10 {
        asks.push(env.borrow(&bob, ONE_ETH / 10, 10 * ONE_USDC, 1_000).await?);
    }
    let bid = env.lend(&alice, 100 * ONE_USDC, 1_000).await?;
    let fills: Vec<(u64, u64, u128)> = asks.iter().map(|ask| (bid, *ask, 10 * ONE_USDC)).collect();

    let result = env.match_orders(&alice, &fills).await?;
    assert!(result.is_success(), "{:?}", result.failures());
    assert_eq!(events(&result, "order_filled").len(), 10);
    assert!(events(&result, "fill_skipped").is_empty());
    assert_eq!(env.balance(bob.id(), USDC).await?, 100 * ONE_USDC);
    let call = tgas(result.receipt_outcomes()[0].gas_burnt);
    let total = tgas(result.total_gas_burnt);
    println!("match_orders borrow x10: call {call:.2} Tgas, total {total:.2} Tgas");
    assert_invariants(&env, &[alice.id(), bob.id()]).await
}

/// Bob escrows ETH and BTC in one `transfer`, tops the loan up with more BTC, borrows more
/// against it with an `auth_call` `borrow`, and a keeper liquidates both tokens pro rata. Gas
/// of the two-token liquidation. Run with `--nocapture`.
#[tokio::test]
async fn multi_token_loan_from_escrow_to_liquidation() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let alice = env.user(1_500 * ONE_USDC).await?;
    let bob = env.user(0).await?;
    let keeper = env.user(2_000 * ONE_USDC).await?;

    // $1,000 of ETH and $1,000 of BTC carry up to $1,400 of face.
    let ask = env
        .borrow_many(
            &bob,
            &[(ETH_ARB, ONE_ETH / 2), (BTC, ONE_BTC / 50)],
            1_000 * ONE_USDC,
            1_000,
        )
        .await?;
    let bid = env.lend(&alice, 1_500 * ONE_USDC, 1_000).await?;
    let result = env
        .match_orders(&alice, &[(bid, ask, 1_000 * ONE_USDC)])
        .await?;
    assert_eq!(
        events(&result, "order_filled").len(),
        1,
        "{:?}",
        result.logs()
    );
    println!(
        "match_orders borrow with two tokens x1: total {:.2} Tgas",
        tgas(result.total_gas_burnt)
    );
    assert_eq!(
        bob_loan(&env, &bob).await?["collateral"],
        json!({ ETH_ARB: (ONE_ETH / 2).to_string(), BTC: (ONE_BTC / 50).to_string() })
    );

    // Top-up: 0.01 BTC more, no price needed.
    env.deposit(bob.id().as_str(), BTC, ONE_BTC / 100).await?;
    let add = json!({"action": "add_collateral", "data": {"maturity": env.maturity.to_string()}});
    let result = env.transfer(&bob, BTC, ONE_BTC / 100, add).await?;
    assert!(result.is_success(), "{:?}", result.failures());
    assert_eq!(events(&result, "collateral_added").len(), 1);

    // 500 USDC more against the loan alone: $1,000 + $1,500 at 70% = $1,750 of power.
    let more = json!({"action": "borrow", "data": {
        "maturity": env.maturity.to_string(), "max_rate_bps": 1_000,
        "principal": (500 * ONE_USDC).to_string(), "expires_at": null
    }});
    let result = env.auth_call(&bob, more).await?;
    assert!(
        result.receipt_failures().is_empty(),
        "{:?}",
        result.failures()
    );
    let placed = &events(&result, "order_placed")[0];
    assert_eq!(placed["collateral"], json!({}));
    let more_ask: u64 = placed["order_id"].as_str().unwrap().parse()?;
    let result = env
        .match_orders(&alice, &[(bid, more_ask, 500 * ONE_USDC)])
        .await?;
    assert_eq!(
        events(&result, "order_filled").len(),
        1,
        "{:?}",
        result.logs()
    );
    assert_eq!(env.balance(bob.id(), USDC).await?, 1_500 * ONE_USDC);
    let debt = as_u128(&bob_loan(&env, &bob).await?["debt_face"]);

    // Both prices fall: $500 of ETH + $900 of BTC at 80% = $1,120, below about $1,512 of face.
    env.set_eth_price(1_000).await?;
    env.set_price(BTC_FEED, 30_000 * 100_000_000, None).await?;
    let result = env
        .transfer_with_gas(
            &keeper,
            USDC,
            500 * ONE_USDC,
            liquidate_msg(&env, &bob),
            Some(ORACLE_MIN_GAS),
        )
        .await?;
    assert!(
        result.receipt_failures().is_empty(),
        "{:?}",
        result.failures()
    );
    let seized = &events(&result, "liquidated")[0]["seized"];
    let (eth, btc) = (as_u128(&seized[ETH_ARB]), as_u128(&seized[BTC]));
    // $500 × 1.05 / $1,400 = 37.5% of each token.
    assert_eq!(eth, ONE_ETH / 2 * 375 / 1_000);
    assert_eq!(btc, ONE_BTC * 3 / 100 * 375 / 1_000);
    assert_eq!(env.balance(keeper.id(), ETH_ARB).await?, eth);
    assert_eq!(env.balance(keeper.id(), BTC).await?, btc);
    let loan = bob_loan(&env, &bob).await?;
    assert_eq!(as_u128(&loan["debt_face"]), debt - 500 * ONE_USDC);
    println!(
        "liquidate two tokens: total {:.2} Tgas",
        tgas(result.total_gas_burnt)
    );
    assert_invariants(&env, &[alice.id(), bob.id(), keeper.id()]).await
}

#[tokio::test]
async fn owner_manages_collateral_tokens() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let mallory = env.user(0).await?;
    let tokens = env.view("get_collateral_tokens", json!({})).await?;
    assert_eq!(tokens.as_array().unwrap().len(), 3);

    let freeze = json!({ "token_id": BTC });
    let result = mallory
        .call(env.setllend.id(), "freeze_collateral_token")
        .args_json(freeze.clone())
        .transact()
        .await?;
    assert!(format!("{:?}", result.failures()).contains("Owner only"));

    let result = env
        .setllend
        .call("freeze_collateral_token")
        .args_json(freeze)
        .transact()
        .await?;
    assert!(result.is_success(), "{:?}", result.failures());
    let tokens = env.view("get_collateral_tokens", json!({})).await?;
    assert_eq!(tokens[2]["token_id"], BTC);
    assert_eq!(tokens[2]["frozen"], true);

    // A frozen token can't be escrowed: the transfer is refunded in full.
    let bob = env.user(0).await?;
    env.deposit(bob.id().as_str(), BTC, ONE_BTC).await?;
    let borrow = json!({"action": "borrow", "data": {
        "maturity": env.maturity.to_string(), "max_rate_bps": 1_000,
        "principal": ONE_USDC.to_string(), "expires_at": null
    }});
    let result = env.transfer(&bob, BTC, ONE_BTC, borrow).await?;
    let failure = format!("{:?}", result.receipt_failures());
    assert!(failure.contains("Collateral token is frozen"), "{failure}");
    assert_eq!(env.balance(bob.id(), BTC).await?, ONE_BTC);
    assert_invariants(&env, &[mallory.id(), bob.id()]).await
}
