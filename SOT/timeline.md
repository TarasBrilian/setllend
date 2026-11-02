# Timeline

Effective start 2026-11-06, after the BNB hackathon. Submission deadline 2026-11-14 23:59 UTC.

| Date | Work | Status |
|---|---|---|
| Before 2026-11-05 | Get 1Click API key | ✅ 2026-11-02 |
| Before 2026-11-05 | Set up repo, SOT, README skeleton | ✅ 2026-11-02 scaffold on branch `scaffold`: contract builds with `cargo near` and passes a sandbox deploy test, backend serves `/health`, frontend builds with EVM wallet discovery. README "do X, see Y" still TODO |
| Before 2026-11-05 | Draft [contract-interface.md](contract-interface.md) (`msg` formats, methods) | ✅ approved v0.2 2026-11-02 (D15 to D23, D26) |
| Before 2026-11-05 | Decide [risk-params.md](risk-params.md) | ✅ approved v0.1 2026-11-02 |
| Before 2026-11-05 | Test API key with a dry quote, and test the payout path (D31) | 🟡 Key accepted ✅ 2026-11-02 (a corrupted key returns 401). On 2026-11-02 every `/v0/quote` call failed with 400 "Quoting for this pair is not available": all Setllend routes, the docs example, with and without the key, every swap type. The same routes quoted fine on 2026-11-01, and Solver Relay `quote` returned prices for them on 2026-11-02, so the fault is on the 1Click side. Cause confirmed by a 1Click maintenance email the same day: bridge deposits and withdrawals paused for about 1 to 2 hours for GKE node upgrades (CVE-2026-98432). Retry after the window. Payout test also needs a small USDC balance on an Intents account |
| 2026-11-06 to 11-08 | Core contract: `mt_on_transfer`, `on_auth`, order escrow, `match_orders`, positions/notes, unit tests + mocks | ⏳ |
| 2026-11-09 to 11-10 | Oracle integration (promise + callback), health factor, liquidation, maturity settlement, early exit. Mainnet deploy | ⏳ |
| 2026-11-11 | Matcher + relayer + keeper + market-maker agent | ⏳ |
| 2026-11-12 | 1Click integration (Base/Arbitrum deposits, payouts, status, dry-run) + `processWithdrawal`. Frontend: order book, positions, history | ⏳ |
| 2026-11-13 | Finish root README ("do X, see Y"), record demo video, check for secrets | ⏳ |
| 2026-11-14 | Post on X (@NEARProtocol #NEARHackathon), then submit before evening with `tracks: ["defi"]` | ⏳ |
