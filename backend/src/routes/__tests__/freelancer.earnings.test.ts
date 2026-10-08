import express, { NextFunction, Request, Response } from "express";
import request from "supertest";
import type { AuthRequest } from "../../middleware/auth";

// ── Mock auth so the route trusts a fixed userId ──
jest.mock("../../middleware/auth", () => ({
  authenticate: (req: AuthRequest, _res: Response, next: NextFunction) => {
    req.userId = "freelancer-1";
    next();
  },
}));

// ── Mock the Horizon reconciliation service ──
// `reconcileAndRemediate` now owns matching + remediation for the reconcile
// route (issue #874); `fetchOnChainPayments`/`loadDbEarnings` remain mocked
// separately since the export route still calls them directly.
jest.mock("../../services/earnings-reconciliation.service", () => ({
  fetchOnChainPayments: jest.fn(),
  loadDbEarnings: jest.fn(),
  reconcileAndRemediate: jest.fn(),
}));

// ── Mock Prisma ──
jest.mock("@prisma/client", () => {
  const actual = jest.requireActual("@prisma/client") as typeof import("@prisma/client");
  const mockPrisma = {
    user: { findUnique: jest.fn() },
    transaction: { aggregate: jest.fn() },
    $queryRaw: jest.fn(),
  };
  return {
    ...actual,
    PrismaClient: jest.fn(() => mockPrisma),
  };
});

import { PrismaClient } from "@prisma/client";
import freelancerRouter from "../freelancer.routes";
import {
  fetchOnChainPayments,
  loadDbEarnings,
  reconcileAndRemediate,
} from "../../services/earnings-reconciliation.service";
import type { ApiError } from "../../middleware/error";

const prismaMock = new PrismaClient() as unknown as {
  user: { findUnique: jest.Mock };
  transaction: { aggregate: jest.Mock };
  $queryRaw: jest.Mock;
};
const fetchOnChainMock = fetchOnChainPayments as jest.Mock;
const loadDbEarningsMock = loadDbEarnings as jest.Mock;
const reconcileAndRemediateMock = reconcileAndRemediate as jest.Mock;

const app = express();
app.use(express.json());
app.use("/api/freelancers", freelancerRouter);
// Minimal error handler mirroring the app's createError shape.
app.use((err: ApiError, _req: Request, res: Response, _next: NextFunction) => {
  res.status(err.statusCode || 500).json({ error: err.message });
});

const freelancer = {
  id: "freelancer-1",
  role: "FREELANCER",
  walletAddress: "GFREELANCER",
};

function reconciliationResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    range: { from: "2026-01-01T00:00:00.000Z", to: "2026-01-31T00:00:00.000Z" },
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
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.user.findUnique.mockResolvedValue(freelancer);
});

describe("GET /api/freelancers/earnings/summary", () => {
  it("returns 400 when freelancerId is missing", async () => {
    const res = await request(app).get("/api/freelancers/earnings/summary");
    expect(res.status).toBe(400);
  });

  it("returns the summed total for the freelancer's wallet", async () => {
    prismaMock.user.findUnique.mockResolvedValue(freelancer);
    prismaMock.transaction.aggregate.mockResolvedValue({ _sum: { amount: 250 } });

    const res = await request(app).get(
      "/api/freelancers/earnings/summary?freelancerId=freelancer-1",
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 250 });
    expect(prismaMock.transaction.aggregate).toHaveBeenCalledWith({
      where: {
        toAddress: "GFREELANCER",
        type: { in: ["RELEASE", "DISPUTE_PAYOUT"] },
      },
      _sum: { amount: true },
    });
  });

  it("returns a zero total when the freelancer has no wallet address on file", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ ...freelancer, walletAddress: null });

    const res = await request(app).get(
      "/api/freelancers/earnings/summary?freelancerId=freelancer-1",
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 0 });
    expect(prismaMock.transaction.aggregate).not.toHaveBeenCalled();
  });

  it("returns a zero total when the freelancer does not exist", async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    const res = await request(app).get(
      "/api/freelancers/earnings/summary?freelancerId=does-not-exist",
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 0 });
  });
});

