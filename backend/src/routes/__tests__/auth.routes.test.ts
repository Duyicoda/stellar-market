import request from "supertest";
import express from "express";
import { Request, Response, NextFunction } from "express";

// ─── ESM module mocks ────────────────────────────────────────────────────────
jest.mock("otplib", () => ({
  generateSecret: jest.fn(() => "mock-secret"),
  generateSync: jest.fn(() => "123456"),
  verifySync: jest.fn(() => ({ valid: true, delta: 0 })),
  generateURI: jest.fn(() => "otpauth://mock"),
}));

jest.mock("qrcode", () => ({
  toDataURL: jest.fn().mockResolvedValue("data:image/png;base64,mockqr"),
}));

jest.mock("@prisma/client", () => {
  const mockPrisma = {
    user: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    refreshToken: {
      updateMany: jest.fn(),
      create: jest.fn(),
    },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

interface AuthRequest extends Request {
  userId?: string;
}

jest.mock("../../middleware/auth", () => ({
  authenticate: (req: AuthRequest, res: Response, next: NextFunction) => {
    req.userId = "test-user-id";
    next();
  },
}));

jest.mock("bcryptjs", () => ({
  hash: jest.fn().mockResolvedValue("new-hashed-password"),
  compare: jest.fn().mockResolvedValue(true),
}));

import { PrismaClient } from "@prisma/client";
import authRoutes from "../auth.routes";
import { errorHandler } from "../../middleware/error";

const prismaMock = new PrismaClient() as jest.Mocked<PrismaClient>;
const userMock = prismaMock.user as unknown as {
  findFirst: jest.Mock;
  findUnique: jest.Mock;
  update: jest.Mock;
};
const refreshTokenMock = prismaMock.refreshToken as unknown as {
  updateMany: jest.Mock;
  create: jest.Mock;
};

describe("Auth Routes - Password Reset / Change", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRoutes);
  app.use(errorHandler);

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("POST /reset-password should revoke refresh tokens", async () => {
    userMock.findFirst.mockResolvedValue({ id: "test-user-id" });
    userMock.update.mockResolvedValue({ id: "test-user-id" });
    refreshTokenMock.updateMany.mockResolvedValue({ count: 1 });

    const response = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "some-token", password: "NewPassword123" });

    expect(response.status).toBe(200);
    expect(refreshTokenMock.updateMany).toHaveBeenCalledWith({
      where: { userId: "test-user-id" },
      data: { revoked: true },
    });
  });

  it("POST /change-password should revoke refresh tokens", async () => {
    userMock.findUnique.mockResolvedValue({
      id: "test-user-id",
      password: "old-hashed-password",
    });
    userMock.update.mockResolvedValue({
      id: "test-user-id",
      tokenVersion: 2,
    });
    refreshTokenMock.updateMany.mockResolvedValue({ count: 1 });

    const response = await request(app)
      .post("/api/auth/change-password")
      .send({ currentPassword: "OldPassword123", newPassword: "NewPassword123" });

    expect(response.status).toBe(200);
    expect(refreshTokenMock.updateMany).toHaveBeenCalledWith({
      where: { userId: "test-user-id" },
      data: { revoked: true },
    });
  });
});
