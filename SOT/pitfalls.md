# Pitfalls

## Contract

- **Always check `env::predecessor_account_id() == "intents.near"`** in `mt_on_transfer` and `on_auth`, and whitelist accepted `token_ids`. Never trust a token or sender without checking. Fake-collateral attacks are a known lending exploit class.
- **In `mt_on_transfer`, the fund owner is `sender_id`** (the user who signed the `transfer`), not `intents.near`.
- **Invalid input in `mt_on_transfer`:** panic or return the refund amount. A panic reverts our state and `intents.near` refunds the full amount 📄. Never return a "no refund" value after partially failing.
- **`auth_call` is detached:** the user's intent batch succeeds even if `on_auth` fails. The relayer must read the `on_auth` receipt outcome before telling the user it worked.
- **Never accept deposits via `ft_withdraw` + `msg`:** no refund on failure.
- **`mt_transfer` payouts to `intents.near` are async** and need exactly 1 yoctoNEAR attached 📄. Use a callback and re-credit the internal balance on failure.
- **A `transfer` intent can carry several tokens.** Reject `mt_on_transfer` calls with more than one token.
- **300 Tgas limit** per transaction: cap fills per `match_orders`.
- **Storage staking:** every stored order locks NEAR, paid by the contract. Release storage when an order, position, or note entry closes. Watch the contract's NEAR balance and top it up. Users are not limited (D24), so dust-order griefing is an accepted hackathon risk.
- **Note share math rounds against the acting account** (mint and move round down, burn rounds up), so other holders are never diluted. See [contract-interface.md](contract-interface.md#note-accounting).
- **Simple liquidation:** the liquidator pays the debt in USDC and receives collateral plus a bonus. No DEX swap inside the contract.
- **Oracle callbacks re-validate state.** See [oracle.md](oracle.md#integration-pattern-in-the-contract).

## Off-chain

- **Versioned nonce**, salt fetched from `current_salt`. Salt can rotate.
- **Normalize `v`** of EVM wallet signatures to {0, 1}. Wallets differ (27/28 vs 0/1), so test with at least MetaMask and Rabby.
- **Relayer pays gas:** protect our relayer endpoint from request floods (infrastructure protection, not a user limit: anyone can submit `execute_intents` directly). Use a function-call access key restricted to specific methods.
- **The signed JSON must be byte-identical** between frontend and backend. Copy shared types, don't retype them. See [repo-structure.md](repo-structure.md).
- **Matcher and relayer hosting** must stay up until 2026-11-25.
- **Market-maker base rate manipulation (D35):** the agent's base follows fill rates, and EVM accounts are free, so an attacker can fill a dust order between two of their own accounts at an extreme rate to drag the base, then trade against the agent. The contract only blocks same-owner fills. Inside the agent, weight each base move by fill size and bound the move per fill. These are agent settings, not user limits (D24).
- **`lightweight-charts` attribution:** its Apache-2.0 NOTICE requires a link to tradingview.com on the page. Keep the `attributionLogo` chart option on (the default).
- **1Click can pause with short notice.** On 2026-11-02 a maintenance window (about 1 to 2 hours) made every `/v0/quote` fail with 400 "Quoting for this pair is not available". The UI must show this as "1Click temporarily unavailable", and the README's "do X, see Y" steps need a path that works without a live 1Click quote. On-chain actions (orders, cancel, repay, withdraw to the Intents balance) don't depend on 1Click.
- **No secrets in git history.** The repo is public from the first commit. Secrets go in `.env` (gitignored) or the hosting dashboard.
