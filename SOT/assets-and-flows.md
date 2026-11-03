# Assets and money flows

## Asset IDs (from 1Click `GET /v0/tokens`, rechecked ✅ 2026-11-02)

| Asset | Chain | Decimals | Intents asset ID | Role |
|---|---|---|---|---|
| USDC | NEAR (native) | 6 | `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` | **Canonical debt asset** (D3) |
| USDC | Base | 6 | `nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near` | Converted to NEAR USDC |
| USDC | Arbitrum | 6 | `nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near` | Converted to NEAR USDC |
| ETH | Arbitrum | 18 | `nep141:arb.omft.near` | Collateral |
| ETH | Base | 18 | `nep141:base.omft.near` | Collateral |

Collateral added by D48 and D52 (in the contract since contract-interface v0.6; the owner adds each token after deploy, D53), from 1Click `GET /v0/tokens` and keyed dry quotes ✅ 2026-11-03:

| Asset | Chain | Decimals | Intents asset ID | How it arrives |
|---|---|---|---|---|
| BTC | Bitcoin | 8 | `nep141:btc.omft.near` | 1Click deposit from the Bitcoin network: 0.0001 BTC in, 0.00009996 BTC out, about 805 s |
| NEAR | NEAR | 24 | `nep141:wrap.near` | From a NEAR wallet (D51), or a 1Click swap: 5 USDC from Arbitrum → 1.2708 NEAR (about 25 s), from Base → 1.2724 NEAR (about 35 s) |

1Click lists no BTC asset on Arbitrum (ARB, ETH, GMX, SWEAT, USDC, USDT0, WETH) and only cbBTC on Base (`nep141:base-0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf.omft.near`, deposit quoted ✅); cbBTC is not used because no oracle feed prices it (D52). Requests to 1Click from scripts need a `User-Agent` header, or Cloudflare answers 403 (error 1010).

