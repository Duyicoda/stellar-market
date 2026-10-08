import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { EventEmitter } from "events";
import { config } from "../../config";
import jobRouter from "../../routes/job.routes";
import userRouter from "../../routes/user.routes";
import { invalidateCache } from "../cache";

// Produces a scanStream-compatible EventEmitter that emits batches then 'end'.
function makeScanStream(batches: string[][]): EventEmitter {
  const emitter = new EventEmitter();
  process.nextTick(() => {
    for (const batch of batches) {
      emitter.emit("data", batch);
    }
    emitter.emit("end");
  });
  return emitter;
}

// Mock Redis client
jest.mock("../redis", () => {
  const mockPipeline = {
    del: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue([]),
  };

  const mockRedis = {
    get: jest.fn(),
    setex: jest.fn(),
    del: jest.fn(),
    keys: jest.fn(),
    scanStream: jest.fn(),
    pipeline: jest.fn(() => mockPipeline),
    status: "ready",
    on: jest.fn(),
    connect: jest.fn(),
    quit: jest.fn(),
    duplicate: jest.fn(),
  };
  // recommendation-queue.service.ts duplicates the shared client into a
  // dedicated blocking-safe connection for its BullMQ Worker.
  mockRedis.duplicate.mockReturnValue(mockRedis);

  return {
    __esModule: true,
    default: {
      getInstance: jest.fn(() => mockRedis),
      isRedisConnected: jest.fn(() => true),
      connect: jest.fn(),
      disconnect: jest.fn(),
    },
  };
});

// Mock Prisma
type MockPrismaClient = {
  job: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    count: jest.Mock;
  };
  user: {
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    update: jest.Mock;
  };
};

