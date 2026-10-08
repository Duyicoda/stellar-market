/**
 * Admin route tests for:
 *  - issue #1409: GET /api/admin/disputes must paginate (page/limit) and
 *    return the same pagination envelope as the other admin list routes.
 *  - issue #1182: DELETE /api/admin/jobs/:id must notify the client with a
 *    real NotificationType member (JOB_REMOVED) instead of a value Prisma
 *    rejects.
 */

// ─── Prisma mock ─────────────────────────────────────────────────────────────
type MockPrismaClient = {
  job: {
    findMany: jest.Mock;
    count: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  user: {
    findUnique: jest.Mock;
    update: jest.Mock;
  };
  dispute: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
    count: jest.Mock;
  };
  auditLog: {
    create: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
  };
  $disconnect: jest.Mock;
};

jest.mock("@prisma/client", () => {
  const actual = jest.requireActual("@prisma/client") as { NotificationType: unknown };
  const mockPrisma: MockPrismaClient = {
    job: {
      findMany: jest.fn(),
      count: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    dispute: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    auditLog: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    $disconnect: jest.fn(),
  };

  return {
    PrismaClient: jest.fn(() => mockPrisma),
    UserRole: { CLIENT: "CLIENT", FREELANCER: "FREELANCER", ADMIN: "ADMIN" },
    DisputeStatus: { OPEN: "OPEN", IN_PROGRESS: "IN_PROGRESS", RESOLVED: "RESOLVED" },
    NotificationType: actual.NotificationType,
  };
});

jest.mock("jsonwebtoken", () => ({
  verify: jest.fn().mockReturnValue({ userId: "admin-user-id" }),
  sign: jest.fn().mockReturnValue("mock-token"),
}));

jest.mock("../config", () => ({
  config: {
    jwtSecret: "test-secret",
    stellar: {
      rpcUrl: "https://soroban-testnet.stellar.org",
      escrowContractId: "",
      disputeContractId: "",
      reputationContractId: "",
    },
    smtp: {
      host: "smtp.test",
      port: 587,
      user: "",
      pass: "",
      from: "noreply@test.io",
    },
  },
}));

const mockSendNotification = jest.fn().mockResolvedValue(undefined);
jest.mock("../services/notification.service", () => ({
  NotificationService: {
    sendNotification: (...args: unknown[]) => mockSendNotification(...args),
  },
}));

jest.mock("../utils/auditLogger", () => ({
  logAdminAction: jest.fn().mockResolvedValue(undefined),
}));

import { PrismaClient, NotificationType } from "@prisma/client";
import express from "express";
import request from "supertest";
import adminRouter from "../routes/admin";

const prismaMock = new PrismaClient() as unknown as MockPrismaClient;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", adminRouter);
  return app;
}

function asAdmin(req: request.Test): request.Test {
  prismaMock.user.findUnique.mockResolvedValueOnce({ role: "ADMIN" });
  return req.set("Authorization", "Bearer mock-admin-token");
}

const mockDispute = {
  id: "dispute-001",
  jobId: "job-001",
  status: "OPEN",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  job: { id: "job-001", title: "Build a dApp", clientId: "client-001", freelancerId: "fl-001" },
};

afterEach(() => jest.clearAllMocks());

describe("GET /api/admin/disputes", () => {
  it("paginates with defaults and returns the shared pagination envelope", async () => {
    prismaMock.dispute.findMany.mockResolvedValueOnce([mockDispute]);
    prismaMock.dispute.count.mockResolvedValueOnce(25);

    const res = await asAdmin(request(buildApp()).get("/api/admin/disputes"));

    expect(res.status).toBe(200);
    expect(res.body.disputes).toHaveLength(1);
    expect(res.body.pagination).toEqual({ total: 25, page: 1, limit: 10, totalPages: 3 });
    expect(prismaMock.dispute.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 10, orderBy: { createdAt: "desc" } }),
    );
    expect(prismaMock.dispute.count).toHaveBeenCalledTimes(1);
  });

  it("honours page and limit query params", async () => {
    prismaMock.dispute.findMany.mockResolvedValueOnce([]);
    prismaMock.dispute.count.mockResolvedValueOnce(101);

    const res = await asAdmin(request(buildApp()).get("/api/admin/disputes?page=3&limit=25"));

    expect(res.status).toBe(200);
    expect(res.body.pagination).toEqual({ total: 101, page: 3, limit: 25, totalPages: 5 });
    expect(prismaMock.dispute.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 50, take: 25 }),
    );
  });

  it("rejects invalid pagination params with 400", async () => {
    const tooLarge = await asAdmin(request(buildApp()).get("/api/admin/disputes?limit=500"));
    expect(tooLarge.status).toBe(400);
    expect(tooLarge.body.error).toBe("Validation error");

    const zeroPage = await asAdmin(request(buildApp()).get("/api/admin/disputes?page=0"));
    expect(zeroPage.status).toBe(400);

    expect(prismaMock.dispute.findMany).not.toHaveBeenCalled();
  });

  it("returns 500 when the query fails", async () => {
    prismaMock.dispute.findMany.mockRejectedValueOnce(new Error("db down"));
    prismaMock.dispute.count.mockResolvedValueOnce(0);

    const res = await asAdmin(request(buildApp()).get("/api/admin/disputes"));
    expect(res.status).toBe(500);
  });
});

describe("DELETE /api/admin/jobs/:id", () => {
  it("soft-deletes the job and notifies the client with JOB_REMOVED", async () => {
    prismaMock.job.findUnique.mockResolvedValueOnce({
      id: "job-001",
      title: "Build a dApp",
      clientId: "client-001",
    });
    prismaMock.job.update.mockResolvedValueOnce({});

    const res = await asAdmin(request(buildApp()).delete("/api/admin/jobs/job-001"));

    expect(res.status).toBe(200);
    expect(prismaMock.job.update).toHaveBeenCalledWith({
      where: { id: "job-001" },
      data: { deletedAt: expect.any(Date) },
    });
    expect(mockSendNotification).toHaveBeenCalledTimes(1);
    expect(mockSendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "client-001",
        type: NotificationType.JOB_REMOVED,
        title: "Job Removed by Moderator",
      }),
    );
    expect(Object.values(NotificationType)).toContain(mockSendNotification.mock.calls[0][0].type);
  });

  it("returns 404 for an unknown job and sends nothing", async () => {
    prismaMock.job.findUnique.mockResolvedValueOnce(null);

    const res = await asAdmin(request(buildApp()).delete("/api/admin/jobs/missing"));

    expect(res.status).toBe(404);
    expect(mockSendNotification).not.toHaveBeenCalled();
  });
});
