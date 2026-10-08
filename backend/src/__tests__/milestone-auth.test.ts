/**
 * Tests for issue: "GET /jobs/:jobId/milestones has no authorization check"
 *
 * Acceptance criteria:
 *  1. GET /jobs/:jobId/milestones returns 403 for users who are neither the job's client nor freelancer
 *  2. Existing client/freelancer access continues to work
 *  3. A regression test covers the unauthorized case
 */

// ─── Prisma mock ──────────────────────────────────────────────────────────────
type MockPrismaClient = {
  job: {
    findUnique: jest.Mock;
  };
  milestone: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
  };
  user: {
    findUnique: jest.Mock;
  };
};

jest.mock("@prisma/client", () => {
  const mockPrisma: MockPrismaClient = {
    job: {
      findUnique: jest.fn(),
    },
    milestone: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
  };

  return {
    PrismaClient: jest.fn(() => mockPrisma),
  };
});

// ─── JWT mock ─────────────────────────────────────────────────────────────────
jest.mock("jsonwebtoken", () => ({
  verify: jest.fn(),
  sign: jest.fn().mockReturnValue("mock-token"),
}));

// ─── Config & other mocks ─────────────────────────────────────────────────────
jest.mock("../config", () => ({
  config: {
    jwtSecret: "test-secret",
  },
}));

jest.mock("../services/notification.service", () => ({
  NotificationService: {
    sendNotification: jest.fn(),
  },
}));

jest.mock("../services/contract.service", () => ({
  ContractService: {
    buildSubmitMilestoneTx: jest.fn(),
    buildApproveMilestoneTx: jest.fn(),
  },
}));

jest.mock("../socket", () => ({
  getIo: jest.fn(() => ({
    to: jest.fn().mockReturnThis(),
    emit: jest.fn(),
  })),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────
import { PrismaClient } from "@prisma/client";
import * as jwt from "jsonwebtoken";
import express from "express";
import request from "supertest";
import milestoneRouter from "../routes/milestone.routes";
import { errorHandler } from "../middleware/error";

const prismaMock = new PrismaClient() as unknown as MockPrismaClient;
const jwtVerify = jwt.verify as jest.Mock;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CLIENT_ID = "client-123";
const FREELANCER_ID = "freelancer-456";
const STRANGER_ID = "stranger-789";
const JOB_ID = "job-001";

const mockJob = {
  id: JOB_ID,
  clientId: CLIENT_ID,
  freelancerId: FREELANCER_ID,
};

const mockMilestones = [
  { id: "m-1", title: "Milestone 1", amount: 100 },
  { id: "m-2", title: "Milestone 2", amount: 200 },
];

// ─── App factory ──────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/milestones", milestoneRouter);
  // Need to handle error responses properly
  app.use(errorHandler);
  return app;
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────

function mockAuthAs(userId: string) {
  jwtVerify.mockReturnValueOnce({ userId });
  prismaMock.user.findUnique.mockResolvedValueOnce({ id: userId, emailVerified: true });
}

afterEach(() => jest.clearAllMocks());

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/milestones/jobs/:jobId/milestones
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/milestones/jobs/:jobId/milestones — Authorization", () => {
  beforeEach(() => {
    prismaMock.job.findUnique.mockResolvedValue(mockJob);
    prismaMock.milestone.findMany.mockResolvedValue(mockMilestones);
  });

  it("returns 403 for authenticated users who are neither the client nor freelancer", async () => {
    mockAuthAs(STRANGER_ID);

    const app = buildApp();
    const res = await request(app)
      .get(`/api/milestones/jobs/${JOB_ID}/milestones`)
      .set("Authorization", "Bearer mock-token");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Not authorized to view milestones for this job.");
    // Should not fetch milestones if unauthorized
    expect(prismaMock.milestone.findMany).not.toHaveBeenCalled();
  });

  it("returns 200 and milestones list for the job's client", async () => {
    mockAuthAs(CLIENT_ID);

    const app = buildApp();
    const res = await request(app)
      .get(`/api/milestones/jobs/${JOB_ID}/milestones`)
      .set("Authorization", "Bearer mock-token");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockMilestones);
    expect(prismaMock.milestone.findMany).toHaveBeenCalledWith({
      where: { jobId: JOB_ID },
      orderBy: { createdAt: "asc" },
    });
  });

  it("returns 200 and milestones list for the job's freelancer", async () => {
    mockAuthAs(FREELANCER_ID);

    const app = buildApp();
    const res = await request(app)
      .get(`/api/milestones/jobs/${JOB_ID}/milestones`)
      .set("Authorization", "Bearer mock-token");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockMilestones);
    expect(prismaMock.milestone.findMany).toHaveBeenCalledWith({
      where: { jobId: JOB_ID },
      orderBy: { createdAt: "asc" },
    });
  });

  it("returns 404 if the job does not exist", async () => {
    mockAuthAs(CLIENT_ID);
    prismaMock.job.findUnique.mockResolvedValueOnce(null);

    const app = buildApp();
    const res = await request(app)
      .get(`/api/milestones/jobs/nonexistent-job/milestones`)
      .set("Authorization", "Bearer mock-token");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Job not found.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/milestones/:id/status — 403 vs 400 semantics
// ─────────────────────────────────────────────────────────────────────────────

describe("PATCH /api/milestones/:id/status — status codes", () => {
  const MILESTONE_ID = "m-1";

  beforeEach(() => {
    prismaMock.milestone.findUnique.mockResolvedValue({
      id: MILESTONE_ID,
      status: "PENDING",
      job: mockJob,
    });
  });

  it("returns 400 for an authorized caller requesting an invalid transition", async () => {
    mockAuthAs(FREELANCER_ID);

    const res = await request(buildApp())
      .patch(`/api/milestones/${MILESTONE_ID}/status`)
      .set("Authorization", "Bearer mock-token")
      .send({ status: "APPROVED" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid status transition/);
  });

  it("still returns 403 for a caller who is not a job participant", async () => {
    mockAuthAs(STRANGER_ID);

    const res = await request(buildApp())
      .patch(`/api/milestones/${MILESTONE_ID}/status`)
      .set("Authorization", "Bearer mock-token")
      .send({ status: "IN_PROGRESS" });

    expect(res.status).toBe(403);
  });
});
