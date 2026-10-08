/**
 * Regression test for #941 — approved deadline-extension XDR is built then
 * discarded, never reaching the caller.
 *
 * POST /api/deadline-extensions/:id/approve must surface the on-chain `xdr`
 * in its JSON response once the second (completing) approval flips the
 * request to APPROVED_BY_BOTH.
 */

import express from "express";
import request from "supertest";

let currentUserId = "CLIENT_ID_PLACEHOLDER";

jest.mock("../../middleware/auth", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authenticate: jest.fn((req: any, _res: any, next: any) => {
    req.userId = currentUserId;
    next();
  }),
}));

const mockBuildExtendDeadlineTx = jest.fn();

jest.mock("../../services/contract.service", () => ({
  ContractService: {
    buildExtendDeadlineTx: (...args: unknown[]) =>
      mockBuildExtendDeadlineTx(...args),
  },
}));

jest.mock("../../services/notification.service", () => ({
  NotificationService: {
    sendNotification: jest.fn(),
  },
}));

const CLIENT_ID = "00000000-0000-4000-8000-000000000001";
const FREELANCER_ID = "00000000-0000-4000-8000-000000000002";
const EXTENSION_ID = "00000000-0000-4000-8000-000000000300";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma: Record<string, any> = {
  deadlineExtensionRequest: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
};

jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn(() => mockPrisma),
  DeadlineExtensionStatus: {
    PENDING: "PENDING",
    APPROVED_BY_CLIENT: "APPROVED_BY_CLIENT",
    APPROVED_BY_FREELANCER: "APPROVED_BY_FREELANCER",
    APPROVED_BY_BOTH: "APPROVED_BY_BOTH",
    REJECTED: "REJECTED",
    EXPIRED: "EXPIRED",
  },
  JobStatus: {},
}));

jest.mock("../../config", () => ({
  config: { jwtSecret: "test-secret" },
}));

import deadlineExtensionRouter from "../deadline-extension.routes";
import { errorHandler } from "../../middleware/error";

const app = express();
app.use(express.json());
app.use("/api/deadline-extensions", deadlineExtensionRouter);
app.use(errorHandler);

function baseExtensionRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: EXTENSION_ID,
    milestoneId: "milestone-1",
    jobId: "job-1",
    requestedById: FREELANCER_ID,
    newDeadline: new Date("2026-09-01T00:00:00.000Z"),
    reason: "Need more time to finish the work",
    status: "APPROVED_BY_FREELANCER",
    clientApprovedAt: null,
    freelancerApprovedAt: new Date("2026-07-01T00:00:00.000Z"),
    milestone: { id: "milestone-1", title: "Milestone 1", onChainIndex: 0 },
    job: {
      id: "job-1",
      clientId: CLIENT_ID,
      freelancerId: FREELANCER_ID,
      contractJobId: "42",
      client: { walletAddress: "GCLIENTWALLET" },
      freelancer: { walletAddress: "GFREELANCERWALLET" },
    },
    requestedBy: { id: FREELANCER_ID, username: "freelancer" },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  currentUserId = CLIENT_ID;
});

describe("POST /api/deadline-extensions/:id/approve", () => {
  it("returns the built XDR in the response body on the completing approval", async () => {
    // The freelancer already approved; the request itself is still PENDING
    // until the client's (this) approval flips it to APPROVED_BY_BOTH.
    const pending = baseExtensionRequest({ status: "PENDING" });
    mockPrisma.deadlineExtensionRequest.findUnique.mockResolvedValueOnce(
      pending,
    );

    const updated = baseExtensionRequest({
      status: "APPROVED_BY_BOTH",
      clientApprovedAt: new Date("2026-07-28T00:00:00.000Z"),
    });
    mockPrisma.deadlineExtensionRequest.update.mockResolvedValueOnce(updated);

    mockBuildExtendDeadlineTx.mockResolvedValueOnce("AAAA...FAKEXDR");

    const res = await request(app)
      .post(`/api/deadline-extensions/${EXTENSION_ID}/approve`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.xdr).toBe("AAAA...FAKEXDR");
    expect(res.body.status).toBe("APPROVED_BY_BOTH");
    expect(mockBuildExtendDeadlineTx).toHaveBeenCalledWith(
      "GCLIENTWALLET",
      "42",
      0,
      Math.floor(updated.newDeadline.getTime() / 1000),
    );
  });

  it("does not include an xdr when only one party has approved so far", async () => {
    const pending = baseExtensionRequest({
      status: "PENDING",
      freelancerApprovedAt: null,
    });
    mockPrisma.deadlineExtensionRequest.findUnique.mockResolvedValueOnce(
      pending,
    );

    const updated = baseExtensionRequest({
      status: "APPROVED_BY_CLIENT",
      freelancerApprovedAt: null,
      clientApprovedAt: new Date("2026-07-28T00:00:00.000Z"),
    });
    mockPrisma.deadlineExtensionRequest.update.mockResolvedValueOnce(updated);

    const res = await request(app)
      .post(`/api/deadline-extensions/${EXTENSION_ID}/approve`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.xdr).toBeUndefined();
    expect(mockBuildExtendDeadlineTx).not.toHaveBeenCalled();
  });
});
