import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config";
import { UserRole } from "@prisma/client";
import { logger } from "../lib/logger";
import { getCurrentTokenVersion } from "../lib/token-version";
import { getCachedUserAuthData, CachedUserData } from "../lib/user-cache";

export interface AuthRequest extends Request {
  userId?: string;
  userRole?: UserRole;
  /** walletAddress claim from the JWT, present only when the token was issued
   *  after a successful POST /auth/wallet/verify challenge-response round-trip. */
  userWalletAddress?: string;
  /** Per-request cache of the authenticated user's auth data, populated by
   *  authenticate()/optionalAuthenticate() so downstream middleware/handlers
   *  don't need to re-fetch it. */
  _cachedUser?: CachedUserData | null;
}

export const authenticate = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Access denied. No token provided." });
    return;
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, config.jwtSecret) as {
      userId: string;
      walletAddress?: string;
      purpose?: string;
      tokenVersion?: number;
    };

    if (decoded.purpose === "2fa_pending") {
      res.status(401).json({ error: "2FA verification required." });
      return;
    }

    // Reject tokens issued before the user's most recent password change (#787).
    // Tokens minted prior to this feature carry no tokenVersion claim; treat
    // them as version 0 so they stay valid until the next password change.
    const currentTokenVersion = await getCurrentTokenVersion(decoded.userId);
    if (
      currentTokenVersion !== null &&
      (decoded.tokenVersion ?? 0) !== currentTokenVersion
    ) {
      res.status(401).json({
        error: "Token has been invalidated. Please log in again.",
        code: "TokenInvalidated",
      });
      return;
    }

    req.userId = decoded.userId;
    if (decoded.walletAddress) {
      req.userWalletAddress = decoded.walletAddress;
    }

    const user = await getCachedUserAuthData(decoded.userId);
    req._cachedUser = user;

    if (!user) {
      res.status(401).json({ error: "User not found." });
      return;
    }

    if (user.deletedAt) {
      res.status(401).json({ error: "Account deleted.", code: "ACCOUNT_DELETED" });
      return;
    }

    // Check if email verification is required for this route.
    // req.path is relative to this router's mount point (Express strips the
    // "/auth" prefix by the time this middleware runs), so req.baseUrl must be
    // prepended to recover the full request path for matching.
    const exemptRoutes = [
      "/auth/send-verification",
      "/auth/verify-email",
      "/auth/login",
      "/auth/2fa/validate",
      "/auth/forgot-password",
      "/auth/reset-password",
      "/auth/refresh",
      "/auth/logout",
    ];

    const currentPath = `${req.baseUrl}${req.path}` || "";
    // A route is exempt only on an exact match or a "/"-bounded prefix match
    // (for sub-paths like verify-email/:token) — a plain startsWith would also
    // match an unrelated route that merely begins with the same characters,
    // e.g. "/auth/send-verification-evil".
    const matchesRoute = (candidate: string, route: string) =>
      candidate === route || candidate.startsWith(`${route}/`);
    const isExempt = exemptRoutes.some(
      (route) =>
        matchesRoute(currentPath, route) ||
        matchesRoute(currentPath, `/api${route}`) ||
        matchesRoute(currentPath, `/api/v1${route}`),
    );

    if (!isExempt && !user.emailVerified) {
      res.status(403).json({
        error: "Email not verified.",
        message:
          "Please check your inbox and click the verification link before continuing.",
        code: "EMAIL_NOT_VERIFIED",
      });
      return;
    }

    req.userRole = user.role;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token." });
  }
};

export const requireAdmin = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  // First authenticate the user
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Access denied. No token provided." });
    return;
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, config.jwtSecret) as {
      userId: string;
      purpose?: string;
      tokenVersion?: number;
    };

    if (decoded.purpose === "2fa_pending") {
      res.status(401).json({ error: "2FA verification required." });
      return;
    }

    req.userId = decoded.userId;

    // Reject tokens invalidated by a password change (#787).
    const currentTokenVersion = await getCurrentTokenVersion(decoded.userId);
    if (
      currentTokenVersion !== null &&
      (decoded.tokenVersion ?? 0) !== currentTokenVersion
    ) {
      res.status(401).json({
        error: "Token has been invalidated. Please log in again.",
        code: "TokenInvalidated",
      });
      return;
    }

    // Query database for user role
    const user = await getCachedUserAuthData(decoded.userId);
    req._cachedUser = user;

    if (!user) {
      res.status(401).json({ error: "User not found." });
      return;
    }

    if (user.deletedAt) {
      res.status(401).json({ error: "Account deleted.", code: "ACCOUNT_DELETED" });
      return;
    }

    if (user.role !== UserRole.ADMIN) {
      res
        .status(403)
        .json({ error: "Access denied. Admin privileges required." });
      return;
    }

    req.userRole = user.role;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token." });
  }
};

/**
 * Optional authentication middleware.
 *
 * Identical to `authenticate` except it does NOT reject the request when no
 * token is supplied.  Routes that are publicly accessible but need to behave
 * differently for signed-in users (e.g. field-level projections) should use
 * this middleware instead of `authenticate`.
 *
 * When a valid token is present, `req.userId` and `req.userRole` are populated
 * exactly as they would be by `authenticate`.  When no token is present (or the
 * token is invalid) the request continues with `req.userId === undefined`.
 */
export const optionalAuthenticate = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const authHeader = req.headers.authorization;

  // No token supplied — continue as anonymous
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return next();
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, config.jwtSecret) as {
      userId: string;
      walletAddress?: string;
      purpose?: string;
      tokenVersion?: number;
    };

    // A 2FA-pending token is not a full session; treat as anonymous
    if (decoded.purpose === "2fa_pending") {
      return next();
    }

    // A token invalidated by a password change is treated as anonymous (#787).
    const currentTokenVersion = await getCurrentTokenVersion(decoded.userId);
    if (
      currentTokenVersion !== null &&
      (decoded.tokenVersion ?? 0) !== currentTokenVersion
    ) {
      return next();
    }

    const user = await getCachedUserAuthData(decoded.userId);
    req._cachedUser = user;

    if (!user || user.deletedAt) {
      return next();
    }

    req.userId = decoded.userId;
    req.userRole = user.role;
    if (decoded.walletAddress) {
      req.userWalletAddress = decoded.walletAddress;
    }
  } catch {
    // Invalid / expired token — continue as anonymous
  }

  return next();
};

export const checkSuspension = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  if (!req.userId) {
    next();
    return;
  }

  try {
    let user = req._cachedUser;
    if (!user) {
      user = await getCachedUserAuthData(req.userId);
      req._cachedUser = user;
    }

    if (user && user.isSuspended) {
      res.status(403).json({
        error: "Account suspended.",
        reason: user.suspendReason || "Your account has been suspended.",
      });
      return;
    }

    next();
  } catch (error) {
    logger.error({ err: error }, "Error checking suspension status");
    next();
  }
};
