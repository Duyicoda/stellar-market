import request from "supertest";
import express from "express";
import platformRoutes from "../platform.routes";
import { PrismaClient } from "@prisma/client";

// Inline the mock to avoid hoisting issues
jest.mock("@prisma/client", () => {
  const mPrisma = {
    job: { count: jest.fn(), aggregate: jest.fn() },
    user: { count: jest.fn() },
    dispute: { count: jest.fn() },
  };
  return {
    PrismaClient: jest.fn(() => mPrisma)
  };
});

jest.mock("../../lib/cache", () => ({
  cache: jest.fn().mockImplementation(async (key, ttl, cb) => {
    const data = await cb();
    return { data, hit: false };
  }),
}));

describe("Platform Routes", () => {
  let app: express.Express;
  let mockPrisma: {
    job: { count: jest.Mock; aggregate: jest.Mock };
    user: { count: jest.Mock };
    dispute: { count: jest.Mock };
  };

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use("/api/platform", platformRoutes);
    
    // We instantiate PrismaClient here, the mock will return the same mocked object
    // that the route uses when it instantiates its own PrismaClient.
    mockPrisma = new PrismaClient() as unknown as typeof mockPrisma;
    jest.clearAllMocks();
  });

  it("returns a 200 with stats shape and without PII", async () => {
    mockPrisma.job.count.mockImplementation(
      (args?: { where?: { status?: string } }) => {
        if (!args) return Promise.resolve(100);
        if (args.where?.status === "OPEN") return Promise.resolve(30);
        if (args.where?.status === "COMPLETED") return Promise.resolve(60);
        return Promise.resolve(0);
      },
    );

    mockPrisma.user.count.mockResolvedValue(50);

    mockPrisma.dispute.count.mockImplementation((args?: unknown) => {
      if (!args) return Promise.resolve(10);
      return Promise.resolve(9); // resolved
    });

    mockPrisma.job.aggregate.mockResolvedValue({ _sum: { budget: 250000 } });

    const res = await request(app).get("/api/platform/stats");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      totalJobs: 100,
      openJobs: 30,
      completedJobs: 60,
      totalFreelancers: 50,
      totalEscrowXlm: 250000,
      resolvedDisputesPct: 90,
    });
  });

  it("handles zero disputes without dividing by zero", async () => {
    mockPrisma.job.count.mockResolvedValue(0);
    mockPrisma.user.count.mockResolvedValue(0);
    mockPrisma.dispute.count.mockResolvedValue(0);
    mockPrisma.job.aggregate.mockResolvedValue({ _sum: { budget: null } });

    const res = await request(app).get("/api/platform/stats");

    expect(res.status).toBe(200);
    expect(res.body.resolvedDisputesPct).toBe(100);
    expect(res.body.totalEscrowXlm).toBe(0);
  });
});
