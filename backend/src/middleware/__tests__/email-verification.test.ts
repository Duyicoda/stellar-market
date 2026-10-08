import { Response, NextFunction } from "express";
import { authenticate, AuthRequest } from "../auth";
import jwt from "jsonwebtoken";
import { config } from "../../config";

// Mock PrismaClient
jest.mock("@prisma/client", () => {
  const mockPrisma = {
    user: {
      findUnique: jest.fn(),
    },
  };
  return {
    PrismaClient: jest.fn(() => mockPrisma),
  };
});

// Import after mocking
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

describe("Email Verification Enforcement", () => {
  let req: Partial<AuthRequest>;
  let res: Partial<Response>;
  let next: NextFunction;

  beforeEach(() => {
    req = {
      headers: {},
      // Express strips the router's mount prefix from req.path, leaving it in
      // req.baseUrl instead — e.g. a request to /api/v1/users/me arrives at
      // this middleware (mounted under /api/v1) with baseUrl "/api/v1" and
      // path "/users/me". These mocks mirror that split rather than putting
      // the full absolute path in req.path alone.
      baseUrl: "/api/v1",
    } as Partial<AuthRequest>;
    Object.defineProperty(req, "path", {
      writable: true,
      configurable: true,
      value: "/users/me",
    });
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    next = jest.fn();
    jest.clearAllMocks();
  });

  it("should block unverified users from protected routes", async () => {
    const token = jwt.sign({ userId: "user123" }, config.jwtSecret);
    req.headers = { authorization: `Bearer ${token}` };

    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      role: "FREELANCER",
      emailVerified: false,
    });

    await authenticate(req as AuthRequest, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Email not verified.",
      message:
        "Please check your inbox and click the verification link before continuing.",
      code: "EMAIL_NOT_VERIFIED",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("should allow verified users to access protected routes", async () => {
    const token = jwt.sign({ userId: "user123" }, config.jwtSecret);
    req.headers = { authorization: `Bearer ${token}` };

    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      role: "FREELANCER",
      emailVerified: true,
    });

    await authenticate(req as AuthRequest, res as Response, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("should allow unverified users to access exempt routes", async () => {
    const token = jwt.sign({ userId: "user123" }, config.jwtSecret);
    req.headers = { authorization: `Bearer ${token}` };
    req.baseUrl = "/api/v1/auth";
    Object.defineProperty(req, "path", {
      writable: true,
      configurable: true,
      value: "/send-verification",
    });

    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      role: "FREELANCER",
      emailVerified: false,
    });

    await authenticate(req as AuthRequest, res as Response, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("should allow unverified users to verify their email", async () => {
    const token = jwt.sign({ userId: "user123" }, config.jwtSecret);
    req.headers = { authorization: `Bearer ${token}` };
    req.baseUrl = "/api/v1/auth";
    Object.defineProperty(req, "path", {
      writable: true,
      configurable: true,
      value: "/verify-email/sometoken",
    });

    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      role: "FREELANCER",
      emailVerified: false,
    });

    await authenticate(req as AuthRequest, res as Response, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("should allow unverified users to login", async () => {
    const token = jwt.sign({ userId: "user123" }, config.jwtSecret);
    req.headers = { authorization: `Bearer ${token}` };
    req.baseUrl = "/api/v1/auth";
    Object.defineProperty(req, "path", {
      writable: true,
      configurable: true,
      value: "/login",
    });

    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      role: "FREELANCER",
      emailVerified: false,
    });

    await authenticate(req as AuthRequest, res as Response, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("should not exempt a route that merely contains an exempt path as a substring", async () => {
    const token = jwt.sign({ userId: "user123" }, config.jwtSecret);
    req.headers = { authorization: `Bearer ${token}` };
    req.baseUrl = "/api/v1/auth";
    Object.defineProperty(req, "path", {
      writable: true,
      configurable: true,
      // Not a real route — its path merely contains "/login" as a substring.
      value: "/send-verification-then-login",
    });

    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      role: "FREELANCER",
      emailVerified: false,
    });

    await authenticate(req as AuthRequest, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});

