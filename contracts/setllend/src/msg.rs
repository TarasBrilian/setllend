//! `msg` payloads, tagged like the official `escrow-swap` contract:
//! `{"action": "<snake_case>", "data": {…}}`. `backend/src/shared/` mirrors these exactly.

use near_sdk::json_types::{U64, U128};
use near_sdk::{AccountId, near};

/// `msg` of a `transfer` intent, delivered to `mt_on_transfer`.
#[near(serializers = [json])]
#[serde(tag = "action", content = "data", rename_all = "snake_case")]
#[derive(Clone, Debug, PartialEq)]
pub enum TransferMsg {
    Lend(LendMsg),
    Borrow(BorrowMsg),
    Repay(RepayMsg),
    Liquidate(LiquidateMsg),
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct LendMsg {
    pub maturity: U64,
    pub min_rate_bps: u32,
    pub expires_at: Option<U64>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct BorrowMsg {
    pub maturity: U64,
    pub max_rate_bps: u32,
    /// USDC to receive.
    pub principal: U128,
    pub expires_at: Option<U64>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct RepayMsg {
    pub maturity: U64,
    pub collateral_token: String,
    /// Defaults to `sender_id`. Anyone may repay for someone else.
    pub borrower: Option<AccountId>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct LiquidateMsg {
    pub borrower: AccountId,
    pub maturity: U64,
    pub collateral_token: String,
}

/// `msg` of an `auth_call` intent, delivered to `on_auth`.
#[near(serializers = [json])]
#[serde(tag = "action", content = "data", rename_all = "snake_case")]
#[derive(Clone, Debug, PartialEq)]
pub enum AuthMsg {
    Cancel(CancelMsg),
    SellNote(SellNoteMsg),
    WithdrawCollateral(WithdrawCollateralMsg),
    Redeem(RedeemMsg),
    Withdraw(WithdrawMsg),
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct CancelMsg {
    pub order_id: U64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SellNoteMsg {
    pub maturity: U64,
    /// Note value to sell, converted to shares at placement.
    pub value: U128,
    pub max_rate_bps: u32,
    pub expires_at: Option<U64>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct WithdrawCollateralMsg {
    pub maturity: U64,
    pub collateral_token: String,
    pub amount: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct RedeemMsg {
    pub maturity: U64,
    /// `null` = all free shares.
    pub value: Option<U128>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct WithdrawMsg {
    pub token_id: String,
    /// `null` = all.
    pub amount: Option<U128>,
}
