import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { config } from "../../config";
import milestoneRouter from "../milestone.routes";
import { errorHandler } from "../../middleware/error";

// ─── Prisma & service mocks ────────────────────────────────────────────────────
jest.mock("@prisma/client", () => {
  const mockPrisma = {
    job: {
      findUnique: jest.fn(),
    },
    milestone: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    attachment: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
  };

  return {
    PrismaClient: jest.fn(() => mockPrisma),
    NotificationType: {
      MILESTONE_SUBMITTED: "MILESTONE_SUBMITTED",
      MILESTONE_APPROVED: "MILESTONE_APPROVED",
      MILESTONE_REJECTED: "MILESTONE_REJECTED",
    },
  };
});

jest.mock("../../services/notification.service", () => ({
  NotificationService: {
    sendNotification: jest.fn().mockResolvedValue({ id: "mock-notif-id" }),
  },
}));

jest.mock("../../services/contract.service", () => ({
  ContractService: {
    buildSubmitMilestoneTx: jest.fn().mockResolvedValue("SUBMIT_XDR"),
    buildApproveMilestoneTx: jest.fn().mockResolvedValue("APPROVE_XDR"),
  },
}));

jest.mock("../../socket", () => ({
  getIo: jest.fn().mockReturnValue({
    to: jest.fn().mockReturnValue({ emit: jest.fn() }),
  }),
}));

jest.mock("../../lib/token-version", () => ({
  getCurrentTokenVersion: jest.fn().mockResolvedValue(null),
  invalidateTokenVersionCache: jest.fn().mockResolvedValue(undefined),
}));

import { PrismaClient } from "@prisma/client";
import { NotificationService } from "../../services/notification.service";
import { ContractService } from "../../services/contract.service";

const prismaMock = new PrismaClient() as unknown as {
  job: { findUnique: jest.Mock };
  milestone: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  attachment: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    delete: jest.Mock;
  };
  user: { findUnique: jest.Mock };
};
const jobMock = prismaMock.job;
const milestoneMock = prismaMock.milestone;
const userMock = prismaMock.user;

// ─── App setup ────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use("/api/milestones", milestoneRouter);
app.use(errorHandler);

// ─── Stable test UUIDs ────────────────────────────────────────────────────────
const JOB_ID = "00000000-0000-4000-8000-000000000100";
const MILESTONE_ID = "00000000-0000-4000-8000-000000000200";
const CLIENT_ID = "00000000-0000-4000-8000-000000000001";
const FREELANCER_ID = "00000000-0000-4000-8000-000000000002";
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000003";

function authHeader(userId: string, role: "CLIENT" | "FREELANCER" = "CLIENT") {
  userMock.findUnique.mockResolvedValueOnce({
    role,
    emailVerified: true,
    deletedAt: null,
  });
  const token = jwt.sign({ userId }, config.jwtSecret, { expiresIn: "1h" });
  return { Authorization: `Bearer ${token}` };
}

afterEach(() => jest.clearAllMocks());

