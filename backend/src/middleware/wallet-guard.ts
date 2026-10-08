import { Response, NextFunction } from "express";
import { PrismaClient } from "@prisma/client";
import { AuthRequest } from "./auth";

const prisma = new PrismaClient();

/**
 * walletSourceGuard — defense-in-depth middleware for escrow and reputation
 * routes that build Stellar transactions.
 *
 * When the caller's JWT carries a walletAddress claim (present after a
 * successful POST /auth/wallet/verify), this middleware verifies that the
 * claim still matches the address stored in the database.  A mismatch means
 * the JWT is stale or the wallet was bound without going through the
 * challenge-response flow (which is now the only permitted binding path).
 *
 * Routes protected by this middleware will reject the request with 403 before
 * any transaction XDR is constructed, satisfying the acceptance criterion:
 * "Escrow and reputation routes reject transactions whose source account does
 * not match the JWT wallet."
 */
export const walletSourceGuard = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  if (!req.userWalletAddress) {
    // JWT was issued before the wallet-binding flow existed, or the user has
    // no wallet yet.  Pass through — individual route handlers already check
    // whether a wallet address is present before building XDRs.
    next();
    return;
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { walletAddress: true },
    });

    if (user?.walletAddress !== req.userWalletAddress) {
      res.status(403).json({
        error: "Transaction source does not match verified wallet",
      });
      return;
    }

    next();
  } catch {
    res.status(500).json({ error: "Internal server error." });
  }
};
