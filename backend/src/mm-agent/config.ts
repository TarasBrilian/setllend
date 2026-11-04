// Market-maker agent settings (SOT/backend.md#agent-settings, D60). Agent settings, not
// user-facing limits (D24). Rates in bps, amounts in USDC units (6 decimals), times in ms.
export const MM = {
  initialBaseBps: 600,
  spreadBps: 50,
  quoteSize: 100_000_000n,
  /** Below this a quote isn't placed: dust orders would only cost the contract storage. */
  minQuoteSize: 10_000_000n,
  /** Base move per fill: `alpha × min(1, principal / quoteSize)` of the way to the fill rate, at most `maxMoveBps`. */
  alpha: 0.3,
  maxMoveBps: 25,
  requoteBps: 5,
  /** `borrow` collateral is escrowed so the fill opens at this LTV (bps) at mid prices. */
  targetLtvBps: 4_000,
  /** No new `borrow` ask while the agent's loan in that maturity is below this health. */
  minHealth: 1.5,
  /** Orders expire after a day, renewed 2 h before: about 6 payloads a day, a small share of the backend's gas. */
  orderTtlMs: 24 * 3_600_000,
  renewBeforeMs: 2 * 3_600_000,
  /** `borrow` asks stop a day before maturity, since the agent's debt is repaid by hand by maturity + grace. */
  stopBorrowBeforeMs: 24 * 3_600_000,
  /** `lend` bids carry no liquidation risk, so they quote short demo maturities until shortly before. */
  stopLendBeforeMs: 15 * 60_000,
  /** A round at least this often, and on every book change. */
  intervalMs: 30_000,
  /** A failed payload leaves its maturity and side alone until a book change or this long. */
  failureHoldMs: 5 * 60_000,
};

export type MmSettings = typeof MM;
