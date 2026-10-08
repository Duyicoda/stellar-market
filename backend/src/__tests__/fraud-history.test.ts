/**
 * Issue #1410: GET /api/admin/fraud/subjects/:type/:id/history capped the
 * result at 50 rows with no way to page further or see the total. The service
 * now paginates (page/pageSize, default 50, max 100) and returns total/hasMore;
 * the route threads the query params through and exposes both.
 */
import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import type { NextFunction, Request, Response } from "express";

const mockFindMany = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockCount = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock("@prisma/client", () => {
  const actual = jest.requireActual("@prisma/client") as Record<string, unknown>;
  return {
    ...actual,
    PrismaClient: jest.fn().mockImplementation(() => ({
      riskAssessment: { findMany: mockFindMany, count: mockCount },
    })),
  };
});

jest.mock("../middleware/auth", () => ({
  AuthRequest: {},
  requireAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
}));
jest.mock("../utils/auditLogger", () => ({ logAdminAction: jest.fn() }));
jest.mock("../lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import express from "express";
import request from "supertest";
import { RiskSubjectType } from "@prisma/client";
import {
  getSubjectHistory,
  HISTORY_DEFAULT_PAGE_SIZE,
  HISTORY_MAX_PAGE_SIZE,
} from "../services/fraud-detection.service";
import fraudRouter from "../routes/admin/fraud.routes";

function rows(n: number, offset = 0) {
  return Array.from({ length: n }, (_, i) => ({
    id: `assessment-${offset + i}`,
    subjectType: "USER",
    subjectId: "user-1",
    createdAt: new Date(Date.now() - (offset + i) * 1000),
  }));
}

describe("getSubjectHistory", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("defaults to the first page of 50 and reports the total and whether more exist", async () => {
    mockFindMany.mockResolvedValue(rows(50));
    mockCount.mockResolvedValue(120);

    const result = await getSubjectHistory(RiskSubjectType.USER, "user-1");

    expect(HISTORY_DEFAULT_PAGE_SIZE).toBe(50);
    expect(result).toMatchObject({ total: 120, page: 1, pageSize: 50, hasMore: true });
    expect(result.items).toHaveLength(50);
    expect(mockFindMany).toHaveBeenCalledWith({
      where: { subjectType: "USER", subjectId: "user-1" },
      orderBy: { createdAt: "desc" },
      skip: 0,
      take: 50,
    });
    expect(mockCount).toHaveBeenCalledWith({ where: { subjectType: "USER", subjectId: "user-1" } });
  });

  it("returns rows beyond the 50th on later pages", async () => {
    mockFindMany.mockResolvedValue(rows(20, 100));
    mockCount.mockResolvedValue(120);

    const result = await getSubjectHistory(RiskSubjectType.USER, "user-1", { page: 3, pageSize: 50 });

    expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 100, take: 50 }));
    expect(result).toMatchObject({ page: 3, pageSize: 50, total: 120, hasMore: false });
    expect(result.items[0].id).toBe("assessment-100");
  });

  it("clamps pageSize to the maximum and page to at least 1", async () => {
    mockFindMany.mockResolvedValue([]);
    mockCount.mockResolvedValue(0);

    const result = await getSubjectHistory(RiskSubjectType.JOB, "job-1", { page: 0, pageSize: 5000 });

    expect(HISTORY_MAX_PAGE_SIZE).toBe(100);
    expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 100 }));
    expect(result).toMatchObject({ page: 1, pageSize: 100, total: 0, hasMore: false });
  });
});

describe("GET /api/admin/fraud/subjects/:type/:id/history", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/fraud", fraudRouter);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns the first page with total and hasMore when no params are given", async () => {
    mockFindMany.mockResolvedValue(rows(50));
    mockCount.mockResolvedValue(75);

    const res = await request(app).get("/api/admin/fraud/subjects/USER/user-1/history");

    expect(res.status).toBe(200);
    expect(res.body.history).toHaveLength(50);
    expect(res.body).toMatchObject({ total: 75, page: 1, pageSize: 50, hasMore: true });
  });

  it("pages past the first 50 rows with page and pageSize", async () => {
    mockFindMany.mockResolvedValue(rows(25, 50));
    mockCount.mockResolvedValue(75);

    const res = await request(app).get(
      "/api/admin/fraud/subjects/USER/user-1/history?page=2&pageSize=50",
    );

    expect(res.status).toBe(200);
    expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 50, take: 50 }));
    expect(res.body).toMatchObject({ total: 75, page: 2, pageSize: 50, hasMore: false });
    expect(res.body.history[0].id).toBe("assessment-50");
  });

  it("rejects out-of-range query params with 400", async () => {
    const tooBig = await request(app).get(
      "/api/admin/fraud/subjects/USER/user-1/history?pageSize=101",
    );
    expect(tooBig.status).toBe(400);

    const badPage = await request(app).get("/api/admin/fraud/subjects/USER/user-1/history?page=0");
    expect(badPage.status).toBe(400);

    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("still validates the subject type", async () => {
    const res = await request(app).get("/api/admin/fraud/subjects/WALLET/user-1/history");
    expect(res.status).toBe(400);
  });

  it("returns 500 when the lookup fails", async () => {
    mockFindMany.mockRejectedValue(new Error("db down"));
    mockCount.mockResolvedValue(0);

    const res = await request(app).get("/api/admin/fraud/subjects/USER/user-1/history");
    expect(res.status).toBe(500);
  });
});
