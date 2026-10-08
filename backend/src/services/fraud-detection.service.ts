import { PrismaClient } from "@prisma/client";
// Enum *types* only. We reference the enum members as string literals rather
// than the generated runtime objects (Prisma enums are unions of string
// literals, so `"HIGH"` is type-correct as `RiskLevel`). This keeps the module
// loadable even under partial `@prisma/client` mocks that omit the enum objects
// — the pattern several route tests use.
import type {
  RiskSubjectType,
  RiskLevel,
  RiskTrigger,
  RiskFlagStatus,
} from "@prisma/client";
import { logger } from "../lib/logger";

/**
 * Fraud / anomaly detection service (issue #900).
 *
 * Design goals, in priority order:
 *
 *  1. **Review, don't auto-block.** Nothing here suspends, blocks, or hides a
 *     user or job. The only side effect of a high score is that the subject is
 *     surfaced in an admin review queue (`RiskFlag`). Human confirmation is
 *     always the gate before any punitive action.
 *
 *  2. **Minimise false positives.** Signals are normalised and combined with a
 *     noisy-OR model (see {@link combineSignals}) rather than a flat if/else
 *     rule list. That means a single genuinely strong indicator (e.g. two
 *     accounts wash-trading high-value jobs between each other) can raise the
 *     score on its own, while a legitimately busy account — high transaction
 *     volume but with none of the collusion / instant-release signals — stays
 *     well below the review threshold.
 *
 *  3. **Auditable, not transient.** Every scoring run is persisted as a
 *     `RiskAssessment` row with the exact signal breakdown that produced it, so
 *     a reviewer can see *why* something was flagged and how the score moved
 *     over time.
 *
 *  4. **Near-real-time, non-blocking.** Scoring is triggered inline from the
 *     job-creation and escrow-release paths via {@link onJobCreated} /
 *     {@link onEscrowReleased}, but those hooks are fire-and-forget: they never
 *     throw into, or add latency to, the caller's critical path.
 *
 * The thresholds and weights below are the tunable knobs. They live in code
 * (not the database) and are deliberately grouped so they can be calibrated
 * against real false-positive feedback (see {@link getFalsePositiveStats}).
 */

const prisma = new PrismaClient();

// ─── Tunable configuration ───────────────────────────────────────────────────

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Score bands (0–100). A subject is added to the admin review queue at
 * `REVIEW_LEVEL` and above. These are intentionally conservative to favour
 * false negatives over false positives — a missed borderline case is cheaper
 * than wrongly flagging a real freelancer.
 */
export const RISK_BANDS = {
  MEDIUM: 40,
  HIGH: 60,
  CRITICAL: 80,
} as const;

/** Minimum band that lands a subject in the human review queue. */
export const REVIEW_LEVEL: RiskLevel = "HIGH";

/**
 * Per-signal weight, expressed as the maximum probability that signal alone can
 * contribute to the combined risk (see {@link combineSignals}). Higher = the
 * platform trusts this signal more as a standalone indicator of abuse.
 *
 * `reciprocal_pairing` and `pair_concentration` (the wash-trading signals) and
 * `instant_high_value_release` carry the most weight because they are the
 * hardest to produce with ordinary honest usage.
 */
export const SIGNAL_WEIGHTS = {
  reciprocal_pairing: 0.85,
  pair_concentration: 0.75,
  instant_high_value_release: 0.7,
  shared_ip_correlation: 0.6,
  job_churn: 0.5,
  transaction_velocity: 0.4,
  new_account_high_value: 0.35,
} as const;

/** Normalisation parameters for turning raw measurements into 0..1 severities. */
export const SIGNAL_PARAMS = {
  /** Transactions within this window are counted for velocity. */
  velocityWindowMs: 1 * HOUR,
  /** Transaction count at which velocity severity saturates to 1. */
  velocitySoftCap: 25,

  /** Window over which job create/cancel churn is measured. */
  churnWindowMs: 1 * DAY,
  /** Cancelled-job count at which churn severity saturates to 1. */
  churnSoftCap: 8,

  /** A funded→released gap at or below this is treated as "near-instant". */
  instantReleaseMs: 5 * MINUTE,
  /** Job value (budget) at or above this is treated as "high value". */
  highValueThreshold: 500,

  /** Repeat completed jobs with a single counterparty at which the pairing
   *  signal saturates to 1. */
  pairRepeatSoftCap: 5,

  /** Distinct other accounts sharing an IP at which the correlation signal
   *  saturates to 1. */
  sharedIpSoftCap: 3,

  /** Accounts younger than this are considered "new" for the
   *  new-account-high-value signal. */
  youngAccountMs: 1 * DAY,
} as const;

