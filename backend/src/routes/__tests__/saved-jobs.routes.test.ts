import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import jobRoutes from "../job.routes";
import { config } from "../../config";

// Mock cache module
jest.mock("../../lib/cache", () => ({
  cache: jest.fn((key, ttl, fn) => fn()),
  invalidateCache: jest.fn(),
  invalidateCacheKey: jest.fn(),
  generateJobsCacheKey: jest.fn(() => "jobs:list:key"),
  generateJobCacheKey: jest.fn((id) => `job:${id}`),
  generateJobOnChainStatusCacheKey: jest.fn((id) => `job:${id}:onchain`),
}));

// Mock contract service
jest.mock("../../services/contract.service", () => ({
  ContractService: {
    getOnChainJobStatus: jest.fn(),
    getRevisionProposal: jest.fn(),
  },
}));

// Mock Prisma
type MockPrismaClient = {
  user: {
    create: jest.Mock;
    findUnique: jest.Mock;
    deleteMany: jest.Mock;
  };
  job: {
    create: jest.Mock;
    findUnique: jest.Mock;
    delete: jest.Mock;
    deleteMany: jest.Mock;
  };
  savedJob: {
    create: jest.Mock;
    findUnique: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    delete: jest.Mock;
    deleteMany: jest.Mock;
  };
};

