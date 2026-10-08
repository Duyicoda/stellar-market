import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { config } from "../../config";
import deadlineExtensionRouter from "../deadline-extension.routes";
import { errorHandler, ApiError } from "../../middleware/error";
import { DeadlineExtensionService } from "../../services/deadline-extension.service";

jest.mock("../../services/deadline-extension.service", () => ({
  DeadlineExtensionService: {
    requestExtension: jest.fn(),
    approveExtension: jest.fn(),
    rejectExtension: jest.fn(),
    confirmExtensionTransaction: jest.fn(),
    getJobExtensionRequests: jest.fn(),
    getUserPendingExtensionRequests: jest.fn(),
  },
}));

jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn(() => ({
    user: {
      findUnique: jest.fn().mockResolvedValue({
        role: "CLIENT",
        emailVerified: true,
        deletedAt: null,
      }),
    },
  })),
}));

jest.mock("../../lib/token-version", () => ({
  getCurrentTokenVersion: jest.fn().mockResolvedValue(null),
  invalidateTokenVersionCache: jest.fn().mockResolvedValue(undefined),
}));

const app = express();
app.use(express.json());
app.use("/api/deadline-extensions", deadlineExtensionRouter);
app.use(errorHandler);

const USER_ID = "00000000-0000-4000-8000-000000000001";
const JOB_ID = "00000000-0000-4000-8000-000000000100";
const MILESTONE_ID = "00000000-0000-4000-8000-000000000200";
const EXTENSION_ID = "00000000-0000-4000-8000-000000000300";

function authHeader(userId = USER_ID) {
  const token = jwt.sign({ userId }, config.jwtSecret, { expiresIn: "1h" });
  return { Authorization: `Bearer ${token}` };
}

afterEach(() => jest.clearAllMocks());

describe("POST /api/deadline-extensions/request", () => {
  it("returns 401 with no auth token", async () => {
    const res = await request(app).post("/api/deadline-extensions/request").send({
      milestoneId: MILESTONE_ID,
      jobId: JOB_ID,
      newDeadline: new Date(Date.now() + 86400000).toISOString(),
      reason: "Need more time to finish properly",
    });
    expect(res.status).toBe(401);
    expect(DeadlineExtensionService.requestExtension).not.toHaveBeenCalled();
  });

  it("returns 400 when the reason is too short", async () => {
    const res = await request(app)
      .post("/api/deadline-extensions/request")
      .set(authHeader())
      .send({
        milestoneId: MILESTONE_ID,
        jobId: JOB_ID,
        newDeadline: new Date(Date.now() + 86400000).toISOString(),
        reason: "short",
      });

    expect(res.status).toBe(400);
    expect(DeadlineExtensionService.requestExtension).not.toHaveBeenCalled();
  });

  it("returns 400 when newDeadline is not a valid datetime", async () => {
    const res = await request(app)
      .post("/api/deadline-extensions/request")
      .set(authHeader())
      .send({
        milestoneId: MILESTONE_ID,
        jobId: JOB_ID,
        newDeadline: "not-a-date",
        reason: "Need more time to finish properly",
      });

    expect(res.status).toBe(400);
    expect(DeadlineExtensionService.requestExtension).not.toHaveBeenCalled();
  });

  it("creates an extension request with valid input", async () => {
    (DeadlineExtensionService.requestExtension as jest.Mock).mockResolvedValueOnce({
      id: EXTENSION_ID,
      status: "PENDING",
    });

    const res = await request(app)
      .post("/api/deadline-extensions/request")
      .set(authHeader())
      .send({
        milestoneId: MILESTONE_ID,
        jobId: JOB_ID,
        newDeadline: new Date(Date.now() + 86400000).toISOString(),
        reason: "Need more time to finish properly",
      });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: EXTENSION_ID, status: "PENDING" });
    expect(DeadlineExtensionService.requestExtension).toHaveBeenCalledWith(
      MILESTONE_ID,
      JOB_ID,
      USER_ID,
      expect.any(Date),
      "Need more time to finish properly",
    );
  });
});

describe("POST /api/deadline-extensions/:id/approve", () => {
  it("returns 401 with no auth token", async () => {
    const res = await request(app).post(
      `/api/deadline-extensions/${EXTENSION_ID}/approve`,
    );
    expect(res.status).toBe(401);
    expect(DeadlineExtensionService.approveExtension).not.toHaveBeenCalled();
  });

  it("approves an extension request when authenticated", async () => {
    (DeadlineExtensionService.approveExtension as jest.Mock).mockResolvedValueOnce({
      id: EXTENSION_ID,
      status: "APPROVED_BY_CLIENT",
    });

    const res = await request(app)
      .post(`/api/deadline-extensions/${EXTENSION_ID}/approve`)
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: EXTENSION_ID, status: "APPROVED_BY_CLIENT" });
    expect(DeadlineExtensionService.approveExtension).toHaveBeenCalledWith(
      EXTENSION_ID,
      USER_ID,
    );
  });

  it("propagates a 400 error from the service (e.g. self-approval)", async () => {
    const err = new Error(
      "You cannot approve your own extension request",
    ) as ApiError;
    err.statusCode = 400;
    (DeadlineExtensionService.approveExtension as jest.Mock).mockRejectedValueOnce(err);

    const res = await request(app)
      .post(`/api/deadline-extensions/${EXTENSION_ID}/approve`)
      .set(authHeader());

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot approve your own/i);
  });
});