type SignalCode = keyof typeof SIGNAL_WEIGHTS;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SignalResult {
  /** Stable identifier for the signal (matches {@link SIGNAL_WEIGHTS}). */
  code: SignalCode;
  /** Raw measured value (a count, ratio, or duration) — for the audit trail. */
  value: number;
  /** Normalised 0..1 severity. */
  severity: number;
  /** The configured weight applied to this signal. */
  weight: number;
  /** Human-readable explanation shown to reviewers. */
  detail: string;
}

export interface RiskAssessmentResult {
  score: number;
  level: RiskLevel;
  signals: SignalResult[];
}

/** Pre-fetched inputs for scoring a user. Kept as plain data so the scoring
 *  functions are pure and trivially unit-testable without a database. */
export interface UserRiskContext {
  userId: string;
  accountAgeMs: number;
  /** Transactions (sent or received) within the velocity window. */
  recentTxCount: number;
  /** Jobs the user created within the churn window. */
  recentJobsCreated: number;
  /** Of those, how many were cancelled. */
  recentJobsCancelled: number;
  /** Completed jobs grouped by counterparty. */
  counterparties: CounterpartyStat[];
  /** Near-instant, high-value escrow releases on the user's jobs. */
  instantHighValueReleases: number;
  /** Total escrow releases on the user's jobs (denominator). */
  totalReleases: number;
  /** Other distinct accounts seen on the same IP(s) as this user. */
  sharedIpAccounts: number;
  /** The highest job value this user transacted (for new-account weighting). */
  maxJobValue: number;
}

export interface CounterpartyStat {
  counterpartyId: string;
  /** Completed jobs shared with this counterparty. */
  jobCount: number;
  /** Total value across those shared jobs. */
  totalValue: number;
  /** True if jobs flow in both directions (A→B and B→A) — wash-trading tell. */
  bidirectional: boolean;
}

/** Pre-fetched inputs for scoring a single job. */
export interface JobRiskContext {
  jobId: string;
  budget: number;
  /** funded→released gap in ms, or null if not yet released. */
  fundedToReleasedMs: number | null;
  /** Completed jobs the same client/freelancer pair has shared before. */
  priorPairJobCount: number;
  /** Whether this client/freelancer pair has jobs in both directions. */
  pairBidirectional: boolean;
  /** Client's cancelled jobs within the churn window. */
  clientRecentCancelled: number;
  /** Age of the younger participant account in ms. */
  youngestParticipantAgeMs: number;
}

// ─── Signal computation (pure) ───────────────────────────────────────────────

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

function signal(
  code: SignalCode,
  value: number,
  severity: number,
  detail: string,
): SignalResult {
  return {
    code,
    value,
    severity: clamp01(severity),
    weight: SIGNAL_WEIGHTS[code],
    detail,
  };
}

/**
 * Compute the risk signals for a user from a pre-fetched context. Pure: no IO.
 */
