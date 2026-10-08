interface MockFraudPrismaClient {
  user: { findUnique: jest.Mock };
  job: { findUnique: jest.Mock; findMany: jest.Mock; count: jest.Mock };
  transaction: { count: jest.Mock };
  escrowEvent: { findMany: jest.Mock };
  auditLog: { findMany: jest.Mock };
  riskFlag: {
    findUnique: jest.Mock;
    upsert: jest.Mock;
    update: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    groupBy: jest.Mock;
  };
  riskAssessment: { create: jest.Mock; findMany: jest.Mock };
}

// Mock the Prisma client so the service's `new PrismaClient()` returns a mock we
// control. Enums are kept real via requireActual so the scoring maths and level
// comparisons behave exactly as in production.
jest.mock("@prisma/client", () => {
  const actual = jest.requireActual("@prisma/client");
  const mockPrisma: MockFraudPrismaClient = {
    user: { findUnique: jest.fn() },
    job: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    transaction: { count: jest.fn() },
    escrowEvent: { findMany: jest.fn() },
    auditLog: { findMany: jest.fn() },
    riskFlag: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      groupBy: jest.fn(),
    },
    riskAssessment: { create: jest.fn(), findMany: jest.fn() },
  };
  return {
    ...actual,
    PrismaClient: jest.fn(() => mockPrisma),
    __mockPrisma: mockPrisma,
  };
});

