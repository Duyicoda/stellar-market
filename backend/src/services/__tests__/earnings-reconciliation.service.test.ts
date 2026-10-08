/**
 * Tests for the earnings reconciliation cache migration and automated
 * remediation (issue #874):
 *
 *  - The Horizon payment cache is Redis-backed and shared across backend
 *    instances, not a per-process Map — a cache write triggered by "instance A"
 *    is visible to "instance B" without a second Horizon fetch.
 *  - `onChainOnly` discrepancies are automatically, idempotently backfilled
 *    into the DB and every backfill is recorded in the audit trail.
 *  - `dbOnly` discrepancies are flagged for manual review, never auto-deleted
 *    or mutated.
 */

// ─── Prisma mock ─────────────────────────────────────────────────────────────

const mockTransaction = {
  findMany: jest.fn(),
  findUnique: jest.fn(),
  upsert: jest.fn(),
};
const mockJob = {
  findUnique: jest.fn(),
};

jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    transaction: mockTransaction,
    job: mockJob,
  })),
}));

// ─── Shared fake Redis — a single in-memory store simulating the ONE real
// Redis server every backend instance connects to. Two calls into
// `fetchOnChainPayments` in this file both hit this same object, exactly as
// two separate backend processes would both hit the same external Redis. ───

const fakeRedisStore = new Map<string, string>();
const fakeRedis = {
  get: jest.fn(async (key: string) => fakeRedisStore.get(key) ?? null),
  setex: jest.fn(async (key: string, _ttl: number, value: string) => {
    fakeRedisStore.set(key, value);
    return "OK";
  }),
  del: jest.fn(async (...keys: string[]) => {
    let count = 0;
    for (const k of keys) {
      if (fakeRedisStore.delete(k)) count += 1;
    }
    return count;
  }),
  keys: jest.fn(async () => Array.from(fakeRedisStore.keys())),
};

jest.mock("../../lib/redis", () => ({
  __esModule: true,
  default: {
    isRedisConnected: jest.fn(() => true),
    getInstance: jest.fn(() => fakeRedis),
    connect: jest.fn(async () => {}),
  },
}));

jest.mock("../../lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock("../../config", () => ({
  config: { stellar: { horizonUrl: "https://horizon-testnet.stellar.org" } },
}));

// ─── Audit service mock ──────────────────────────────────────────────────────

const mockAuditRecord = jest.fn();
jest.mock("../audit.service", () => ({
  AuditService: { record: (...args: unknown[]) => mockAuditRecord(...args) },
}));

// ─── Horizon SDK mock ────────────────────────────────────────────────────────
//
// Models the exact chain fetchOnChainPayments calls:
//   server.payments().forAccount(w).order("asc").limit(n).call()
// then repeatedly `.next()` until a page comes back empty.

interface FakeHorizonRecord {
  type: string;
  to?: string;
  from?: string;
  amount?: string;
  asset_type?: string;
  asset_code?: string;
  created_at: string;
  transaction_hash: string;
  transaction: () => Promise<{ memo_type?: string; memo?: string }>;
}

let horizonPages: FakeHorizonRecord[][] = [[]];
let horizonCallCount = 0;

function buildPage(index: number) {
  const records = horizonPages[index] ?? [];
  return {
    records,
    next: async () => buildPage(index + 1),
  };
}

jest.mock("@stellar/stellar-sdk", () => ({
  Horizon: {
    Server: jest.fn().mockImplementation(() => ({
      payments: () => ({
        forAccount: () => ({
          order: () => ({
            limit: () => ({
              call: async () => {
                horizonCallCount += 1;
                return buildPage(0);
              },
            }),
          }),
        }),
      }),
    })),
  },
}));

// ─── Import after mocks are in place ────────────────────────────────────────

import {
  fetchOnChainPayments,
  remediateOnChainOnly,
  flagDbOnlyForReview,
  type OnChainOnlyEarning,
  type DbOnlyEarning,
} from "../earnings-reconciliation.service";

function makeMemoRecord(overrides: Partial<FakeHorizonRecord> = {}): FakeHorizonRecord {
  return {
    type: "payment",
    to: "GFREELANCER",
    from: "GCLIENT",
    amount: "100.0000000",
    asset_type: "native",
    created_at: "2026-01-10T00:00:00Z",
    transaction_hash: "HASH_A",
    transaction: async () => ({ memo_type: "text", memo: "job-1" }),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  fakeRedisStore.clear();
  horizonPages = [[]];
  horizonCallCount = 0;
});

// ─── Cross-instance Redis cache sharing ──────────────────────────────────────