export function computeUserSignals(ctx: UserRiskContext): SignalResult[] {
  const p = SIGNAL_PARAMS;
  const signals: SignalResult[] = [];

  // 1. Transaction velocity — a burst of transactions in a short window.
  signals.push(
    signal(
      "transaction_velocity",
      ctx.recentTxCount,
      ctx.recentTxCount / p.velocitySoftCap,
      `${ctx.recentTxCount} transactions in the last ${p.velocityWindowMs / MINUTE}m`,
    ),
  );

  // 2. Job churn — rapid post/cancel cycles. Weighted by cancellation ratio so
  //    a client who posts many jobs but keeps them open is not penalised.
  const cancelRatio =
    ctx.recentJobsCreated > 0
      ? ctx.recentJobsCancelled / ctx.recentJobsCreated
      : 0;
  const churnSeverity =
    (ctx.recentJobsCancelled / p.churnSoftCap) * (0.5 + 0.5 * cancelRatio);
  signals.push(
    signal(
      "job_churn",
      ctx.recentJobsCancelled,
      churnSeverity,
      `${ctx.recentJobsCancelled}/${ctx.recentJobsCreated} recent jobs cancelled`,
    ),
  );

  // 3. Reciprocal pairing / wash-trading — completed job value concentrated in,
  //    and cycling between, a small set of counterparties.
  const topPair = ctx.counterparties.reduce<CounterpartyStat | null>(
    (best, c) => (best === null || c.jobCount > best.jobCount ? c : best),
    null,
  );
  if (topPair) {
    const repeatSeverity = topPair.jobCount / p.pairRepeatSoftCap;
    // Bidirectional flow between the same two accounts is the classic
    // wash-trading tell; boost severity when present.
    const directionBoost = topPair.bidirectional ? 1 : 0.55;
    signals.push(
      signal(
        "reciprocal_pairing",
        topPair.jobCount,
        repeatSeverity * directionBoost,
        `${topPair.jobCount} completed jobs with a single counterparty` +
          (topPair.bidirectional ? " (bidirectional flow)" : ""),
      ),
    );
  } else {
    signals.push(
      signal("reciprocal_pairing", 0, 0, "No repeated counterparty pairing"),
    );
  }

  // 4. Instant high-value release — money moving through escrow near-instantly
  //    on high-value jobs, which bypasses normal milestone-review behaviour.
  const instantRatio =
    ctx.totalReleases > 0
      ? ctx.instantHighValueReleases / ctx.totalReleases
      : 0;
  signals.push(
    signal(
      "instant_high_value_release",
      ctx.instantHighValueReleases,
      instantRatio,
      `${ctx.instantHighValueReleases}/${ctx.totalReleases} releases were near-instant on high-value jobs`,
    ),
  );

  // 5. Shared IP correlation — potential Sybil / collusion cluster.
  signals.push(
    signal(
      "shared_ip_correlation",
      ctx.sharedIpAccounts,
      ctx.sharedIpAccounts / p.sharedIpSoftCap,
      `${ctx.sharedIpAccounts} other accounts share an IP with this user`,
    ),
  );

  // 6. New account transacting high value — Sybil weighting. Only meaningful
  //    when the account is young AND handling non-trivial value.
  const youngFactor = clamp01(
    1 - ctx.accountAgeMs / p.youngAccountMs,
  );
  const valueFactor = clamp01(ctx.maxJobValue / (p.highValueThreshold * 2));
  signals.push(
    signal(
      "new_account_high_value",
      ctx.maxJobValue,
      youngFactor * valueFactor,
      `Account age ${(ctx.accountAgeMs / HOUR).toFixed(1)}h, max job value ${ctx.maxJobValue}`,
    ),
  );

  return signals;
}

/**
 * Compute the risk signals for a single job from a pre-fetched context. Pure.
 */
