import { Router, Response, Request } from "express";
import { PrismaClient, Prisma, TransactionType } from "@prisma/client";
import { z } from "zod";
import { authenticate, AuthRequest } from "../middleware/auth";
import { asyncHandler } from "../middleware/error";
import { validate } from "../middleware/validation";
import { freelancerSearchQuerySchema, getUserByIdParamSchema } from "../schemas";
import { searchFreelancers } from "../services/freelancer-search.service";
import { ReputationCacheService } from "../services/reputation-cache.service";
import {
  fetchOnChainPayments,
  loadDbEarnings,
  reconcileAndRemediate,
} from "../services/earnings-reconciliation.service";
import { logger } from "../lib/logger";
import { MAX_PAGE_SIZE } from "../config";

const router = Router();
const prisma = new PrismaClient();

/**
 * Default reconciliation/export window: last 90 days.
 * Used when the caller omits `from`/`to`.
 */
function defaultRange(): { from: Date; to: Date } {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 90);
  return { from, to };
}

const dateRangeQuerySchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .refine((q) => !(q.from && q.to) || q.from <= q.to, {
    message: "`from` must be on or before `to`",
    path: ["from"],
  });

function escapeCsv(value: string | number | null | undefined): string {
  const str = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * GET /api/freelancers/me/stats
 * Get quick dashboard statistics for the authenticated freelancer.
 */
router.get(
  "/me/stats",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user || user.role !== "FREELANCER") {
      return res.status(403).json({ error: "Only freelancers can access stats" });
    }

    const wallet = user.walletAddress;

    let totalEarnedXlm = 0;
    if (wallet) {
      const earnedAgg = await prisma.transaction.aggregate({
        where: {
          toAddress: wallet,
          type: { in: ["RELEASE", "DISPUTE_PAYOUT"] },
        },
        _sum: { amount: true },
      });
      totalEarnedXlm = earnedAgg._sum?.amount ?? 0;
    }

    const completedJobs = await prisma.job.count({
      where: {
        freelancerId: user.id,
        status: "COMPLETED",
      },
    });

    const activeJobs = await prisma.job.count({
      where: {
        freelancerId: user.id,
        status: "IN_PROGRESS",
      },
    });

    res.json({
      totalEarnedXlm,
      completedJobs,
      activeJobs,
      averageRating: user.averageRating ?? 0,
      reviewCount: user.reviewCount ?? 0,
    });
  }),
);

/**
 * GET /api/freelancers/me/saved-jobs
 * List saved jobs with pagination
 */
