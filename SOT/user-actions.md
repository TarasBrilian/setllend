# User actions

All actions are gasless for users because the relayer submits `execute_intents`. Exact `msg` shapes, math, and validation live in [contract-interface.md](contract-interface.md).

| Action | Mechanism | User signs | Needs oracle |
|---|---|---|---|
| Place lend order | `transfer` USDC to contract, `msg = lend{maturity, min_rate_bps}` | 1 signature | No |
| Place borrow order | `transfer` collateral to contract, `msg = borrow{maturity, max_rate_bps, principal}` | 1 signature | No (checked at fill) |
| Cancel order | `auth_call` → `cancel{order_id}`, remaining escrow returns to the Intents balance | 1 signature | No |
| Withdraw free balance (failed payouts) | `auth_call` → `withdraw{token_id, amount}` | 1 signature | No |
| Match | `match_orders(fills)` by any matcher. Fill rate = maker's limit rate. Contract checks crossing and, for borrow fills, collateral | – | **Yes** (borrow fills) |
| Payout to Arbitrum/Base | Contract `mt_transfer`s USDC to the borrower's Intents balance at fill, then the user signs 1Click `INTENTS → DESTINATION_CHAIN` | 1 signature | No |
| Repay | `transfer` USDC, `msg = repay{maturity, collateral_token}`. Collateral stays until withdrawn | 1 signature | No |
| Repay early, cheaper | Place a lend order in the same maturity. Bought notes net against the debt automatically | 1 signature | No |
| Withdraw collateral | `auth_call` → `withdraw_collateral{maturity, collateral_token, amount}` | 1 signature | **Yes** (if debt remains) |
| Redeem at maturity | `auth_call` → `redeem{maturity}` | 1 signature | No |
| Liquidate (unhealthy, or unpaid after maturity + grace) | Keeper `transfer`s USDC, `msg = liquidate{borrower, maturity, collateral_token}`. If not liquidatable, funds are refunded automatically | – | **Yes** |
| Exit before maturity | `auth_call` → `sell_note{maturity, face, max_rate_bps}`: sell notes on the same book, quoted in APR | 1 signature | No |

## End-to-end flow (demo)

1. **Borrower (Arbitrum):** deposits ETH via 1Click into their Intents balance (`recipientType: INTENTS`), then signs a `transfer` of ETH to Setllend with `msg = borrow` "borrow 1,000 USDC, 30 days, max 8% APR".
2. **Lender (Base):** deposits USDC via 1Click (Base USDC → NEAR USDC, `recipientType: INTENTS`), then signs a `transfer` of USDC with `msg = lend` "lend 1,000 USDC, 30 days, min 7%".
3. **Matcher** sees crossing orders (7% ≤ 8%). Fill rate = maker's rate. Matcher calls `match_orders`. Contract reads the oracle, checks collateral value × max LTV ≥ debt face, where face = principal × (1 + r·t), records the position, and sends USDC to the borrower's Intents balance.
4. **Borrower** signs the payout: 1Click NEAR USDC → Arbitrum USDC. Funds land in the Arbitrum wallet.
5. **Lender exits on day 10:** sells the note on the book. Another lender buys. The original lender receives USDC and can withdraw to Base.
6. **Liquidation (simulated):** price drops, keeper liquidates the position.