export function computeJobSignals(ctx: JobRiskContext): SignalResult[] {
  const p = SIGNAL_PARAMS;
  const signals: SignalResult[] = [];

  // Instant high-value release for this specific job.
  let instantSeverity = 0;
  let instantValue = 0;
  if (ctx.fundedToReleasedMs !== null && ctx.budget >= p.highValueThreshold) {
    instantValue = ctx.fundedToReleasedMs;
    // Severity ramps from 0 (>= instant window) to 1 (released immediately),
    // scaled up for larger budgets.
    const speedFactor = clamp01(
      1 - ctx.fundedToReleasedMs / p.instantReleaseMs,
    );
    const valueFactor = clamp01(ctx.budget / (p.highValueThreshold * 4));
    instantSeverity = speedFactor * (0.6 + 0.4 * valueFactor);
  }
  signals.push(
    signal(
      "instant_high_value_release",
      instantValue,
      instantSeverity,
      ctx.fundedToReleasedMs === null
        ? "Not yet released"
        : `Funded→released in ${(ctx.fundedToReleasedMs / MINUTE).toFixed(1)}m on a ${ctx.budget}-value job`,
    ),
  );

  // Repeat pairing between the same client and freelancer.
  const repeatSeverity =
    (ctx.priorPairJobCount / p.pairRepeatSoftCap) *
    (ctx.pairBidirectional ? 1 : 0.55);
  signals.push(
    signal(
      "pair_concentration",
      ctx.priorPairJobCount,
      repeatSeverity,
      `${ctx.priorPairJobCount} prior completed jobs between this client and freelancer` +
        (ctx.pairBidirectional ? " (bidirectional)" : ""),
    ),
  );

  // Client churn around this job.
  signals.push(
    signal(
      "job_churn",
      ctx.clientRecentCancelled,
      ctx.clientRecentCancelled / p.churnSoftCap,
      `Client cancelled ${ctx.clientRecentCancelled} recent jobs`,
    ),
  );

  // New account handling high value.
  const youngFactor = clamp01(1 - ctx.youngestParticipantAgeMs / p.youngAccountMs);
  const valueFactor = clamp01(ctx.budget / (p.highValueThreshold * 2));
  signals.push(
    signal(
      "new_account_high_value",
      ctx.budget,
      youngFactor * valueFactor,
      `Youngest participant ${(ctx.youngestParticipantAgeMs / HOUR).toFixed(1)}h old on a ${ctx.budget}-value job`,
    ),
  );

  return signals;
}

/**
 * Combine independent signals into a 0–100 score using a weighted noisy-OR:
 *
 *   combined = 1 - Π (1 - severityᵢ · weightᵢ)
 *
 * Properties that make this a better fit than a weighted average for fraud:
 *  - Any single strong, high-weight signal can raise the score on its own
 *    (a lone wash-trading pattern should not be diluted by six quiet signals).
 *  - Independent weak signals still accumulate, but sub-linearly, so ordinary
 *    activity does not stack its way into a flag.
 *  - Bounded in [0, 1] regardless of how many signals are added later.
 */
export function combineSignals(signals: SignalResult[]): number {
  const survival = signals.reduce(
    (acc, s) => acc * (1 - s.severity * s.weight),
    1,
  );
  return clamp01(1 - survival) * 100;
}

export function scoreToLevel(score: number): RiskLevel {
  if (score >= RISK_BANDS.CRITICAL) return "CRITICAL";
  if (score >= RISK_BANDS.HIGH) return "HIGH";
  if (score >= RISK_BANDS.MEDIUM) return "MEDIUM";
  return "LOW";
}

const LEVEL_ORDER: Record<RiskLevel, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

/** True when `level` is at or above the review threshold. */
export function meetsReviewThreshold(level: RiskLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[REVIEW_LEVEL];
}

function assess(signals: SignalResult[]): RiskAssessmentResult {
  const score = Math.round(combineSignals(signals) * 100) / 100;
  return { score, level: scoreToLevel(score), signals };
}

// ─── Context loading (IO) ────────────────────────────────────────────────────

/**
 * Load everything needed to score a user from existing Transaction / Job /
 * EscrowEvent / User / AuditLog data. Isolated from the scoring maths so the
 * feature logic stays pure and testable.
 */