jest.mock("../../lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { RiskLevel, RiskSubjectType, RiskTrigger, RiskFlagStatus } from "@prisma/client";
import { logger } from "../../lib/logger";
import {
  computeUserSignals,
  computeJobSignals,
  combineSignals,
  scoreToLevel,
  meetsReviewThreshold,
  scoreAndPersist,
  onEscrowReleased,
  reviewFlag,
  getFalsePositiveStats,
  RISK_BANDS,
  REVIEW_LEVEL,
  UserRiskContext,
  JobRiskContext,
  SignalResult,
} from "../fraud-detection.service";

// The mock object created inside jest.mock above.
const prismaMock = (
  jest.requireMock("@prisma/client") as unknown as { __mockPrisma: MockFraudPrismaClient }
).__mockPrisma;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function baseUserContext(overrides: Partial<UserRiskContext> = {}): UserRiskContext {
  return {
    userId: "user-1",
    accountAgeMs: 400 * DAY, // established account
    recentTxCount: 0,
    recentJobsCreated: 0,
    recentJobsCancelled: 0,
    counterparties: [],
    instantHighValueReleases: 0,
    totalReleases: 0,
    sharedIpAccounts: 0,
    maxJobValue: 0,
    ...overrides,
  };
}

function baseJobContext(overrides: Partial<JobRiskContext> = {}): JobRiskContext {
  return {
    jobId: "job-1",
    budget: 100,
    fundedToReleasedMs: null,
    priorPairJobCount: 0,
    pairBidirectional: false,
    clientRecentCancelled: 0,
    youngestParticipantAgeMs: 400 * DAY,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("scoring model (pure)", () => {
  it("combines signals with a bounded noisy-OR and maps to levels", () => {
    expect(combineSignals([])).toBe(0);
    expect(scoreToLevel(0)).toBe(RiskLevel.LOW);
    expect(scoreToLevel(RISK_BANDS.MEDIUM)).toBe(RiskLevel.MEDIUM);
    expect(scoreToLevel(RISK_BANDS.HIGH)).toBe(RiskLevel.HIGH);
    expect(scoreToLevel(RISK_BANDS.CRITICAL)).toBe(RiskLevel.CRITICAL);
    // A single strong signal is not diluted by many quiet ones.
    const strong: SignalResult[] = [
      { code: "reciprocal_pairing", value: 6, severity: 1, weight: 0.85, detail: "" },
      { code: "transaction_velocity", value: 0, severity: 0, weight: 0.4, detail: "" },
    ];
    expect(combineSignals(strong)).toBeGreaterThanOrEqual(RISK_BANDS.HIGH);
  });

  it("flags a wash-trading pattern with a meaningfully elevated score", () => {
    // Two accounts repeatedly creating and instantly completing high-value jobs
    // between each other.
    const ctx = baseUserContext({
      recentTxCount: 25,
      counterparties: [
        { counterpartyId: "user-2", jobCount: 6, totalValue: 12000, bidirectional: true },
      ],
      instantHighValueReleases: 8,
      totalReleases: 8,
      maxJobValue: 3000,
      accountAgeMs: 2 * DAY,
    });

    const signals = computeUserSignals(ctx);
    const score = combineSignals(signals);

    expect(score).toBeGreaterThanOrEqual(RISK_BANDS.CRITICAL);
    expect(meetsReviewThreshold(scoreToLevel(score))).toBe(true);

    // The dominant contributor is the reciprocal-pairing (wash-trading) signal.
    const pairing = signals.find((s) => s.code === "reciprocal_pairing")!;
    expect(pairing.severity).toBeGreaterThan(0.9);
  });

  it("does NOT flag a legitimately busy, high-volume freelancer (false-positive guard)", () => {
    // High transaction volume and many completed jobs, but spread across many
    // distinct counterparties, no instant releases, no collusion signals.
    const ctx = baseUserContext({
      recentTxCount: 18, // busy but not saturated
      recentJobsCreated: 12,
      recentJobsCancelled: 0,
      counterparties: [
        { counterpartyId: "c1", jobCount: 2, totalValue: 400, bidirectional: false },
        { counterpartyId: "c2", jobCount: 1, totalValue: 150, bidirectional: false },
        { counterpartyId: "c3", jobCount: 3, totalValue: 900, bidirectional: false },
        { counterpartyId: "c4", jobCount: 1, totalValue: 200, bidirectional: false },
      ],
      instantHighValueReleases: 0,
      totalReleases: 15,
      maxJobValue: 800,
      accountAgeMs: 300 * DAY,
    });

    const score = combineSignals(computeUserSignals(ctx));

    expect(score).toBeLessThan(RISK_BANDS.HIGH); // below the review threshold
    expect(meetsReviewThreshold(scoreToLevel(score))).toBe(false);
  });

  it("scores an instant high-value escrow release on a repeat pair as elevated", () => {
    const ctx = baseJobContext({
      budget: 4000,
      fundedToReleasedMs: 30 * 1000, // released 30s after funding
      priorPairJobCount: 6,
      pairBidirectional: true,
    });
    const signals = computeJobSignals(ctx);
    const score = combineSignals(signals);

    expect(score).toBeGreaterThanOrEqual(RISK_BANDS.HIGH);
    const instant = signals.find((s) => s.code === "instant_high_value_release")!;
    expect(instant.severity).toBeGreaterThan(0.5);
  });

  it("does not treat a normal-paced release as instant", () => {
    const ctx = baseJobContext({
      budget: 4000,
      fundedToReleasedMs: 5 * DAY, // reviewed over days — normal
      priorPairJobCount: 0,
    });
    const signals = computeJobSignals(ctx);
    const instant = signals.find((s) => s.code === "instant_high_value_release")!;
    expect(instant.severity).toBe(0);
  });
});

describe("scoreAndPersist (persistence & review queue)", () => {
  it("persists the assessment AND enqueues a flag when above the review threshold", async () => {
    prismaMock.riskFlag.findUnique.mockResolvedValue(null);
    prismaMock.riskFlag.upsert.mockResolvedValue({ id: "flag-1" });
    prismaMock.riskAssessment.create.mockResolvedValue({ id: "assess-1" });

    const signals = computeUserSignals(
      baseUserContext({
        counterparties: [
          { counterpartyId: "u2", jobCount: 6, totalValue: 12000, bidirectional: true },
        ],
        instantHighValueReleases: 5,
        totalReleases: 5,
      }),
    );

    const result = await scoreAndPersist({
      subjectType: RiskSubjectType.USER,
      subjectId: "user-1",
      trigger: RiskTrigger.ESCROW_RELEASE,
      signals,
    });

    expect(result.flagged).toBe(true);
    expect(meetsReviewThreshold(result.level)).toBe(true);

    // The score AND its contributing signals are persisted, not just computed.
    expect(prismaMock.riskAssessment.create).toHaveBeenCalledTimes(1);
    const created = prismaMock.riskAssessment.create.mock.calls[0][0].data;
    expect(created.subjectId).toBe("user-1");
    expect(created.flagId).toBe("flag-1");
    expect(Array.isArray(created.signals)).toBe(true);
    expect(created.signals.length).toBeGreaterThan(0);

    // The subject is surfaced for human review.
    expect(prismaMock.riskFlag.upsert).toHaveBeenCalledTimes(1);
  });

  it("persists a low-risk assessment WITHOUT creating a review flag", async () => {
    prismaMock.riskAssessment.create.mockResolvedValue({ id: "assess-2" });

    const result = await scoreAndPersist({
      subjectType: RiskSubjectType.USER,
      subjectId: "user-3",
      trigger: RiskTrigger.JOB_CREATED,
      signals: computeUserSignals(baseUserContext()),
    });

    expect(result.flagged).toBe(false);
    expect(prismaMock.riskAssessment.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.riskFlag.upsert).not.toHaveBeenCalled();
  });

  it("respects a prior FALSE_POSITIVE review and does not reopen it for a non-critical score", async () => {
    prismaMock.riskFlag.findUnique.mockResolvedValue({
      id: "flag-9",
      status: RiskFlagStatus.FALSE_POSITIVE,
      currentLevel: RiskLevel.HIGH,
    });
    prismaMock.riskFlag.upsert.mockResolvedValue({ id: "flag-9" });
    prismaMock.riskAssessment.create.mockResolvedValue({ id: "a" });

    // A HIGH (not CRITICAL) score.
    const signals: SignalResult[] = [
      { code: "reciprocal_pairing", value: 5, severity: 0.8, weight: 0.85, detail: "" },
    ];
    await scoreAndPersist({
      subjectType: RiskSubjectType.USER,
      subjectId: "user-9",
      trigger: RiskTrigger.BATCH,
      signals,
    });

    const updateArg = prismaMock.riskFlag.upsert.mock.calls[0][0].update;
    expect(updateArg.status).toBe(RiskFlagStatus.FALSE_POSITIVE);
  });
});

describe("real-time hooks are non-blocking", () => {
  it("onEscrowReleased never throws and swallows downstream errors", async () => {
    // Force the scoring path to blow up.
    prismaMock.job.findUnique.mockRejectedValue(new Error("db down"));

    // Must not throw synchronously and must return void immediately.
    expect(() => onEscrowReleased("job-x", ["user-1", "user-2"])).not.toThrow();

    // Let the fire-and-forget microtasks settle.
    await new Promise((resolve) => setImmediate(resolve));

    // The failure was logged, not propagated.
    expect(logger.error).toHaveBeenCalled();
  });
});

describe("false-positive feedback loop", () => {
  it("records a FALSE_POSITIVE decision with reviewer and note", async () => {
    prismaMock.riskFlag.findUnique.mockResolvedValue({ id: "flag-1" });
    prismaMock.riskFlag.update.mockResolvedValue({
      id: "flag-1",
      status: RiskFlagStatus.FALSE_POSITIVE,
      subjectType: RiskSubjectType.USER,
      subjectId: "user-1",
    });

    const updated = await reviewFlag("flag-1", {
      status: RiskFlagStatus.FALSE_POSITIVE,
      reviewerId: "admin-1",
      note: "Known agency with many legitimate clients",
    });

    expect(updated).not.toBeNull();
    const data = prismaMock.riskFlag.update.mock.calls[0][0].data;
    expect(data.status).toBe(RiskFlagStatus.FALSE_POSITIVE);
    expect(data.reviewedById).toBe("admin-1");
    expect(data.reviewNote).toContain("agency");
    expect(data.reviewedAt).toBeInstanceOf(Date);
  });

  it("aggregates false-positive rates by level for threshold tuning", async () => {
    prismaMock.riskFlag.groupBy.mockResolvedValue([
      { currentLevel: RiskLevel.HIGH, status: RiskFlagStatus.FALSE_POSITIVE, _count: { _all: 3 } },
      { currentLevel: RiskLevel.HIGH, status: RiskFlagStatus.CONFIRMED, _count: { _all: 1 } },
      { currentLevel: RiskLevel.CRITICAL, status: RiskFlagStatus.CONFIRMED, _count: { _all: 5 } },
    ]);

    const stats = await getFalsePositiveStats();

    expect(stats.byLevel.HIGH.reviewed).toBe(4);
    expect(stats.byLevel.HIGH.falsePositive).toBe(3);
    expect(stats.byLevel.HIGH.falsePositiveRate).toBeCloseTo(0.75);
    expect(stats.byLevel.CRITICAL.falsePositiveRate).toBe(0);
    // The current thresholds are echoed back so tuners see what produced these.
    expect(stats.thresholds).toEqual(RISK_BANDS);
  });
});

describe("configuration sanity", () => {
  it("uses HIGH as the review threshold", () => {
    expect(REVIEW_LEVEL).toBe(RiskLevel.HIGH);
  });
});
