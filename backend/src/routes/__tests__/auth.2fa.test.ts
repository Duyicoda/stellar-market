import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { config } from "../../config";

// ─── otplib mock ─────────────────────────────────────────────────────────────
const MOCK_SECRET = "JBSWY3DPEHPK3PXP";
const mockTotpCode = "123456";
jest.mock("otplib", () => ({
  generateSecret: jest.fn(() => MOCK_SECRET),
  generateSync: jest.fn(() => mockTotpCode),
  verifySync: jest.fn(({ token, secret: _secret }: { token: string; secret: string }) => ({
    valid: token === mockTotpCode,
    delta: 0,
  })),
  generateURI: jest.fn(() => "otpauth://totp/StellarMarket:test@example.com?secret=MOCK"),
}));

// ─── Prisma mock ─────────────────────────────────────────────────────────────
jest.mock("@prisma/client", () => {
  const mockPrisma = {
    user: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

// ─── Encryption mock ─────────────────────────────────────────────────────────
jest.mock("../../utils/encryption", () => ({
  encrypt: jest.fn((text: string) => `encrypted:${text}`),
  decrypt: jest.fn((text: string) => text.replace("encrypted:", "")),
}));

// ─── QRCode mock ─────────────────────────────────────────────────────────────
jest.mock("qrcode", () => ({
  toDataURL: jest.fn().mockResolvedValue("data:image/png;base64,mockqr"),
}));

import { PrismaClient } from "@prisma/client";
import authRouter from "../auth.routes";

const prismaMock = new PrismaClient() as jest.Mocked<PrismaClient>;
const userMock = prismaMock.user as unknown as {
  findFirst: jest.Mock;
  findUnique: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
};

// ─── App setup ────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use("/api/auth", authRouter);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function authHeader(userId = "user-test") {
  const token = jwt.sign({ userId }, config.jwtSecret, { expiresIn: "1h" });
  return { Authorization: `Bearer ${token}` };
}

function pendingToken(userId = "user-test") {
  return jwt.sign({ userId, purpose: "2fa_pending" }, config.jwtSecret, { expiresIn: "5m" });
}

const baseUser = {
  id: "user-test",
  walletAddress: "GABCDEF",
  username: "testuser",
  email: "test@example.com",
  password: bcrypt.hashSync("Password1", 10),
  role: "FREELANCER",
  bio: null,
  avatarUrl: null,
  twoFactorSecret: null,
  twoFactorEnabled: false,
  backupCodes: [] as string[],
  emailVerified: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

afterEach(() => jest.clearAllMocks());

// ─── POST /api/auth/2fa/setup ────────────────────────────────────────────────
describe.skip("POST /api/auth/2fa/setup", () => {
  it("returns QR code and secret (recovery codes are issued only after TOTP verify)", async () => {
    userMock.findUnique.mockResolvedValue({ ...baseUser });
    userMock.update.mockResolvedValueOnce({ ...baseUser });

    const res = await request(app)
      .post("/api/auth/2fa/setup")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.qrCode).toContain("data:image/png");
    expect(res.body.secret).toBeDefined();
    expect(res.body.backupCodes).toBeUndefined();
    expect(res.body.recoveryCodes).toBeUndefined();
    expect(userMock.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ backupCodes: [] }),
      }),
    );
  });

  it("returns 400 if 2FA is already enabled", async () => {
    userMock.findUnique.mockResolvedValue({
      ...baseUser,
      twoFactorEnabled: true,
    });

    const res = await request(app)
      .post("/api/auth/2fa/setup")
      .set(authHeader());

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("2FA is already enabled.");
  });

  it("returns 401 without auth token", async () => {
    const res = await request(app).post("/api/auth/2fa/setup");
    expect(res.status).toBe(401);
  });
});