export async function loadUserContext(
  userId: string,
): Promise<UserRiskContext | null> {
  const now = Date.now();
  const p = SIGNAL_PARAMS;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, walletAddress: true, createdAt: true },
  });
  if (!user) return null;

  const velocitySince = new Date(now - p.velocityWindowMs);
  const churnSince = new Date(now - p.churnWindowMs);

  const [
    recentTxCount,
    recentJobsCreated,
    recentJobsCancelled,
    completedAsClient,
    completedAsFreelancer,
    releaseEvents,
    userJobs,
  ] = await Promise.all([
    user.walletAddress
      ? prisma.transaction.count({
          where: {
            createdAt: { gte: velocitySince },
            OR: [
              { fromAddress: user.walletAddress },
              { toAddress: user.walletAddress },
            ],
          },
        })
      : Promise.resolve(0),
    prisma.job.count({
      where: { clientId: userId, createdAt: { gte: churnSince } },
    }),
    prisma.job.count({
      where: {
        clientId: userId,
        createdAt: { gte: churnSince },
        status: "CANCELLED",
      },
    }),
    prisma.job.findMany({
      where: {
        clientId: userId,
        status: "COMPLETED",
        freelancerId: { not: null },
      },
      select: { freelancerId: true, budget: true },
    }),
    prisma.job.findMany({
      where: { freelancerId: userId, status: "COMPLETED" },
      select: { clientId: true, budget: true },
    }),
    prisma.escrowEvent.findMany({
      where: {
        eventType: {
          in: ["JOB_FUNDED", "PAYMENT_RELEASED"],
        },
        job: {
          OR: [{ clientId: userId }, { freelancerId: userId }],
        },
      },
      select: {
        jobId: true,
        eventType: true,
        processedAt: true,
        job: { select: { budget: true } },
      },
    }),
    prisma.job.findMany({
      where: {
        OR: [{ clientId: userId }, { freelancerId: userId }],
      },
      select: { budget: true },
    }),
  ]);

  // Build counterparty statistics: how much completed work flows to/from each
  // other account, and whether it flows in both directions (wash-trading tell).
  const outgoing = new Map<string, { jobCount: number; totalValue: number }>();
  const incoming = new Map<string, { jobCount: number; totalValue: number }>();
  for (const j of completedAsClient) {
    if (!j.freelancerId) continue;
    const cur = outgoing.get(j.freelancerId) ?? { jobCount: 0, totalValue: 0 };
    cur.jobCount += 1;
    cur.totalValue += j.budget ?? 0;
    outgoing.set(j.freelancerId, cur);
  }
  for (const j of completedAsFreelancer) {
    const cur = incoming.get(j.clientId) ?? { jobCount: 0, totalValue: 0 };
    cur.jobCount += 1;
    cur.totalValue += j.budget ?? 0;
    incoming.set(j.clientId, cur);
  }
  const counterpartyIds = new Set([...outgoing.keys(), ...incoming.keys()]);
  const counterparties: CounterpartyStat[] = [...counterpartyIds].map((id) => {
    const out = outgoing.get(id);
    const inc = incoming.get(id);
    return {
      counterpartyId: id,
      jobCount: (out?.jobCount ?? 0) + (inc?.jobCount ?? 0),
      totalValue: (out?.totalValue ?? 0) + (inc?.totalValue ?? 0),
      bidirectional: Boolean(out) && Boolean(inc),
    };
  });

  // Escrow-release timing: pair the latest JOB_FUNDED with the latest
  // PAYMENT_RELEASED per job and measure the gap on high-value jobs.
  const fundedAt = new Map<string, number>();
  const releasedAt = new Map<string, number>();
  const jobBudget = new Map<string, number>();
  for (const e of releaseEvents) {
    jobBudget.set(e.jobId, e.job?.budget ?? 0);
    const ts = e.processedAt.getTime();
    if (e.eventType === "JOB_FUNDED") {
      fundedAt.set(e.jobId, Math.max(fundedAt.get(e.jobId) ?? 0, ts));
    } else {
      releasedAt.set(e.jobId, Math.max(releasedAt.get(e.jobId) ?? 0, ts));
    }
  }
  let instantHighValueReleases = 0;
  let totalReleases = 0;
  for (const [jobId, rel] of releasedAt) {
    totalReleases += 1;
    const funded = fundedAt.get(jobId);
    const budget = jobBudget.get(jobId) ?? 0;
    if (
      funded !== undefined &&
      budget >= p.highValueThreshold &&
      rel - funded <= p.instantReleaseMs
    ) {
      instantHighValueReleases += 1;
    }
  }

  const sharedIpAccounts = await countSharedIpAccounts(userId);
  const maxJobValue = userJobs.reduce((m, j) => Math.max(m, j.budget ?? 0), 0);

  return {
    userId,
    accountAgeMs: now - user.createdAt.getTime(),
    recentTxCount,
    recentJobsCreated,
    recentJobsCancelled,
    counterparties,
    instantHighValueReleases,
    totalReleases,
    sharedIpAccounts,
    maxJobValue,
  };
}

/**
 * Count distinct other accounts that have acted from the same IP address as the
 * given user, using the existing AuditLog IP trail. Degrades gracefully to 0
 * when no IP data is available for the user.
 */
