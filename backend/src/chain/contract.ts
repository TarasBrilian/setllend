// Typed views of the Setllend contract, intents.near, and the oracle (SOT/contract-interface.md#views).
// Paged views are read to the end in pages of 100, all at one block height.
import type { AccountId, TokenId, U128, U64 } from "../shared/encoding.ts";
import type {
  AccountLoanView,
  CollateralToken,
  Config,
  FreeBalancesView,
  LoanEntryView,
  NotesView,
  OracleResponse,
  OrderView,
  PoolView,
} from "../shared/views.ts";
import type { Rpc } from "./rpc.ts";

/** Page size of `get_orders` and `get_loans` (SOT/backend.md#book). Internal. */
export const PAGE = 100;

export class Contract {
  readonly rpc: Rpc;
  readonly id: AccountId;
  readonly intents: AccountId;

  constructor(rpc: Rpc, id: AccountId, intents: AccountId = "intents.near") {
    this.rpc = rpc;
    this.id = id;
    this.intents = intents;
  }

  private view<T>(method: string, args: Record<string, unknown> = {}, height?: number): Promise<T> {
    return this.rpc.view<T>(this.id, method, args, height);
  }

  config(height?: number) {
    return this.view<Config>("get_config", {}, height);
  }

  maturities(height?: number) {
    return this.view<U64[]>("get_maturities", {}, height);
  }

  collateralTokens(height?: number) {
    return this.view<CollateralToken[]>("get_collateral_tokens", {}, height);
  }

  pool(maturity: U64, height?: number) {
    return this.view<PoolView | null>("get_pool", { maturity }, height);
  }

  /** Every order of a maturity, in index order (D38). */
  async orders(maturity: U64, height: number): Promise<OrderView[]> {
    const count = await this.view<number>("get_order_count", { maturity }, height);
    const orders: OrderView[] = [];
    for (let from = 0; from < count; from += PAGE) {
      orders.push(...(await this.view<OrderView[]>("get_orders", { maturity, from_index: from, limit: PAGE }, height)));
    }
    return orders;
  }

  /** Every loan of every account, in index order (D45). */
  async loans(height: number): Promise<LoanEntryView[]> {
    const count = await this.view<number>("get_loan_count", {}, height);
    const loans: LoanEntryView[] = [];
    for (let from = 0; from < count; from += PAGE) {
      loans.push(...(await this.view<LoanEntryView[]>("get_loans", { from_index: from, limit: PAGE }, height)));
    }
    return loans;
  }

  ordersOf(account: AccountId) {
    return this.view<OrderView[]>("get_orders_by_account", { account_id: account });
  }

  loansOf(account: AccountId) {
    return this.view<AccountLoanView[]>("get_loans_by_account", { account_id: account });
  }

  notesOf(account: AccountId) {
    return this.view<NotesView>("get_notes", { account_id: account });
  }

  freeBalancesOf(account: AccountId) {
    return this.view<FreeBalancesView>("get_free_balances", { account_id: account });
  }

  /** The account's Intents balance per token (`mt_batch_balance_of` on intents.near). */
  async intentsBalances(account: AccountId, tokens: TokenId[]): Promise<Record<TokenId, U128>> {
    const amounts = await this.rpc.view<U128[]>(this.intents, "mt_batch_balance_of", { account_id: account, token_ids: tokens });
    return Object.fromEntries(tokens.map((token, i) => [token, amounts[i] ?? "0"]));
  }

  currentSalt() {
    return this.rpc.view<string>(this.intents, "current_salt", {});
  }

  /** The oracle call the contract makes, with its `age` (D41, D44). */
  prices(config: Config, feedIds: string[]) {
    return this.rpc.view<OracleResponse>(config.oracle_contract, "list_prices_no_older_than", {
      price_ids: feedIds,
      age: config.oracle_max_age,
    });
  }
}
