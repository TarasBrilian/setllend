# NEAR Intents primitives

Tested 2026-11-01 with `simulate_intents` on mainnet `intents.near` using a throwaway keypair. View call, free, no state change.

| Primitive | Mainnet status | Role in Setllend |
|---|---|---|
| `transfer` + `msg` (`NotifyOnTransfer`) | ✅ accepted | Triggers `mt_on_transfer(sender_id, previous_owner_ids, token_ids, amounts, msg)` on our contract. **Deposit and place an order atomically.** If the contract returns a refund amount, funds go back to the user's Intents balance (`nep245/resolver.rs`) |
| `auth_call` | ✅ live | `intents.near` calls `on_auth(signer_id, msg)` on our contract. Used for cancel, withdraw, and actions without token movement |
| `set_auth_by_predecessor_id` | ✅ live | Enabled by default for new accounts: our contract can call `mt_transfer` / `ft_withdraw` on `intents.near` for its own balance |
| `token_diff` | 📄 docs + source | Atomic multi-party swap. Option for secondary-market settlement |
| `imt_mint` / `imt_burn` | ❌ **not deployed** (`unknown variant`) | Not used |
| `ft_withdraw` + `msg` to a contract | ⚠️ **do not use** | Docs: if it fails, funds are **not refunded** |

## Details

- **Signatures supported by the Verifier:** NEP-413 (NEAR wallets), ERC-191 (EVM EOA wallets: MetaMask, Rabby, …), TIP-191 (Tron), raw Ed25519 (Phantom), WebAuthn (passkeys), TonConnect, SEP-53 (Stellar). For ERC-191, normalize the recovery byte `v` to {0, 1}.
- **Cross-chain identity:** an EVM wallet address becomes an *implicit Eth* account (`0x…`) on `intents.near` with no registration. Setllend positions are keyed to the same account ID.
- **Nonce:** must use the *versioned* format (legacy will be banned): `5628f6c6` (magic) + `00` (version) + 4-byte salt + 8-byte LE deadline in nanoseconds + 15 random bytes. Salt was `252812b3` on 2026-11-01. Always fetch it from the `current_salt` view, since it can rotate.
- **Protocol fee:** 1 pip (0.0001%) per transaction. The "Simulating Intents" page that says 100 pips is outdated.
- **Ordering:** intents in one batch execute in order, but the cross-contract promises they spawn run concurrently. Don't rely on completion order.
- **Events:** DIP-4 (version 0.4.3 on mainnet), e.g. `intents_executed`, `token_diff`, `mt_transfer`. Usable by the matcher's indexer.
- **Simulation:** `simulate_intents` takes the same input as `execute_intents`. The relayer should simulate before submitting.