// ─── POST /api/auth/2fa/verify ───────────────────────────────────────────────
describe.skip("POST /api/auth/2fa/verify", () => {
  it("enables 2FA with valid TOTP code", async () => {
    userMock.findUnique.mockResolvedValue({
      ...baseUser,
      twoFactorSecret: `encrypted:${MOCK_SECRET}`,
    });
    userMock.update.mockResolvedValueOnce({ ...baseUser, twoFactorEnabled: true });

    const res = await request(app)
      .post("/api/auth/2fa/verify")
      .set(authHeader())
      .send({ code: mockTotpCode });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("2FA has been enabled successfully.");
    expect(res.body.recoveryCodes).toHaveLength(10);
    expect(res.body.recoveryCodes.every((c: string) => /^[a-f0-9]{8}$/.test(c))).toBe(true);
    const updateArg = userMock.update.mock.calls[0][0];
    expect(updateArg.data.twoFactorEnabled).toBe(true);
    expect(updateArg.data.backupCodes).toHaveLength(10);
  });

  it("returns 400 with invalid code", async () => {
    userMock.findUnique.mockResolvedValue({
      ...baseUser,
      twoFactorSecret: `encrypted:${MOCK_SECRET}`,
    });

    const res = await request(app)
      .post("/api/auth/2fa/verify")
      .set(authHeader())
      .send({ code: "000000" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid verification code.");
  });

  it("returns 400 if setup not initiated", async () => {
    userMock.findUnique.mockResolvedValue({ ...baseUser });

    const res = await request(app)
      .post("/api/auth/2fa/verify")
      .set(authHeader())
      .send({ code: mockTotpCode });

    expect(res.status).toBe(400);
  });
});

// ─── POST /api/auth/2fa/enable (alias of verify) ─────────────────────────────
describe.skip("POST /api/auth/2fa/enable", () => {
  it("enables 2FA and returns recovery codes like verify", async () => {
    userMock.findUnique.mockResolvedValue({
      ...baseUser,
      twoFactorSecret: `encrypted:${MOCK_SECRET}`,
    });
    userMock.update.mockResolvedValueOnce({ ...baseUser, twoFactorEnabled: true });

    const res = await request(app)
      .post("/api/auth/2fa/enable")
      .set(authHeader())
      .send({ code: mockTotpCode });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("2FA has been enabled successfully.");
    expect(res.body.recoveryCodes).toHaveLength(10);
  });
});

// ─── POST /api/auth/2fa/regenerate ───────────────────────────────────────────
describe.skip("POST /api/auth/2fa/regenerate", () => {
  it("returns new recovery codes when TOTP is valid", async () => {
    userMock.findUnique.mockResolvedValue({
      ...baseUser,
      twoFactorEnabled: true,
      twoFactorSecret: `encrypted:${MOCK_SECRET}`,
      backupCodes: ["oldhash"],
    });
    userMock.update.mockResolvedValueOnce({ ...baseUser, twoFactorEnabled: true });

    const res = await request(app)
      .post("/api/auth/2fa/regenerate")
      .set(authHeader())
      .send({ code: mockTotpCode });

    expect(res.status).toBe(200);
    expect(res.body.recoveryCodes).toHaveLength(10);
    expect(res.body.message).toContain("regenerated");
    const updateArg = userMock.update.mock.calls[0][0];
    expect(updateArg.data.backupCodes).toHaveLength(10);
  });

  it("returns 400 with invalid TOTP", async () => {
    userMock.findUnique.mockResolvedValue({
      ...baseUser,
      twoFactorEnabled: true,
      twoFactorSecret: `encrypted:${MOCK_SECRET}`,
    });

    const res = await request(app)
      .post("/api/auth/2fa/regenerate")
      .set(authHeader())
      .send({ code: "000000" });

    expect(res.status).toBe(400);
    expect(userMock.update).not.toHaveBeenCalled();
  });

  it("returns 400 if 2FA is not enabled", async () => {
    userMock.findUnique.mockResolvedValue({ ...baseUser });

    const res = await request(app)
      .post("/api/auth/2fa/regenerate")
      .set(authHeader())
      .send({ code: mockTotpCode });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("2FA is not enabled.");
  });
});

// ─── POST /api/auth/login with 2FA ──────────────────────────────────────────
describe.skip("POST /api/auth/login (2FA enabled)", () => {
  it("returns tempToken when 2FA is enabled", async () => {
    userMock.findUnique.mockResolvedValue({
      ...baseUser,
      twoFactorEnabled: true,
    });

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "test@example.com", password: "Password1" });

    expect(res.status).toBe(200);
    expect(res.body.requiresTwoFactor).toBe(true);
    expect(res.body.tempToken).toBeDefined();
    expect(res.body.user).toBeUndefined();

    // Verify the temp token has 2fa_pending purpose
    const decoded = jwt.verify(res.body.tempToken, config.jwtSecret) as { purpose: string };
    expect(decoded.purpose).toBe("2fa_pending");
  });

  it("returns full token when 2FA is not enabled", async () => {
    userMock.findUnique.mockResolvedValue({ ...baseUser });

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "test@example.com", password: "Password1" });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user).toBeDefined();
    expect(res.body.requiresTwoFactor).toBeUndefined();
  });
});