describe("PATCH /api/milestones/:id/status", () => {
  it("returns 401 with no auth token", async () => {
    const res = await request(app).patch(`/api/milestones/${MILESTONE_ID}/status`);
    expect(res.status).toBe(401);
  });

  it("returns 404 when milestone does not exist", async () => {
    milestoneMock.findUnique.mockResolvedValueOnce(null);

    const res = await request(app)
      .patch(`/api/milestones/${MILESTONE_ID}/status`)
      .set(authHeader(CLIENT_ID))
      .send({ status: "APPROVED" });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Milestone not found." });
  });

  it("returns 403 when caller is neither client nor freelancer on the job", async () => {
    milestoneMock.findUnique.mockResolvedValueOnce({
      id: MILESTONE_ID,
      status: "SUBMITTED",
      job: { id: JOB_ID, clientId: CLIENT_ID, freelancerId: FREELANCER_ID },
    });

    const res = await request(app)
      .patch(`/api/milestones/${MILESTONE_ID}/status`)
      .set(authHeader(OTHER_USER_ID))
      .send({ status: "APPROVED" });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Not authorized to update this milestone." });
    expect(milestoneMock.update).not.toHaveBeenCalled();
  });

  it("freelancer can transition PENDING -> IN_PROGRESS", async () => {
    milestoneMock.findUnique.mockResolvedValueOnce({
      id: MILESTONE_ID,
      status: "PENDING",
      title: "Design mockups",
      job: { id: JOB_ID, clientId: CLIENT_ID, freelancerId: FREELANCER_ID },
    });
    milestoneMock.update.mockResolvedValueOnce({
      id: MILESTONE_ID,
      jobId: JOB_ID,
      status: "IN_PROGRESS",
    });

    const res = await request(app)
      .patch(`/api/milestones/${MILESTONE_ID}/status`)
      .set(authHeader(FREELANCER_ID, "FREELANCER"))
      .send({ status: "IN_PROGRESS" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("IN_PROGRESS");
    expect(milestoneMock.update).toHaveBeenCalledWith({
      where: { id: MILESTONE_ID },
      data: { status: "IN_PROGRESS" },
    });
    expect(NotificationService.sendNotification).not.toHaveBeenCalled();
  });

  it("freelancer can transition IN_PROGRESS -> SUBMITTED and notifies the client", async () => {
    milestoneMock.findUnique.mockResolvedValueOnce({
      id: MILESTONE_ID,
      status: "IN_PROGRESS",
      title: "Design mockups",
      job: { id: JOB_ID, clientId: CLIENT_ID, freelancerId: FREELANCER_ID },
    });
    milestoneMock.update.mockResolvedValueOnce({
      id: MILESTONE_ID,
      jobId: JOB_ID,
      status: "SUBMITTED",
    });

    const res = await request(app)
      .patch(`/api/milestones/${MILESTONE_ID}/status`)
      .set(authHeader(FREELANCER_ID, "FREELANCER"))
      .send({ status: "SUBMITTED" });

    expect(res.status).toBe(200);
    expect(NotificationService.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: CLIENT_ID,
        type: "MILESTONE_SUBMITTED",
      }),
    );
  });

  it("rejects an invalid transition for the freelancer role", async () => {
    milestoneMock.findUnique.mockResolvedValueOnce({
      id: MILESTONE_ID,
      status: "SUBMITTED",
      job: { id: JOB_ID, clientId: CLIENT_ID, freelancerId: FREELANCER_ID },
    });

    const res = await request(app)
      .patch(`/api/milestones/${MILESTONE_ID}/status`)
      .set(authHeader(FREELANCER_ID, "FREELANCER"))
      .send({ status: "APPROVED" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Invalid status transition/);
    expect(milestoneMock.update).not.toHaveBeenCalled();
  });

  it("rejects client approval without a verified escrow transaction", async () => {
    milestoneMock.findUnique.mockResolvedValueOnce({
      id: MILESTONE_ID,
      status: "SUBMITTED",
      job: { id: JOB_ID, clientId: CLIENT_ID, freelancerId: FREELANCER_ID },
    });

    const res = await request(app)
      .patch(`/api/milestones/${MILESTONE_ID}/status`)
      .set(authHeader(CLIENT_ID, "CLIENT"))
      .send({ status: "APPROVED" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Invalid status transition/);
    expect(milestoneMock.update).not.toHaveBeenCalled();
  });

  it("client can transition SUBMITTED -> REJECTED", async () => {
    milestoneMock.findUnique.mockResolvedValueOnce({
      id: MILESTONE_ID,
      status: "SUBMITTED",
      job: { id: JOB_ID, clientId: CLIENT_ID, freelancerId: FREELANCER_ID },
    });
    milestoneMock.update.mockResolvedValueOnce({
      id: MILESTONE_ID,
      jobId: JOB_ID,
      status: "REJECTED",
    });

    const res = await request(app)
      .patch(`/api/milestones/${MILESTONE_ID}/status`)
      .set(authHeader(CLIENT_ID, "CLIENT"))
      .send({ status: "REJECTED" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("REJECTED");
    expect(NotificationService.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: FREELANCER_ID,
        type: "MILESTONE_REJECTED",
      }),
    );
  });

  it("rejects an invalid transition for the client role", async () => {
    milestoneMock.findUnique.mockResolvedValueOnce({
      id: MILESTONE_ID,
      status: "PENDING",
      job: { id: JOB_ID, clientId: CLIENT_ID, freelancerId: FREELANCER_ID },
    });

    const res = await request(app)
      .patch(`/api/milestones/${MILESTONE_ID}/status`)
      .set(authHeader(CLIENT_ID, "CLIENT"))
      .send({ status: "APPROVED" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Invalid status transition/);
    expect(milestoneMock.update).not.toHaveBeenCalled();
  });
});

describe("PUT /api/milestones/milestones/:id/submit", () => {
  it("returns 401 with no auth token", async () => {
    const res = await request(app).put(
      `/api/milestones/milestones/${MILESTONE_ID}/submit`,
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when the milestone has no on-chain contract data", async () => {
    milestoneMock.findUnique.mockResolvedValueOnce({
      id: MILESTONE_ID,
      status: "IN_PROGRESS",
      job: { contractJobId: null, freelancerId: FREELANCER_ID, freelancer: {} },
      onChainIndex: null,
    });

    const res = await request(app)
      .put(`/api/milestones/milestones/${MILESTONE_ID}/submit`)
      .set(authHeader(FREELANCER_ID, "FREELANCER"));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "On-chain milestone not found." });
  });

  it("returns 403 when caller is not the assigned freelancer", async () => {
    milestoneMock.findUnique.mockResolvedValueOnce({
      id: MILESTONE_ID,
      status: "IN_PROGRESS",
      onChainIndex: 0,
      job: {
        contractJobId: "contract-1",
        freelancerId: FREELANCER_ID,
        freelancer: { walletAddress: "GFREELANCER" },
      },
    });

    const res = await request(app)
      .put(`/api/milestones/milestones/${MILESTONE_ID}/submit`)
      .set(authHeader(OTHER_USER_ID));

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: "Only the assigned freelancer can submit milestones.",
    });
    expect(ContractService.buildSubmitMilestoneTx).not.toHaveBeenCalled();
  });

  it("returns 400 when milestone is not IN_PROGRESS", async () => {
    milestoneMock.findUnique.mockResolvedValueOnce({
      id: MILESTONE_ID,
      status: "PENDING",
      onChainIndex: 0,
      job: {
        contractJobId: "contract-1",
        freelancerId: FREELANCER_ID,
        freelancer: { walletAddress: "GFREELANCER" },
      },
    });

    const res = await request(app)
      .put(`/api/milestones/milestones/${MILESTONE_ID}/submit`)
      .set(authHeader(FREELANCER_ID, "FREELANCER"));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Milestone must be in progress to submit." });
  });

  it("returns the submit XDR for the assigned freelancer", async () => {
    milestoneMock.findUnique.mockResolvedValueOnce({
      id: MILESTONE_ID,
      status: "IN_PROGRESS",
      onChainIndex: 0,
      job: {
        contractJobId: "contract-1",
        freelancerId: FREELANCER_ID,
        freelancer: { walletAddress: "GFREELANCER" },
      },
    });

    const res = await request(app)
      .put(`/api/milestones/milestones/${MILESTONE_ID}/submit`)
      .set(authHeader(FREELANCER_ID, "FREELANCER"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ xdr: "SUBMIT_XDR" });
    expect(ContractService.buildSubmitMilestoneTx).toHaveBeenCalledWith(
      "GFREELANCER",
      "contract-1",
      0,
    );
  });
});