async function countSharedIpAccounts(userId: string): Promise<number> {
  const myIps = await prisma.auditLog.findMany({
    where: { actorId: userId, ipAddress: { not: null } },
    select: { ipAddress: true },
    distinct: ["ipAddress"],
    take: 25,
  });
  const ips = myIps
    .map((r) => r.ipAddress)
    .filter((ip): ip is string => Boolean(ip));
  if (ips.length === 0) return 0;

  const others = await prisma.auditLog.findMany({
    where: { ipAddress: { in: ips }, actorId: { not: userId } },
    select: { actorId: true },
    distinct: ["actorId"],
    take: 50,
  });
  return new Set(
    others.map((r) => r.actorId).filter((a): a is string => Boolean(a)),
  ).size;
}

/** Load everything needed to score a single job. */
export async function loadJobContext(
  jobId: string,
): Promise<JobRiskContext | null> {
  const now = Date.now();
  const p = SIGNAL_PARAMS;

  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      budget: true,
      clientId: true,
      freelancerId: true,
      client: { select: { createdAt: true } },
      freelancer: { select: { createdAt: true } },
    },
  });
  if (!job) return null;

  const [events, clientRecentCancelled, priorForward, priorReverse] =
    await Promise.all([
      prisma.escrowEvent.findMany({
        where: {
          jobId,
          eventType: {
            in: ["JOB_FUNDED", "PAYMENT_RELEASED"],
          },
        },
        select: { eventType: true, processedAt: true },
        orderBy: { processedAt: "asc" },
      }),
      prisma.job.count({
        where: {
          clientId: job.clientId,
          createdAt: { gte: new Date(now - p.churnWindowMs) },
          status: "CANCELLED",
        },
      }),
      job.freelancerId
        ? prisma.job.count({
            where: {
              clientId: job.clientId,
              freelancerId: job.freelancerId,
              status: "COMPLETED",
              id: { not: jobId },
            },
          })
        : Promise.resolve(0),
      job.freelancerId
        ? prisma.job.count({
            where: {
              clientId: job.freelancerId,
              freelancerId: job.clientId,
              status: "COMPLETED",
            },
          })
        : Promise.resolve(0),
    ]);

  let fundedTs: number | null = null;
  let releasedTs: number | null = null;
  for (const e of events) {
    if (e.eventType === "JOB_FUNDED") {
      fundedTs = e.processedAt.getTime();
    } else if (e.eventType === "PAYMENT_RELEASED") {
      releasedTs = e.processedAt.getTime();
    }
  }
  const fundedToReleasedMs =
    fundedTs !== null && releasedTs !== null ? releasedTs - fundedTs : null;

  const ages = [job.client?.createdAt, job.freelancer?.createdAt]
    .filter((d): d is Date => Boolean(d))
    .map((d) => now - d.getTime());
  const youngestParticipantAgeMs = ages.length > 0 ? Math.min(...ages) : Infinity;

  return {
    jobId,
    budget: job.budget ?? 0,
    fundedToReleasedMs,
    priorPairJobCount: priorForward,
    pairBidirectional: priorReverse > 0,
    clientRecentCancelled,
    youngestParticipantAgeMs,
  };
}

// ─── Persistence & orchestration ─────────────────────────────────────────────

/**
 * Score a subject and persist the result. Always writes a `RiskAssessment`
 * (the auditable history). When the score reaches the review threshold, upserts
 * a `RiskFlag` so the subject appears in the admin review queue.
 *
 * Human review outcomes are respected: a subject a reviewer previously marked
 * FALSE_POSITIVE or DISMISSED is *not* silently reopened, unless the new score
 * escalates to CRITICAL (a materially stronger signal than what was dismissed).
 */