// ─── POST /api/auth/2fa/validate ─────────────────────────────────────────────
describe.skip("POST /api/auth/2fa/validate", () => {
  it("issues full JWT with valid TOTP code", async () => {
    userMock.findUnique.mockResolvedValue({
      ...baseUser,
      twoFactorEnabled: true,
      twoFactorSecret: `encrypted:${MOCK_SECRET}`,
    });

    const res = await request(app)
      .post("/api/auth/2fa/validate")
      .send({ code: mockTotpCode, tempToken: pendingToken() });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user).toBeDefined();
    expect(res.body.user.id).toBe("user-test");
  });

  it("issues full JWT with valid backup code", async () => {
    const backupCode = "abcd1234";
    const hashedBackup = bcrypt.hashSync(backupCode, 10);

    userMock.findUnique.mockResolvedValue({
      ...baseUser,
      twoFactorEnabled: true,
      twoFactorSecret: "encrypted:somesecret",
      backupCodes: [hashedBackup],
    });
    userMock.update.mockResolvedValueOnce({ ...baseUser, backupCodes: [] });

    const res = await request(app)
      .post("/api/auth/2fa/validate")
      .send({ code: backupCode, tempToken: pendingToken() });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    // Verify backup code was consumed
    expect(userMock.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { backupCodes: [] } }),
    );
  });

  it("returns 401 with invalid code", async () => {
    userMock.findUnique.mockResolvedValue({
      ...baseUser,
      twoFactorEnabled: true,
      twoFactorSecret: `encrypted:${MOCK_SECRET}`,
      backupCodes: [],
    });

    const res = await request(app)
      .post("/api/auth/2fa/validate")
      .send({ code: "000000", tempToken: pendingToken() });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid verification code.");
  });

  it("returns 401 with expired temp token", async () => {
    const expiredToken = jwt.sign(
      { userId: "user-test", purpose: "2fa_pending" },
      config.jwtSecret,
      { expiresIn: "0s" },
    );

    const res = await request(app)
      .post("/api/auth/2fa/validate")
      .send({ code: "123456", tempToken: expiredToken });

    expect(res.status).toBe(401);
  });

  it("returns 401 with non-2fa token", async () => {
    const normalToken = jwt.sign({ userId: "user-test" }, config.jwtSecret, { expiresIn: "1h" });

    const res = await request(app)
      .post("/api/auth/2fa/validate")
      .send({ code: "123456", tempToken: normalToken });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid token type.");
  });
});

// ─── POST /api/auth/2fa/disable ──────────────────────────────────────────────
describe.skip("POST /api/auth/2fa/disable", () => {
  it("disables 2FA with correct password", async () => {
    userMock.findUnique.mockResolvedValueOnce({
      ...baseUser,
      twoFactorEnabled: true,
      twoFactorSecret: "encrypted:secret",
    });
    userMock.update.mockResolvedValueOnce({ ...baseUser });

    const res = await request(app)
      .post("/api/auth/2fa/disable")
      .set(authHeader())
      .send({ password: "Password1" });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("2FA has been disabled.");
    expect(userMock.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { twoFactorSecret: null, twoFactorEnabled: false, backupCodes: [] },
      }),
    );
  });

  it("returns 401 with wrong password", async () => {
    userMock.findUnique.mockResolvedValueOnce({
      ...baseUser,
      twoFactorEnabled: true,
    });

    const res = await request(app)
      .post("/api/auth/2fa/disable")
      .set(authHeader())
      .send({ password: "WrongPass1" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid password.");
  });

  it("returns 400 if 2FA not enabled", async () => {
    userMock.findUnique.mockResolvedValue({ ...baseUser });

    const res = await request(app)
      .post("/api/auth/2fa/disable")
      .set(authHeader())
      .send({ password: "Password1" });

    expect(res.status).toBe(400);
  });
});

// ─── Middleware rejects 2fa_pending tokens ────────────────────────────────────
describe.skip("Auth middleware rejects 2fa_pending tokens", () => {
  it("returns 401 when using 2fa_pending token on protected route", async () => {
    const token = pendingToken();

    const res = await request(app)
      .post("/api/auth/2fa/setup")
      .set({ Authorization: `Bearer ${token}` });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("2FA verification required.");
  });
});
