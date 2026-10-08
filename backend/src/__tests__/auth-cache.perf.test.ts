import { authenticate, checkSuspension } from "../middleware/auth";
import { getCachedUserAuthData } from "../lib/user-cache";
import jwt from "jsonwebtoken";
import { config } from "../config";
import { Request, Response, NextFunction } from "express";

jest.mock("../lib/user-cache", () => ({
  getCachedUserAuthData: jest.fn(),
}));

jest.mock("../lib/token-version", () => ({
  getCurrentTokenVersion: jest.fn().mockResolvedValue(1),
}));

type RequestWithCachedUser = Request & { _cachedUser?: unknown };

describe("Auth Middleware Caching", () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;

  beforeEach(() => {
    jest.clearAllMocks();
    
    const token = jwt.sign({ userId: "user123", tokenVersion: 1 }, config.jwtSecret || "secret");
    req = {
      headers: {
        authorization: `Bearer ${token}`,
      },
      path: "/some-route",
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    next = jest.fn();
  });

  it("should memoize user lookup when chaining authenticate and checkSuspension", async () => {
    const mockUser = {
      id: "user123",
      role: "USER",
      emailVerified: true,
      deletedAt: null,
      isSuspended: false,
      suspendReason: null,
    };
    (getCachedUserAuthData as jest.Mock).mockResolvedValue(mockUser);

    // Call authenticate
    await authenticate(req as Request, res as Response, next);
    
    expect(next).toHaveBeenCalledTimes(1);
    expect(getCachedUserAuthData).toHaveBeenCalledTimes(1);
    expect((req as RequestWithCachedUser)._cachedUser).toEqual(mockUser);

    // Call checkSuspension in the same request chain
    await checkSuspension(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledTimes(2);
    // getCachedUserAuthData should NOT be called again
    expect(getCachedUserAuthData).toHaveBeenCalledTimes(1);
  });
});
