//! Reputation-weighted on-chain governance for protocol parameters (issue #899).
//!
//! # Overview
//!
//! This module adds a stakeholder-weighted voting path for changing protocol
//! *parameters*, running **in parallel** to — not replacing — the existing
//! fixed multisig. Broad reputation holders can now decide fee and treasury
//! changes, instead of those being controlled solely by the closed signer set.
//!
//! ## Separation of powers (explicit, enforced)
//!
//! Admin actions are partitioned into two **disjoint** domains, and the split is
//! enforced in both directions so neither path can bypass the other:
//!
//! - **Governable (governance-only) actions** — protocol parameters:
//!   [`AdminAction::SetFeeBps`], [`AdminAction::SetTreasury`]. Once governance is
//!   configured, these can *only* be enacted through the governance vote. The
//!   multisig path rejects them with [`EscrowError::GovernanceRequired`].
//! - **Operational (multisig-only) actions** — everything else: `Pause`,
//!   `Unpause`, `AddSigner`, `RemoveSigner`, `ChangeThreshold`, `RotateSigner`,
//!   `EmergencyWithdraw`. These remain multisig-only and cannot be proposed
//!   through governance (rejected with [`GovError::NotGovernable`]).
//!
//! Rationale: emergency/safety controls (pause, emergency withdraw) and the
//! composition of the signer set must stay fast and in the multisig's hands;
//! economic parameters (fee, treasury) are exactly what the broader stakeholder
//! base should control. Governance is "enabled" once [`configure_governance`]
//! has run; before that the multisig retains full authority (backward
//! compatible), and there is deliberately **no** disable function so a signer
//! majority cannot switch governance off to reclaim parameter control.
//!
//! ## Snapshot safety (anti-gaming)
//!
//! Each proposal records `snapshot_ts` at open time. A vote's weight is read
//! from the reputation contract via `get_gov_weight(user) -> (score, last_change_ts)`
//! and accepted **only if `last_change_ts <= snapshot_ts`**. Any account that
//! acquires or changes reputation *after* the proposal opens has
//! `last_change_ts > snapshot_ts` and is rejected with
//! [`GovError::WeightChangedAfterSnapshot`]. This defeats the classic attack of
//! pumping reputation to swing an in-flight vote. Reputation decay only ever
//! *reduces* the reported score, so the guard can never be tricked into counting
//! inflated weight.
//!
//! ## Delegation
//!
//! An account may [`delegate`] its weight to another address. Delegation is
//! **single-hop** and exercised explicitly: the delegate first casts its own
//! vote, then the delegator's weight is pulled onto the *same* side via
//! [`cast_delegated_vote`]. Each account's weight is recorded in a per-proposal
//! [`VoteReceipt`] and can be cast **at most once**, so re-delegating mid-vote
//! never retroactively moves weight that has already been counted. The
//! delegator's own snapshot weight (subject to the same anti-gaming guard) is
//! what counts — not the delegate's.

use soroban_sdk::{
    contracterror, contractimpl, contracttype, symbol_short, Address, Env, IntoVal, Symbol,
};

use crate::{AdminAction, EscrowContract, MAX_FEE_BPS};
// The escrow's `#[contractimpl]` in lib.rs generates `EscrowContractClient`; the
// second `#[contractimpl]` block below needs that type in scope.
#[allow(unused_imports)]
use crate::EscrowContractClient;

/// Defense-in-depth cap on the raw score returned by the reputation contract's
/// `get_gov_weight`. The reputation contract already caps its output at
/// `MAX_GOV_WEIGHT` (= 5 * MAX_STAKE_WEIGHT_PER_REVIEW * 200), but this local
/// cap is an independent second barrier inside the escrow governance layer.
///
/// If the reputation contract is upgraded to a version that removes its own cap,
/// or if a future cross-contract interface mismatch causes uncapped weight to
/// arrive here, this guard ensures a single account can never cast more than
/// `GOV_WEIGHT_CAP` voting units regardless of what the reputation side reports.
///
/// Value is kept identical to the reputation contract's `MAX_GOV_WEIGHT` so that
/// legitimate high-reputation users are unaffected.
/// 5 stars × 10_000_000_000 (max weight per review) × 200 (max reviews counted)
const GOV_WEIGHT_CAP: u64 = 10_000_000_000_000_u64;

// ============================================================
// Errors
// ============================================================

