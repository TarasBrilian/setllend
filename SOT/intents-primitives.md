# NEAR Intents primitives

Tested 2026-11-01 with `simulate_intents` on mainnet `intents.near` using a throwaway keypair. View call, free, no state change.

| Primitive | Mainnet status | Role in Setllend |
|---|---|---|
| `transfer` + `msg` (`NotifyOnTransfer`) | ✅ accepted | Triggers `mt_on_transfer(sender_id, previous_owner_ids, token_ids, amounts, msg)` on our contract. **Deposit and place an order atomically.** If the contract returns a refund amount, funds go back to the user's Intents balance (`nep245/resolver.rs`) |
| `auth_call` | ✅ live | `intents.near` calls `on_auth(signer_id, msg)` on our contract. Used for cancel, withdraw, and actions without token movement |
| `set_auth_by_predecessor_id` | ✅ live | Enabled by default for new accounts: our contract can call `mt_transfer` / `ft_withdraw` on `intents.near` for its own balance |
| `token_diff` | 📄 docs + source | Atomic multi-party swap. Not needed in the MVP: notes are internal positions, so note sales settle inside our contract. Relevant only for a Solver Relay fallback (D10) |
| `imt_mint` / `imt_burn` | ❌ **not deployed** (`unknown variant`) | Not used |
| `ft_withdraw` + `msg` to a contract | ⚠️ **do not use** | Docs: if it fails, funds are **not refunded** |

## Details

- **Signatures supported by the Verifier:** NEP-413 (NEAR wallets), ERC-191 (EVM EOA wallets: MetaMask, Rabby, …), TIP-191 (Tron), raw Ed25519 (Phantom), WebAuthn (passkeys), TonConnect, SEP-53 (Stellar). For ERC-191, normalize the recovery byte `v` to {0, 1}.
- **Cross-chain identity:** an EVM wallet address becomes an *implicit Eth* account (`0x…`) on `intents.near` with no registration. Setllend orders, loans, and notes are keyed to the same account ID. A NEAR user is their own NEAR account and signs with NEP-413 after registering a key (D51).
- **Nonce:** must use the *versioned* format (legacy will be banned): `5628f6c6` (magic) + `00` (version) + 4-byte salt + 8-byte LE deadline in nanoseconds + 15 random bytes. Salt was `252812b3` on 2026-11-01. Always fetch it from the `current_salt` view, since it can rotate.
- **Protocol fee:** 1 pip (0.0001%) per transaction. The "Simulating Intents" page that says 100 pips is outdated.
- **Ordering:** intents in one batch execute in order, but the cross-contract promises they spawn run concurrently. Don't rely on completion order.
- **Events:** DIP-4 (version 0.4.3 on mainnet), e.g. `intents_executed`, `token_diff`, `mt_transfer`. Usable by the matcher's indexer.
- **Simulation:** `simulate_intents` takes the same input as `execute_intents`. The relayer should simulate before submitting.

## Payload format

Read from near/intents source (`contracts/defuse/core`, commit `d340060`) 📄 on 2026-11-03, and checked with `simulate_intents` on mainnet ✅ 2026-11-03 (a throwaway key; an `auth_call` payload executed, a `transfer` failed only on the empty balance). Built by `backend/src/shared/intents.ts`.

- **Payload** (the string signed with ERC-191): `{"signer_id", "verifying_contract": "intents.near", "deadline", "nonce", "intents": [...]}`. `deadline` is RFC 3339 (`Date.toISOString()` works) and must not be later than the nonce's own deadline. `nonce` is base64 of the 32-byte versioned nonce above (the version byte is the borsh enum index, `00` for V1).
- **`transfer`:** `{"intent": "transfer", "receiver_id", "tokens": {"<asset id>": "<amount>"}, "msg", "min_gas"}`. `msg` and `min_gas` are flattened from the notification. `min_gas` defaults to 30 Tgas, minimum 5 Tgas.
- **`auth_call`:** `{"intent": "auth_call", "contract_id", "msg", "attached_deposit", "min_gas"}`. `attached_deposit` is omitted when 0, `min_gas` defaults to 10 Tgas.
- **Gas** is a decimal string of gas units (`"100000000000000"` = 100 Tgas), like `NearGas` in `near-sdk`.
- **`execute_intents` / `simulate_intents`** take `{"signed": [<MultiPayload>]}`. For ERC-191: `{"standard": "erc191", "payload": "<the signed string>", "signature": "secp256k1:<base58 of r ‖ s ‖ v>"}`, `v` normalized to 0 or 1, no public key.
- **NEP-413** (for a NEAR account such as the backend's): `{"standard": "nep413", "payload": {"message", "nonce", "recipient": "intents.near"}, "public_key", "signature"}`, where `message` is `{"signer_id", "deadline", "intents"}` and the nonce sits in the NEP-413 payload. The key signs the SHA-256 of the NEP-413 tag `2^31 + 413` (u32 LE) followed by the borsh payload (`message`, the 32 nonce bytes, `recipient`, no callback URL) 📄 (NEP-413 standard); a wallet's `signMessage` does this itself. Built by `buildNep413Payload` and `nep413Hash` in `backend/src/shared/intents.ts`. Envelope and hash ✅ 2026-11-03 with `simulate_intents` on mainnet: a throwaway ed25519 key signing as its own implicit account (64 hex characters) had an `auth_call` executed without any `add_public_key`, and the same payload with one signature bit flipped failed with `invalid signature`. A named account must first register its key with `add_public_key` on `intents.near`; that step is not tested yet ⚠️ ([open-questions.md](open-questions.md) #7).
- **Failed receipts keep their logs** ⚠️ (nearcore behaviour as we understand it, not tested by us). A receipt that panics after `log_str` still lists those logs in its outcome, so an indexer reads events only from receipts whose status is a success. The rule is correct either way.
