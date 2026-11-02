//! Helpers shared by the sandbox tests in `tests/`.

use std::path::Path;

/// Builds the Setllend contract with `cargo-near` and returns the wasm.
pub async fn setllend_wasm() -> anyhow::Result<Vec<u8>> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../setllend");
    Ok(near_workspaces::compile_project(path.to_str().unwrap()).await?)
}

/// Init args with the approved risk parameters (`SOT/risk-params.md`).
pub fn default_config(owner_id: &str) -> serde_json::Value {
    serde_json::json!({
        "owner_id": owner_id,
        "intents_contract": "intents.near",
        "oracle_contract": "aggregate-oracle.near",
        "debt_token": "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
        "debt_feed_id": "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
        "collateral_tokens": [
            {
                "token_id": "nep141:arb.omft.near",
                "decimals": 18,
                "feed_id": "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace"
            },
            {
                "token_id": "nep141:base.omft.near",
                "decimals": 18,
                "feed_id": "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace"
            }
        ],
        "max_ltv": 7000,
        "liq_threshold": 8000,
        "liq_bonus": 500,
        "grace": "3600000000000",
        "oracle_max_age": 60,
        "oracle_max_conf": 100
    })
}