/// Governance-specific errors.
///
/// Kept in a **dedicated** error enum (rather than extending `EscrowError`)
/// because a single Soroban `#[contracterror]` enum is capped at 50 cases and
/// `EscrowError` is already near that limit. Codes start at 200 so they never
/// overlap with `EscrowError`'s codes, keeping raw error values unambiguous.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum GovError {
    /// Governance has not been configured.
    NotConfigured = 200,
    /// Action cannot be enacted via governance.
    NotGovernable = 201,
    /// No governance proposal exists with this ID.
    ProposalNotFound = 202,
    /// The proposal's voting window has closed.
    VotingClosed = 203,
    /// The proposal's voting window is still open.
    VotingActive = 204,
    /// This account has already voted on this proposal.
    AlreadyVoted = 205,
    /// The account has no snapshot voting weight.
    NoVotingPower = 206,
    /// Reputation changed after the snapshot (anti-gaming guard).
    WeightChangedAfterSnapshot = 207,
    /// The reputation contract could not be reached.
    ReputationUnavailable = 208,
    /// The caller is not the delegate of the named delegator.
    NotDelegate = 209,
    /// The delegate has not yet cast its own vote.
    DelegateHasNotVoted = 210,
    /// The account has delegated its weight away.
    DelegatedAway = 211,
    /// The proposal is not in the Queued state.
    NotQueued = 212,
    /// The execution time-lock has not yet elapsed.
    TimelockActive = 213,
    /// The proposal's execution grace window has passed.
    Expired = 214,
    /// The proposal is not in a state that can be expired.
    NotExpirable = 215,
    /// A governance config parameter is out of range.
    InvalidParam = 216,
    /// The proposal is not in the Active state.
    NotActive = 217,
    /// Caller is not a registered multisig signer.
    NotAdmin = 218,
    /// The proposed fee exceeds the maximum permitted.
    InvalidFee = 219,
    /// The delegate voted with weight it received via delegation, so it cannot
    /// pass that weight on again (delegation is single-hop).
    DelegateNotDirect = 220,
}

// ============================================================
// Storage
// ============================================================

/// Governance storage keys. Kept in a dedicated enum (rather than extending the
/// escrow `DataKey`) so the governance feature is self-contained and does not
/// collide with existing keys.
#[contracttype]
#[derive(Clone)]
pub enum GovKey {
    /// [`GovernanceConfig`] — presence of this key means governance is enabled.
    Config,
    /// Monotonic proposal counter (`u64`).
    ProposalCount,
    /// A [`GovernanceProposal`] by id.
    Proposal(u64),
    /// A [`VoteReceipt`] per (proposal id, account). One vote per account.
    Receipt(u64, Address),
    /// The address an account has delegated its voting weight to.
    Delegate(Address),
}

/// TTL bump parameters for governance persistent entries (~90 days at 5s/ledger,
/// matching the escrow's own persistent-entry lifetime).
const GOV_TTL_LEDGERS: u32 = 535_000;

fn bump_persistent_ttl(env: &Env, key: &GovKey) {
    if env.storage().persistent().has(key) {
        env.storage()
            .persistent()
            .extend_ttl(key, GOV_TTL_LEDGERS, GOV_TTL_LEDGERS);
    }
}

// ============================================================
// Types
// ============================================================

/// Which side of a proposal a vote falls on.
///
/// `Abstain` counts toward **quorum** (participation) but not toward the
/// for/against pass threshold — the standard way to let stakeholders signal
/// engagement without taking a side.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum VoteSupport {
    Against,
    For,
    Abstain,
}

/// Lifecycle state of a governance proposal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GovProposalStatus {
    /// Open for voting (within `[start_ts, end_ts]`).
    Active,
    /// Voting closed, quorum + threshold met; awaiting the execution time-lock.
    Queued,
    /// Voting closed and failed quorum or threshold. Terminal.
    Defeated,
    /// The parameter change has been enacted. Terminal.
    Executed,
    /// The execution grace window elapsed without execution. Terminal.
    Expired,
}

