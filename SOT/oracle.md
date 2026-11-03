# Oracle

## On-chain survey (2026-11-01)

| Contract | Status | Conclusion |
|---|---|---|
| **`aggregate-oracle.near`** | ✅ ETH/USD 29 s old, USDC/USD 43 s old. `report_pyth_pro_prices` about every 20 s | **Used** (D5) |
| `pyth-oracle.near` | ❌ ETH/USD last published about 90 days ago. Last update 2026-08-26 | Dead since Hermes requires an API key |
| `priceoracle.near` (old Burrow) | ❌ All prices `null`, last reporter active March 2026 | Dead. Rhea disabled it (`enable_price_oracle: false`) |
| `price-oracle.near` (OutLayer) | ❌ Prices `null`, last report June 2026 | On-demand (`request_price_data`), not fresh |
| `switchboard-v2.near`, `oracle.near` | ❌ No prices via a known interface | – |

Public Hermes (`hermes.pyth.network`) now returns `401 unauthorized` without an API key. The cutover finished 2026-08-26, the same day as the last `pyth-oracle.near` update. Pyth Core keys are a free trial then paid, so Pyth directly is not used as a fallback.

## `aggregate-oracle.near`

- **Used by Rhea Lend:** config of `contract.main.burrow.near` → `pyth_oracle_account_id: "aggregate-oracle.near"`, `enable_pyth_oracle: true`. Rhea holds about 99% of the value secured by Pyth on NEAR (about $86M per DefiLlama).
- **Pyth-compatible interface, Pyth feed IDs:**

  ```
  list_prices_no_older_than({ "price_ids": [ETH_USD, USDC_USD], "age": 60 })
  → { "<feed_id>": { "price": "226333103391", "conf": "212896609", "expo": -8, "publish_time": 1793517540 } }
  ```

  Other live methods: `get_price({price_identifier})`, `get_price_no_older_than({price_id, age})`, `list_prices({price_ids})`. No EMA method.
- **Stale price → `null`** (tested with `age: 1`). The contract must handle `Option`.
- **Feeds:**
  - ETH/USD: `ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace` (for both ETH(arb) and ETH(base))
  - USDC/USD: `eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a`
- **Data source:** report payloads use the Pyth Pro/Lazer format (magic `75d3c793`, 64-byte ed25519 signature, 32-byte signer public key). Events show aggregation from `pyth_pro`, `outlayer`, `atlas`, and `generic` sources.

## Risks (disclose in the submission README)

1. Operated by Rhea. The source repo in NEP-330 metadata (`rhea-finance/agg-oracle`) is **private**, and Rhea can upgrade the contract.
2. A single reporter key submits reports. Payloads are Pyth-signed, but without source we can't confirm the contract verifies them.
3. No `aggregate-oracle.testnet`. Tests use a mock oracle with the same interface in the sandbox.
4. No EMA. Guard with `conf / price` (e.g. reject above 1%) and a 60 s max age.

## Integration pattern in the contract

Reading another contract on NEAR is async. Follow Rhea's pattern: action → promise to oracle → callback.

- Actions that need a price: `match_orders`, `liquidate`, withdrawing collateral while a loan is open.
- One `list_prices_no_older_than` call per action, for the debt feed and every collateral feed, with `age = oracle_max_age` ✅ implemented 2026-11-03. The callback validates each price again (positive, `conf / price`, and `publish_time` within the max age of the block time, in either direction), since the oracle's source is private (D39).
- Sandbox tests use `contracts/mocks/oracle` (`mock-oracle`): the same method and JSON shape, `null` for a feed older than `age`, and a setter for prices and publish times.
- **The callback must re-validate state**, because an order can be cancelled between the oracle call and the callback. Alternatively, lock the order with a `pending` status while the promise is in flight.
- If the oracle returns `null`: new loans, liquidations (including post-maturity settlement), and collateral withdrawals with open debt stop on their own. Repay, cancel, redeem, note sales, collateral withdrawal without debt, and free-balance withdrawals keep working. No admin pause.