describe("POST /api/deadline-extensions/:id/reject", () => {
  it("returns 401 with no auth token", async () => {
    const res = await request(app)
      .post(`/api/deadline-extensions/${EXTENSION_ID}/reject`)
      .send({ rejectionReason: "Too long a delay for this project" });
    expect(res.status).toBe(401);
    expect(DeadlineExtensionService.rejectExtension).not.toHaveBeenCalled();
  });

  it("returns 400 when rejectionReason is too short", async () => {
    const res = await request(app)
      .post(`/api/deadline-extensions/${EXTENSION_ID}/reject`)
      .set(authHeader())
      .send({ extensionRequestId: EXTENSION_ID, rejectionReason: "no" });

    expect(res.status).toBe(400);
    expect(DeadlineExtensionService.rejectExtension).not.toHaveBeenCalled();
  });

  it("rejects an extension request with a valid reason", async () => {
    (DeadlineExtensionService.rejectExtension as jest.Mock).mockResolvedValueOnce({
      id: EXTENSION_ID,
      status: "REJECTED",
    });

    const res = await request(app)
      .post(`/api/deadline-extensions/${EXTENSION_ID}/reject`)
      .set(authHeader())
      .send({
        extensionRequestId: EXTENSION_ID,
        rejectionReason: "Too long a delay for this project",
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: EXTENSION_ID, status: "REJECTED" });
    expect(DeadlineExtensionService.rejectExtension).toHaveBeenCalledWith(
      EXTENSION_ID,
      USER_ID,
      "Too long a delay for this project",
    );
  });
});

describe("POST /api/deadline-extensions/:id/confirm-tx", () => {
  it("returns 401 with no auth token", async () => {
    const res = await request(app)
      .post(`/api/deadline-extensions/${EXTENSION_ID}/confirm-tx`)
      .send({ txHash: "abc123" });
    expect(res.status).toBe(401);
    expect(
      DeadlineExtensionService.confirmExtensionTransaction,
    ).not.toHaveBeenCalled();
  });

  it("returns 400 when txHash is missing", async () => {
    const res = await request(app)
      .post(`/api/deadline-extensions/${EXTENSION_ID}/confirm-tx`)
      .set(authHeader())
      .send({ extensionRequestId: EXTENSION_ID });

    expect(res.status).toBe(400);
    expect(
      DeadlineExtensionService.confirmExtensionTransaction,
    ).not.toHaveBeenCalled();
  });

  it("confirms the on-chain transaction", async () => {
    (
      DeadlineExtensionService.confirmExtensionTransaction as jest.Mock
    ).mockResolvedValueOnce({ id: EXTENSION_ID, onChainTxHash: "abc123" });

    const res = await request(app)
      .post(`/api/deadline-extensions/${EXTENSION_ID}/confirm-tx`)
      .set(authHeader())
      .send({ extensionRequestId: EXTENSION_ID, txHash: "abc123" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: EXTENSION_ID, onChainTxHash: "abc123" });
    expect(
      DeadlineExtensionService.confirmExtensionTransaction,
    ).toHaveBeenCalledWith(EXTENSION_ID, "abc123", USER_ID);
  });
});

describe("GET /api/deadline-extensions/job/:jobId", () => {
  it("returns 401 with no auth token", async () => {
    const res = await request(app).get(`/api/deadline-extensions/job/${JOB_ID}`);
    expect(res.status).toBe(401);
  });

  it("returns extension requests for the job", async () => {
    (
      DeadlineExtensionService.getJobExtensionRequests as jest.Mock
    ).mockResolvedValueOnce([{ id: EXTENSION_ID }]);

    const res = await request(app)
      .get(`/api/deadline-extensions/job/${JOB_ID}`)
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: EXTENSION_ID }]);
    expect(
      DeadlineExtensionService.getJobExtensionRequests,
    ).toHaveBeenCalledWith(JOB_ID);
  });
});

describe("GET /api/deadline-extensions/pending", () => {
  it("returns 401 with no auth token", async () => {
    const res = await request(app).get("/api/deadline-extensions/pending");
    expect(res.status).toBe(401);
  });

  it("returns pending extension requests for the authenticated user", async () => {
    (
      DeadlineExtensionService.getUserPendingExtensionRequests as jest.Mock
    ).mockResolvedValueOnce([{ id: EXTENSION_ID, status: "PENDING" }]);

    const res = await request(app)
      .get("/api/deadline-extensions/pending")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: EXTENSION_ID, status: "PENDING" }]);
    expect(
      DeadlineExtensionService.getUserPendingExtensionRequests,
    ).toHaveBeenCalledWith(USER_ID);
  });
});
