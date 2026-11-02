# Timeline

Effective start 2026-11-06, after the BNB hackathon. Submission deadline 2026-11-14 23:59 UTC.

| Date | Work | Status |
|---|---|---|
| Before 2026-11-05 | Get 1Click API key | ✅ 2026-11-02 |
| Before 2026-11-05 | Set up repo, SOT, README skeleton | 🟡 in progress (stack decided D28 to D33, scaffold pending) |
| Before 2026-11-05 | Draft [contract-interface.md](contract-interface.md) (`msg` formats, methods) | ✅ approved v0.2 2026-11-02 (D15 to D23, D26) |
| Before 2026-11-05 | Decide [risk-params.md](risk-params.md) | ✅ approved v0.1 2026-11-02 |
| Before 2026-11-05 | Test API key with a dry quote, and test the payout path (D31) | ⏳ dry quote needs `ONE_CLICK_JWT` in `.env`. Payout test also needs a small USDC balance on an Intents account |
| 2026-11-06 to 11-08 | Core contract: `mt_on_transfer`, `on_auth`, order escrow, `match_orders`, positions/notes, unit tests + mocks | ⏳ |
| 2026-11-09 to 11-10 | Oracle integration (promise + callback), health factor, liquidation, maturity settlement, early exit. Mainnet deploy | ⏳ |
| 2026-11-11 | Matcher + relayer + keeper + market-maker agent | ⏳ |
| 2026-11-12 | 1Click integration (Base/Arbitrum deposits, payouts, status, dry-run) + `processWithdrawal`. Frontend: order book, positions, history | ⏳ |
| 2026-11-13 | Finish root README ("do X, see Y"), record demo video, check for secrets | ⏳ |
| 2026-11-14 | Post on X (@NEARProtocol #NEARHackathon), then submit before evening with `tracks: ["defi"]` | ⏳ |