jest.mock("@prisma/client", () => {
  const mockPrisma: MockPrismaClient = {
    job: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
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

import { UserRole } from "@prisma/client";
import { PrismaClient } from "@prisma/client";
import RedisClientDefault from "../redis";

const prismaMock = new PrismaClient() as unknown as MockPrismaClient;
const jobMock = prismaMock.job;
const userMock = prismaMock.user;

// Get mock Redis instance
type MockRedisClientStatic = {
  getInstance: jest.Mock;
  isRedisConnected: jest.Mock;
  connect: jest.Mock;
  disconnect: jest.Mock;
};

const RedisClient = RedisClientDefault as unknown as MockRedisClientStatic;
const mockRedis = RedisClient.getInstance() as {
  get: jest.Mock;
  setex: jest.Mock;
  del: jest.Mock;
  keys: jest.Mock;
  scanStream: jest.Mock;
  pipeline: jest.Mock;
};
const mockPipeline = mockRedis.pipeline();

// App setup
const app = express();
app.use(express.json());
app.use("/api/jobs", jobRouter);
app.use("/api/users", userRouter);

// Test constants
const USER_TEST_ID = "00000000-0000-4000-8000-000000000001";
const USER_OTHER_ID = "00000000-0000-4000-8000-000000000002";
const JOB_TEST_ID = "00000000-0000-4000-8000-000000000010";

// Helper: auth header
function authHeader(userId = USER_TEST_ID) {
  const token = jwt.sign({ userId }, config.jwtSecret, { expiresIn: "1h" });
  return { Authorization: `Bearer ${token}` };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Re-wire pipeline mock after clearAllMocks so chained .del() calls still work.
  mockRedis.pipeline.mockReturnValue(mockPipeline);
  mockPipeline.del.mockReturnValue(mockPipeline);
  mockPipeline.exec.mockResolvedValue([]);
  // Ensure authenticated requests pass the authenticate middleware
  userMock.findUnique.mockResolvedValue({
    id: USER_TEST_ID,
    role: UserRole.CLIENT,
    emailVerified: true,
  });
});

afterEach(() => jest.clearAllMocks());

// ─── invalidateCache unit tests (issue #1185) ────────────────────────────────
// These tests verify that invalidateCache uses SCAN (non-blocking) instead of
// KEYS. We do NOT assert on redis.keys — that call must never appear.
describe("invalidateCache", () => {
  it("deletes all keys matching the pattern via SCAN + pipeline", async () => {
    const matchedKeys = ["jobs:list:abc", "jobs:list:def"];
    mockRedis.scanStream.mockReturnValueOnce(makeScanStream([matchedKeys]));

    await invalidateCache("jobs:list:*");

    // SCAN was called with the correct match pattern.
    expect(mockRedis.scanStream).toHaveBeenCalledWith({
      match: "jobs:list:*",
      count: 100,
    });

    // Each matched key was queued in the pipeline.
    expect(mockPipeline.del).toHaveBeenCalledWith("jobs:list:abc");
    expect(mockPipeline.del).toHaveBeenCalledWith("jobs:list:def");
    expect(mockPipeline.exec).toHaveBeenCalledTimes(1);

    // The blocking KEYS command must not be called.
    expect(mockRedis.keys).not.toHaveBeenCalled();
  });

  it("handles multiple scan batches and deletes all keys", async () => {
    const batch1 = ["jobs:list:a1", "jobs:list:a2"];
    const batch2 = ["jobs:list:b1"];
    mockRedis.scanStream.mockReturnValueOnce(makeScanStream([batch1, batch2]));

    await invalidateCache("jobs:list:*");

    expect(mockPipeline.del).toHaveBeenCalledTimes(3);
    expect(mockPipeline.exec).toHaveBeenCalledTimes(1);
    expect(mockRedis.keys).not.toHaveBeenCalled();
  });

  it("skips pipeline exec when no keys match", async () => {
    mockRedis.scanStream.mockReturnValueOnce(makeScanStream([[]]));

    await invalidateCache("jobs:list:*");

    expect(mockPipeline.exec).not.toHaveBeenCalled();
    expect(mockRedis.keys).not.toHaveBeenCalled();
  });

  it("does nothing when Redis is not connected", async () => {
    (RedisClient.isRedisConnected as jest.Mock).mockReturnValueOnce(false);

    await invalidateCache("jobs:list:*");

    expect(mockRedis.scanStream).not.toHaveBeenCalled();
    expect(mockRedis.keys).not.toHaveBeenCalled();
  });

  it("swallows scan stream errors without throwing", async () => {
    const errStream = new EventEmitter();
    mockRedis.scanStream.mockReturnValueOnce(errStream);

    const promise = invalidateCache("jobs:list:*");
    process.nextTick(() => errStream.emit("error", new Error("scan failed")));

    await expect(promise).resolves.toBeUndefined();
    expect(mockRedis.keys).not.toHaveBeenCalled();
  });
});
// ─────────────────────────────────────────────────────────────────────────────

describe.skip("Cache Integration Tests", () => {
  describe("GET /api/jobs caching", () => {
    const mockJobData = {
      data: [
        {
          id: JOB_TEST_ID,
          title: "Test Job",
          description: "Test Description",
          budget: 1000,
          status: "OPEN",
          client: { id: USER_TEST_ID, username: "alice", avatarUrl: null },
          freelancer: null,
          milestones: [],
          _count: { applications: 0 },
        },
      ],
      total: 1,
      page: 1,
      totalPages: 1,
    };

    it("should cache job listings on first request and serve from cache on subsequent requests", async () => {
      // Mock cache miss on first request
      mockRedis.get.mockResolvedValueOnce(null);
      mockRedis.setex.mockResolvedValueOnce("OK");

      // Mock database response
      jobMock.findMany.mockResolvedValueOnce(mockJobData.data);
      jobMock.count.mockResolvedValueOnce(mockJobData.total);

      // First request - cache miss
      const res1 = await request(app)
        .get("/api/jobs?page=1&limit=10")
        .set(authHeader());

      expect(res1.status).toBe(200);
      expect(res1.headers["x-cache-hit"]).toBe("false");
      expect(mockRedis.get).toHaveBeenCalledWith(
        expect.stringMatching(/^jobs:list:/),
      );
      expect(mockRedis.setex).toHaveBeenCalledWith(
        expect.stringMatching(/^jobs:list:/),
        60,
        expect.any(String),
      );

      // Mock cache hit on second request
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(mockJobData));

      // Second request - cache hit
      const res2 = await request(app)
        .get("/api/jobs?page=1&limit=10")
        .set(authHeader());

      expect(res2.status).toBe(200);
      expect(res2.headers["x-cache-hit"]).toBe("true");
      expect(res2.body).toEqual(mockJobData);

      // Database should not be called on cache hit
      expect(jobMock.findMany).toHaveBeenCalledTimes(1);
      expect(jobMock.count).toHaveBeenCalledTimes(1);
    });

    it("should generate different cache keys for different query parameters", async () => {
      mockRedis.get.mockResolvedValue(null);
      mockRedis.setex.mockResolvedValue("OK");

      jobMock.findMany.mockResolvedValue([]);
      jobMock.count.mockResolvedValue(0);

      // Request with different parameters
      await request(app)
        .get("/api/jobs?page=1&limit=10&status=OPEN")
        .set(authHeader());

      await request(app)
        .get("/api/jobs?page=1&limit=10&status=CLOSED")
        .set(authHeader());

      // Should have different cache keys
      expect(mockRedis.get).toHaveBeenCalledTimes(2);
      expect(mockRedis.setex).toHaveBeenCalledTimes(2);

      const firstCallKey = (mockRedis.get as jest.Mock).mock.calls[0][0];
      const secondCallKey = (mockRedis.get as jest.Mock).mock.calls[1][0];

      expect(firstCallKey).not.toBe(secondCallKey);
    });
  });

  describe("GET /api/users/:id caching", () => {
    const mockUserData = {
      id: USER_OTHER_ID,
      username: "bob",
      walletAddress: "0x123",
      bio: "Test bio",
      avatarUrl: null,
      role: "FREELANCER",
      emailVerified: true,
      createdAt: new Date().toISOString(),
      reviewsReceived: [],
      clientJobs: [],
      freelancerJobs: [],
      averageRating: 0,
      reviewCount: 0,
    };

    it("should cache user profile on first request and serve from cache on subsequent requests", async () => {
      // Mock cache miss on first request
      mockRedis.get.mockResolvedValueOnce(null);
      mockRedis.setex.mockResolvedValueOnce("OK");

      // Mock database response
      userMock.findUnique.mockResolvedValueOnce({
        id: USER_OTHER_ID,
        username: "bob",
        walletAddress: "0x123",
        bio: "Test bio",
        avatarUrl: null,
        role: "FREELANCER",
        emailVerified: true,
        createdAt: new Date(),
        reviewsReceived: [],
        clientJobs: [],
        freelancerJobs: [],
      });

      // First request - cache miss
      const res1 = await request(app)
        .get(`/api/users/${USER_OTHER_ID}`)
        .set(authHeader());

      expect(res1.status).toBe(200);
      expect(res1.headers["x-cache-hit"]).toBe("false");
      expect(mockRedis.get).toHaveBeenCalledWith(
        `user:profile:${USER_OTHER_ID}`,
      );
      expect(mockRedis.setex).toHaveBeenCalledWith(
        `user:profile:${USER_OTHER_ID}`,
        300,
        expect.any(String),
      );

      // Mock cache hit on second request
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(mockUserData));

      // Second request - cache hit
      const res2 = await request(app)
        .get(`/api/users/${USER_OTHER_ID}`)
        .set(authHeader());

      expect(res2.status).toBe(200);
      expect(res2.headers["x-cache-hit"]).toBe("true");
      expect(res2.body).toEqual(mockUserData);

      // Database should not be called on cache hit
      expect(userMock.findUnique).toHaveBeenCalledTimes(1);
    });

    it("should handle user not found correctly", async () => {
      mockRedis.get.mockResolvedValueOnce(null);
      userMock.findUnique.mockResolvedValue(null);

      const res = await request(app)
        .get(`/api/users/${USER_OTHER_ID}`)
        .set(authHeader());

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "User not found." });
    });
  });

  describe("Cache invalidation", () => {
    it("should invalidate job listings cache when creating a new job", async () => {
      const mockJob = {
        id: JOB_TEST_ID,
        title: "New Job",
        description: "Description",
        budget: 1000,
        clientId: USER_TEST_ID,
        status: "OPEN",
        createdAt: new Date(),
        updatedAt: new Date(),
        skills: ["JavaScript"],
        deadline: new Date("2026-12-31T23:59:59Z"),
        category: "Development",
      };

      // Mock successful job creation
      jobMock.create.mockResolvedValueOnce(mockJob);
      mockRedis.keys.mockResolvedValueOnce([
        "jobs:list:abc123",
        "jobs:list:def456",
      ]);
      mockRedis.del.mockResolvedValueOnce(2);

      const res = await request(app)
        .post("/api/jobs")
        .set(authHeader())
        .send({
          title: "New Job",
          description:
            "Description for the new job that is at least 20 characters long",
          budget: 1000,
          skills: ["JavaScript"],
          deadline: "2026-12-31T23:59:59Z",
          category: "Development",
        });

      expect(res.status).toBe(201);
      expect(mockRedis.keys).toHaveBeenCalledWith("jobs:list:*");
      expect(mockRedis.del).toHaveBeenCalledWith(
        "jobs:list:abc123",
        "jobs:list:def456",
      );
    });

    it("should invalidate user profile cache when updating profile", async () => {
      const mockUser = {
        id: USER_TEST_ID,
        username: "alice",
        bio: "Updated bio",
      };

      // Mock successful user update
      userMock.findFirst.mockResolvedValueOnce(null); // No username conflict
      userMock.update.mockResolvedValueOnce(mockUser);
      mockRedis.del.mockResolvedValueOnce(1);

      const res = await request(app)
        .put("/api/users/me")
        .set(authHeader())
        .send({ bio: "Updated bio" });

      expect(res.status).toBe(200);
      expect(mockRedis.del).toHaveBeenCalledWith(
        `user:profile:${USER_TEST_ID}`,
      );
    });
  });

  describe("Graceful degradation", () => {
    it("should fall back to database when Redis is unavailable", async () => {
      // Mock Redis connection failure
      RedisClient.isRedisConnected.mockReturnValue(false);
      mockRedis.get.mockRejectedValueOnce(new Error("Redis connection failed"));

      // Mock database response
      jobMock.findMany.mockResolvedValueOnce([]);
      jobMock.count.mockResolvedValueOnce(0);

      const res = await request(app)
        .get("/api/jobs?page=1&limit=10")
        .set(authHeader());

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        data: [],
        nextCursor: null,
        total: 0,
        page: 1,
        totalPages: 0,
      });

      // Should still attempt database query
      expect(jobMock.findMany).toHaveBeenCalledTimes(1);
      expect(jobMock.count).toHaveBeenCalledTimes(1);
    });

    it("should handle cache set errors gracefully", async () => {
      // Mock cache miss but set fails
      mockRedis.get.mockResolvedValueOnce(null);
      mockRedis.setex.mockRejectedValueOnce(new Error("Redis set failed"));

      // Mock database response (called twice due to cache error retry)
      jobMock.findMany.mockResolvedValue([]);
      jobMock.count.mockResolvedValue(0);

      const res = await request(app)
        .get("/api/jobs?page=1&limit=10")
        .set(authHeader());

      expect(res.status).toBe(200);
      expect(res.headers["x-cache-hit"]).toBe("false");

      // Database is called twice due to cache error retry logic
      expect(jobMock.findMany).toHaveBeenCalledTimes(2);
      expect(jobMock.count).toHaveBeenCalledTimes(2);
    });
  });
});