Deposits from NEAR (D51): NEAR goes through `wrap.near` (`near_deposit`, then `ft_transfer_call` to `intents.near`, both in one transaction), native USDC through `ft_transfer_call` on its token contract. `msg` is the receiving Intents account ID; empty credits the sender 📄 (near/intents `d340060`, `ft_on_transfer`). Not tested by us ⚠️ ([open-questions.md](open-questions.md) #9).

`mt_on_transfer` receives these IDs as-is in `token_ids` (e.g. `nep141:arb.omft.near`) 📄. Seen from outside Intents, the same balance is the NEP-245 token `<asset_id>` on `intents.near` (sometimes written `nep245:intents.near:<asset_id>`), but our contract only deals with the bare asset ID. Fetch the latest IDs from `/v0/tokens` before deploying. Don't hardcode from memory.

## Demo money paths (dry quotes, $20, no API key, 2026-11-01) ✅

| Path | Result | Est. time |
|---|---|---|
| Lender: 20 USDC Base (wallet) → NEAR USDC in Intents | 19.998285 USDC | about 35 s |
| Payout: 20 NEAR USDC in Intents → Arbitrum USDC (wallet) | 19.992215 USDC | about 9 s |
| Collateral: 0.01 ETH Arbitrum (wallet) → ETH(arb) in Intents | 0.01 ETH (no fee) | about 25 s |
| Control, origin → origin: 20 USDC Base → Arbitrum USDC | 19.992938 USDC | about 34 s |

The temporary $1,000 minimum (changelog 2026-09-09) does not block these paths: the changelog says deposits to and withdrawals from Intents are unaffected, and the $20 quotes succeeded.

## Keyed dry quotes (2026-11-03) ✅

With the partner key (`X-API-Key`), `EXACT_INPUT`, slippage 1%, at 06:40 UTC. Deposits: `recipientType: INTENTS` to the user's lowercase implicit Eth account, refund to the wallet on the origin chain. Payouts: `depositType: INTENTS` and `refundType: INTENTS` to the same lowercase account, recipient is the wallet on the destination chain. Address casing rules: [pitfalls.md](pitfalls.md#off-chain).

| Path | In | Out | `withdrawFee` | Est. time |
|---|---|---|---|---|
| Deposit: Base USDC → NEAR USDC in Intents | 5 USDC | 4.999585 USDC | 0 | about 35 s |
| Deposit: Arbitrum USDC → NEAR USDC in Intents | 5 USDC | 4.999553 USDC | 0 | about 25 s |
| Deposit: Arbitrum ETH → ETH(arb) in Intents | 0.01 ETH | 0.01 ETH | 0 | about 25 s |
| Payout: NEAR USDC in Intents → Base USDC | 5 USDC | 4.99659 USDC | 0.0024 USDC | about 12 s |
| Payout: NEAR USDC in Intents → Arbitrum USDC | 5 USDC | 4.993868 USDC | 0.0053 USDC | about 9 s |
| Payout: ETH(arb) in Intents → Base ETH | 0.01 ETH | 0.00999742 ETH | 0.00000056 ETH | about 12 s |

Arbitrum ETH → Base ETH (origin → origin) also quoted with and without the key, same output.

## Real-funds test (2026-11-03) ✅

Closes D31 and open question #1. Run with $1 from a test EOA, partner key, `EXACT_INPUT`, slippage 1%.

| Leg | In | Out | Fee | Time |
|---|---|---|---|---|
| Deposit: Arbitrum USDC (wallet) → NEAR USDC in Intents | 1 USDC | 0.999799 USDC | none charged | `SUCCESS` about 1 min after the Arbitrum transfer |
| Payout: NEAR USDC in Intents → Arbitrum USDC (wallet) | 0.999799 USDC | 0.994297 USDC | `withdrawFee` 0.0053 USDC | `SUCCESS` about 15 s after `submit-intent` |

Both legs checked on-chain: `mt_balance_of` on `intents.near` showed 999799 after the deposit and 0 after the payout, and the Arbitrum receipt shows the USDC transfer to the wallet. $1 is above any minimum on these routes.

Payout path as it ran:

1. `POST /v0/quote` with `dry: false`, `depositType: INTENTS`, `refundType: INTENTS`, `refundTo` = lowercase Intents account, `recipientType: DESTINATION_CHAIN`. The `depositAddress` is a 64-hex implicit NEAR account, not an EVM address.
2. `POST /v0/generate-intent` with `type: swap_transfer`, `standard: erc191`, `signerId` = lowercase Intents account. **Accepted our key** (201). The payload is a JSON string with `verifying_contract: intents.near`, a 1Click-supplied `nonce`, `deadline` = the quote deadline, and one plain `transfer` intent of the full amount to the `depositAddress` (no `token_diff`).
3. The user signs the payload string unchanged with `personal_sign`.
4. `POST /v0/submit-intent` with `signedData: { standard: "erc191", payload, signature }`. `signature` is `secp256k1:` + base58 of the 65 bytes `r ‖ s ‖ v`, with `v` normalized from 27/28 to 0/1. No `public_key` field. Returns `intentHash`. Track with `GET /v0/status?depositAddress=…`, as with any swap.

## 1Click notes

- Since 2026-10-27 all 1Click swaps are confidential (settled on the NEAR Private Shard). `recipientType: INTENTS` still lands in the **public** `intents.near` balance that the contract can use.
- `POST /v0/generate-intent` and `POST /v0/submit-intent` (used for payouts from an Intents balance) **require a partner API key** 📄, and accept ours ✅ 2026-11-03 ([real-funds test](#real-funds-test-2026-11-03-)).
- Swap statuses: `PENDING_DEPOSIT`, `KNOWN_DEPOSIT_TX`, `PROCESSING`, `SUCCESS`, `INCOMPLETE_DEPOSIT`, `REFUNDED`, `FAILED`. Show all of them in the UI, including `REFUNDED` and `FAILED`.
- For same-asset withdrawals without a swap, the Intents SDK has `processWithdrawal` via bridge (Omni / PoA, both support Base and Arbitrum). This is the 1Click-independent exit path for ETH collateral, and for BTC (`btc.omft.near`, a PoA token) to a Bitcoin address (D52, not tested by us ⚠️, [open-questions.md](open-questions.md) #10). It does not cover native NEAR USDC, which has no same-asset route to Base/Arbitrum (D10).
- Partner key (type "Distribution Channel") obtained 2026-11-02. Stored only in backend env as `ONE_CLICK_JWT`, sent as `X-API-Key: <key>` (recommended; `Authorization: Bearer` is the legacy form and also works). Never in the frontend or git.
- The Explorer API (`explorer.near-intents.org/api/v0`) needs a separate key with `key_type: explorer`. Our distribution-channel key gets 400 `INVALID_TOKEN` there ✅ 2026-11-02. Not needed for the MVP: track our swaps with `GET /v0/status`.
- Solver Relay `quote` (`POST https://solver-relay-v2.chaindefuser.com/rpc`) returned prices for Base USDC → NEAR USDC and Arbitrum USDC → NEAR USDC on 2026-11-02, with and without a key ✅. This is the D10 fallback route if 1Click quoting stays down.

## 1Click fees

Checked 2026-11-02 against the [Fees page](https://docs.near-intents.org/resources/fees.md) 📄. Charged on top of the 1 pip protocol fee. Not applied to `ANY_INPUT` quotes.

| Case | Fee |
|---|---|
| No API key | +0.25% (25 bps) on every non-`ANY_INPUT` quote |
| API key, no `appFees` | 0.20% (20 bps). **0.01% (1 bp) for stablecoin pairs (USDC, USDT, DAI) and same-asset multichain routes** |
| API key + `appFees` | Split 50/50. 1Click keeps at least 20 bps (or 1 bp on stablecoin/same-asset routes) |

All Setllend paths (USDC Base/Arb ↔ NEAR USDC, ETH chain → ETH in Intents) are stablecoin or same-asset routes, so with the key they cost about 0.01% instead of 0.25%.

⚠️ Docs are inconsistent: the 1Click overview page mentions 0.1% and older pages 0.2% for the no-key fee. The Fees and Authentication pages (25 bps) are treated as authoritative.
