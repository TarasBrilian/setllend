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
| Number fields | Amounts and rates accept only digits and one decimal point. A comma is read as the decimal point, and any other keystroke or paste is ignored. Prefilled values (Max, balances) are plain decimals, never exponent notation such as `1e-7` |

## Intro

A logo animation over the Market page, about 4.8 s, that ends as the header logo.

- **When:** only when the first page load of a browser tab is `/`. It does not replay on reload, on later visits to `/` in the same tab, or when the tab first opened another page. It never shows under the OS "reduce motion" setting. The dev server (`npm run dev`) replays it on every load of `/`, to make it easy to review.
- **Skip:** a "Skip" button in the bottom-right corner, shown from 0.3 s until the pills start flying. It fades the intro out in 0.25 s and shows the page as it is after the intro.
- **Sequence:** on the site's own background, which covers the header and page, the top (orange) pill of the mark slides in from the right edge and the bottom (light orange) pill from the left a moment later, meeting as the mark in the center. The mark moves left while "Setllend" slides out from behind it, keeping the pair centered. The letters then spread apart, "S" staying in place, and fade one by one, center first. The two pills then fly to the header logo in the top-left corner, shrinking to its size on smooth curves: the top pill rises and lands from above, the bottom pill a moment later dips and rises to land from below, while the background fades so the Market page shows behind them. They join as the header mark, which gives a small bounce. The header's "Setllend" slides out from behind it, then the "Demo data" badge fades in.
- **Build:** CSS (`globals.css`) and the Web Animations API, no animation library. A small inline script in `<head>` turns it on before first paint, marks the tab session in `sessionStorage`, and animates the pills' flight, measuring the header logo's position once the mark and word have settled, about 1 s before the flight.

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
- **Panels:** the chart, book, and order panels share one height of 30rem; a taller order form scrolls inside its panel with the submit button kept in view.
- **Chart panel**, two tabs, both `lightweight-charts` with the TradingView attribution logo on ([pitfalls.md](pitfalls.md#off-chain)):
  - Rate History: fill rates over time, ranges 1D, 7D, All, with a date and rate tooltip on hover.
  - Depth: cumulative USDC of lend offers and borrow requests by rate.
  - Both update in place as fills and books arrive, so a hover tooltip survives. Rate History plots one point per period (15 minutes on 1D, 1 hour on 7D, 3 hours on All): the principal-weighted average rate of its fills, since fills on both sides of the spread land close together and single fills would zigzag by the spread's width. Its rate axis spans at least 0.5 percentage points, so a few bps don't fill the chart.
- **Book panel**, two tabs:
  - Order Book: lend offers (bids) on top, highest rate first, then a row with the mid rate and the spread in bps, then borrow requests (asks, `sell_note` merged in) with the highest rate first. Each level shows its rate, USDC, and a size bar. A header row has APR, a color legend (Lend orange, Borrow green), and USDC; there are no side labels. Each side gets half of the panel's height, so the mid row stays in the middle, and shows as many levels as fit there, best first, hiding the ones farthest from the spread; the book never scrolls. Size bars scale to the largest level shown. The best level of each side, next to the spread, has a faint tint of its side's color. Clicking a lend offer opens the Borrow form at that rate in Limit mode; clicking a borrow request opens Lend.
  - **Live flashes (D56):** the book follows `/ws` pushes ([Data](#data)), and a changed row lights up for its whole width, then fades out over 350 ms. A fill flashes its maker's level bright in the side's color (orange for lend offers, green for borrow requests); a new order or a larger level flashes faint in the side's color; a cancel (a level that shrank or left without a trade) flashes faint gray. A level that empties stays at size 0 until its flash ends, then leaves. A sweep across levels lights each of them. The mid and spread row flashes gray when either changes. Flashes are worked out only from the pushed book and trades, compared with the previous ones: a new trade marks its maker's level (the side holding the trade's order at the trade's rate) as a fill, and a trade that arrives after its book turns that level's cancel flash into a fill.
  - Recent Trades: time, rate, USDC, and kind (`borrow` or `sell_note`). Trades that arrive while the tab is open flash once in orange.
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

Every action opens a modal on the page: amount, a preview (for example the health factor after a collateral withdrawal), then the simulated steps. For a NEAR account, the first action that signs an intent adds a "Register your key on NEAR Intents" step (`add_public_key`, once). Chain pickers for payouts, withdrawals, and USDC payments also offer NEAR to a NEAR account, and default to it (D51). A NEAR account has no address on Arbitrum or Base, so any 1Click leg there (a payout, a withdrawal, or a deposit and its refund) asks for one, checked as a `0x` address. A Bitcoin leg (a BTC deposit's refund, or BTC sent out) asks every account for a Bitcoin address. ETH and BTC leave through 1Click to their own chain (D61); USDC and NEAR leave through 1Click to Arbitrum or Base, or to the NEAR account through an `ft_withdraw` or `native_withdraw` intent, signed alone (D64). Before a USDC withdrawal to the NEAR account, the UI reads `storage_balance_of` on the USDC contract from NEAR RPC, and without storage adds a "Register on USDC" step: a `storage_deposit` from the NEAR wallet, 0.00125 NEAR, once (D64). Repay takes a partial amount or Max and notes that, before maturity, buying notes through a lend order in the same maturity is cheaper because they net against the debt (D20).

Add collateral and multi-token loans are D48. The contract has them (v0.6); the UI shows them on mock data until the backend serves them. Collateral tokens, their risk parameters, and frozen tokens come from one list ([risk-params.md](risk-params.md#per-token-parameters-d48)); a frozen token shows as such, can't be picked for a new borrow or a top-up, and gives no borrowing power in the loan math (D53). Add collateral offers only loans with debt that are not past maturity plus grace, as the contract requires (D53).

## Data

- Components read data only through `src/lib/api/`, whose functions mirror the REST endpoints in [backend.md](backend.md#api) and return the shared view types (`src/shared/`). Amounts stay decimal strings until display.
- Until the backend API exists, `src/lib/api/` serves mock data only, and the UI shows a "Demo data" badge. Actions that would sign or send something only run a simulated stepper and say so. The HTTP client replaces the mocks once the backend is up.
- **Live updates (D56):** `subscribe(channels, onMessage)` in `src/lib/api/` mirrors WebSocket `/ws` ([backend.md](backend.md#websocket-ws)) for `book:<maturity>` and `trades:<maturity>`: the full book after every change, and every fill. `useLiveMarket` (`src/lib/use-live-market.ts`) writes the pushes into the query cache: a book replaces the cached `["book", maturity]`, a trade joins the cached `["trades", maturity]` (newest first, 200 kept). The Market grid subscribes to every open maturity, the market detail page to its own.
- **Market simulator (mock only, D56):** while anyone subscribes, the mock makes one random event every 0.5 to 1.5 s on each open maturity, each on its own timer: a fill at the best level, sweeping 2 levels 15% of the time, at each maker's rate (D17); a new order that never crosses the other side, either added to a level or as a new level on the 5 bps grid, more likely near the spread; or a cancel of all or part of a level. Amounts stay whole hundreds of USDC. Each side stays between 4 and 9 levels, and a side refilled at 4 gets its new level beyond its last one. A spread wider than 30 bps makes the next event a new level inside it. The mid drifts back to the seed book's mid, where the trade history ends: the further it strays, the likelier the events that move it back. It pushes the trades first, then the book, as `/ws` would. It exists so the book's flashes can be seen before real orders arrive, and leaves with the mocks.
- **D49 data in the backend API** since backend step 2 ([backend.md](backend.md#api)): protocol totals for the hero (`/api/stats`), per-maturity totals (`/api/maturities`), rate history (`/api/trades` with `since`), the user's event history (`/api/accounts/:account/history`, raw events with a `next` cursor, which the UI maps to its rows), the user's Intents balance (`deposits`), the collateral token list (`/api/collateral-tokens`), and fill totals per maturity (`fill_totals`). The UI's types in `src/lib/api/types.ts` still follow the mocks; they move to these shapes when the UI is wired. 1Click deposits and withdrawals come from `/api/accounts/:account/oneclick` (D61), which the UI merges into History by time when the 1Click step is wired, and so are withdrawals to the NEAR account from `/api/accounts/:account/withdrawals` (D64), where a `sent` or `pending` row shows as unknown with a pointer to the Intents balance.
- **Actions (when wired):** the stepper sends the signed payload to `POST /api/intents` and branches on `error.code`, not on `ok` alone: `pending` (202) means wait for the `{type: "intent"}` push on `account:<id>`, `rejected` shows the contract's `reason`, and `payout_failed` means the action happened but the funds wait in the free balance ([backend.md](backend.md#submitting-user-intents)).
- **1Click legs (when wired, D61):** a deposit that funds an order asks for `EXACT_OUTPUT`, so the balance receives exactly the order's amount, and the form shows `amount_in` to send; other deposits and withdrawals are `EXACT_INPUT`. Each 1Click leg shows a slippage field prefilled with the route's default. Previews use dry quotes. A 1Click withdrawal is signed once: the payload comes with the quote, and the signature goes to `POST /api/oneclick/:id/submit` ([backend.md](backend.md#withdrawals)). After sending a deposit, the UI gives 1Click the transaction hash (`deposit-tx`), and follows each quote through the `oneclick` push. The mock forms don't have these yet.
- Rate math (debt face, LTV, liquidation price) follows [contract-interface.md](contract-interface.md): simple interest on a 365-day year (D16), LTV on debt face.
- **Health factor (D54):** the API's `health_factor` uses conservative prices (`price − conf` for collateral, `price + conf` for debt), like the keeper ([backend.md](backend.md#api)). The mock-data previews in `src/lib/collateral.ts` use mid prices. When the UI is wired to the API, previews (health after a withdrawal or top-up, the borrow form's bar) switch to `shared/math.ts` with the prices from `/api/prices`, so a preview and the loan's own health agree.