/// Governance configuration. Its presence in storage is what "enables"
/// governance and activates the multisig/governance separation of powers.
#[contracttype]
#[derive(Clone, Debug)]
pub struct GovernanceConfig {
    /// Reputation contract queried for snapshot voting weight.
    pub reputation: Address,
    /// Length of the voting window, in seconds.
    pub voting_period_secs: u64,
    /// Delay between a proposal passing and becoming executable, in seconds.
    pub timelock_secs: u64,
    /// Window after the time-lock during which a passed proposal may be
    /// executed before it expires, in seconds.
    pub grace_secs: u64,
    /// Minimum total participating weight (`for + against + abstain`) required
    /// for a proposal to be valid. Absolute, so no global supply enumeration is
    /// needed.
    pub quorum_votes: u128,
    /// Fraction of decisive (`for + against`) weight that must be `for`, in
    /// basis points. e.g. `5000` = a simple majority (> 50%).
    pub pass_threshold_bps: u32,
    /// Minimum snapshot weight an account must hold to open a proposal
    /// (anti-spam / sybil resistance).
    pub min_proposer_weight: u64,
}

/// A governance proposal to change a protocol parameter.
#[contracttype]
#[derive(Clone, Debug)]
pub struct GovernanceProposal {
    pub id: u64,
    pub proposer: Address,
    /// The parameter change to enact if the proposal passes. Always a governable
    /// action (see [`is_governable_action`]).
    pub action: AdminAction,
    /// Timestamp captured at open time. Voting weight is measured as-of here:
    /// only reputation that existed at or before this instant counts.
    pub snapshot_ts: u64,
    pub start_ts: u64,
    pub end_ts: u64,
    /// Earliest execution time (set when the proposal is queued); `0` until then.
    pub eta: u64,
    pub for_weight: u128,
    pub against_weight: u128,
    pub abstain_weight: u128,
    pub status: GovProposalStatus,
}

/// Record of a single account's vote on a proposal. Existence of a receipt is
/// what prevents an account's weight from being counted twice, and it is what
/// makes an already-cast vote immune to later delegation changes.
#[contracttype]
#[derive(Clone, Debug)]
pub struct VoteReceipt {
    pub support: VoteSupport,
    pub weight: u128,
    pub voted_at: u64,
    /// `true` if this weight was pulled in by the account's delegate rather than
    /// cast by the account itself.
    pub via_delegate: bool,
}

// ============================================================
// Internal helpers (also used by the multisig guard in lib.rs)
// ============================================================

/// Whether governance has been configured (and thus enabled).
pub(crate) fn governance_enabled(env: &Env) -> bool {
    env.storage().instance().has(&GovKey::Config)
}

/// Whether `action` is a protocol-parameter change owned by governance once
/// governance is enabled. Kept in one place so the multisig guard and the
/// governance proposal path agree on the exact partition.
pub(crate) fn is_governable_action(action: &AdminAction) -> bool {
    matches!(
        action,
        AdminAction::SetFeeBps(_) | AdminAction::SetTreasury(_)
    )
}

fn load_config(env: &Env) -> Result<GovernanceConfig, GovError> {
    env.storage()
        .instance()
        .get(&GovKey::Config)
        .ok_or(GovError::NotConfigured)
}

fn load_proposal(env: &Env, id: u64) -> Result<GovernanceProposal, GovError> {
    let p: GovernanceProposal = env
        .storage()
        .persistent()
        .get(&GovKey::Proposal(id))
        .ok_or(GovError::ProposalNotFound)?;
    bump_persistent_ttl(env, &GovKey::Proposal(id));
    Ok(p)
}

fn save_proposal(env: &Env, p: &GovernanceProposal) {
    env.storage().persistent().set(&GovKey::Proposal(p.id), p);
    bump_persistent_ttl(env, &GovKey::Proposal(p.id));
}

/// Fetch a subject's **snapshot-safe** voting weight for a proposal.
///
/// Cross-calls the reputation contract's `get_gov_weight(user) -> (score, last_change_ts)`
/// and enforces the anti-gaming invariant `last_change_ts <= snapshot_ts`. See
/// the module docs for why this is safe against post-snapshot reputation gaming.
fn snapshot_weight(
    env: &Env,
    reputation: &Address,
    subject: &Address,
    snapshot_ts: u64,
) -> Result<u128, GovError> {
    let args = soroban_sdk::vec![env, subject.clone().into_val(env)];
    // `try_invoke_contract` turns an unreachable/invalid reputation contract into
    // a typed error instead of trapping.
    let result = env.try_invoke_contract::<(u64, u64), soroban_sdk::Error>(
        reputation,
        &Symbol::new(env, "get_gov_weight"),
        args,
    );
    let (score, last_change_ts) = match result {
        Ok(Ok(value)) => value,
        _ => return Err(GovError::ReputationUnavailable),
    };

    // Core anti-gaming guard: reputation changed after the snapshot cannot vote.
    if last_change_ts > snapshot_ts {
        return Err(GovError::WeightChangedAfterSnapshot);
    }
    if score == 0 {
        return Err(GovError::NoVotingPower);
    }
    // Defense-in-depth: cap the raw score at GOV_WEIGHT_CAP before it becomes
    // voting weight. The reputation contract applies the same cap via
    // MAX_GOV_WEIGHT, but this is an independent escrow-side guard against a
    // future reputation upgrade that removes or raises that cap (issue #exploit).
    let capped_score = score.min(GOV_WEIGHT_CAP);
    Ok(capped_score as u128)
}

