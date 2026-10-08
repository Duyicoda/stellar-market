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

describe("writeRateLimiter on /admin", () => {
  let app: express.Application;

  beforeEach(async () => {
    await resetAllRateLimiters();
    app = express();
    app.use(express.json());

    // Mirrors the mount in src/index.ts: writeRateLimiter on /api/v1/admin
    app.use("/api/v1/admin", writeRateLimiter);

    app.get("/api/v1/admin/users", (_req, res) => {
      res.json({ message: "list users" });
    });
    app.get("/api/v1/admin/disputes", (_req, res) => {
      res.json({ message: "list disputes" });
    });
    app.patch("/api/v1/admin/users/:id/suspend", (_req, res) => {
      res.json({ message: "suspended" });
    });
    app.delete("/api/v1/admin/jobs/:id", (_req, res) => {
      res.json({ message: "deleted job" });
    });
    app.post("/api/v1/admin/disputes/:id/override", (_req, res) => {
      res.json({ message: "overridden" });
    });
    app.post("/api/v1/admin/fraud/flags/:id/review", (_req, res) => {
      res.json({ message: "flag reviewed" });
    });
  });

  it("returns 429 after the limit on repeated admin writes", async () => {
    for (let i = 0; i < 30; i++) {
      const res = await request(app).patch("/api/v1/admin/users/123/suspend");
      expect(res.status).toBe(200);
    }
    const rateLimited = await request(app).patch("/api/v1/admin/users/123/suspend");
    expect(rateLimited.status).toBe(429);
    expect(rateLimited.body).toEqual({ error: "Too many write requests" });
    expect(rateLimited.headers["retry-after"]).toBeDefined();
  });

  it("rate limits admin DELETE (delete job)", async () => {
    for (let i = 0; i < 30; i++) {
      const res = await request(app).delete("/api/v1/admin/jobs/abc");
      expect(res.status).toBe(200);
    }
    const rateLimited = await request(app).delete("/api/v1/admin/jobs/abc");
    expect(rateLimited.status).toBe(429);
  });

  it("rate limits admin POST routes including the fraud sub-router", async () => {
    for (let i = 0; i < 30; i++) {
      const res = await request(app).post("/api/v1/admin/fraud/flags/flag1/review");
      expect(res.status).toBe(200);
    }
    const rateLimited = await request(app).post("/api/v1/admin/fraud/flags/flag1/review");
    expect(rateLimited.status).toBe(429);
  });

  it("shares the limit across admin sub-paths and verbs", async () => {
    for (let i = 0; i < 20; i++) {
      await request(app).post("/api/v1/admin/disputes/1/override");
    }
    for (let i = 0; i < 10; i++) {
      const res = await request(app).post("/api/v1/admin/disputes/2/override");
      expect(res.status).toBe(200);
    }
    const rateLimited = await request(app).patch("/api/v1/admin/users/9/suspend");
    expect(rateLimited.status).toBe(429);
  });

  it("leaves GET admin routes unaffected", async () => {
    for (let i = 0; i < 50; i++) {
      const res = await request(app).get("/api/v1/admin/users");
      expect(res.status).toBe(200);
    }
    const disputes = await request(app).get("/api/v1/admin/disputes");
    expect(disputes.status).toBe(200);
  });

  it("does not consume the write quota on GET requests", async () => {
    for (let i = 0; i < 100; i++) {
      await request(app).get("/api/v1/admin/users");
    }
    for (let i = 0; i < 30; i++) {
      const res = await request(app).post("/api/v1/admin/disputes/1/override");
      expect(res.status).toBe(200);
    }
    const rateLimited = await request(app).post("/api/v1/admin/disputes/1/override");
    expect(rateLimited.status).toBe(429);
  });
});
