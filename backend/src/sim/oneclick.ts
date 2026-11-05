// 1Click for the simulated chain (SOT/simulation.md, D71): quotes with a 0.1% fee, deposits that
// arrive in the simulated Intents balance, and withdrawals whose signed payload executes on the
// simulated `intents.near`. Deposit addresses are 64 hex characters: an implicit account on
// `intents.near`, and no address an EVM wallet can send to.
import { randomBytes } from "node:crypto";
import { type GeneratedIntent, type OneClickApi, OneClickError, type QuoteRequest, type QuoteResponse, type StatusResponse } from "../oneclick/client.ts";
import { failureOf } from "../relayer/outcome.ts";
import { type SignedErc191Payload, type SignedNep413Payload, versionedNonce } from "../shared/intents.ts";
import type { SimChain } from "./chain.ts";
import { INTENTS } from "./intents.ts";

/** Internal settings of the simulation. */
export const SIM_ONECLICK = { feeBps: 10n, arriveMs: 3_000, payoutMs: 3_000, intentDeadlineMs: 30 * 60_000 };

type Quoted = { request: QuoteRequest; amountIn: string; amountOut: string; status: StatusResponse };

export class SimOneClick implements OneClickApi {
  private readonly chain: SimChain;
  private readonly quotes = new Map<string, Quoted>();

  constructor(chain: SimChain) {
    this.chain = chain;
  }

  async quote(request: QuoteRequest): Promise<QuoteResponse> {
    const amount = BigInt(request.amount);
    const fee = (x: bigint) => (x * SIM_ONECLICK.feeBps + 9_999n) / 10_000n;
    const amountIn = request.swapType === "EXACT_OUTPUT" ? amount + fee(amount) : amount;
    const amountOut = request.swapType === "EXACT_OUTPUT" ? amount : amount - fee(amount);
    const quote = {
      amountIn: amountIn.toString(),
      minAmountIn: amount.toString(),
      amountOut: amountOut.toString(),
      minAmountOut: ((amountOut * 99n) / 100n).toString(),
      timeEstimate: 3,
    };
    if (request.dry) return { quote };
    const depositAddress = randomBytes(32).toString("hex");
    this.quotes.set(depositAddress, { request, amountIn: quote.amountIn, amountOut: quote.amountOut, status: { status: "PENDING_DEPOSIT" } });
    const deadline = new Date(Date.parse(request.deadline) + 3 * 86_400_000).toISOString();
    return { quote: { ...quote, depositAddress, deadline }, signature: "ed25519:simulated", correlationId: depositAddress.slice(0, 8) };
  }

  async generateIntent(request: { standard: "erc191" | "nep413"; signerId: string; depositAddress: string }): Promise<GeneratedIntent> {
    const quoted = this.get(request.depositAddress);
    const intents = [{ intent: "transfer", receiver_id: request.depositAddress, tokens: { [quoted.request.originAsset]: quoted.amountIn } }];
    const deadline = new Date(Date.now() + SIM_ONECLICK.intentDeadlineMs);
    const nonce = versionedNonce(this.chain.intents.st.salt, deadline);
    if (request.standard === "erc191") {
      return {
        standard: "erc191",
        payload: JSON.stringify({ signer_id: request.signerId, verifying_contract: INTENTS, deadline: deadline.toISOString(), nonce, intents }),
      };
    }
    return {
      standard: "nep413",
      payload: { message: JSON.stringify({ signer_id: request.signerId, deadline: deadline.toISOString(), intents }), nonce, recipient: INTENTS },
    };
  }

  async submitIntent(signed: SignedErc191Payload | SignedNep413Payload): Promise<{ intentHash: string }> {
    const outcome = await this.chain.relay([signed]);
    const failure = outcome.receipts[0] ? failureOf(outcome.receipts[0]) : "no receipts";
    if (failure !== null) throw new OneClickError("rejected", `simulated intents.near refused the withdrawal: ${failure}`, 400);
    const address = this.addressOf(signed);
    const quoted = address ? this.quotes.get(address) : undefined;
    if (quoted) {
      quoted.status = { status: "PROCESSING", swapDetails: { intentHashes: [outcome.hash], nearTxHashes: [outcome.hash] } };
      setTimeout(() => {
        quoted.status = {
          status: "SUCCESS",
          swapDetails: {
            intentHashes: [outcome.hash],
            nearTxHashes: [outcome.hash],
            amountIn: quoted.amountIn,
            amountOut: quoted.amountOut,
            destinationChainTxHashes: [{ hash: `0x${randomBytes(32).toString("hex")}` }],
          },
        };
      }, SIM_ONECLICK.payoutMs).unref();
    }
    return { intentHash: outcome.hash };
  }

  async submitDeposit(depositAddress: string, txHash: string): Promise<void> {
    const quoted = this.get(depositAddress);
    if (quoted.status.status !== "PENDING_DEPOSIT") return;
    quoted.status = { status: "KNOWN_DEPOSIT_TX", swapDetails: { originChainTxHashes: [{ hash: txHash }] } };
    setTimeout(() => void this.arrive(depositAddress), SIM_ONECLICK.arriveMs).unref();
  }

  /** Makes a deposit arrive: the recipient's Intents balance gets `amountOut`. */
  async arrive(depositAddress: string): Promise<void> {
    const quoted = this.get(depositAddress);
    if (quoted.request.recipientType !== "INTENTS" || quoted.status.status === "SUCCESS") return;
    await this.chain.faucet(quoted.request.recipient, quoted.request.destinationAsset, BigInt(quoted.amountOut));
    const origin = quoted.status.swapDetails?.originChainTxHashes ?? [];
    quoted.status = { status: "SUCCESS", swapDetails: { amountIn: quoted.amountIn, amountOut: quoted.amountOut, originChainTxHashes: origin } };
  }

  async status(depositAddress: string): Promise<StatusResponse> {
    return this.get(depositAddress).status;
  }

  private get(depositAddress: string): Quoted {
    const quoted = this.quotes.get(depositAddress);
    if (!quoted) throw new OneClickError("rejected", "Unknown deposit address", 404);
    return quoted;
  }

  /** The deposit address a signed withdrawal pays. */
  private addressOf(signed: SignedErc191Payload | SignedNep413Payload): string | undefined {
    const inner = JSON.parse(signed.standard === "erc191" ? signed.payload : signed.payload.message) as { intents?: { receiver_id?: string }[] };
    return inner.intents?.[0]?.receiver_id;
  }
}