/// Add `weight` to the appropriate tally on `proposal` for `support`.
fn add_weight(proposal: &mut GovernanceProposal, support: VoteSupport, weight: u128) {
    match support {
        VoteSupport::For => proposal.for_weight = proposal.for_weight.saturating_add(weight),
        VoteSupport::Against => {
            proposal.against_weight = proposal.against_weight.saturating_add(weight)
        }
        VoteSupport::Abstain => {
            proposal.abstain_weight = proposal.abstain_weight.saturating_add(weight)
        }
    }
}

/// Enact a governed parameter change. Only ever called on a passed, time-locked
/// proposal whose action passed [`is_governable_action`], so the match is total
/// over the governable variants; any other variant is a defensive no-op error.
fn enact(env: &Env, action: &AdminAction) -> Result<(), GovError> {
    match action {
        AdminAction::SetFeeBps(fee) => {
            if *fee > MAX_FEE_BPS {
                return Err(GovError::InvalidFee);
            }
            // Same storage slot the multisig path and `initialize` use.
            env.storage().instance().set(&symbol_short!("FEE"), fee);
            Ok(())
        }
        AdminAction::SetTreasury(treasury) => {
            env.storage()
                .instance()
                .set(&symbol_short!("TRE"), treasury);
            Ok(())
        }
        // Unreachable in practice: proposals are validated as governable at open.
        _ => Err(GovError::NotGovernable),
    }
}

fn get_delegate_internal(env: &Env, account: &Address) -> Option<Address> {
    env.storage()
        .persistent()
        .get(&GovKey::Delegate(account.clone()))
}

/// Require that `proposal` is currently accepting votes.
fn require_open_for_voting(env: &Env, proposal: &GovernanceProposal) -> Result<(), GovError> {
    if proposal.status != GovProposalStatus::Active {
        return Err(GovError::VotingClosed);
    }
    let now = env.ledger().timestamp();
    if now < proposal.start_ts || now > proposal.end_ts {
        return Err(GovError::VotingClosed);
    }
    Ok(())
}

// ============================================================
// Contract entry points
// ============================================================

#[contractimpl]
impl EscrowContract {
    /// Configure (and thereby enable) reputation-weighted governance. Callable
    /// only by a registered multisig signer — the closed signer set voluntarily
    /// hands parameter control to the stakeholder vote. May be called again by a
    /// signer to re-tune parameters; there is intentionally no way to *disable*
    /// governance, so parameter control cannot be silently reclaimed.
    ///
    /// - `reputation`: contract exposing `get_gov_weight(Address) -> (u64, u64)`.
    /// - `pass_threshold_bps`: must be in `1..=10000`.
    /// - `voting_period_secs`: must be `> 0`.
    #[allow(clippy::too_many_arguments)]
    pub fn configure_governance(
        env: Env,
        admin: Address,
        reputation: Address,
        voting_period_secs: u64,
        timelock_secs: u64,
        grace_secs: u64,
        quorum_votes: u128,
        pass_threshold_bps: u32,
        min_proposer_weight: u64,
    ) -> Result<(), GovError> {
        admin.require_auth();
        if !crate::is_signer(&env, &admin) {
            return Err(GovError::NotAdmin);
        }
        if voting_period_secs == 0 || pass_threshold_bps == 0 || pass_threshold_bps > 10_000 {
            return Err(GovError::InvalidParam);
        }

        let config = GovernanceConfig {
            reputation,
            voting_period_secs,
            timelock_secs,
            grace_secs,
            quorum_votes,
            pass_threshold_bps,
            min_proposer_weight,
        };
        env.storage().instance().set(&GovKey::Config, &config);

        env.events().publish(
            (symbol_short!("gov"), symbol_short!("config")),
            (admin, config.reputation, config.voting_period_secs),
        );
        Ok(())
    }

