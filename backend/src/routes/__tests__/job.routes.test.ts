import request from "supertest";
import express from "express";
import { Request, Response, NextFunction } from "express";

jest.mock("@prisma/client", () => {
  const mockPrisma = {
    job: {
      findFirst: jest.fn().mockResolvedValue({
        id: "job-id",
        clientId: "test-client-id",
        deletedAt: null,
      }),
      update: jest.fn(),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({ tokenVersion: 1 }),
    },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

interface AuthRequest extends Request {
  userId?: string;
}

jest.mock("../../middleware/auth", () => ({
  authenticate: (req: AuthRequest, res: Response, next: NextFunction) => {
    req.userId = "test-client-id";
    next();
  },
  optionalAuthenticate: (req: AuthRequest, res: Response, next: NextFunction) => {
    req.userId = "test-client-id";
    next();
  },
}));

import jobRoutes from "../job.routes";
import { errorHandler } from "../../middleware/error";

describe("Job Routes - PUT /:id", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/jobs", jobRoutes);
  app.use(errorHandler);

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("should reject setting status to COMPLETED directly via generic update", async () => {
    const response = await request(app)
      .put("/api/jobs/job-id")
      .send({ status: "COMPLETED" });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Cannot update job status to COMPLETED directly.");
  });

  it("should reject setting status to CANCELLED directly via generic update", async () => {
    const response = await request(app)
      .put("/api/jobs/job-id")
      .send({ status: "CANCELLED" });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Cannot update job status to CANCELLED directly.");
  });
});
