# Frontend: pages, look, and data

> **Status: APPROVED v0.1 (2026-11-03), D47.** The UI is built first against mock data, before the backend API exists. Nothing in it sends a transaction yet.

The frontend is `frontend/` (Next.js, `wagmi`, `viem`, see [tech-stack.md](tech-stack.md)). It reads only the backend API ([backend.md](backend.md#api)) and signs intents with the user's EVM wallet. This file owns what the user sees.

## Look

| Item | Value |
|---|---|
| Theme | Dark only. Background warm black `#0C0A09`, accent orange `#F97316`. Surfaces and borders from the warm-grey (`stone`) scale |
| Type | Figtree (`next/font/google`). Numbers use tabular figures |
| Logo | Orange SVG mark plus the word "Setllend" |
| Target | Desktop first. Mobile layout is deferred |

## Pages

### Header (every page)

- Logo on the left. Navigation in the middle: **Market** (`/`) and **Portfolio** (`/portfolio`).
- No separate Deposit button: every order form deposits inline through 1Click (source chain picked in the form). Free balances are withdrawn from Portfolio.
- **Connect** on the right lists the EIP-6963 wallets found (D14). Once connected it shows the short address and the chain (Base or Arbitrum). Its menu: copy address, switch chain, disconnect.

### Market (`/`)

- **Hero:** "Welcome to Setllend" and a tagline, no user name (an EVM wallet has none). Two figures: before connecting, protocol totals (total supplied = note value outstanding plus open `lend` orders, active loans = total debt face); after connecting, the user's own (supplied, borrowed). An abstract orange gradient shape on the right, drawn in SVG.
- **One card per open maturity** (2026-11-13, 11-27, 12-25, plus any demo maturity, see [risk-params.md](risk-params.md)). Each card shows USDC, the maturity date and days left, and:

  | Field | Meaning |
  |---|---|
  | Borrow rate | Lowest `lend` order rate in the book: the APR a borrower pays to fill now |
  | Lend rate | Highest `borrow` / `sell_note` order rate: the APR a lender earns to fill now |
  | Max LTV | `max_ltv` from `Config` (70%) |
  | Liquidity | USDC in open `lend` orders: what can be borrowed now |

  A side with no orders shows "–".
- **Borrow** and **Start Earning** open a modal on the same page:
  - Borrow: USDC amount, max APR (prefilled with the borrow rate), collateral ETH (Arbitrum) or ETH (Base) and its amount, the chain that receives the USDC. Preview: debt face at maturity, LTV against max LTV, liquidation price.
  - Start Earning: USDC amount, the chain the USDC comes from, min APR (prefilled with the lend rate). Preview: value at maturity and interest.
  - Submit shows the steps as a stepper: 1Click deposit, sign the order, order placed ([user-actions.md](user-actions.md)).
- **View market** links to the market detail page.

### Market detail (`/market/[maturity]`)

- **Top:** back link, USDC, a tab per open maturity (switching reloads the whole page for that maturity), and days left. On the right: this maturity's total supplied, active loans, and the oracle ETH price with its age.
- **Chart panel**, two tabs, both `lightweight-charts` with the TradingView attribution logo on ([pitfalls.md](pitfalls.md#off-chain)):
  - Rate History: fill rates over time, ranges 1D, 7D, All, with a date and rate tooltip on hover.
  - Depth: cumulative USDC of lend offers and borrow requests by rate.
- **Book panel**, two tabs:
  - Order Book: lend offers (bids) on top, highest rate first, then a row with the mid rate and the spread in bps, then borrow requests (asks, `sell_note` merged in) with the highest rate first. Each level shows its rate, USDC, and a size bar. Clicking a lend offer opens the Borrow form at that rate in Limit mode; clicking a borrow request opens Lend.
  - Recent Trades: time, rate, USDC, and kind (`borrow` or `sell_note`).
- **Order panel**, tabs Lend, Borrow, Sell note (Sell note only with notes in this maturity), each in Limit or Market mode:
  - Limit: the user sets the rate. Any rest waits in the book.
  - Market: a UI shortcut, not a contract feature. The order is a limit order at the rate of the last book level needed to fill the amount. Each fill happens at the maker's rate (D17), so the form shows the average rate, and any amount beyond the book waits at that last rate.
  - Borrow adds collateral (ETH on Arbitrum or Base) and a health factor bar, `collateral value × liq_threshold / debt face`, with the ETH price at which the position becomes liquidatable. LTV above `max_ltv` blocks submit.
  - Sell note: note value to sell and the max rate. Preview: USDC received now.
- **Tables** for this maturity only, after connecting (before that, a Connect prompt): Open Orders (with cancel), Positions (the loan with repay, notes with sell or redeem), History (the user's events with time and status).

### Portfolio (`/portfolio`)

- Loans: debt face, collateral, health factor, liquidation price per maturity and collateral. Repay, add collateral, withdraw collateral.
- Notes: value at maturity and locked rate. Sell early, redeem after maturity.
- Open orders, with cancel.
- Free balances (with withdraw) and history.

## Data

- Components read data only through `src/lib/api/`, whose functions mirror the REST endpoints in [backend.md](backend.md#api) and return the shared view types (`src/shared/`). Amounts stay decimal strings until display.
- Until the backend API exists, `src/lib/api/` serves mock data only, and the UI shows a "Demo data" badge. Actions that would sign or send something only run a simulated stepper and say so. The HTTP client replaces the mocks once the backend is up.
- **Not in the backend API yet** ([backend.md](backend.md#api)): protocol totals for the hero, per-maturity totals for the detail page (total supplied, active loans), rate history beyond the recent-trades limit, and the user's event history. The mocks serve them now; the backend spec needs endpoints for them before the switch.
- Rate math (debt face, LTV, liquidation price) follows [contract-interface.md](contract-interface.md): simple interest on a 365-day year (D16), LTV on debt face.
