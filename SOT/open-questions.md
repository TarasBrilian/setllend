# Open questions

Move an item to [decisions.md](decisions.md) once resolved.

1. *Moved to Resolved (tested 2026-11-03). Number kept because D31 links to it.*
2. **Does `dry: true` quoting have rate limits** with or without a key? Not documented. Response headers on 2026-11-02 show `x-ratelimit-limit-unauth: 1200` with a reset of about 60 s ✅. Keyed requests on 2026-11-03 still returned only the `-unauth` headers ✅, so the authenticated limit, if any, is not exposed. On 2026-11-04, 25 status requests in a row all passed, still showing only the `-unauth` header ✅. The backend stays at 20 status requests per 5 s ([backend.md](backend.md#status-polling)).
3. *Moved to Resolved (D35). Number kept because D30 links to it.*
4. **USDC exit without 1Click:** `ft_withdraw` of native NEAR USDC and `native_withdraw` to the signer's NEAR account are built (D64) and parse in `simulate_intents` ✅ 2026-11-05; a small real withdrawal of each is left, with #9, planned as step 10 of the smoke test ([smoke-test.md](smoke-test.md)). An implicit Eth account no longer needs this exit: EVM accounts leave through 1Click (D61, D64). Still open: whether a Solver Relay swap is worth building as fallback (D10).
5. *Moved to Resolved (2026-11-03).*
6. *Moved to Resolved (2026-11-03).*
7. **NEP-413 intents from a named account** ⚠️: the keeper's signing path needs `add_public_key` on `intents.near` and a `nep413` payload. The payload half is settled ✅ 2026-11-03: the shared builder's envelope passed `simulate_intents` with a throwaway key as its implicit account, which needed no `add_public_key` ([intents-primitives.md](intents-primitives.md#payload-format)). Left: the `add_public_key` step itself on mainnet, done by `backend/scripts/backend-account.ts` once `backend.setllend.near` exists. Its deposit is exactly 1 yoctoNEAR with no storage deposit 📄 (near/intents `accounts/mod.rs`, `assert_one_yocto`); the gas it burns is still to measure.
8. *Moved to Resolved (D52). Number kept because D48 links to it.*
9. **NEAR users (D51)** ⚠️: do Meteor, MyNearWallet, and Intear sign NEP-413 messages (`signMessage`) that `intents.near` accepts? (Meteor connects ✅ 2026-11-03, tested by the user.) What does `add_public_key` on `intents.near` cost a user (deposit, gas), and does `wrap.near` need a `storage_deposit` before `near_deposit` for a new account? Meteor is tested by the smoke test ([smoke-test.md](smoke-test.md)); MyNearWallet and Intear stay open. Test with small amounts once a NEAR wallet is at hand; #7 covers the same registration for the keeper.
10. **BTC exit (D52, D61)** ⚠️: BTC leaves through 1Click since D61, and a dry quote passed ✅ 2026-11-04 (0.001 BTC → 0.000985 BTC, about 455 s, [assets-and-flows.md](assets-and-flows.md#exit-and-exact_output-quotes-2026-11-04-)). Left: a small real withdrawal from an Intents balance to a Bitcoin address, before the owner adds BTC with `add_collateral_token` (D53: tokens are added after deploy, so the deploy can go ahead without it). `processWithdrawal` on the PoA bridge is only the untested fallback now.

## Resolved

- D48 collateral tokens (#8) → D52: native BTC (`btc.omft.near`) and NEAR (`wrap.near`) at 70/80/5. WBTC isn't on 1Click for Arbitrum or Base, and cbBTC has no oracle feed. USDC → NEAR swaps quote. Feeds BTC/USD and NEAR/USD are live on `aggregate-oracle.near` ✅ 2026-11-03.
- Backend account and funding (#5) → `backend.setllend.near`, about 0.5 NEAR for gas, keeper USDC chosen at funding time and kept small because the account's Intents balance is a hot wallet (D43). No FastNear key for now: following the tip uses about 103 of the 180 free requests per minute, and since the book and keeper read state (D40, D45), backfill only feeds history. Add `NEARDATA_API_KEY` if `/health` shows lag or 429s on Railway. Superseded for events by D55: the backend reads them from the FastNear explorer, not neardata.
- Sandbox end-to-end backend test (#6) → not built: neardata doesn't exist for a sandbox, so the follower couldn't be covered, and the Rust sandbox tests already cover the contract. A scripted mainnet smoke test with small amounts runs after the deploy ([backend.md](backend.md#tests)). Since D55 the follower reads the FastNear explorer, which has no sandbox either.

- Matching model → D9 (continuous CLOB).
- 1Click API key → obtained 2026-11-02.
- Payout path from an Intents balance → works with our key ✅ 2026-11-03 (quote → `generate-intent` → ERC-191 signature → `submit-intent`), see [assets-and-flows.md](assets-and-flows.md#real-funds-test-2026-11-03-). The relayer fallback (user-signed `transfer` submitted via `execute_intents`) is not needed.
- Contract interface → approved v0.1, D15 to D22.
- Secondary-market quoting → D15 (APR everywhere).
- Maturity settlement mechanism → D19 (liquidation after maturity + grace).
- Upgradeability during the hackathon → D23.
- Risk parameters → approved v0.1 2026-11-02, no user-facing limits (D24).
- Contract account → D25 (`setllend.near`).
- Bad debt → D26 (in MVP, shared pro rata via note shares).
- `defuse-core` off-chain orders → dropped (D27).
- Backend/frontend stack, hosting, license, track → D28 to D33.
- Rhea APR source for the market-maker agent → not needed, the agent uses no external rate source (D35).