export async function scoreAndPersist(input: {
  subjectType: RiskSubjectType;
  subjectId: string;
  trigger: RiskTrigger;
  signals: SignalResult[];
}): Promise<RiskAssessmentResult & { flagged: boolean }> {
  const { subjectType, subjectId, trigger, signals } = input;
  const result = assess(signals);

  let flagId: string | null = null;
  let flagged = false;

  if (meetsReviewThreshold(result.level)) {
    const existing = await prisma.riskFlag.findUnique({
      where: { subjectType_subjectId: { subjectType, subjectId } },
      select: { id: true, status: true, currentLevel: true },
    });

    const reviewerLocked =
      existing?.status === "FALSE_POSITIVE" ||
      existing?.status === "DISMISSED";
    const escalatesToCritical =
      result.level === "CRITICAL" &&
      existing?.currentLevel !== "CRITICAL";

    const nextStatus =
      reviewerLocked && !escalatesToCritical
        ? existing!.status
        : "OPEN";

    const flag = await prisma.riskFlag.upsert({
      where: { subjectType_subjectId: { subjectType, subjectId } },
      create: {
        subjectType,
        subjectId,
        currentScore: result.score,
        currentLevel: result.level,
        status: "OPEN",
      },
      update: {
        currentScore: result.score,
        currentLevel: result.level,
        status: nextStatus,
      },
      select: { id: true },
    });
    flagId = flag.id;
    flagged = true;
  }

  await prisma.riskAssessment.create({
    data: {
      subjectType,
      subjectId,
      score: result.score,
      level: result.level,
      signals: result.signals as unknown as object[],
      trigger,
      flagId,
    },
  });

  return { ...result, flagged };
}

/** Score a user by id and persist. Returns null if the user does not exist. */
export async function assessUser(
  userId: string,
  trigger: RiskTrigger,
): Promise<(RiskAssessmentResult & { flagged: boolean }) | null> {
  const ctx = await loadUserContext(userId);
  if (!ctx) return null;
  return scoreAndPersist({
    subjectType: "USER",
    subjectId: userId,
    trigger,
    signals: computeUserSignals(ctx),
  });
}

/** Score a job by id and persist. Returns null if the job does not exist. */
export async function assessJob(
  jobId: string,
  trigger: RiskTrigger,
): Promise<(RiskAssessmentResult & { flagged: boolean }) | null> {
  const ctx = await loadJobContext(jobId);
  if (!ctx) return null;
  return scoreAndPersist({
    subjectType: "JOB",
    subjectId: jobId,
    trigger,
    signals: computeJobSignals(ctx),
  });
}

// ─── Non-blocking real-time hooks ────────────────────────────────────────────

/**
 * Run a scoring task without ever throwing into, or blocking, the caller's
 * critical path. Errors are logged and swallowed — a failure of the fraud
 * subsystem must never break job creation or escrow release.
 */
function fireAndForget(label: string, task: () => Promise<unknown>): void {
  void Promise.resolve()
    .then(task)
    .catch((err) => {
      logger.error(
        { err, hook: label },
        "[FraudDetectionService] scoring hook failed (non-fatal)",
      );
    });
}

/**
 * Hook for the job-creation path. Scores the new job and its client in the
 * background. Safe to call with `void` — returns immediately.
 */
export function onJobCreated(jobId: string, clientId: string): void {
  fireAndForget("onJobCreated", async () => {
    await assessJob(jobId, "JOB_CREATED");
    await assessUser(clientId, "JOB_CREATED");
  });
}

/**
 * Hook for the escrow-release path. Scores the job and both participants in the
 * background so time-sensitive release patterns are caught near-real-time.
 */
export function onEscrowReleased(
  jobId: string,
  participantIds: string[] = [],
): void {
  fireAndForget("onEscrowReleased", async () => {
    await assessJob(jobId, "ESCROW_RELEASE");
    for (const id of participantIds) {
      await assessUser(id, "ESCROW_RELEASE");
    }
  });
}

// ─── Admin review queue ──────────────────────────────────────────────────────

export interface FlagQuery {
  status?: RiskFlagStatus;
  level?: RiskLevel;
  subjectType?: RiskSubjectType;
  page?: number;
  pageSize?: number;
}

/** List review-queue flags, newest activity first. */
export async function listFlags(query: FlagQuery = {}) {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));

  const where = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.level ? { currentLevel: query.level } : {}),
    ...(query.subjectType ? { subjectType: query.subjectType } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.riskFlag.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.riskFlag.count({ where }),
  ]);

  return { items, total, page, pageSize };
}

/** Fetch a flag together with its full assessment history for reviewer context. */
export async function getFlagWithHistory(flagId: string, historyLimit = 50) {
  const flag = await prisma.riskFlag.findUnique({ where: { id: flagId } });
  if (!flag) return null;

  const history = await prisma.riskAssessment.findMany({
    where: { subjectType: flag.subjectType, subjectId: flag.subjectId },
    orderBy: { createdAt: "desc" },
    take: historyLimit,
  });

  return { flag, history };
}

