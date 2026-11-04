// One keeper scan (SOT/backend.md#scan, D44, D59): which loans the contract would let the keeper
// liquidate now, in the order to liquidate them, each with the repayment it would send and why it
// can't be sent yet, if so. Pure: loans, prices, capital, and holds come in. Eligibility mirrors
// `execute_liquidation` in contracts/setllend/src/loans.rs: overdue first, then health at each
// token's `liq_threshold` with conservative prices; the seizure estimate uses mid prices (D39).
import type { AccountId, TokenId, U64 } from "../shared/encoding.ts";
import { MathError, type Price, canOpen, healthFactor, seize, valuation } from "../shared/math.ts";
import type { CollateralToken, LoanEntryView } from "../shared/views.ts";
import { allNewer } from "../matcher/parking.ts";

export type SkipReason = "no_price" | "unknown_token" | "nothing_to_seize" | "math_overflow" | "held" | "no_capital";

export type Candidate = {
  account_id: AccountId;
  maturity: U64;
  reason: "overdue" | "unhealthy";
  /** Conservative health at `liq_threshold`, null without usable prices. */
  health: number | null;
  /** Debt face to send: `min(capital, debt_face)`. The contract caps it at `repay_for(all)`. */
  repay: bigint;
  /** Estimated seizure per token at mid prices; empty when skipped before the estimate. */
  seized: Record<TokenId, bigint>;
  skip: SkipReason | null;
};

export type ScanInput = {
  /** Block time of the scan's final block (ns). */
  nowNs: bigint;
  /** `Config.grace` (ns). */
  graceNs: bigint;
  loans: readonly LoanEntryView[];
  tokens: readonly CollateralToken[];
  debtFeedId: string;
  /** Validated prices by feed; null when the oracle call failed. */
  prices: ReadonlyMap<string, Price> | null;
  /** The keeper's USDC on intents.near. */
  capital: bigint;
  holds: Holds;
};

export type ScanResult = {
  /** Eligible loans in liquidation order. */
  eligible: Candidate[];
  /** Loans with debt that aren't overdue and whose health can't be computed (no price, unknown token). */
  unpriced: number;
};

export const loanKey = (account: AccountId, maturity: U64) => `${account}|${maturity}`;

/**
 * Loans whose liquidation failed, held until every feed they use has published a newer price
 * (D59): a new price is what changes the contract's verdict.
 */
export class Holds {
  private readonly held = new Map<string, Map<string, number>>();

  hold(account: AccountId, maturity: U64, publishTime: ReadonlyMap<string, number>): void {
    this.held.set(loanKey(account, maturity), new Map(publishTime));
  }

  /** Whether the loan is still held; a hold whose feeds all moved on is dropped. */
  isHeld(account: AccountId, maturity: U64, feeds: readonly string[], publishTime: ReadonlyMap<string, number>): boolean {
    const key = loanKey(account, maturity);
    const at = this.held.get(key);
    if (!at) return false;
    const used = new Map(feeds.map((feed) => [feed, at.get(feed) ?? -Infinity]));
    if (!allNewer(used, publishTime)) return true;
    this.held.delete(key);
    return false;
  }

  /** Drops holds of loans that are gone or have no debt left. */
  prune(loans: readonly LoanEntryView[]): void {
    const live = new Set(loans.filter((l) => BigInt(l.debt_face) > 0n).map((l) => loanKey(l.account_id, l.maturity)));
    for (const key of this.held.keys()) if (!live.has(key)) this.held.delete(key);
  }

  get size(): number {
    return this.held.size;
  }
}

/** The debt feed and the feed of every listed token the loan holds. */
export function feedsOf(loan: LoanEntryView, tokens: readonly CollateralToken[], debtFeedId: string): string[] {
  const feeds = new Set([debtFeedId]);
  for (const tokenId of Object.keys(loan.collateral)) {
    const token = tokens.find((t) => t.token_id === tokenId);
    if (token) feeds.add(token.feed_id);
  }
  return [...feeds];
}

export function scan(input: ScanInput, publishTime: ReadonlyMap<string, number>): ScanResult {
  const eligible: (Candidate & { index: number })[] = [];
  let unpriced = 0;
  input.loans.forEach((loan, index) => {
    const debt = BigInt(loan.debt_face);
    if (debt === 0n) return;
    const overdue = input.nowNs >= BigInt(loan.maturity) + input.graceNs;
    const at = threshold(loan, input);
    if (!overdue && at.health === null) {
      unpriced++;
      return;
    }
    if (!overdue && at.liquidatable === false) return;
    const candidate: Candidate & { index: number } = {
      account_id: loan.account_id,
      maturity: loan.maturity,
      reason: overdue ? "overdue" : "unhealthy",
      health: at.health,
      repay: debt < input.capital ? debt : input.capital,
      seized: {},
      skip: at.skip,
      index,
    };
    eligible.push(candidate);
    if (candidate.skip) return;
    if (input.holds.isHeld(loan.account_id, loan.maturity, feedsOf(loan, input.tokens, input.debtFeedId), publishTime)) {
      candidate.skip = "held";
    } else if (input.capital === 0n) {
      candidate.skip = "no_capital";
    } else {
      estimate(candidate, loan, input);
    }
  });
  eligible.sort(
    (a, b) =>
      Number(b.reason === "overdue") - Number(a.reason === "overdue") ||
      (a.health ?? Infinity) - (b.health ?? Infinity) ||
      a.index - b.index,
  );
  return { eligible: eligible.map(({ index: _, ...c }) => c), unpriced };
}

/** Health at `liq_threshold`, and whether that makes the loan liquidatable. */
function threshold(
  loan: LoanEntryView,
  input: ScanInput,
): { health: number | null; liquidatable: boolean | null; skip: SkipReason | null } {
  if (input.prices === null) return { health: null, liquidatable: null, skip: "no_price" };
  try {
    const v = valuation(loan.collateral, input.tokens, input.prices, input.debtFeedId, "liq_threshold");
    if (v === null) return { health: null, liquidatable: null, skip: "no_price" };
    const debt = BigInt(loan.debt_face);
    return { health: healthFactor(v.collateral, debt, v.debtPrice), liquidatable: !canOpen(v.collateral, debt, v.debtPrice), skip: null };
  } catch (error) {
    if (!(error instanceof MathError)) throw error;
    const skip = error.message === "Unknown collateral token" ? "unknown_token" : "math_overflow";
    return { health: null, liquidatable: null, skip };
  }
}

/** The seizure at mid prices, as the contract computes it, or the reason it would panic. */
function estimate(candidate: Candidate, loan: LoanEntryView, input: ScanInput): void {
  try {
    const v = valuation(loan.collateral, input.tokens, input.prices!, input.debtFeedId, "liq_bonus")!;
    const { seized } = seize(v.collateral, candidate.repay, v.debtPrice);
    v.tokenIds.forEach((tokenId, i) => {
      if (seized[i]! > 0n) candidate.seized[tokenId] = seized[i]!;
    });
    if (Object.keys(candidate.seized).length === 0) candidate.skip = "nothing_to_seize";
  } catch (error) {
    if (!(error instanceof MathError)) throw error;
    candidate.skip = "math_overflow";
  }
}
