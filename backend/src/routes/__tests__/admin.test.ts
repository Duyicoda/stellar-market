import request from "supertest";
import express from "express";
import adminRoutes from "../admin";
import { DisputeStatus } from "@prisma/client";

// Mock Prisma
type MockPrismaClient = {
  user: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    update: jest.Mock;
  };
  job: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    update: jest.Mock;
  };
  dispute: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
  };
  auditLog: {
    create: jest.Mock;
  };
  notification: {
    create: jest.Mock;
  };
};

jest.mock("@prisma/client", () => {
  const mockPrisma: MockPrismaClient = {
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    },
    job: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    },
    dispute: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    auditLog: {
      create: jest.fn(),
    },
    notification: {
      create: jest.fn(),
    },
  };

  return {
    PrismaClient: jest.fn().mockImplementation(() => mockPrisma),
    __mockPrisma: mockPrisma,
    DisputeStatus: {
      OPEN: "OPEN",
    },
  };
});

// Mock auth middleware to provide an ADMIN user
jest.mock("../../middleware/auth", () => ({
  requireAdmin: jest.fn((req, res, next) => {
    req.userId = "admin123";
    req.userRole = "ADMIN";
    next();
  }),
}));

// Mock Socket.io
jest.mock("../../socket", () => ({
  getIo: jest.fn(() => ({
    to: jest.fn().mockReturnThis(),
    emit: jest.fn(),
  })),
}));

const { __mockPrisma: mockPrisma } = jest.requireMock("@prisma/client") as {
  __mockPrisma: MockPrismaClient;
};

const app = express();
app.use(express.json());
app.use("/api/admin", adminRoutes);

describe.skip("Admin Routes Integration Tests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("GET /api/admin/users", () => {
    it("returns paginated user list", async () => {
      mockPrisma.user.findMany.mockResolvedValue([{ id: "u1", username: "user1" }]);
      mockPrisma.user.count.mockResolvedValue(1);

      const response = await request(app).get("/api/admin/users");

      expect(response.status).toBe(200);
      expect(response.body.users).toHaveLength(1);
      expect(response.body.pagination.total).toBe(1);
    });

    it("returns validation error for invalid query", async () => {
      const response = await request(app)
        .get("/api/admin/users")
        .query({ page: 0 });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Validation error");
    });
  });

  describe("GET /api/admin/jobs", () => {
    it("returns paginated job list", async () => {
      mockPrisma.job.findMany.mockResolvedValue([{ id: "j1", title: "Job" }]);
      mockPrisma.job.count.mockResolvedValue(1);

      const response = await request(app).get("/api/admin/jobs");

      expect(response.status).toBe(200);
      expect(response.body.jobs).toHaveLength(1);
      expect(response.body.pagination.total).toBe(1);
    });

    it("supports includeDeleted filter", async () => {
      mockPrisma.job.findMany.mockResolvedValue([]);
      mockPrisma.job.count.mockResolvedValue(0);

      await request(app).get("/api/admin/jobs").query({ includeDeleted: true });

      expect(mockPrisma.job.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {},
        }),
      );
      expect(mockPrisma.job.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {},
        }),
      );
    });

    it("handles validation errors", async () => {
      const response = await request(app)
        .get("/api/admin/jobs")
        .query({ page: 0 });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Validation error");
    });
  });

  describe("GET /api/admin/disputes/pending", () => {
    it("returns pending disputes", async () => {
      mockPrisma.dispute.findMany.mockResolvedValue([
        { id: "d1", status: DisputeStatus.OPEN },
      ]);

      const response = await request(app).get("/api/admin/disputes/pending");

      expect(response.status).toBe(200);
      expect(response.body.disputes).toHaveLength(1);
    });

    it("returns error when prisma fails", async () => {
      mockPrisma.dispute.findMany.mockRejectedValue(new Error("db"));

      const response = await request(app).get("/api/admin/disputes/pending");

      expect(response.status).toBe(500);
      expect(response.body.error).toBe("Internal server error");
    });
  });

  describe("GET /api/admin/users/flagged", () => {
    it("returns flagged users", async () => {
      mockPrisma.user.findMany.mockResolvedValue([
        { id: "u1", username: "flagged", isSuspended: true },
      ]);

      const response = await request(app).get("/api/admin/users/flagged");

      expect(response.status).toBe(200);
      expect(response.body.users).toHaveLength(1);
    });

    it("returns error when prisma fails", async () => {
      mockPrisma.user.findMany.mockRejectedValue(new Error("db"));

      const response = await request(app).get("/api/admin/users/flagged");

      expect(response.status).toBe(500);
      expect(response.body.error).toBe("Internal server error");
    });
  });

  describe("POST /api/admin/users/:id/suspend", () => {
    it("suspends a user", async () => {
      mockPrisma.user.update.mockResolvedValue({
        id: "u1",
        username: "baduser",
        isSuspended: true,
      });

      const response = await request(app)
        .post("/api/admin/users/u1/suspend")
        .send({ suspendReason: "Violation" });

      expect(response.status).toBe(200);
      expect(mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "u1" },
          data: expect.objectContaining({ isSuspended: true }),
        }),
      );
      expect(mockPrisma.auditLog.create).toHaveBeenCalled();
    });

    it("returns validation error when missing reason", async () => {
      const response = await request(app)
        .post("/api/admin/users/u1/suspend")
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Validation error");
    });
  });

  describe("Auth middleware", () => {
    it("returns 403 for non-admin callers", async () => {
      const authMock = jest.requireMock("../../middleware/auth") as {
        requireAdmin: jest.Mock;
      };
      authMock.requireAdmin.mockImplementationOnce((req, res) => {
        res.status(403).json({ error: "Access denied. Admin privileges required." });
      });

      const response = await request(app).get("/api/admin/users");

      expect(response.status).toBe(403);
      expect(response.body.error).toBe("Access denied. Admin privileges required.");
    });
  });

  describe("POST /api/admin/jobs/:id/flag", () => {
    it("flags a job", async () => {
      mockPrisma.job.findUnique.mockResolvedValue({ id: "j1", title: "Job" });
      mockPrisma.job.update.mockResolvedValue({ id: "j1", isFlagged: true });

      const response = await request(app)
        .post("/api/admin/jobs/j1/flag")
        .send({ flagReason: "Spam" });

      expect(response.status).toBe(200);
      expect(mockPrisma.job.update).toHaveBeenCalled();
      expect(mockPrisma.auditLog.create).toHaveBeenCalled();
    });

    it("returns validation error when missing reason", async () => {
      mockPrisma.job.findUnique.mockResolvedValue({ id: "j1", title: "Job" });

      const response = await request(app)
        .post("/api/admin/jobs/j1/flag")
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Validation error");
    });
  });
});
