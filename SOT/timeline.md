# Timeline

Effective start 2026-11-06, after the BNB hackathon. Submission deadline 2026-11-14 23:59 UTC.

| Date | Work | Status |
|---|---|---|
| Before 2026-11-05 | Get 1Click API key | ✅ 2026-11-02 |
| Before 2026-11-05 | Set up repo, SOT, README skeleton | ✅ 2026-11-02 scaffold (PR #1): contract builds with `cargo near` and passes a sandbox deploy test, backend serves `/health`, frontend connects and disconnects an EVM wallet, CI runs every check. README skeleton with "Run locally"; "do X, see Y" is part of the 2026-11-13 row |
| Before 2026-11-05 | Draft [contract-interface.md](contract-interface.md) (`msg` formats, methods) | ✅ approved v0.2 2026-11-02 (D15 to D23, D26), v0.3 clarifications 2026-11-02 (D37, D38) |
| Before 2026-11-05 | Decide [risk-params.md](risk-params.md) | ✅ approved v0.1 2026-11-02 |
| Before 2026-11-05 | Test API key with a dry quote, and test the payout path (D31) | ✅ Key accepted ✅ 2026-11-02 (a corrupted key returns 401). Dry quotes with the key ✅ 2026-11-03 on all six Setllend routes, see [assets-and-flows.md](assets-and-flows.md#keyed-dry-quotes-2026-11-03-). Outage before that: from about 12:30 UTC on 2026-11-02 every `/v0/quote` call failed with 400 "Quoting for this pair is not available" (all routes, the docs example, with and without the key), while Solver Relay `quote` still priced our routes. A 1Click email the same day announced a 1 to 2 hour maintenance window (GKE node upgrades, CVE-2026-98432). At 15:43 UTC 1Click was still down, now with Cloudflare 521 on `/v0/quote` and `/v0/tokens`. Recovered by 06:40 UTC on 2026-11-03. Payout test ✅ 2026-11-03 with $1 of real funds: Arbitrum USDC → Intents, then back to Arbitrum through `generate-intent` → ERC-191 signature → `submit-intent`, see [assets-and-flows.md](assets-and-flows.md#real-funds-test-2026-11-03-) |
| 2026-11-06 to 11-08 | Core contract: `mt_on_transfer`, `on_auth`, order escrow, `match_orders`, positions/notes, unit tests + mocks | 🟡 Phase 1 (everything without the oracle) done 2026-11-02 and merged to `main` (PR #2): `lend`, `borrow` placement, `repay`, `cancel`, `sell_note`, `redeem`, `withdraw`, `withdraw_collateral` without debt, `match_orders` for `sell_note` fills, netting, payouts with free-balance fallback, all views, and all events except `liquidated` and `bad_debt_realized`. The `lend` × `borrow` fill is written and unit-tested with injected prices, but `match_orders` panics on `borrow` asks until the oracle lands. 99 unit tests, 7 sandbox tests through a mock `intents.near`, verification pass done (D38). Gas per `sell_note` fill measured, see [contract-interface.md](contract-interface.md#matching). Spec clarifications: D37, D38. Left for 2026-11-09: oracle call + `on_match_prices`, `liquidate`, bad-debt realization, `withdraw_collateral` with debt |
| 2026-11-09 to 11-10 | Oracle integration (promise + callback), health factor, liquidation, maturity settlement, early exit. Mainnet deploy | ⏳ |
| 2026-11-11 | Matcher + relayer + keeper + market-maker agent | ⏳ |
| 2026-11-12 | 1Click integration (Base/Arbitrum deposits, payouts, status, dry-run) + `processWithdrawal`. Frontend: order book, positions, history | ⏳ |
| 2026-11-13 | Finish root README ("do X, see Y"), record demo video, check for secrets | ⏳ |
| 2026-11-14 | Post on X (@NEARProtocol #NEARHackathon), then submit before evening with `tracks: ["defi"]` | ⏳ |