jest.mock("@prisma/client", () => {
  const mockPrisma: MockPrismaClient = {
    user: {
      create: jest.fn(),
      findUnique: jest.fn(),
      deleteMany: jest.fn(),
    },
    job: {
      create: jest.fn(),
      findUnique: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
    savedJob: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
  };
  return {
    PrismaClient: jest.fn(() => mockPrisma),
    UserRole: {
      CLIENT: "CLIENT",
      FREELANCER: "FREELANCER",
      ADMIN: "ADMIN",
    },
    JobStatus: {
      OPEN: "OPEN",
      IN_PROGRESS: "IN_PROGRESS",
      COMPLETED: "COMPLETED",
      CANCELLED: "CANCELLED",
      DISPUTED: "DISPUTED",
    },
  };
});

import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient() as unknown as MockPrismaClient;

const app = express();
app.use(express.json());
app.use("/api/jobs", jobRoutes);

describe.skip("Saved Jobs API", () => {
  let freelancerToken: string;
  let clientToken: string;
  let freelancerId: string;
  let clientId: string;
  let jobId: string;

  beforeAll(() => {
    freelancerId = "freelancer-id-123";
    clientId = "client-id-456";
    jobId = "job-id-789";
    
    freelancerToken = jwt.sign({ userId: freelancerId }, config.jwtSecret);
    clientToken = jwt.sign({ userId: clientId }, config.jwtSecret);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("POST /api/jobs/:id/save", () => {
    it("should allow freelancer to save a job", async () => {
      prisma.user.findUnique.mockResolvedValue({ role: "FREELANCER", emailVerified: true });
      prisma.job.findUnique.mockResolvedValue({ id: jobId, title: "Test Job" });
      prisma.savedJob.findUnique.mockResolvedValue(null);
      prisma.savedJob.create.mockResolvedValue({
        id: "saved-job-id",
        freelancerId,
        jobId,
        createdAt: new Date(),
      });

      const response = await request(app)
        .post(`/api/jobs/${jobId}/save`)
        .set("Authorization", `Bearer ${freelancerToken}`)
        .expect(201);

      expect(response.body.message).toBe("Job saved successfully.");
      expect(response.body.savedJob).toHaveProperty("id");
      expect(prisma.savedJob.create).toHaveBeenCalledWith({
        data: {
          freelancerId,
          jobId,
        },
      });
    });

    it("should return 409 when trying to save an already saved job", async () => {
      prisma.user.findUnique.mockResolvedValue({ role: "FREELANCER", emailVerified: true });
      prisma.job.findUnique.mockResolvedValue({ id: jobId });
      prisma.savedJob.findUnique.mockResolvedValue({
        id: "existing-save",
        freelancerId,
        jobId,
        createdAt: new Date(),
      });

      const response = await request(app)
        .post(`/api/jobs/${jobId}/save`)
        .set("Authorization", `Bearer ${freelancerToken}`)
        .expect(409);

      expect(response.body.error).toBe("Job already saved.");
    });

    it("should return 404 when trying to save a non-existent job", async () => {
      prisma.user.findUnique.mockResolvedValue({ role: "FREELANCER", emailVerified: true });
      prisma.job.findUnique.mockResolvedValue(null);

      const response = await request(app)
        .post("/api/jobs/non-existent-id/save")
        .set("Authorization", `Bearer ${freelancerToken}`)
        .expect(404);

      expect(response.body.error).toBe("Job not found.");
    });

    it("should return 403 when client tries to save a job", async () => {
      prisma.user.findUnique.mockResolvedValue({ role: "CLIENT", emailVerified: true });

      const response = await request(app)
        .post(`/api/jobs/${jobId}/save`)
        .set("Authorization", `Bearer ${clientToken}`)
        .expect(403);

      expect(response.body.error).toBe("Only freelancers can save jobs.");
    });

    it("should return 401 when unauthenticated user tries to save a job", async () => {
      await request(app)
        .post(`/api/jobs/${jobId}/save`)
        .expect(401);
    });
  });

  describe("GET /api/jobs/saved", () => {
    it("should return saved jobs for authenticated freelancer", async () => {
      const mockJob = {
        id: jobId,
        title: "Test Job",
        description: "Test description",
        budget: 1000,
        skills: ["JavaScript"],
        status: "OPEN",
        client: { id: clientId, username: "testclient", avatarUrl: null },
        milestones: [],
        _count: { applications: 2 },
      };

      prisma.user.findUnique.mockResolvedValue({ role: "FREELANCER", emailVerified: true });
      prisma.savedJob.findMany.mockResolvedValue([
        {
          id: "saved-1",
          freelancerId,
          jobId,
          createdAt: new Date(),
          job: mockJob,
        },
      ]);
      prisma.savedJob.count.mockResolvedValue(1);

      const response = await request(app)
        .get("/api/jobs/saved")
        .set("Authorization", `Bearer ${freelancerToken}`)
        .expect(200);

      expect(response.body).toHaveProperty("data");
      expect(response.body).toHaveProperty("total", 1);
      expect(response.body).toHaveProperty("page", 1);
      expect(response.body).toHaveProperty("totalPages");
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data[0]).toHaveProperty("isSaved", true);
      expect(response.body.data[0]).toHaveProperty("savedAt");
    });

    it("should support pagination", async () => {
      prisma.user.findUnique.mockResolvedValue({ role: "FREELANCER", emailVerified: true });
      prisma.savedJob.findMany.mockResolvedValue([]);
      prisma.savedJob.count.mockResolvedValue(0);

      const response = await request(app)
        .get("/api/jobs/saved?page=1&limit=5")
        .set("Authorization", `Bearer ${freelancerToken}`)
        .expect(200);

      expect(response.body.page).toBe(1);
      expect(prisma.savedJob.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 0,
          take: 5,
        })
      );
    });

    it("should support search filter", async () => {
      prisma.user.findUnique.mockResolvedValue({ role: "FREELANCER", emailVerified: true });
      prisma.savedJob.findMany.mockResolvedValue([]);
      prisma.savedJob.count.mockResolvedValue(0);

      await request(app)
        .get("/api/jobs/saved?search=Bookmarking")
        .set("Authorization", `Bearer ${freelancerToken}`)
        .expect(200);

      expect(prisma.savedJob.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            job: expect.objectContaining({
              OR: expect.arrayContaining([
                expect.objectContaining({ title: expect.anything() }),
              ]),
            }),
          }),
        })
      );
    });

    it("should support skill filter", async () => {
      prisma.user.findUnique.mockResolvedValue({ role: "FREELANCER", emailVerified: true });
      prisma.savedJob.findMany.mockResolvedValue([]);
      prisma.savedJob.count.mockResolvedValue(0);

      await request(app)
        .get("/api/jobs/saved?skill=JavaScript")
        .set("Authorization", `Bearer ${freelancerToken}`)
        .expect(200);

      expect(prisma.savedJob.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            job: expect.objectContaining({
              skills: { has: "JavaScript" },
            }),
          }),
        })
      );
    });

    it("should return 403 when client tries to view saved jobs", async () => {
      prisma.user.findUnique.mockResolvedValue({ role: "CLIENT", emailVerified: true });

      const response = await request(app)
        .get("/api/jobs/saved")
        .set("Authorization", `Bearer ${clientToken}`)
        .expect(403);

      expect(response.body.error).toBe("Only freelancers can view saved jobs.");
    });

    it("should return 401 when unauthenticated user tries to view saved jobs", async () => {
      await request(app)
        .get("/api/jobs/saved")
        .expect(401);
    });
  });

  describe("DELETE /api/jobs/:id/save", () => {
    it("should allow freelancer to unsave a job", async () => {
      prisma.user.findUnique.mockResolvedValue({ role: "FREELANCER", emailVerified: true });
      prisma.savedJob.findUnique.mockResolvedValue({
        id: "saved-job-id",
        freelancerId,
        jobId,
        createdAt: new Date(),
      });
      prisma.savedJob.delete.mockResolvedValue({});

      const response = await request(app)
        .delete(`/api/jobs/${jobId}/save`)
        .set("Authorization", `Bearer ${freelancerToken}`)
        .expect(200);

      expect(response.body.message).toBe("Job unsaved successfully.");
      expect(prisma.savedJob.delete).toHaveBeenCalled();
    });

    it("should return 404 when trying to unsave a job that was not saved", async () => {
      prisma.user.findUnique.mockResolvedValue({ role: "FREELANCER", emailVerified: true });
      prisma.savedJob.findUnique.mockResolvedValue(null);

      const response = await request(app)
        .delete(`/api/jobs/${jobId}/save`)
        .set("Authorization", `Bearer ${freelancerToken}`)
        .expect(404);

      expect(response.body.error).toBe("Job was not saved.");
    });

    it("should return 403 when client tries to unsave a job", async () => {
      prisma.user.findUnique.mockResolvedValue({ role: "CLIENT", emailVerified: true });

      const response = await request(app)
        .delete(`/api/jobs/${jobId}/save`)
        .set("Authorization", `Bearer ${clientToken}`)
        .expect(403);

      expect(response.body.error).toBe("Only freelancers can unsave jobs.");
    });

    it("should return 401 when unauthenticated user tries to unsave a job", async () => {
      await request(app)
        .delete(`/api/jobs/${jobId}/save`)
        .expect(401);
    });
  });

  describe("GET /api/jobs/:id - isSaved field", () => {
    // Note: The GET /:id endpoint doesn't use authenticate middleware,
    // so req.userId is not set even when a token is provided.
    // This means isSaved will always be false unless the route is updated
    // to support optional authentication.
    
    it("should include isSaved: false when unauthenticated user views a job", async () => {
      const mockJob = {
        id: jobId,
        title: "Test Job",
        description: "Test description",
        budget: 1000,
        client: { id: clientId, username: "testclient", avatarUrl: null, bio: null },
        freelancer: null,
        milestones: [],
        applications: [],
        escrowStatus: "UNFUNDED",
        contractJobId: null,
      };

      prisma.job.findUnique.mockResolvedValue(mockJob);

      const response = await request(app)
        .get(`/api/jobs/${jobId}`)
        .expect(200);

      expect(response.body).toHaveProperty("isSaved", false);
    });
  });
});
