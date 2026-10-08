/**
 * Unit tests for report route abuse detection (#497).
 *
 * Tests cover:
 *  - threshold: reporter flagged after 10 reports in 24h
 *  - requiresReview set on reports from already-suspicious reporters
 *  - Redis counter reset (TTL behaviour mocked)
 *  - Admin notification sent on first flag
 */

// ─── Mocks ────────────────────────────────────────────────────────────────────

const prismaReportCreateMock = jest.fn();
const prismaReportCountMock = jest.fn();
const prismaUserFindUniqueMock = jest.fn();
const prismaUserUpdateMock = jest.fn();
const prismaUserFindManyMock = jest.fn();

jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    user: {
      findUnique: (...a: unknown[]) => prismaUserFindUniqueMock(...a),
      update: (...a: unknown[]) => prismaUserUpdateMock(...a),
      findMany: (...a: unknown[]) => prismaUserFindManyMock(...a),
    },
    report: {
      create: (...a: unknown[]) => prismaReportCreateMock(...a),
      count: (...a: unknown[]) => prismaReportCountMock(...a),
    },
  })),
}));

const redisIncrMock = jest.fn();
const redisExpireMock = jest.fn();
const redisGetMock = jest.fn();
const isRedisConnectedMock = jest.fn().mockReturnValue(true);
const redisConnectMock = jest.fn().mockResolvedValue(undefined);

jest.mock("../../lib/redis", () => ({
  __esModule: true,
  default: {
    isRedisConnected: () => isRedisConnectedMock(),
    connect: () => redisConnectMock(),
    getInstance: () => ({
      incr: (...a: unknown[]) => redisIncrMock(...a),
      expire: (...a: unknown[]) => redisExpireMock(...a),
      get: (...a: unknown[]) => redisGetMock(...a),
    }),
  },
}));

const sendNotificationMock = jest.fn().mockResolvedValue(null);
jest.mock("../../services/notification.service", () => ({
  NotificationService: { sendNotification: (...a: unknown[]) => sendNotificationMock(...a) },
}));

jest.mock("../../lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock("../../middleware/auth", () => ({
  authenticate: (req: AuthRequest, _res: Response, next: NextFunction) => {
    req.userId = "reporter-user-id";
    next();
  },
}));

jest.mock("../../middleware/validation", () => ({
  validate:
    () => (_req: Request, _res: Response, next: NextFunction) =>
      next(),
}));

// Bypass express-rate-limit in tests
jest.mock("express-rate-limit", () =>
  jest
    .fn()
    .mockReturnValue((_req: Request, _res: Response, next: NextFunction) => next())
);

import request from "supertest";
import express, { Request, Response, NextFunction } from "express";
import reportRoutes from "../report.routes";
import type { AuthRequest } from "../../middleware/auth";

const app = express();
app.use(express.json());
app.use("/api/reports", reportRoutes);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const validBody = {
  targetType: "USER",
  targetId: "target-user-id",
  reason: "This user is spamming the platform repeatedly",
};

function mockReporterNotSuspicious() {
  prismaUserFindUniqueMock.mockResolvedValue({ isSuspiciousReporter: false });
}

function mockReporterSuspicious() {
  prismaUserFindUniqueMock.mockResolvedValue({ isSuspiciousReporter: true });
}