    /// Return the governance configuration, if governance is enabled.
    pub fn get_governance_config(env: Env) -> Option<GovernanceConfig> {
        env.storage().instance().get(&GovKey::Config)
    }

    /// Return the current platform fee in basis points. Reads the same `FEE`
    /// slot that `initialize`, the multisig, and governance all write, so it
    /// reflects changes made through any path.
    pub fn get_fee_bps(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&symbol_short!("FEE"))
            .unwrap_or(0)
    }

    /// Return the current treasury address, if set.
    pub fn get_treasury(env: Env) -> Option<Address> {
        env.storage().instance().get(&symbol_short!("TRE"))
    }

    /// Open a governance proposal to change a protocol parameter. The action
    /// must be governable ([`AdminAction::SetFeeBps`] / [`AdminAction::SetTreasury`]).
    /// The proposer must hold at least `min_proposer_weight` snapshot weight.
    /// The snapshot timestamp is captured now; all voting weight is measured
    /// as-of this instant.
    pub fn propose_governance(
        env: Env,
        proposer: Address,
        action: AdminAction,
    ) -> Result<u64, GovError> {
        proposer.require_auth();
        let config = load_config(&env)?;

        if !is_governable_action(&action) {
            return Err(GovError::NotGovernable);
        }
        // Validate the parameter eagerly so a doomed proposal never opens.
        if let AdminAction::SetFeeBps(fee) = &action {
            if *fee > MAX_FEE_BPS {
                return Err(GovError::InvalidFee);
            }
        }

        let now = env.ledger().timestamp();
        // Proposer must clear the anti-spam weight floor at the snapshot instant.
        let proposer_weight = snapshot_weight(&env, &config.reputation, &proposer, now)?;
        if proposer_weight < config.min_proposer_weight as u128 {
            return Err(GovError::NoVotingPower);
        }

        let mut count: u64 = env
            .storage()
            .instance()
            .get(&GovKey::ProposalCount)
            .unwrap_or(0);
        count += 1;

        let proposal = GovernanceProposal {
            id: count,
            proposer: proposer.clone(),
            action: action.clone(),
            snapshot_ts: now,
            start_ts: now,
            end_ts: now.saturating_add(config.voting_period_secs),
            eta: 0,
            for_weight: 0,
            against_weight: 0,
            abstain_weight: 0,
            status: GovProposalStatus::Active,
        };
        save_proposal(&env, &proposal);
        env.storage().instance().set(&GovKey::ProposalCount, &count);

        env.events().publish(
            (symbol_short!("gov"), symbol_short!("proposed")),
            (count, proposer, action, now, proposal.end_ts),
        );
        Ok(count)
    }

    /// Cast the caller's own snapshot weight on a proposal. The caller must not
    /// have delegated its weight away (delegated weight is exercised by the
    /// delegate via [`cast_delegated_vote`]).
    pub fn cast_vote(
        env: Env,
        voter: Address,
        proposal_id: u64,
        support: VoteSupport,
    ) -> Result<(), GovError> {
        voter.require_auth();
        let config = load_config(&env)?;
        let mut proposal = load_proposal(&env, proposal_id)?;

        require_open_for_voting(&env, &proposal)?;

        // An account that delegated its weight away cannot also vote directly.
        if let Some(delegate) = get_delegate_internal(&env, &voter) {
            if delegate != voter {
                return Err(GovError::DelegatedAway);
            }
        }
        if env
            .storage()
            .persistent()
            .has(&GovKey::Receipt(proposal_id, voter.clone()))
        {
            return Err(GovError::AlreadyVoted);
        }

        let weight = snapshot_weight(&env, &config.reputation, &voter, proposal.snapshot_ts)?;
        add_weight(&mut proposal, support, weight);
        save_proposal(&env, &proposal);

        let receipt = VoteReceipt {
            support,
            weight,
            voted_at: env.ledger().timestamp(),
            via_delegate: false,
        };
        env.storage()
            .persistent()
            .set(&GovKey::Receipt(proposal_id, voter.clone()), &receipt);
        bump_persistent_ttl(&env, &GovKey::Receipt(proposal_id, voter.clone()));

        env.events().publish(
            (symbol_short!("gov"), symbol_short!("voted")),
            (proposal_id, voter, support, weight),
        );
        Ok(())
    }

    /// Exercise a delegator's weight on a proposal, on the **same side** the
    /// delegate already voted. Callable only by the delegator's current delegate,
    /// and only after that delegate has cast its own vote. The delegator's own
    /// snapshot weight is used (subject to the anti-gaming guard) and locked into
    /// a receipt, so it can be cast only once regardless of later re-delegation.
    pub fn cast_delegated_vote(
        env: Env,
        delegate: Address,
        proposal_id: u64,
        delegator: Address,
    ) -> Result<(), GovError> {
        delegate.require_auth();
        let config = load_config(&env)?;
        let mut proposal = load_proposal(&env, proposal_id)?;

        require_open_for_voting(&env, &proposal)?;

        // The caller must be the delegator's *current* delegate.
        match get_delegate_internal(&env, &delegator) {
            Some(d) if d == delegate => {}
            _ => return Err(GovError::NotDelegate),
        }

        // The delegate must have voted first; the delegated weight follows that side.
        let delegate_receipt: VoteReceipt = env
            .storage()
            .persistent()
            .get(&GovKey::Receipt(proposal_id, delegate.clone()))
            .ok_or(GovError::DelegateHasNotVoted)?;

        // Single-hop enforcement: the delegate must have voted with its OWN
        // snapshot weight, not weight it itself received through delegation.
        // Without this, A→B and B→C would let B forward A's weight on to C,
        // chaining delegation past the one hop the design guarantees. (Weight is
        // still never double-counted — each address gets one receipt — but the
        // chain length must be capped for the documented model to hold.)
        if delegate_receipt.via_delegate {
            return Err(GovError::DelegateNotDirect);
        }
        let support = delegate_receipt.support;

        // Each account's weight can be counted at most once.
        if env
            .storage()
            .persistent()
            .has(&GovKey::Receipt(proposal_id, delegator.clone()))
        {
            return Err(GovError::AlreadyVoted);
        }

        // Snapshot-safety applies to the *delegator's* reputation, not the delegate's.
        let weight = snapshot_weight(&env, &config.reputation, &delegator, proposal.snapshot_ts)?;
        add_weight(&mut proposal, support, weight);
        save_proposal(&env, &proposal);

        let receipt = VoteReceipt {
            support,
            weight,
            voted_at: env.ledger().timestamp(),
            via_delegate: true,
        };
        env.storage()
            .persistent()
            .set(&GovKey::Receipt(proposal_id, delegator.clone()), &receipt);
        bump_persistent_ttl(&env, &GovKey::Receipt(proposal_id, delegator.clone()));

        env.events().publish(
            (symbol_short!("gov"), symbol_short!("dvoted")),
            (proposal_id, delegate, delegator, support, weight),
        );
        Ok(())
    }

    /// Delegate the caller's voting weight to `to`. Delegating to oneself is
    /// equivalent to holding no delegation. Delegation is single-hop: the
    /// delegate exercises delegated weight explicitly and must itself vote
    /// directly (it may not have delegated its own weight away).
    ///
    /// Changing delegation never moves weight that has already been cast on an
    /// open proposal — cast weight is locked by its receipt.
    pub fn delegate(env: Env, delegator: Address, to: Address) -> Result<(), GovError> {
        delegator.require_auth();
        if to == delegator {
            // Self-delegation clears any existing delegation.
            env.storage()
                .persistent()
                .remove(&GovKey::Delegate(delegator.clone()));
        } else {
            env.storage()
                .persistent()
                .set(&GovKey::Delegate(delegator.clone()), &to);
            bump_persistent_ttl(&env, &GovKey::Delegate(delegator.clone()));
        }
        env.events().publish(
            (symbol_short!("gov"), symbol_short!("delegate")),
            (delegator, to),
        );
        Ok(())
    }

    /// Remove any delegation set by the caller (they regain direct voting).
    pub fn undelegate(env: Env, delegator: Address) -> Result<(), GovError> {
        delegator.require_auth();
        env.storage()
            .persistent()
            .remove(&GovKey::Delegate(delegator.clone()));
        env.events().publish(
            (symbol_short!("gov"), Symbol::new(&env, "undelegate")),
            (delegator,),
        );
        Ok(())
    }

    /// Return the address `account` has delegated to, if any.
    pub fn get_delegate(env: Env, account: Address) -> Option<Address> {
        get_delegate_internal(&env, &account)
    }

    /// Tally a proposal after its voting window closes and move it to `Queued`
    /// (passed) or `Defeated`. Permissionless: anyone may finalize.
    pub fn finalize_governance(env: Env, proposal_id: u64) -> Result<GovProposalStatus, GovError> {
        let config = load_config(&env)?;
        let mut proposal = load_proposal(&env, proposal_id)?;

        if proposal.status != GovProposalStatus::Active {
            return Err(GovError::NotActive);
        }
        let now = env.ledger().timestamp();
        if now <= proposal.end_ts {
            return Err(GovError::VotingActive);
        }

        let participation = proposal
            .for_weight
            .saturating_add(proposal.against_weight)
            .saturating_add(proposal.abstain_weight);
        let decisive = proposal.for_weight.saturating_add(proposal.against_weight);

        // Passed iff quorum reached, at least one decisive vote, and the `for`
        // share of decisive weight meets the configured threshold. Abstentions
        // count toward quorum but never toward the threshold.
        let passed = participation >= config.quorum_votes
            && decisive > 0
            && proposal.for_weight.saturating_mul(10_000)
                >= decisive.saturating_mul(config.pass_threshold_bps as u128);

        if passed {
            proposal.status = GovProposalStatus::Queued;
            proposal.eta = now.saturating_add(config.timelock_secs);
        } else {
            proposal.status = GovProposalStatus::Defeated;
        }
        save_proposal(&env, &proposal);

        env.events().publish(
            (symbol_short!("gov"), symbol_short!("finalized")),
            (
                proposal_id,
                proposal.status.clone(),
                proposal.for_weight,
                proposal.against_weight,
                proposal.abstain_weight,
            ),
        );
        Ok(proposal.status)
    }

    /// Execute a `Queued` proposal once its time-lock has elapsed and before its
    /// grace window closes. Enacts the governed parameter change. Permissionless.
    pub fn execute_governance(env: Env, proposal_id: u64) -> Result<(), GovError> {
        let config = load_config(&env)?;
        let mut proposal = load_proposal(&env, proposal_id)?;

        if proposal.status != GovProposalStatus::Queued {
            return Err(GovError::NotQueued);
        }
        let now = env.ledger().timestamp();
        if now < proposal.eta {
            return Err(GovError::TimelockActive);
        }
        if now > proposal.eta.saturating_add(config.grace_secs) {
            // Past the grace window: refuse to execute stale intent. We do NOT
            // mutate here — a Soroban `Err` return rolls storage back anyway, so
            // formally marking the proposal `Expired` is the job of the dedicated
            // `expire_governance` (which returns `Ok` and persists the status).
            return Err(GovError::Expired);
        }

        enact(&env, &proposal.action)?;
        proposal.status = GovProposalStatus::Executed;
        save_proposal(&env, &proposal);

        env.events().publish(
            (symbol_short!("gov"), symbol_short!("executed")),
            (proposal_id, proposal.action),
        );
        Ok(())
    }

    /// Mark a `Queued` proposal `Expired` once its execution grace window has
    /// passed without execution. Permissionless cleanup.
    pub fn expire_governance(env: Env, proposal_id: u64) -> Result<(), GovError> {
        let config = load_config(&env)?;
        let mut proposal = load_proposal(&env, proposal_id)?;

        if proposal.status != GovProposalStatus::Queued {
            return Err(GovError::NotExpirable);
        }
        let now = env.ledger().timestamp();
        if now <= proposal.eta.saturating_add(config.grace_secs) {
            return Err(GovError::NotExpirable);
        }
        proposal.status = GovProposalStatus::Expired;
        save_proposal(&env, &proposal);

        env.events().publish(
            (symbol_short!("gov"), symbol_short!("expired")),
            (proposal_id,),
        );
        Ok(())
    }

    /// Return a governance proposal by id, if it exists.
    pub fn get_governance_proposal(env: Env, proposal_id: u64) -> Option<GovernanceProposal> {
        env.storage()
            .persistent()
            .get(&GovKey::Proposal(proposal_id))
    }

    /// Return an account's vote receipt for a proposal, if it has voted.
    pub fn get_vote_receipt(
        env: Env,
        proposal_id: u64,
        account: Address,
    ) -> Option<VoteReceipt> {
        env.storage()
            .persistent()
            .get(&GovKey::Receipt(proposal_id, account))
    }
}