router.get(
  "/me/saved-jobs",
  authenticate,
  validate({
    query: z.object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(10),
    }),
  }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user || user.role !== "FREELANCER") {
      return res.status(403).json({ error: "Only freelancers can access saved jobs" });
    }

    const { page, limit } = req.query as unknown as { page: number; limit: number };
    const skip = (page - 1) * limit;

    const [savedJobs, total] = await Promise.all([
      prisma.savedJob.findMany({
        where: { freelancerId: req.userId },
        include: {
          job: {
            include: {
              client: { select: { username: true, avatarUrl: true, averageRating: true } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.savedJob.count({ where: { freelancerId: req.userId } }),
    ]);

    res.json({
      savedJobs,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  }),
);

/**
 * GET /api/freelancers/earnings/summary?freelancerId=<id>
 * Public total-earnings figure for a freelancer's public profile page. No auth
 * required since this is displayed to any visitor viewing the profile.
 */
router.get(
  "/earnings/summary",
  validate({
    query: z.object({
      freelancerId: z.string().min(1),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { freelancerId } = req.query as unknown as { freelancerId: string };

    const freelancer = await prisma.user.findUnique({ where: { id: freelancerId } });
    if (!freelancer || !freelancer.walletAddress) {
      return res.json({ total: 0 });
    }

    const totalEarnedAgg = await prisma.transaction.aggregate({
      where: {
        toAddress: freelancer.walletAddress,
        type: { in: ["RELEASE", "DISPUTE_PAYOUT"] },
      },
      _sum: { amount: true },
    });

    res.json({ total: totalEarnedAgg._sum.amount ?? 0 });
  }),
);

/**
 * Resolve the authenticated user, asserting they are a freelancer with a wallet.
 * Returns the wallet on success, or writes an error response and returns null.
 */
async function requireFreelancerWallet(
  req: AuthRequest,
  res: Response,
): Promise<{ userId: string; wallet: string } | null> {
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return null;
  }
  if (user.role !== "FREELANCER") {
    res.status(403).json({ error: "Only freelancers can access earnings" });
    return null;
  }
  if (!user.walletAddress) {
    res.status(400).json({ error: "Freelancer has no wallet address." });
    return null;
  }
  return { userId: user.id, wallet: user.walletAddress };
}

/**
 * GET /api/freelancers/earnings
 * Get earnings summary, monthly + weekly chart data, category breakdown, and
 * paginated transaction history for the authenticated freelancer.
 *
 * Optional `from`/`to` (ISO dates) scope the weekly chart and category breakdown
 * so the dashboard chart, category panel, and reconciliation panel share one range.
 */
router.get(
  "/earnings",
  authenticate,
  validate({
    query: z.object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(10),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
    }),
  }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const auth = await requireFreelancerWallet(req, res);
    if (!auth) return;

    const query = req.query as unknown as {
      page: number;
      limit: number;
      from?: Date;
      to?: Date;
    };
    const { page = 1, limit = 10 } = query;
    const skip = (Number(page) - 1) * Number(limit);
    const { userId, wallet } = auth;

    const fallback = defaultRange();
    const rangeFrom = query.from ?? fallback.from;
    const rangeTo = query.to ?? fallback.to;

    // ── Summary stats ──
    const [totalEarnedAgg, earnedThisMonthAgg, pendingJobs, escrowJobs] = await Promise.all([
      // Total earned: all RELEASE + DISPUTE_PAYOUT to freelancer wallet
      prisma.transaction.aggregate({
        where: {
          toAddress: wallet,
          type: { in: ["RELEASE", "DISPUTE_PAYOUT"] },
        },
        _sum: { amount: true },
      }),
      // Earned this month
      prisma.transaction.aggregate({
        where: {
          toAddress: wallet,
          type: { in: ["RELEASE", "DISPUTE_PAYOUT"] },
          createdAt: {
            gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
          },
        },
        _sum: { amount: true },
      }),
      // Pending release: IN_PROGRESS jobs assigned to freelancer
      prisma.job.aggregate({
        where: {
          freelancerId: userId,
          status: "IN_PROGRESS",
        },
        _sum: { budget: true },
      }),
      // Active escrow: FUNDED escrow jobs assigned to freelancer
      prisma.job.aggregate({
        where: {
          freelancerId: userId,
          escrowStatus: "FUNDED",
        },
        _sum: { budget: true },
      }),
    ]);

    // ── Monthly earnings for last 12 months ──
    const monthlyRaw = await prisma.$queryRaw<Array<{ month: string; earnings: number }>>`
      SELECT
        TO_CHAR(DATE_TRUNC('month', "createdAt"), 'YYYY-MM') as month,
        COALESCE(SUM(amount), 0)::float as earnings
      FROM "Transaction"
      WHERE "toAddress" = ${wallet}
        AND "type" IN ('RELEASE', 'DISPUTE_PAYOUT')
        AND "createdAt" >= NOW() - INTERVAL '12 months'
      GROUP BY DATE_TRUNC('month', "createdAt")
      ORDER BY month ASC
    `;

    // ── Weekly earnings within the selected range (for the time-series chart) ──
    // Returned sparse (only weeks with earnings); the frontend fills zero-value gaps.
    const weeklyRaw = await prisma.$queryRaw<Array<{ week: string; earnings: number }>>`
      SELECT
        TO_CHAR(DATE_TRUNC('week', "createdAt"), 'YYYY-MM-DD') as week,
        COALESCE(SUM(amount), 0)::float as earnings
      FROM "Transaction"
      WHERE "toAddress" = ${wallet}
        AND "type" IN ('RELEASE', 'DISPUTE_PAYOUT')
        AND "createdAt" >= ${rangeFrom}
        AND "createdAt" <= ${rangeTo}
      GROUP BY DATE_TRUNC('week', "createdAt")
      ORDER BY week ASC
    `;

    // ── Category breakdown within the selected range ──
    // Derived from each job's category tag (not hardcoded).
    const categoryRaw = await prisma.$queryRaw<Array<{ category: string; earnings: number }>>`
      SELECT
        COALESCE(j."category", 'Uncategorized') as category,
        COALESCE(SUM(t.amount), 0)::float as earnings
      FROM "Transaction" t
      LEFT JOIN "Job" j ON j."id" = t."jobId"
      WHERE t."toAddress" = ${wallet}
        AND t."type" IN ('RELEASE', 'DISPUTE_PAYOUT')
        AND t."createdAt" >= ${rangeFrom}
        AND t."createdAt" <= ${rangeTo}
      GROUP BY COALESCE(j."category", 'Uncategorized')
      ORDER BY earnings DESC
    `;

    const categoryTotal = categoryRaw.reduce((sum, c) => sum + c.earnings, 0);
    const categoryBreakdown = categoryRaw.map((c) => ({
      category: c.category,
      earnings: c.earnings,
      percentage: categoryTotal > 0 ? (c.earnings / categoryTotal) * 100 : 0,
    }));

    // ── Transaction history (paginated) ──
    const whereTx: Prisma.TransactionWhereInput = {
      toAddress: wallet,
      type: { in: [TransactionType.RELEASE, TransactionType.DISPUTE_PAYOUT] },
    };

    const [transactions, totalTx] = await Promise.all([
      prisma.transaction.findMany({
        where: whereTx,
        skip,
        take: Number(limit),
        orderBy: { createdAt: "desc" },
        include: {
          job: {
            select: {
              id: true,
              title: true,
              clientId: true,
              client: {
                select: {
                  id: true,
                  username: true,
                  avatarUrl: true,
                },
              },
            },
          },
          milestone: {
            select: {
              id: true,
              title: true,
              status: true,
            },
          },
        },
      }),
      prisma.transaction.count({ where: whereTx }),
    ]);

    res.json({
      summary: {
        totalEarned: totalEarnedAgg._sum?.amount ?? 0,
        earnedThisMonth: earnedThisMonthAgg._sum?.amount ?? 0,
        pendingRelease: pendingJobs._sum?.budget ?? 0,
        activeEscrow: escrowJobs._sum?.budget ?? 0,
      },
      monthlyEarnings: monthlyRaw,
      weeklyEarnings: weeklyRaw,
      categoryBreakdown,
      range: { from: rangeFrom.toISOString(), to: rangeTo.toISOString() },
      transactions,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total: totalTx,
        totalPages: Math.ceil(totalTx / Number(limit)),
      },
    });
  }),
);

/**
 * GET /api/freelancers/earnings/reconcile?from=<ISO>&to=<ISO>
 * Cross-check DB earnings records against on-chain escrow releases from Horizon.
 *
 * Returns three buckets:
 *  - matched: present in both Horizon and the DB (joined by jobId memo / txHash)
 *  - onChainOnly: settled on-chain but missing from the DB (indicates a sync failure)
 *  - dbOnly: recorded in the DB but not found on-chain in the window
 *
 * Unlike before #874, this is no longer read-only: `onChainOnly` discrepancies
 * are automatically backfilled (idempotently) and `dbOnly` discrepancies are
 * flagged in the audit trail for manual review, via the same
 * `reconcileAndRemediate` the proactive background job uses — so loading this
 * page fixes discrepancies immediately rather than only reporting them, and a
 * freelancer who never loads it still gets fixed by the scheduled sweep.
 */
router.get(
  "/earnings/reconcile",
  authenticate,
  validate({ query: dateRangeQuerySchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const auth = await requireFreelancerWallet(req, res);
    if (!auth) return;

    const q = req.query as unknown as { from?: Date; to?: Date };
    const fallback = defaultRange();
    const from = q.from ?? fallback.from;
    const to = q.to ?? fallback.to;

    let result: Awaited<ReturnType<typeof reconcileAndRemediate>>;
    try {
      result = await reconcileAndRemediate(auth.wallet, from, to);
    } catch (err) {
      logger.error({ err, wallet: auth.wallet }, "[Reconciliation] Horizon fetch failed");
      return res.status(502).json({ error: "Unable to reach the Stellar network for reconciliation." });
    }

    res.json(result);
  }),
);

/**
 * GET /api/freelancers/earnings/export?from=<ISO>&to=<ISO>&format=csv
 * Download earnings for a tax period as CSV. Reconciliation status is computed
 * against Horizon when reachable; otherwise rows fall back to "unverified".
 */
router.get(
  "/earnings/export",
  authenticate,
  validate({
    query: dateRangeQuerySchema.and(
      z.object({ format: z.enum(["csv"]).default("csv") }),
    ),
  }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const auth = await requireFreelancerWallet(req, res);
    if (!auth) return;

    const q = req.query as unknown as { from?: Date; to?: Date };
    const fallback = defaultRange();
    const from = q.from ?? fallback.from;
    const to = q.to ?? fallback.to;

    const dbRecords = await loadDbEarnings(auth.wallet, from, to);

    // Best-effort reconciliation so each row carries a status; export still
    // succeeds (rows marked "unverified") if Horizon is unreachable.
    const onChainTxHashes = new Set<string>();
    const onChainJobIds = new Set<string>();
    try {
      const payments = await fetchOnChainPayments(auth.wallet, from, to);
      for (const p of payments) {
        onChainTxHashes.add(p.txHash);
        if (p.memoJobId) onChainJobIds.add(p.memoJobId);
      }
    } catch (err) {
      logger.warn({ err, wallet: auth.wallet }, "[Export] Horizon unreachable — exporting without on-chain status");
    }

    const xlmUsdRate = Number(process.env.XLM_USD_RATE ?? "0");

    const header = [
      "date",
      "job_title",
      "client_name",
      "amount_xlm",
      "amount_usd",
      "tx_hash",
      "reconciliation_status",
    ];

    const lines = [header.join(",")];
    for (const r of dbRecords) {
      const reconciled =
        onChainTxHashes.has(r.txHash) || (r.jobId ? onChainJobIds.has(r.jobId) : false);
      const status = onChainTxHashes.size === 0 ? "unverified" : reconciled ? "matched" : "db_only";
      const usd = xlmUsdRate > 0 ? (r.amount * xlmUsdRate).toFixed(2) : "";
      lines.push(
        [
          escapeCsv(r.createdAt.toISOString().slice(0, 10)),
          escapeCsv(r.jobTitle ?? "N/A"),
          escapeCsv(r.clientName ?? "N/A"),
          escapeCsv(r.amount),
          escapeCsv(usd),
          escapeCsv(r.txHash),
          escapeCsv(status),
        ].join(","),
      );
    }

    const csv = lines.join("\n");
    const fromStr = from.toISOString().slice(0, 10);
    const toStr = to.toISOString().slice(0, 10);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="earnings-${fromStr}-to-${toStr}.csv"`,
    );
    res.send(csv);
  }),
);

/**
 * GET /api/freelancers/top
 * Get top freelancers leaderboard sorted by rating and review count.
 * Returns the highest-rated and most-reviewed freelancers.
 */
router.get(
  "/top",
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 100);
    const offset = parseInt(req.query.offset as string) || 0;
    const category = req.query.category as string | undefined;

    const where: Prisma.UserWhereInput = {
      role: "FREELANCER",
      averageRating: { gte: 4.0 },
      reviewCount: { gt: 0 },
    };

    if (category) {
      where.skills = { has: category };
    }

    const topFreelancers = await prisma.user.findMany({
      where,
      select: {
        id: true,
        username: true,
        avatarUrl: true,
        bio: true,
        skills: true,
        availability: true,
        averageRating: true,
        reviewCount: true,
        walletAddress: true,
        createdAt: true,
      },
      orderBy: [
        { averageRating: "desc" },
        { reviewCount: "desc" },
        { createdAt: "asc" },
      ],
      take: limit,
      skip: offset,
    });

    // Fetch on-chain reputation for each freelancer
    const freelancersWithReputation = await Promise.all(
      topFreelancers.map(async (freelancer) => {
        const reputation = await ReputationCacheService.getCachedReputation(
          freelancer.walletAddress ?? ""
        );
        return {
          ...freelancer,
          reputation: reputation
            ? {
                totalScore: reputation.score.toString(),
                totalWeight: reputation.endorsementWeight.toString(),
                reviewCount: 0,
              }
            : null,
        };
      })
    );

    const total = await prisma.user.count({ where });

    res.setHeader("X-Max-Page-Size", String(MAX_PAGE_SIZE));
    res.json({
      data: freelancersWithReputation,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      },
    });
  })
);

/**
 * GET /api/freelancers/search
 * Public freelancer discovery with optional filters (skills, rating, availability, text).
 */
router.get(
  "/search",
  validate({ query: freelancerSearchQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as {
      page: number;
      limit: number;
      minRating?: number;
      available?: boolean;
      q?: string;
      skills?: string[];
    };

    const result = await searchFreelancers(prisma, {
      page: q.page,
      limit: q.limit,
      minRating: q.minRating,
      available: q.available,
      q: q.q,
      skills: q.skills,
    });

    res.setHeader("X-Max-Page-Size", String(MAX_PAGE_SIZE));
    res.json(result);
  })
);

router.get(
  "/:id",
  validate({ params: getUserByIdParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;

    const freelancer = await prisma.user.findFirst({
      where: { id, role: "FREELANCER" },
      select: {
        id: true,
        username: true,
        avatarUrl: true,
        bio: true,
        role: true,
        skills: true,
        availability: true,
        averageRating: true,
        reviewCount: true,
        walletAddress: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!freelancer) {
      return res.status(404).json({ error: "Freelancer not found." });
    }

    const lastModified = freelancer.updatedAt ?? freelancer.createdAt;
    const etag = `W/"freelancer:${id}:${lastModified.toISOString()}"`;
    res.setHeader("ETag", etag);
    res.setHeader("Last-Modified", lastModified.toUTCString());
    if (req.headers["if-none-match"] === etag) {
      return res.status(304).end();
    }

    const reputation = await ReputationCacheService.getCachedReputation(freelancer.walletAddress ?? "");

    res.json({
      ...freelancer,
      reputation: reputation ? {
totalScore: reputation.score.toString(),
totalWeight: reputation.endorsementWeight.toString(),
reviewCount: 0,
tier: reputation.tier,
      } : null
    });
  }),
);

export default router;
