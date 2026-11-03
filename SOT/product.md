# Product

**One-liner:** Borrow and lend at a fixed rate from Base, Arbitrum, or NEAR with just an EVM wallet (MetaMask, Rabby, …) or a NEAR wallet (D51), without being locked until maturity, because a lender's note can be sold any time on an order book settled by NEAR Intents.

## Problem

- Most active loans on large lending protocols are variable rate with no maturity. ⚠️ The "over 95% of about $25B" figure comes from a single secondary source (4Pillars). Verify before quoting.
- The main lending market on NEAR (Rhea, the merger of Ref and Burrow) is variable rate. There is no fixed-rate market on NEAR.
- The classic weakness of fixed-rate lending: the lender's funds are locked until maturity.

## Model: zero-coupon note

Lenders and borrowers trade one instrument:

- **Lend** = buy a fixed-rate note, a claim to receive 1 USDC at maturity T. If a borrower in that maturity defaults beyond their collateral, every note in the maturity absorbs the loss pro rata (D26).
- **Borrow** = sell that note (a short position that must be collateralized).
- Book prices are quoted in APR with a 1 bps tick, then converted to a discount price.

Benefits:

- **Lenders can exit before maturity** by selling the note on the same book. This is the literal meaning of "a market that never closes".
- Borrowers can repay early by buying the note back.
- Less code: one matching engine serves both the primary and the secondary market.

> `imt_mint` (Intents-native multi-token) is **not deployed** on mainnet ✅ (2026-11-01). Notes are stored as internal positions in our contract, not as tokens on the Intents ledger.

## Fixed maturities

Free-form tenors split liquidity into many thin books. Use fixed buckets, for example **7d / 30d / 90d**, or weekly Friday expiries (the Notional and Pendle pattern). Final list: [risk-params.md](risk-params.md).

## Prior art

The pattern exists on other chains but not on NEAR: Centuari, Avon (MegaETH), Loopscale (Solana), Yume (Sui, HackMoney 2026), Jet Fixed Rate (2023). Jet Fixed Rate, Yield Protocol, and Notional v2 struggled with liquidity cold start. The market-maker agent (D7) addresses that.

## Relation to the NEAR Intents roadmap 📄

The official `escrow-swap` contract in [near/intents](https://github.com/near/intents) (`contracts/escrow-swap/src/lib.rs`) contains these TODOs:

> *"if we make solvers to be MMs, then solver-bus-proxy.near can implement **CLOB**"*
>
> *"**TODO: lending**: solver -> escrow::mt_on_transfer(sender_id, token_id, amount, msg) * msg: loan"*

Setllend builds a CLOB-based lending market on the same `mt_on_transfer` + `msg` pattern.