describe("PUT /api/milestones/milestones/:id/approve", () => {
  it("returns 401 with no auth token", async () => {
    const res = await request(app).put(
      `/api/milestones/milestones/${MILESTONE_ID}/approve`,
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when caller is not the client", async () => {
    milestoneMock.findUnique.mockResolvedValueOnce({
      id: MILESTONE_ID,
      status: "SUBMITTED",
      onChainIndex: 0,
      job: {
        contractJobId: "contract-1",
        clientId: CLIENT_ID,
        client: { walletAddress: "GCLIENT" },
      },
    });

    const res = await request(app)
      .put(`/api/milestones/milestones/${MILESTONE_ID}/approve`)
      .set(authHeader(FREELANCER_ID, "FREELANCER"));

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: "Only the client can approve milestones.",
    });
    expect(ContractService.buildApproveMilestoneTx).not.toHaveBeenCalled();
  });

  it("returns 400 when milestone is not SUBMITTED", async () => {
    milestoneMock.findUnique.mockResolvedValueOnce({
      id: MILESTONE_ID,
      status: "IN_PROGRESS",
      onChainIndex: 0,
      job: {
        contractJobId: "contract-1",
        clientId: CLIENT_ID,
        client: { walletAddress: "GCLIENT" },
      },
    });

    const res = await request(app)
      .put(`/api/milestones/milestones/${MILESTONE_ID}/approve`)
      .set(authHeader(CLIENT_ID, "CLIENT"));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Milestone must be submitted to approve." });
  });

  it("returns the approve XDR for the client", async () => {
    milestoneMock.findUnique.mockResolvedValueOnce({
      id: MILESTONE_ID,
      status: "SUBMITTED",
      onChainIndex: 0,
      job: {
        contractJobId: "contract-1",
        clientId: CLIENT_ID,
        client: { walletAddress: "GCLIENT" },
      },
    });

    const res = await request(app)
      .put(`/api/milestones/milestones/${MILESTONE_ID}/approve`)
      .set(authHeader(CLIENT_ID, "CLIENT"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ xdr: "APPROVE_XDR" });
    expect(ContractService.buildApproveMilestoneTx).toHaveBeenCalledWith(
      "GCLIENT",
      "contract-1",
      0,
    );
  });
});