export interface HistoryQuery {
  page?: number;
  pageSize?: number;
}

/** Default page size for subject history; callers page past it with `page`. */
export const HISTORY_DEFAULT_PAGE_SIZE = 50;
export const HISTORY_MAX_PAGE_SIZE = 100;

/**
 * Assessment history for any subject, whether or not it was ever flagged.
 * Newest first, paginated; `total` lets callers tell when more rows exist.
 */
export async function getSubjectHistory(
  subjectType: RiskSubjectType,
  subjectId: string,
  query: HistoryQuery = {},
) {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(
    HISTORY_MAX_PAGE_SIZE,
    Math.max(1, query.pageSize ?? HISTORY_DEFAULT_PAGE_SIZE),
  );
  const where = { subjectType, subjectId };

  const [items, total] = await Promise.all([
    prisma.riskAssessment.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.riskAssessment.count({ where }),
  ]);

  return { items, total, page, pageSize, hasMore: page * pageSize < total };
}

const TERMINAL_REVIEW_STATUSES: RiskFlagStatus[] = [
  "CONFIRMED",
  "FALSE_POSITIVE",
  "DISMISSED",
];

/**
 * Record a reviewer's decision on a flag. Marking a flag FALSE_POSITIVE (or
 * DISMISSED) captures the human feedback that feeds threshold tuning via
 * {@link getFalsePositiveStats}. This is the only place a flag's lifecycle
 * advances — nothing here blocks or suspends the underlying subject.
 */
export async function reviewFlag(
  flagId: string,
  input: { status: RiskFlagStatus; reviewerId: string; note?: string },
) {
  const flag = await prisma.riskFlag.findUnique({ where: { id: flagId } });
  if (!flag) return null;

  return prisma.riskFlag.update({
    where: { id: flagId },
    data: {
      status: input.status,
      reviewedById: input.reviewerId,
      reviewedAt: new Date(),
      reviewNote: input.note ?? null,
    },
  });
}

/**
 * Aggregate false-positive feedback for threshold calibration. Answers "of the
 * flags reviewers have closed, how many were false positives, broken down by
 * the risk level we assigned?" — the core input for tuning
 * {@link SIGNAL_WEIGHTS} and {@link RISK_BANDS}.
 */
export async function getFalsePositiveStats() {
  const grouped = await prisma.riskFlag.groupBy({
    by: ["currentLevel", "status"],
    where: { status: { in: TERMINAL_REVIEW_STATUSES } },
    _count: { _all: true },
  });

  const byLevel: Record<
    string,
    { reviewed: number; falsePositive: number; falsePositiveRate: number }
  > = {};
  for (const row of grouped) {
    const bucket =
      byLevel[row.currentLevel] ??
      (byLevel[row.currentLevel] = {
        reviewed: 0,
        falsePositive: 0,
        falsePositiveRate: 0,
      });
    bucket.reviewed += row._count._all;
    if (row.status === "FALSE_POSITIVE") {
      bucket.falsePositive += row._count._all;
    }
  }
  for (const bucket of Object.values(byLevel)) {
    bucket.falsePositiveRate =
      bucket.reviewed > 0 ? bucket.falsePositive / bucket.reviewed : 0;
  }

  return { byLevel, thresholds: RISK_BANDS, weights: SIGNAL_WEIGHTS };
}

export const FraudDetectionService = {
  // scoring (pure)
  computeUserSignals,
  computeJobSignals,
  combineSignals,
  scoreToLevel,
  meetsReviewThreshold,
  // orchestration
  assessUser,
  assessJob,
  scoreAndPersist,
  loadUserContext,
  loadJobContext,
  // hooks
  onJobCreated,
  onEscrowReleased,
  // admin queue
  listFlags,
  getFlagWithHistory,
  getSubjectHistory,
  reviewFlag,
  getFalsePositiveStats,
  // config
  RISK_BANDS,
  SIGNAL_WEIGHTS,
  SIGNAL_PARAMS,
  REVIEW_LEVEL,
};
