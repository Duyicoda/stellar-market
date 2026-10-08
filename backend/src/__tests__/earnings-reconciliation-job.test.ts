/**
 * Tests for the proactive earnings reconciliation background job (issue #874).
 *
 * The whole point of this job is to catch and fix discrepancies for
 * freelancers who are *not* currently loading the earnings page — these tests
 * call the sweep directly and never touch the `/earnings/reconcile` route, to
 * prove reconciliation genuinely happens without a page load.
 */

const mockUser = {
  findMany: jest.fn(),
};

jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    user: mockUser,
  })),
}));

jest.mock("../lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockReconcileAndRemediate = jest.fn();
jest.mock("../services/earnings-reconciliation.service", () => ({
  reconcileAndRemediate: (...args: unknown[]) => mockReconcileAndRemediate(...args),
}));

import { runEarningsReconciliationSweep } from "../jobs/earnings-reconciliation.job";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("runEarningsReconciliationSweep", () => {
  it("reconciles an inactive freelancer (no page load) purely from the scheduled sweep", async () => {
    const inactiveFreelancer = {
      id: "freelancer-inactive-1",
      walletAddress: "GINACTIVE1",
    };
    mockUser.findMany.mockResolvedValue([inactiveFreelancer]);
    mockReconcileAndRemediate.mockResolvedValue({
      range: { from: "2026-01-01T00:00:00.000Z", to: "2026-01-03T00:00:00.000Z" },
      summary: {
        onChainCount: 1,
        dbCount: 0,
        matchedCount: 0,
        onChainOnlyCount: 1,
        dbOnlyCount: 0,
        allMatched: false,
      },
      matched: [],
      onChainOnly: [
        {
          txHash: "HASH_INACTIVE_USER_PAYMENT",
          memoJobId: null,
          amount: 300,
          assetCode: "XLM",
          createdAt: "2026-01-02T00:00:00.000Z",
          horizonUrl: "https://horizon-testnet.stellar.org/transactions/HASH_INACTIVE_USER_PAYMENT",
        },
      ],
      dbOnly: [],
      remediation: { backfilled: 1, alreadyRemediated: 0, flaggedForReview: 0 },
    });

    // No route, no request, no page load — only the sweep itself.
    await runEarningsReconciliationSweep();

    expect(mockUser.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          role: "FREELANCER",
          walletAddress: { not: null },
          deletedAt: null,
          isSuspended: false,
        }),
      }),
    );
    expect(mockReconcileAndRemediate).toHaveBeenCalledTimes(1);
    expect(mockReconcileAndRemediate).toHaveBeenCalledWith(
      "GINACTIVE1",
      expect.any(Date),
      expect.any(Date),
    );
  });

  it("reconciles active freelancers in batches and does not stop the sweep when one fails", async () => {
    const freelancers = Array.from({ length: 30 }, (_, i) => ({
      id: `freelancer-${i}`,
      walletAddress: `GWALLET${i}`,
    }));
    mockUser.findMany.mockResolvedValue(freelancers);

    mockReconcileAndRemediate.mockImplementation(async (wallet: string) => {
      if (wallet === "GWALLET5") {
        throw new Error("Horizon unreachable for this wallet");
      }
      return {
        range: { from: "", to: "" },
        summary: {
          onChainCount: 0,
          dbCount: 0,
          matchedCount: 0,
          onChainOnlyCount: 0,
          dbOnlyCount: 0,
          allMatched: true,
        },
        matched: [],
        onChainOnly: [],
        dbOnly: [],
        remediation: { backfilled: 0, alreadyRemediated: 0, flaggedForReview: 0 },
      };
    });

    await expect(runEarningsReconciliationSweep()).resolves.not.toThrow();

    // All 30 freelancers attempted despite one failure among them.
    expect(mockReconcileAndRemediate).toHaveBeenCalledTimes(30);
  });

  it("does nothing when there are no active freelancers", async () => {
    mockUser.findMany.mockResolvedValue([]);

    await runEarningsReconciliationSweep();

    expect(mockReconcileAndRemediate).not.toHaveBeenCalled();
  });

  it("skips freelancers without a wallet address at the query level", async () => {
    mockUser.findMany.mockResolvedValue([{ id: "freelancer-no-wallet", walletAddress: null }]);

    await runEarningsReconciliationSweep();

    // The where-clause already excludes null wallets; this guards against a
    // regression where a null slips through and crashes reconcileAndRemediate.
    expect(mockReconcileAndRemediate).not.toHaveBeenCalled();
  });
});