describe("POST /api/milestones (create)", () => {
  it("returns 403 when caller is not the job's client", async () => {
    jobMock.findUnique.mockResolvedValueOnce({ id: JOB_ID, clientId: CLIENT_ID, budget: 500 });

    const res = await request(app)
      .post("/api/milestones")
      .set(authHeader(OTHER_USER_ID))
      .send({
        jobId: JOB_ID,
        title: "Initial design",
        description: "Deliver the initial design mockups for review.",
        amount: 100,
        dueDate: new Date(Date.now() + 86400000).toISOString(),
      });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: "Not authorized to create milestones for this job.",
    });
    expect(milestoneMock.create).not.toHaveBeenCalled();
  });

  it("returns 400 when creating a milestone that would push total amount above job budget", async () => {
    jobMock.findUnique.mockResolvedValueOnce({ id: JOB_ID, clientId: CLIENT_ID, budget: 500 });
    milestoneMock.findMany.mockResolvedValueOnce([
      { amount: 300 },
      { amount: 150 },
    ]);

    const res = await request(app)
      .post("/api/milestones")
      .set(authHeader(CLIENT_ID, "CLIENT"))
      .send({
        jobId: JOB_ID,
        title: "Excessive milestone",
        description: "Deliver deliverables that exceed the remaining budget.",
        amount: 100,
        dueDate: new Date(Date.now() + 86400000).toISOString(),
      });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Total milestone amount exceeds job budget.",
    });
    expect(milestoneMock.create).not.toHaveBeenCalled();
  });

  it("creates a milestone for the job's client when total is within budget", async () => {
    jobMock.findUnique.mockResolvedValueOnce({ id: JOB_ID, clientId: CLIENT_ID, budget: 500 });
    milestoneMock.findMany.mockResolvedValueOnce([
      { amount: 300 },
    ]);
    milestoneMock.create.mockResolvedValueOnce({
      id: MILESTONE_ID,
      jobId: JOB_ID,
      title: "Valid milestone",
      order: 2,
    });

    const res = await request(app)
      .post("/api/milestones")
      .set(authHeader(CLIENT_ID, "CLIENT"))
      .send({
        jobId: JOB_ID,
        title: "Valid milestone",
        description: "Deliver secondary milestone deliverables.",
        amount: 150,
        dueDate: new Date(Date.now() + 86400000).toISOString(),
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(MILESTONE_ID);
  });
});
