# User actions

All actions are gasless for users because the relayer submits `execute_intents`. Exact `msg` shapes live in [contract-interface.md](contract-interface.md).

| Action | Mechanism | User signs | Needs oracle |
|---|---|---|---|
| Place lend order | `transfer` USDC to contract, `msg = LendOrder{maturity, min_rate}` | 1 signature | No |
| Place borrow order | `transfer` ETH to contract, `msg = BorrowOrder{maturity, max_rate, qty}` | 1 signature | No (checked at match) |
| Cancel order | `auth_call` → `on_auth(Cancel{order_id})`, remaining escrow returns to the Intents balance | 1 signature | No |
| Withdraw free balance | `auth_call` → `on_auth(Withdraw)` | 1 signature | No |
| Match | `match_orders(lend_id, borrow_id, qty, rate)` by any matcher. Contract checks `min_rate ≤ rate ≤ max_rate` and health factor | – | **Yes** |
| Payout to Arbitrum/Base | Contract `mt_transfer`s USDC to the borrower's Intents balance, then 1Click `INTENTS → DESTINATION_CHAIN` | 1 signature | No |
| Repay | `transfer` USDC, `msg = Repay{loan_id}`, collateral returned | 1 signature | No |
| Withdraw collateral while a loan is open | `auth_call` → `on_auth(WithdrawCollateral)` | 1 signature | **Yes** |
| Redeem at maturity | `auth_call` → `on_auth(Redeem)`, or paid automatically on repay | 1 signature | No |
| Settle unpaid loan at maturity | Keeper calls the maturity settlement method: collateral is seized and note holders are paid. Method TBD in [contract-interface.md](contract-interface.md) | – | **Yes** |
| Liquidate | Keeper `transfer`s USDC, `msg = Liquidate{loan_id}`. If the position is still healthy, funds are refunded automatically | – | **Yes** |
| Exit before maturity | `auth_call` → `on_auth(SellNote)`: sell the note on the same book. Quoting convention (rate or price) is an [open question](open-questions.md) | 1 signature | No |

## End-to-end flow (demo)

1. **Borrower (Arbitrum):** deposits ETH via 1Click into their Intents balance (`recipientType: INTENTS`), then signs a `transfer` of ETH to Setllend with `msg = BorrowOrder` "borrow 1,000 USDC, 30 days, max 8% APR".
2. **Lender (Base):** deposits USDC via 1Click (Base USDC → NEAR USDC, `recipientType: INTENTS`), then signs a `transfer` of USDC with `msg = LendOrder` "lend 1,000 USDC, 30 days, min 7%".
3. **Matcher** sees crossing orders (7% ≤ 8%). Execution price = maker's rate. Matcher calls `match_orders`. Contract reads the oracle, checks collateral × LTV ≥ principal × (1 + r·t), records the position, and sends USDC to the borrower's Intents balance.
4. **Borrower** signs the payout: 1Click NEAR USDC → Arbitrum USDC. Funds land in the Arbitrum wallet.
5. **Lender exits on day 10:** sells the note on the book. Another lender buys. The original lender receives USDC and can withdraw to Base.
6. **Liquidation (simulated):** price drops, keeper liquidates the position.