describe("fetchOnChainPayments — shared Redis cache across backend instances", () => {
  it("a cache write from one simulated instance is visible to another, without a second Horizon fetch", async () => {
    horizonPages = [[makeMemoRecord()]];

    const from = new Date("2026-01-01T00:00:00Z");
    const to = new Date("2026-01-31T00:00:00Z");

    // "Instance A" handles the first request: cache miss, fetches Horizon,
    // and writes the result into the shared Redis store.
    const resultFromInstanceA = await fetchOnChainPayments("GFREELANCER", from, to);
    expect(horizonCallCount).toBe(1);
    expect(resultFromInstanceA).toHaveLength(1);
    expect(resultFromInstanceA[0].txHash).toBe("HASH_A");

    // Prove the write actually landed in the shared store, not some
    // per-call/in-memory structure private to the first call.
    expect(fakeRedisStore.size).toBe(1);

    // "Instance B": a *separate* call simulating a different backend process.
    // It reads from the exact same fakeRedisStore Map — the thing standing in
    // for the one real Redis server both instances would be connected to.
    // Unlike the old per-process Map cache, this must be a cache HIT.
    const resultFromInstanceB = await fetchOnChainPayments("GFREELANCER", from, to);

    expect(horizonCallCount).toBe(1); // no second Horizon call — served from Redis
    expect(resultFromInstanceB).toEqual(resultFromInstanceA);
  });

  it("falls back to a direct Horizon fetch (not a crash) when Redis is unreachable", async () => {
    const RedisClient = (
      jest.requireMock("../../lib/redis") as {
        default: { isRedisConnected: jest.Mock; connect: jest.Mock };
      }
    ).default;
    RedisClient.isRedisConnected.mockReturnValue(false);
    RedisClient.connect.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    horizonPages = [[makeMemoRecord({ transaction_hash: "HASH_NOCACHE" })]];

    const result = await fetchOnChainPayments(
      "GFREELANCER",
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-01-31T00:00:00Z"),
    );

    expect(result[0].txHash).toBe("HASH_NOCACHE");
    expect(horizonCallCount).toBe(1);
  });
});

// ─── Idempotent onChainOnly remediation ──────────────────────────────────────

describe("remediateOnChainOnly — idempotent backfill", () => {
  const payment: OnChainOnlyEarning = {
    txHash: "HASH_ONCHAIN_ONLY",
    memoJobId: "job-42",
    amount: 250,
    assetCode: "XLM",
    createdAt: "2026-01-15T12:00:00.000Z",
    horizonUrl: "https://horizon-testnet.stellar.org/transactions/HASH_ONCHAIN_ONLY",
  };

  it("backfills a missing Transaction row and records an audit entry on first remediation", async () => {
    mockTransaction.findUnique.mockResolvedValueOnce(null); // not present yet
    mockJob.findUnique.mockResolvedValueOnce({ id: "job-42" });
    mockTransaction.upsert.mockResolvedValueOnce({});

    const outcome = await remediateOnChainOnly("GFREELANCER", payment);

    expect(outcome).toBe("created");
    expect(mockTransaction.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { txHash: "HASH_ONCHAIN_ONLY" },
        update: {},
        create: expect.objectContaining({
          txHash: "HASH_ONCHAIN_ONLY",
          jobId: "job-42",
          toAddress: "GFREELANCER",
          amount: 250,
          type: "RELEASE",
          status: "SUCCESS",
          createdAt: new Date("2026-01-15T12:00:00.000Z"),
        }),
      }),
    );
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "ADMIN_ACTION",
        action: "earnings_reconciliation.onchain_only_backfilled",
        actorId: "system",
        target: "HASH_ONCHAIN_ONLY",
      }),
    );
  });

  it("does not create a duplicate record or a second audit entry when run again for the same txHash", async () => {
    // Second call: the row is now present (findUnique returns it).
    mockTransaction.findUnique.mockResolvedValueOnce({ id: "existing-row" });
    mockJob.findUnique.mockResolvedValueOnce({ id: "job-42" });
    mockTransaction.upsert.mockResolvedValueOnce({});

    const outcome = await remediateOnChainOnly("GFREELANCER", payment);

    expect(outcome).toBe("already_remediated");
    // The upsert's `update: {}` means an existing row is never overwritten —
    // still called (upsert is what makes it idempotent), but no new audit
    // entry should be written for a replay.
    expect(mockTransaction.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: {} }),
    );
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("leaves jobId null when the memo does not name a real job", async () => {
    mockTransaction.findUnique.mockResolvedValueOnce(null);
    mockJob.findUnique.mockResolvedValueOnce(null); // memo job doesn't exist
    mockTransaction.upsert.mockResolvedValueOnce({});

    await remediateOnChainOnly("GFREELANCER", { ...payment, memoJobId: "bogus-job-id" });

    expect(mockTransaction.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ jobId: null }) }),
    );
  });

  it("preserves the on-chain settlement date rather than the backfill's insertion time", async () => {
    mockTransaction.findUnique.mockResolvedValueOnce(null);
    mockJob.findUnique.mockResolvedValueOnce(null);
    mockTransaction.upsert.mockResolvedValueOnce({});

    await remediateOnChainOnly("GFREELANCER", payment);

    const createArg = mockTransaction.upsert.mock.calls[0][0].create;
    expect(createArg.createdAt.toISOString()).toBe("2026-01-15T12:00:00.000Z");
  });
});

// ─── dbOnly — cautious, non-destructive handling ─────────────────────────────

describe("flagDbOnlyForReview — never auto-deletes", () => {
  const dbOnlyRecord: DbOnlyEarning = {
    txHash: "HASH_DB_ONLY",
    jobId: "job-7",
    jobTitle: "Landing page",
    amount: 80,
    createdAt: "2026-01-05T00:00:00.000Z",
  };

  it("records an audit entry and never calls delete/update on the Transaction row", async () => {
    await flagDbOnlyForReview("GFREELANCER", dbOnlyRecord);

    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "ADMIN_ACTION",
        action: "earnings_reconciliation.db_only_flagged_for_review",
        actorId: "system",
        target: "HASH_DB_ONLY",
        metadata: expect.objectContaining({ jobId: "job-7", amount: 80 }),
      }),
    );

    // The whole point of the cautious path: nothing destructive ever happens
    // to the Transaction table for a dbOnly record.
    expect(mockTransaction.upsert).not.toHaveBeenCalled();
    // No delete method exists on the mock at all — flagging must never call
    // one, so there is nothing wired up for it to reach.
    expect((mockTransaction as Record<string, unknown>).delete).toBeUndefined();
  });
});
