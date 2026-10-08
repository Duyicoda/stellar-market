import request from "supertest";
import express from "express";

// Mock otplib (ESM module, must be mocked before import)
jest.mock("otplib", () => ({
  generateSecret: jest.fn(() => "MOCKSECRET"),
  generateSync: jest.fn(() => "123456"),
  verifySync: jest.fn(),
  generateURI: jest.fn(),
}));

// Mock qrcode
jest.mock("qrcode", () => ({
  toDataURL: jest.fn().mockResolvedValue("data:image/png;base64,mockqr"),
}));

// Mock bcryptjs
jest.mock("bcryptjs", () => ({
  hash: jest.fn().mockResolvedValue("hashed_password"),
  compare: jest.fn(),
}));

// Mock jsonwebtoken
jest.mock("jsonwebtoken", () => ({
  sign: jest.fn().mockReturnValue("mock_token"),
  verify: jest.fn(),
}));

// Mock Prisma
type MockPrismaClient = {
  user: {
    findFirst: jest.Mock;
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
};

jest.mock("@prisma/client", () => {
  const mockPrisma: MockPrismaClient = {
    user: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  };

  return {
    PrismaClient: jest.fn().mockImplementation(() => mockPrisma),
    __mockPrisma: mockPrisma,
    UserRole: {
      ADMIN: "ADMIN",
      CLIENT: "CLIENT",
      FREELANCER: "FREELANCER",
    },
  };
});

// Mock config
jest.mock("../../config", () => ({
  config: {
    jwtSecret: "test_secret",
  },
}));

// Mock email utils
jest.mock("../../utils/email", () => ({
  sendPasswordResetEmail: jest.fn(),
  sendVerificationEmail: jest.fn(),
}));

// Mock encryption utils
jest.mock("../../utils/encryption", () => ({
  encrypt: jest.fn((text: string) => `encrypted:${text}`),
  decrypt: jest.fn((text: string) => text.replace("encrypted:", "")),
}));

// Mock token utils
jest.mock("../../utils/token", () => ({
  generateToken: jest.fn(),
  hashToken: jest.fn(),
}));

import authRoutes from "../auth.routes";

const { __mockPrisma: mockPrisma } = jest.requireMock("@prisma/client") as {
  __mockPrisma: MockPrismaClient;
};

const app = express();
app.use(express.json());
app.use("/auth", authRoutes);

describe.skip("POST /auth/register - Role Selection", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const basePayload = {
    email: "test@example.com",
    password: "StrongPass1",
    stellarAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    name: "TestUser",
  };

  it("should create a user with role FREELANCER when role is FREELANCER", async () => {
    mockPrisma.user.findFirst.mockResolvedValue(null);
    mockPrisma.user.create.mockResolvedValue({
      id: "user1",
      walletAddress: basePayload.stellarAddress,
      username: basePayload.name,
      email: basePayload.email,
      role: "FREELANCER",
    });

    const res = await request(app)
      .post("/auth/register")
      .send({ ...basePayload, role: "FREELANCER" });

    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe("FREELANCER");
    expect(mockPrisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          role: "FREELANCER",
        }),
      }),
    );
  });

  it("should create a user with role CLIENT when role is CLIENT", async () => {
    mockPrisma.user.findFirst.mockResolvedValue(null);
    mockPrisma.user.create.mockResolvedValue({
      id: "user2",
      walletAddress: basePayload.stellarAddress,
      username: basePayload.name,
      email: basePayload.email,
      role: "CLIENT",
    });

    const res = await request(app)
      .post("/auth/register")
      .send({ ...basePayload, role: "CLIENT" });

    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe("CLIENT");
    expect(mockPrisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          role: "CLIENT",
        }),
      }),
    );
  });

  it("should default to FREELANCER when role is not provided", async () => {
    mockPrisma.user.findFirst.mockResolvedValue(null);
    mockPrisma.user.create.mockResolvedValue({
      id: "user3",
      walletAddress: basePayload.stellarAddress,
      username: basePayload.name,
      email: basePayload.email,
      role: "FREELANCER",
    });

    const res = await request(app)
      .post("/auth/register")
      .send(basePayload); // no role field

    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe("FREELANCER");
    expect(mockPrisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          role: "FREELANCER",
        }),
      }),
    );
  });

  it("should reject invalid role values", async () => {
    const res = await request(app)
      .post("/auth/register")
      .send({ ...basePayload, role: "ADMIN" });

    expect(res.status).toBe(400);
  });

  it("should return the role in the API response", async () => {
    mockPrisma.user.findFirst.mockResolvedValue(null);
    mockPrisma.user.create.mockResolvedValue({
      id: "user4",
      walletAddress: basePayload.stellarAddress,
      username: basePayload.name,
      email: basePayload.email,
      role: "CLIENT",
    });

    const res = await request(app)
      .post("/auth/register")
      .send({ ...basePayload, role: "CLIENT" });

    expect(res.status).toBe(201);
    expect(res.body.user).toHaveProperty("role", "CLIENT");
    expect(res.body).toHaveProperty("token");
  });
});
