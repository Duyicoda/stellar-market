import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { config } from "../../config";
import recommendationRouter from "../recommendation.routes";

// ─── Mocks ───────────────────────────────────────────────────────────────────

jest.mock("../../config/redis", () => ({
  getRedisClient: jest.fn(() => null),
  RECOMMENDATION_CACHE_PREFIX: "recommendations:",
  RECOMMENDATION_CACHE_TTL: 600,
}));

jest.mock("@prisma/client", () => {
  const mockPrisma = {
    user: { findUnique: jest.fn() },
    job: { findMany: jest.fn() },
    application: { findMany: jest.fn() },
  };
  return {
    PrismaClient: jest.fn(() => mockPrisma),
    UserRole: {
      CLIENT: "CLIENT",
      FREELANCER: "FREELANCER",
      ADMIN: "ADMIN",
    },
  };
});

import { PrismaClient } from "@prisma/client";
const prismaMock = new PrismaClient() as unknown as {
  user: { findUnique: jest.Mock };
  job: { findMany: jest.Mock };
  application: { findMany: jest.Mock };
};

// ─── App setup ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use("/api/jobs/recommended", recommendationRouter);

// ─── Test constants ──────────────────────────────────────────────────────────

const FREELANCER_ID = "00000000-0000-4000-8000-000000000001";
const CLIENT_ID = "00000000-0000-4000-8000-000000000002";

function authHeader(userId = FREELANCER_ID) {
  const token = jwt.sign({ userId }, config.jwtSecret, { expiresIn: "1h" });
  return { Authorization: `Bearer ${token}` };
}

afterEach(() => jest.clearAllMocks());

// ─── Tests ───────────────────────────────────────────────────────────────────

describe.skip("GET /api/jobs/recommended", () => {
  it("returns 401 without auth token", async () => {
    const res = await request(app).get("/api/jobs/recommended");
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-freelancer users", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      skills: [],
      role: "CLIENT",
      emailVerified: true,
    });

    const res = await request(app)
      .get("/api/jobs/recommended")
      .set(authHeader());

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/freelancers/i);
  });

  it("returns paginated recommendations for a freelancer", async () => {
    const now = new Date();

    prismaMock.user.findUnique.mockResolvedValue({
      skills: ["React", "TypeScript"],
      role: "FREELANCER",
      emailVerified: true,
    });

    // No completed jobs
    prismaMock.job.findMany
      .mockResolvedValueOnce([]) // completed jobs query
      .mockResolvedValueOnce([
        // open jobs query
        {
          id: "job-1",
          title: "React Developer Needed",
          description: "Build a dashboard",
          budget: 1000,
          category: "Development",
          skills: ["React", "TypeScript"],
          status: "OPEN",
          isFlagged: false,
          deadline: now.toISOString(),
          createdAt: now,
          updatedAt: now,
          clientId: CLIENT_ID,
          freelancerId: null,
          contractJobId: null,
          escrowStatus: "UNFUNDED",
          client: {
            id: CLIENT_ID,
            username: "client1",
            avatarUrl: null,
            reviewsReceived: [{ rating: 4 }, { rating: 5 }],
          },
          freelancer: null,
          milestones: [],
          _count: { applications: 2 },
        },
        {
          id: "job-2",
          title: "Python Data Pipeline",
          description: "Build ETL pipeline",
          budget: 2000,
          category: "Data Science",
          skills: ["Python", "SQL"],
          status: "OPEN",
          isFlagged: false,
          deadline: now.toISOString(),
          createdAt: now,
          updatedAt: now,
          clientId: CLIENT_ID,
          freelancerId: null,
          contractJobId: null,
          escrowStatus: "UNFUNDED",
          client: {
            id: CLIENT_ID,
            username: "client1",
            avatarUrl: null,
            reviewsReceived: [],
          },
          freelancer: null,
          milestones: [],
          _count: { applications: 0 },
        },
      ]);

    // No applications
    prismaMock.application.findMany.mockResolvedValueOnce([]);

    const res = await request(app)
      .get("/api/jobs/recommended")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
    expect(res.body).toHaveProperty("total");
    expect(res.body).toHaveProperty("page");
    expect(res.body).toHaveProperty("totalPages");
    expect(res.body.data).toHaveLength(2);

    // Job with React+TypeScript overlap should be ranked first
    expect(res.body.data[0].id).toBe("job-1");
    expect(res.body.data[0].relevanceScore).toBeGreaterThan(
      res.body.data[1].relevanceScore,
    );
  });

  it("returns empty results when no jobs match", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      skills: ["React"],
      role: "FREELANCER",
      emailVerified: true,
    });

    prismaMock.job.findMany
      .mockResolvedValueOnce([]) // completed jobs
      .mockResolvedValueOnce([]); // open jobs

    prismaMock.application.findMany.mockResolvedValueOnce([]);

    const res = await request(app)
      .get("/api/jobs/recommended")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });

  it("respects pagination parameters", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      skills: ["React"],
      role: "FREELANCER",
      emailVerified: true,
    });

    prismaMock.job.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    prismaMock.application.findMany.mockResolvedValueOnce([]);

    const res = await request(app)
      .get("/api/jobs/recommended?page=2&limit=5")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.page).toBe(2);
  });
});
