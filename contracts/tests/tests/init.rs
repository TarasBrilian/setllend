use serde_json::json;
use setllend_tests::{default_config, setllend_wasm};

#[tokio::test]
async fn deploy_and_init() -> anyhow::Result<()> {
    let sandbox = near_workspaces::sandbox().await?;
    let contract = sandbox.dev_deploy(&setllend_wasm().await?).await?;
    let config = default_config(contract.id().as_str(), "intents.near");

    contract
        .call("new")
        .args_json(json!({ "config": config }))
        .transact()
        .await?
        .into_result()?;

    let stored: serde_json::Value = contract.view("get_config").await?.json()?;
    assert_eq!(stored, config);
    Ok(())
}
