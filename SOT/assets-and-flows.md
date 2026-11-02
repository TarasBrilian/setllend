# Assets and money flows

## Asset IDs (from 1Click `GET /v0/tokens`)

| Asset | Chain | Decimals | Intents asset ID | Role |
|---|---|---|---|---|
| USDC | NEAR (native) | 6 | `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` | **Canonical debt asset** (D3) |
| USDC | Base | 6 | `nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near` | Converted to NEAR USDC |
| USDC | Arbitrum | 6 | `nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near` | Converted to NEAR USDC |
| ETH | Arbitrum | 18 | `nep141:arb.omft.near` | Collateral |
| ETH | Base | 18 | `nep141:base.omft.near` | Collateral |

`mt_on_transfer` receives these IDs as-is in `token_ids` (e.g. `nep141:arb.omft.near`) 📄. Seen from outside Intents, the same balance is the NEP-245 token `<asset_id>` on `intents.near` (sometimes written `nep245:intents.near:<asset_id>`), but our contract only deals with the bare asset ID. Fetch the latest IDs from `/v0/tokens` before deploying. Don't hardcode from memory.

## Demo money paths (dry quotes, $20, no API key, 2026-11-01) ✅

| Path | Result | Est. time |
|---|---|---|
| Lender: 20 USDC Base (wallet) → NEAR USDC in Intents | 19.998285 USDC | about 35 s |
| Payout: 20 NEAR USDC in Intents → Arbitrum USDC (wallet) | 19.992215 USDC | about 9 s |
| Collateral: 0.01 ETH Arbitrum (wallet) → ETH(arb) in Intents | 0.01 ETH (no fee) | about 25 s |
| Control, origin → origin: 20 USDC Base → Arbitrum USDC | 19.992938 USDC | about 34 s |

The temporary $1,000 minimum (changelog 2026-09-09) does not block these paths: the changelog says deposits to and withdrawals from Intents are unaffected, and the $20 quotes succeeded.

## 1Click notes

- Since 2026-10-27 all 1Click swaps are confidential (settled on the NEAR Private Shard). `recipientType: INTENTS` still lands in the **public** `intents.near` balance that the contract can use.
- `POST /v0/generate-intent` and `POST /v0/submit-intent` (used for payouts from an Intents balance) **require a partner API key**. 📄
- Swap statuses: `PENDING_DEPOSIT`, `KNOWN_DEPOSIT_TX`, `PROCESSING`, `SUCCESS`, `INCOMPLETE_DEPOSIT`, `REFUNDED`, `FAILED`. Show all of them in the UI, including `REFUNDED` and `FAILED`.
- For same-asset withdrawals without a swap, the Intents SDK has `processWithdrawal` via bridge (Omni / PoA, both support Base and Arbitrum). This is the 1Click-independent exit path for ETH collateral. It does not cover native NEAR USDC, which has no same-asset route to Base/Arbitrum (D10).
- Partner key (type "Distribution Channel") obtained 2026-11-02. Stored only in backend env as `ONE_CLICK_JWT`, sent as `Authorization: Bearer <key>`. Never in the frontend or git.

## 1Click fees

Checked 2026-11-02 against the [Fees page](https://docs.near-intents.org/resources/fees.md) 📄. Charged on top of the 1 pip protocol fee. Not applied to `ANY_INPUT` quotes.

| Case | Fee |
|---|---|
| No API key | +0.25% (25 bps) on every non-`ANY_INPUT` quote |
| API key, no `appFees` | 0.20% (20 bps). **0.01% (1 bp) for stablecoin pairs (USDC, USDT, DAI) and same-asset multichain routes** |
| API key + `appFees` | Split 50/50. 1Click keeps at least 20 bps (or 1 bp on stablecoin/same-asset routes) |

All Setllend paths (USDC Base/Arb ↔ NEAR USDC, ETH chain → ETH in Intents) are stablecoin or same-asset routes, so with the key they cost about 0.01% instead of 0.25%.

⚠️ Docs are inconsistent: the 1Click overview page mentions 0.1% and older pages 0.2% for the no-key fee. The Fees and Authentication pages (25 bps) are treated as authoritative.
