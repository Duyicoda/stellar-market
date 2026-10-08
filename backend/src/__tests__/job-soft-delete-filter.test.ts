/**
 * Regression tests for: "Soft-deleted jobs still appear in the main job feed"
 *
 * GET /api/jobs must exclude jobs with a non-null deletedAt, for both the
 * offset-based and cursor-based pagination paths.
 */

// ─── Prisma mock ──────────────────────────────────────────────────────────────
type MockPrismaClient = {
  job: {
    findMany: jest.Mock;
    count: jest.Mock;
    findUnique: jest.Mock;
  };
  user: {
    findUnique: jest.Mock;
  };
  $queryRaw: jest.Mock;
  $disconnect: jest.Mock;
};

jest.mock("@prisma/client", () => {
  const mockPrisma: MockPrismaClient = {
    job: {
      findMany: jest.fn(),
      count: jest.fn(),
      findUnique: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
    $queryRaw: jest.fn(),
    $disconnect: jest.fn(),
  };

  return {
    PrismaClient: jest.fn(() => mockPrisma),
    UserRole: { CLIENT: "CLIENT", FREELANCER: "FREELANCER", ADMIN: "ADMIN" },
  };
});

// ─── Config mock ──────────────────────────────────────────────────────────────
jest.mock("../config", () => ({
  config: {
    jwtSecret: "test-secret",
    platformMinBudgetXlm: 1,
  },
  MAX_PAGE_SIZE: 100,
}));

// ─── Cache mock (bypass Redis for tests) ─────────────────────────────────────
jest.mock("../lib/cache", () => ({
  cache: jest.fn((_key: string, _ttl: number, fn: () => Promise<unknown>) =>
    fn().then((data: unknown) => ({ data, hit: false })),
  ),
  invalidateCache: jest.fn().mockResolvedValue(undefined),
  invalidateCacheKey: jest.fn().mockResolvedValue(undefined),
  generateJobsCacheKey: jest.fn().mockReturnValue("jobs:list:test"),
  generateJobCacheKey: jest.fn().mockReturnValue("job:test"),
  generateJobOnChainStatusCacheKey: jest.fn().mockReturnValue("job:on-chain:test"),
}));

// ─── ContractService mock ─────────────────────────────────────────────────────
jest.mock("../services/contract.service", () => ({
  ContractService: {
    getOnChainJobStatus: jest.fn().mockResolvedValue("FUNDED"),
    getRevisionProposal: jest.fn().mockResolvedValue(null),
  },
}));

// ─── RecommendationQueueService mock ─────────────────────────────────────────
jest.mock("../services/recommendation-queue.service", () => ({
  RecommendationQueueService: {
    enqueueRebuild: jest.fn().mockResolvedValue(undefined),
  },
}));

import { PrismaClient } from "@prisma/client";
import express from "express";
import request from "supertest";
import jobRouter from "../routes/job.routes";

const prismaMock = new PrismaClient() as unknown as MockPrismaClient;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/jobs", jobRouter);
  return app;
}

afterEach(() => jest.clearAllMocks());

describe("GET /api/jobs — soft-delete filtering", () => {
  beforeEach(() => {
    prismaMock.job.findMany.mockResolvedValue([]);
    prismaMock.job.count.mockResolvedValue(0);
  });

  it("excludes soft-deleted jobs on the offset pagination path", async () => {
    const app = buildApp();
    await request(app).get("/api/jobs?page=1&limit=20");

    const findManyCall = prismaMock.job.findMany.mock.calls[0][0];
    const countCall = prismaMock.job.count.mock.calls[0][0];

    expect(findManyCall.where).toMatchObject({ deletedAt: null });
    expect(countCall.where).toMatchObject({ deletedAt: null });
  });

  it("excludes soft-deleted jobs on the cursor pagination path", async () => {
    prismaMock.job.findUnique.mockResolvedValue({
      id: "job-anchor",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });

    const app = buildApp();
    await request(app).get("/api/jobs?cursor=job-anchor");

    const findManyCall = prismaMock.job.findMany.mock.calls[0][0];
    const countCall = prismaMock.job.count.mock.calls[0][0];

    expect(findManyCall.where.AND).toEqual(
      expect.arrayContaining([expect.anything()]),
    );
    expect(findManyCall.where).toMatchObject({ deletedAt: null });
    expect(countCall.where).toMatchObject({ deletedAt: null });
  });
});
