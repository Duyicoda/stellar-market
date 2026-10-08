import express from "express";
import request from "supertest";
import { writeRateLimiter, resetAllRateLimiters } from "../middleware/rate-limit";

jest.mock("../config/redis", () => ({
  getRedisClient: jest.fn(() => null),
}));

jest.mock("../lib/logger", () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
  installRequestIdConsolePatch: jest.fn(),
}));

describe("writeRateLimiter HTTP Methods (Issue #931)", () => {
  let app: express.Application;

  beforeEach(async () => {
    await resetAllRateLimiters();
    app = express();
    app.use(express.json());

    app.get("/api/v1/jobs/:id", writeRateLimiter, (_req, res) => {
      res.json({ message: "read job" });
    });
    app.post("/api/v1/jobs", writeRateLimiter, (_req, res) => {
      res.json({ message: "created job" });
    });
    app.put("/api/v1/jobs/:id", writeRateLimiter, (_req, res) => {
      res.json({ message: "updated job" });
    });
    app.patch("/api/v1/jobs/:id/status", writeRateLimiter, (_req, res) => {
      res.json({ message: "patched job status" });
    });
    app.delete("/api/v1/jobs/:id", writeRateLimiter, (_req, res) => {
      res.json({ message: "deleted job" });
    });
  });

  it("skips rate limiting for GET requests", async () => {
    for (let i = 0; i < 35; i++) {
      const response = await request(app).get("/api/v1/jobs/123");
      expect(response.status).toBe(200);
    }
  });

  it("applies rate limiting to PUT requests after limit (max 30)", async () => {
    for (let i = 0; i < 30; i++) {
      const res = await request(app).put("/api/v1/jobs/123").send({ title: "Updated" });
      expect(res.status).toBe(200);
    }
    const rateLimitedRes = await request(app).put("/api/v1/jobs/123").send({ title: "Updated" });
    expect(rateLimitedRes.status).toBe(429);
    expect(rateLimitedRes.body).toEqual({ error: "Too many write requests" });
  });

  it("applies rate limiting to PATCH requests", async () => {
    for (let i = 0; i < 30; i++) {
      const res = await request(app).patch("/api/v1/jobs/123/status").send({ status: "COMPLETED" });
      expect(res.status).toBe(200);
    }
    const rateLimitedRes = await request(app).patch("/api/v1/jobs/123/status").send({ status: "COMPLETED" });
    expect(rateLimitedRes.status).toBe(429);
  });

  it("applies rate limiting to DELETE requests", async () => {
    for (let i = 0; i < 30; i++) {
      const res = await request(app).delete("/api/v1/jobs/123");
      expect(res.status).toBe(200);
    }
    const rateLimitedRes = await request(app).delete("/api/v1/jobs/123");
    expect(rateLimitedRes.status).toBe(429);
  });
});