function mockReportCreate(overrides = {}) {
  prismaReportCreateMock.mockResolvedValue({
    id: "report-id",
    reporterId: "reporter-user-id",
    ...validBody,
    requiresReview: false,
    status: "PENDING",
    createdAt: new Date(),
    ...overrides,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Report abuse detection", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaReportCountMock.mockResolvedValue(0);
    prismaUserUpdateMock.mockResolvedValue({});
    prismaUserFindManyMock.mockResolvedValue([{ id: "admin-id" }]);
    redisExpireMock.mockResolvedValue(1);
  });

  // ── Threshold ──────────────────────────────────────────────────────────────

  it("does NOT flag reporter when count is below threshold (9 reports)", async () => {
    mockReporterNotSuspicious();
    redisIncrMock.mockResolvedValue(9); // 9th report
    mockReportCreate({ requiresReview: false });

    const res = await request(app).post("/api/reports").send(validBody);

    expect(res.status).toBe(201);
    expect(prismaUserUpdateMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "reporter-user-id" } })
    );
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it("flags reporter as suspicious on the 10th report (threshold breach)", async () => {
    mockReporterNotSuspicious();
    redisIncrMock.mockResolvedValue(10); // exactly at threshold
    mockReportCreate({ requiresReview: true });

    const res = await request(app).post("/api/reports").send(validBody);

    expect(res.status).toBe(201);
    expect(prismaUserUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "reporter-user-id" },
        data: { isSuspiciousReporter: true },
      })
    );
  });

  it("sends admin notification on first flag", async () => {
    mockReporterNotSuspicious();
    redisIncrMock.mockResolvedValue(10);
    mockReportCreate({ requiresReview: true });

    await request(app).post("/api/reports").send(validBody);

    expect(sendNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "admin-id",
        title: "Suspicious Reporter Flagged",
      })
    );
  });

  it("does NOT re-flag or re-notify when reporter is already suspicious", async () => {
    mockReporterSuspicious();
    redisIncrMock.mockResolvedValue(15); // well over threshold
    mockReportCreate({ requiresReview: true });

    await request(app).post("/api/reports").send(validBody);

    // isSuspiciousReporter update should NOT be called again
    expect(prismaUserUpdateMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: { isSuspiciousReporter: true },
      })
    );
    // No admin notification for repeat
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  // ── requiresReview flag ────────────────────────────────────────────────────

  it("sets requiresReview: true on reports from already-suspicious reporters", async () => {
    mockReporterSuspicious();
    redisIncrMock.mockResolvedValue(1);
    mockReportCreate({ requiresReview: true });

    const res = await request(app).post("/api/reports").send(validBody);

    expect(res.status).toBe(201);
    expect(prismaReportCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ requiresReview: true }),
      })
    );
    expect(res.body.notice).toBeDefined();
  });

  it("sets requiresReview: true when count exceeds threshold mid-request", async () => {
    mockReporterNotSuspicious();
    redisIncrMock.mockResolvedValue(11); // over threshold
    mockReportCreate({ requiresReview: true });

    const res = await request(app).post("/api/reports").send(validBody);

    expect(prismaReportCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ requiresReview: true }),
      })
    );
    expect(res.body.notice).toBeDefined();
  });

  it("does NOT set requiresReview on normal reports (count < threshold)", async () => {
    mockReporterNotSuspicious();
    redisIncrMock.mockResolvedValue(3);
    mockReportCreate({ requiresReview: false });
    prismaReportCountMock.mockResolvedValue(1);

    const res = await request(app).post("/api/reports").send(validBody);

    expect(res.status).toBe(201);
    expect(prismaReportCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ requiresReview: false }),
      })
    );
    expect(res.body.notice).toBeUndefined();
  });

  // ── Redis TTL / counter reset ──────────────────────────────────────────────

  it("sets Redis TTL of 24h (86400s) on the first increment", async () => {
    mockReporterNotSuspicious();
    redisIncrMock.mockResolvedValue(1); // first report
    mockReportCreate();

    await request(app).post("/api/reports").send(validBody);

    expect(redisExpireMock).toHaveBeenCalledWith(
      `reporter:24h:reporter-user-id`,
      86400
    );
  });

  it("does NOT reset TTL on subsequent increments (counter > 1)", async () => {
    mockReporterNotSuspicious();
    redisIncrMock.mockResolvedValue(5); // 5th report
    mockReportCreate();

    await request(app).post("/api/reports").send(validBody);

    expect(redisExpireMock).not.toHaveBeenCalled();
  });

  // ── Redis unavailability graceful degradation ──────────────────────────────

  it("still creates the report when Redis is unavailable", async () => {
    mockReporterNotSuspicious();
    redisIncrMock.mockRejectedValue(new Error("Redis connection refused"));
    mockReportCreate({ requiresReview: false });

    const res = await request(app).post("/api/reports").send(validBody);

    expect(res.status).toBe(201);
    expect(prismaReportCreateMock).toHaveBeenCalled();
  });
});