describe("GET /api/freelancers/earnings/reconcile", () => {
  it("returns the classification and remediation summary from reconcileAndRemediate", async () => {
    reconcileAndRemediateMock.mockResolvedValue(
      reconciliationResult({
        summary: {
          onChainCount: 2,
          dbCount: 2,
          matchedCount: 1,
          onChainOnlyCount: 1,
          dbOnlyCount: 1,
          allMatched: false,
        },
        matched: [
          {
            txHash: "HASH_MATCHED",
            jobId: "job-1",
            jobTitle: "Build API",
            amount: 100,
            onChainAmount: 100,
            createdAt: "2026-01-10T00:00:00Z",
          },
        ],
        onChainOnly: [
          {
            txHash: "HASH_ONCHAIN_ONLY",
            memoJobId: "job-9",
            amount: 75,
            assetCode: "XLM",
            createdAt: "2026-01-11T00:00:00Z",
            horizonUrl: "https://horizon-testnet.stellar.org/transactions/HASH_ONCHAIN_ONLY",
          },
        ],
        dbOnly: [
          {
            txHash: "HASH_DB_ONLY",
            jobId: "job-2",
            jobTitle: "Frontend",
            amount: 50,
            createdAt: "2026-01-12T00:00:00Z",
          },
        ],
        remediation: { backfilled: 1, alreadyRemediated: 0, flaggedForReview: 1 },
      }),
    );

    const res = await request(app).get(
      "/api/freelancers/earnings/reconcile?from=2026-01-01&to=2026-01-31",
    );

    expect(res.status).toBe(200);
    expect(reconcileAndRemediateMock).toHaveBeenCalledWith(
      "GFREELANCER",
      new Date("2026-01-01"),
      new Date("2026-01-31"),
    );
    expect(res.body.summary).toMatchObject({
      onChainCount: 2,
      dbCount: 2,
      matchedCount: 1,
      onChainOnlyCount: 1,
      dbOnlyCount: 1,
      allMatched: false,
    });
    expect(res.body.matched[0].txHash).toBe("HASH_MATCHED");
    expect(res.body.onChainOnly[0].txHash).toBe("HASH_ONCHAIN_ONLY");
    expect(res.body.onChainOnly[0].horizonUrl).toContain("HASH_ONCHAIN_ONLY");
    expect(res.body.dbOnly[0].txHash).toBe("HASH_DB_ONLY");
    // The route is no longer read-only: the remediation summary comes back
    // to the caller too (issue #874).
    expect(res.body.remediation).toEqual({
      backfilled: 1,
      alreadyRemediated: 0,
      flaggedForReview: 1,
    });
  });

  it("returns 502 when Horizon is unreachable", async () => {
    reconcileAndRemediateMock.mockRejectedValue(new Error("horizon down"));

    const res = await request(app).get("/api/freelancers/earnings/reconcile");
    expect(res.status).toBe(502);
  });

  it("rejects from after to with 400", async () => {
    const res = await request(app).get(
      "/api/freelancers/earnings/reconcile?from=2026-02-01&to=2026-01-01",
    );
    expect(res.status).toBe(400);
    expect(reconcileAndRemediateMock).not.toHaveBeenCalled();
  });

  it("returns 403 for non-freelancers", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ ...freelancer, role: "CLIENT" });
    const res = await request(app).get("/api/freelancers/earnings/reconcile");
    expect(res.status).toBe(403);
    expect(reconcileAndRemediateMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/freelancers/earnings/export", () => {
  it("returns a downloadable CSV with all required fields", async () => {
    loadDbEarningsMock.mockResolvedValue([
      {
        txHash: "HASH_1",
        jobId: "job-1",
        jobTitle: "Smart Contract, Dev",
        clientName: "acme",
        category: "Smart Contract",
        amount: 120.5,
        createdAt: new Date("2026-01-10T00:00:00Z"),
      },
    ]);
    fetchOnChainMock.mockResolvedValue([
      { txHash: "HASH_1", memoJobId: "job-1", amount: 120.5, assetCode: "XLM", createdAt: "2026-01-10T00:00:00Z", from: "GCLIENT" },
    ]);

    const res = await request(app).get(
      "/api/freelancers/earnings/export?from=2026-01-01&to=2026-01-31",
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("earnings-2026-01-01-to-2026-01-31.csv");
    const [header, row] = res.text.split("\n");
    expect(header).toBe("date,job_title,client_name,amount_xlm,amount_usd,tx_hash,reconciliation_status");
    // Title contains a comma → must be quoted.
    expect(row).toContain('"Smart Contract, Dev"');
    expect(row).toContain("2026-01-10");
    expect(row).toContain("matched");
  });

  it("marks rows unverified when Horizon is unreachable", async () => {
    loadDbEarningsMock.mockResolvedValue([
      {
        txHash: "HASH_1",
        jobId: "job-1",
        jobTitle: "Job",
        clientName: "acme",
        category: "X",
        amount: 10,
        createdAt: new Date("2026-01-10T00:00:00Z"),
      },
    ]);
    fetchOnChainMock.mockRejectedValue(new Error("down"));

    const res = await request(app).get("/api/freelancers/earnings/export");
    expect(res.status).toBe(200);
    expect(res.text).toContain("unverified");
  });
});
