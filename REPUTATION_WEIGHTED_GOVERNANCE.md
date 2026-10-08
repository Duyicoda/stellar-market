# Reputation-Weighted On-Chain Governance (issue #899)

Adds a stakeholder-weighted voting path for changing **protocol parameters**
(`SetFeeBps`, `SetTreasury`) to the escrow contract, running **in parallel** to —
not replacing — the existing fixed multisig.

- Contract logic: `contracts/escrow/src/governance.rs` (+ small hooks in `contracts/escrow/src/lib.rs`)
- Reputation cross-call: `get_gov_weight` in `contracts/reputation/src/lib.rs`
- Tests: `contracts/escrow/src/governance_test.rs`, plus reputation unit tests

## Design decisions

### 1. Separation of powers (explicit, enforced both ways)

Admin actions are partitioned into two **disjoint** domains:

| Domain | Actions | Enacted by |
| --- | --- | --- |
| **Governable** (protocol parameters) | `SetFeeBps`, `SetTreasury` | Governance vote **only** (once enabled) |
| **Operational** (safety / signer set) | `Pause`, `Unpause`, `AddSigner`, `RemoveSigner`, `ChangeThreshold`, `RotateSigner`, `EmergencyWithdraw` | Multisig **only** |

Enforcement is bidirectional and un-bypassable:

- The multisig path (`propose_admin_action` **and** `execute_proposal_internal`)
  rejects governable actions with `EscrowError::GovernanceRequired` once
  governance is enabled — a signer majority cannot override a governed parameter.
- The governance path (`propose_governance`) rejects non-governable actions with
  `GovError::NotGovernable` — governance cannot touch pause/emergency/signer-set.

Rationale: emergency controls and the signer set must stay fast and in the
multisig's hands; economic parameters are what the broader stakeholder base
should control. Governance is "enabled" once `configure_governance` runs; before
that the multisig retains full authority (fully backward compatible — all 232
pre-existing escrow tests still pass). There is deliberately **no disable
function**, so parameter control cannot be silently reclaimed.

### 2. Snapshot safety / anti-gaming (the core property)

Each proposal records `snapshot_ts` at open time. Voting weight is read from the
reputation contract via `get_gov_weight(user) -> (score, last_change_ts)` and a
vote is accepted **only if `last_change_ts <= snapshot_ts`**.

`last_change_ts` is the stored `UserReputation.last_updated_ts` (a Unix
timestamp in seconds, from `env.ledger().timestamp()` — renamed from the
misleading `last_updated_ledger` per review), which is
bumped by every score-changing event (review, slash, dispute outcome, referral
bonus, appeal) and never by a pure read. Any account that acquires or changes
reputation after a proposal opens therefore has `last_change_ts > snapshot_ts`
and is rejected with `GovError::WeightChangedAfterSnapshot`. This defeats the
classic "pump reputation to swing an in-flight vote" attack **without** requiring
full historical checkpointing in the reputation contract. Decay only ever
*reduces* the reported score, so the guard can never be tricked into counting
inflated weight.

### 3. Delegation

Single-hop and exercised explicitly:

1. A delegator calls `delegate(to)`. A delegator that has delegated away may not
   vote directly (`GovError::DelegatedAway`).
2. The delegate casts its own vote (`cast_vote`).
3. The delegate pulls each delegator's weight onto the **same side** via
   `cast_delegated_vote(delegator)`, using the *delegator's* own snapshot weight
   (subject to the same anti-gaming guard).

Every account's weight is recorded in a per-proposal `VoteReceipt` and can be
cast **at most once**. Re-delegating mid-vote therefore never retroactively moves
weight that has already been counted — the receipt locks it.

Single-hop is enforced: `cast_delegated_vote` rejects
(`GovError::DelegateNotDirect`) when the delegate's own receipt has
`via_delegate == true`, so weight received through delegation cannot be forwarded
on again (A→B→C never lets B pass A's weight to C).

### 4. Quorum & threshold

- **Quorum** is an absolute minimum participating weight (`for + against + abstain
  >= quorum_votes`). Using an absolute floor avoids having to enumerate global
  reputation supply on-chain.
- **Pass threshold**: `for * 10000 >= (for + against) * pass_threshold_bps`.
  `Abstain` counts toward quorum but never toward the threshold.

### 5. Lifecycle

`Active` → (`finalize_governance` after voting closes) → `Queued` (passed) or
`Defeated`. `Queued` → (`execute_governance` after the time-lock, within the
grace window) → `Executed`. A `Queued` proposal past its grace window is refused
by `execute_governance` and can be cleaned up to `Expired` via
`expire_governance`. `finalize`/`execute`/`expire` are all permissionless.

## New / changed surface

- **Reputation**: `get_gov_weight(Address) -> (u64, u64)` view function.
- **Escrow entry points**: `configure_governance`, `get_governance_config`,
  `get_fee_bps`, `get_treasury`, `propose_governance`, `cast_vote`,
  `cast_delegated_vote`, `delegate`, `undelegate`, `get_delegate`,
  `finalize_governance`, `execute_governance`, `expire_governance`,
  `get_governance_proposal`, `get_vote_receipt`.
- **Errors**: dedicated `GovError` enum (codes 200+, separate from `EscrowError`'s
  50-case budget); one new `EscrowError::GovernanceRequired` for the multisig guard.
- **Events**: `gov` topic — `config`, `proposed`, `voted`, `dvoted`, `delegate`,
  `undelegat`, `finalized`, `executed`, `expired`.

## Test coverage

`governance_test.rs` covers: happy-path pass + parameter application, treasury
change, quorum failure, threshold failure, abstain accounting, **snapshot
anti-gaming** (post-snapshot reputation ignored) and an **adversarial whale**
scenario, zero-weight/double-vote rejection, **delegation** (weight applies to
the delegate's side; mid-vote re-delegation does not alter cast votes; delegated
weight is snapshot-safe; ordering and authorization guards), the **multisig /
governance separation** in both directions and before/after enabling, and the
time-lock / grace / expiry lifecycle. Reputation unit tests cover `get_gov_weight`
score/timestamp reporting and the last-change-bump property.
