# Frontend: pages, look, and data

> **Status: APPROVED v0.2 (2026-11-03), D47 and D48.** The UI is built first against mock data, before the backend API exists. Nothing in it sends a transaction yet. The collateral model is D48, which the contract implements since contract-interface v0.6 (2026-11-03, [contract-interface.md](contract-interface.md#math)); the UI still shows it on mock data.

The frontend is `frontend/` (Next.js, `wagmi`, `viem`, see [tech-stack.md](tech-stack.md)). It reads only the backend API ([backend.md](backend.md#api)), except wallet balances, which it reads from chain, and signs intents with the user's EVM or NEAR wallet (D51). This file owns what the user sees.

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
- No Deposit button in the header: deposits start from Portfolio's My Assets, and order forms can also deposit inline through 1Click.
- **Connect** on the right opens one menu with two parts (D51): EVM wallets found through EIP-6963 (D14), and NEAR wallets through NEAR Wallet Selector (Meteor, MyNearWallet, Intear). Once connected it shows the account and its network: the short address and the chain (Base or Arbitrum) for EVM, the account ID for NEAR. Its menu: copy the account, switch chain (EVM), switch between a connected EVM and NEAR account, disconnect. The last account connected is the active one.

### Market (`/`)

- **Hero:** "Welcome to Setllend" and a tagline, no user name (an EVM wallet has none). Two figures: before connecting, protocol totals (total supplied = note value outstanding plus open `lend` orders, active loans = total debt face); after connecting, the user's own (supplied, borrowed). An abstract orange gradient shape on the right, drawn in SVG.
- **One card per open maturity** (2026-11-13, 11-27, 12-25, plus any demo maturity, see [risk-params.md](risk-params.md)). Each card shows USDC, the maturity date and days left, and:

  | Field | Meaning |
  |---|---|
  | Borrow rate | Lowest `lend` order rate in the book: the APR a borrower pays to fill now |
  | Lend rate | Highest `borrow` / `sell_note` order rate: the APR a lender earns to fill now |
  | Max LTV | "Up to" the highest max LTV among active collateral tokens, with the icons of the accepted tokens (D48) |
  | Liquidity | USDC in open `lend` orders: what can be borrowed now |

  A side with no orders shows "–".
- **Borrow** and **Start Earning** open a modal on the same page:
  - Borrow: USDC amount, max APR (prefilled with the borrow rate), collateral, and the chain that receives the USDC. Collateral is a list of tokens with an amount each (one row to start, more through "Add token"), taken from the deposited balance or deposited now: from Arbitrum or Base, BTC from Bitcoin, and NEAR from the NEAR account or a 1Click swap (D52). With a loan already open in that maturity, a third source, "Existing loan", borrows more against the collateral the loan holds without adding any (D50). Preview: debt face at maturity, borrow limit (`Σ value × max_ltv`), health factor, and the price per token at which the loan becomes liquidatable, the other tokens held constant.
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
  - Borrow uses the same multi-token collateral list as the modal, with a health factor bar, `Σ value × liq_threshold / debt face`. A debt face above the borrow limit blocks submit.
  - Sell note: note value to sell and the max rate. Preview: USDC received now.
- **Tables** for this maturity only, after connecting (before that, a Connect prompt): Open Orders (with cancel), Positions (the loan with repay, add collateral, and withdraw collateral; notes with sell or redeem), History (the user's events with time and status).

### Portfolio (`/portfolio`)

Before connecting: one card with a Connect prompt. After connecting, top to bottom:

- **My Position:** net value (notes + collateral at oracle price + available balances − debt face), interest to receive at maturity, average lend and borrow rates, and the lowest health factor across loans (health is per loan, never per account). A donut splits lending (notes), borrowed (debt face), collateral, and available (deposits in the Intents balance plus free balances in Setllend), with a legend that carries the values. "See all transactions" scrolls to History.
- **Maturity timeline:** per maturity, what the user receives from notes and what they owe, as paired bars.
- **All My Positions**, tabs:
  - Borrow: one row per loan (maturity). Maturity and days left ("Due" after maturity, liquidatable after the grace period), each collateral token with its amount and USD value, debt face and average rate, health factor, and the liquidation price per token. Actions: Repay, Add collateral, Withdraw collateral (one token at a time).
  - Lend: maturity and status ("Redeemable" after maturity), value at maturity and the part listed for sale, average rate and interest, and an estimate of what the notes would sell for now at the book's mid rate. Actions: Sell, Redeem.
  - Open Orders, every maturity, with cancel.
- **My Assets**, with a **Deposit** button. From Arbitrum or Base: USDC, ETH, or NEAR bought with a 1Click swap from USDC or ETH, then the 1Click steps. From Bitcoin: BTC through 1Click, sent from any Bitcoin wallet to the deposit address (about 15 minutes, D52). From NEAR (D51): NEAR or native USDC in one NEAR transaction, no 1Click; it asks for a NEAR wallet if none is connected (connecting one there only signs the deposit and keeps the active account), and credits the active account:
  - Wallet: for an EVM account, USDC and ETH on Base and Arbitrum, read from chain through `wagmi`; for a NEAR account, NEAR and USDC in the NEAR account, read from NEAR RPC.
  - Deposited: the Intents balance per token, "Not collateral" by default, with Add to collateral (pick a loan and an amount, preview the health factor before and after) and Withdraw.
  - Free balances in Setllend (failed payouts, redemptions), with Withdraw.
- **History:** every maturity, with a filter by action.

Every action opens a modal on the page: amount, a preview (for example the health factor after a collateral withdrawal), then the simulated steps. For a NEAR account, the first action that signs an intent adds a "Register your key on NEAR Intents" step (`add_public_key`, once). Chain pickers for payouts, withdrawals, and USDC payments also offer NEAR to a NEAR account, and default to it (D51). A NEAR account has no address on Arbitrum or Base, so any 1Click leg there (a payout, a withdrawal, or a deposit and its refund) asks for one, checked as a `0x` address. A Bitcoin leg (a BTC deposit's refund, or BTC sent out) asks every account for a Bitcoin address. ETH and BTC leave through the bridge (`processWithdrawal`, D10, D52) to their own chain; USDC and NEAR leave through 1Click or to the NEAR account. Repay takes a partial amount or Max and notes that, before maturity, buying notes through a lend order in the same maturity is cheaper because they net against the debt (D20).

Add collateral and multi-token loans are D48. The contract has them (v0.6); the UI shows them on mock data until the backend serves them. Collateral tokens, their risk parameters, and frozen tokens come from one list ([risk-params.md](risk-params.md#per-token-parameters-d48)); a frozen token shows as such, can't be picked for a new borrow or a top-up, and gives no borrowing power in the loan math (D53). Add collateral offers only loans with debt that are not past maturity plus grace, as the contract requires (D53).

## Data

- Components read data only through `src/lib/api/`, whose functions mirror the REST endpoints in [backend.md](backend.md#api) and return the shared view types (`src/shared/`). Amounts stay decimal strings until display.
- Until the backend API exists, `src/lib/api/` serves mock data only, and the UI shows a "Demo data" badge. Actions that would sign or send something only run a simulated stepper and say so. The HTTP client replaces the mocks once the backend is up.
- **Not in the backend API yet**, specified in D49 ([backend.md](backend.md#api)): protocol totals for the hero, per-maturity totals for the detail page (total supplied, active loans), rate history beyond the recent-trades limit, the user's event history, the user's Intents balance (`mt_batch_balance_of` on `intents.near`), the collateral token list with its parameters (D48), and the user's fill totals per maturity (principal and face, for average rates and interest: positions and notes store neither). The mocks serve them now; the backend spec needs endpoints for them before the switch.
- Rate math (debt face, LTV, liquidation price) follows [contract-interface.md](contract-interface.md): simple interest on a 365-day year (D16), LTV on debt face.
