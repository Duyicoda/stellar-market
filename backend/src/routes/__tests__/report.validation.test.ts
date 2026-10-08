import express from "express";
import request from "supertest";
import reportRoutes from "../report.routes";
import { errorHandler } from "../../middleware/error";

const reportCreateMock = jest.fn();
const reportCountMock = jest.fn();
const userUpdateMock = jest.fn();

jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn(() => ({
    report: {
      create: (...args: unknown[]) => reportCreateMock(...args),
      count: (...args: unknown[]) => reportCountMock(...args),
    },
    user: {
      update: (...args: unknown[]) => userUpdateMock(...args),
    },
  })),
}));

jest.mock("../../middleware/auth", () => ({
  authenticate: jest.fn((req, _res, next) => {
    req.userId = "user-1";
    next();
  }),
}));

const app = express();
app.use(express.json());
app.use("/api/reports", reportRoutes);
app.use(errorHandler);

describe("report route validation", () => {
  it("rejects invalid report payloads before Prisma is called", async () => {
    const response = await request(app)
      .post("/api/reports")
      .send({ targetType: "JOB", targetId: "", reason: "short" });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Validation failed");
    expect(reportCreateMock).not.toHaveBeenCalled();
  });

  it("rejects report payloads with an oversized targetId", async () => {
    const oversizedTargetId = "a".repeat(256);
    const response = await request(app)
      .post("/api/reports")
      .send({
        targetType: "JOB",
        targetId: oversizedTargetId,
        reason: "Valid reason text with enough length",
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Validation failed");
    expect(reportCreateMock).not.toHaveBeenCalled();
  });
});
