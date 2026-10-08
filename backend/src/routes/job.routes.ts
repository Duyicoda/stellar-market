import { Router, Response } from "express";
import { PrismaClient, Prisma, JobStatus } from "@prisma/client";
import { z } from "zod";
import { authenticate, optionalAuthenticate, AuthRequest } from "../middleware/auth";
import { validate } from "../middleware/validation";
import { asyncHandler } from "../middleware/error";
import { AppError } from "../errors/AppError";
import { ErrorCodes } from "../errors/codes";
import { logger } from "../lib/logger";
import { RecommendationQueueService } from "../services/recommendation-queue.service";
import { FraudDetectionService } from "../services/fraud-detection.service";
import {
  createJobSchema,
  createJobWithMilestonesSchema,
  updateJobSchema,
  getJobsQuerySchema,
  getJobByIdParamSchema,
  updateJobStatusSchema,
  getSavedJobsQuerySchema,
  publicJobListResponseSchema,
  authenticatedJobListResponseSchema,
  publicSingleJobResponseSchema,
  authenticatedSingleJobResponseSchema,
  ownerSingleJobResponseSchema,
} from "../schemas";
import { paginationSchema } from "../schemas/common";
import {
  cache,
  invalidateCache,
  invalidateCacheKey,
  generateJobsCacheKey,
  generateJobCacheKey,
  generateJobOnChainStatusCacheKey,
} from "../lib/cache";
import {
  ContractService,
  RevisionProposalView,
} from "../services/contract.service";
import { MAX_PAGE_SIZE, config } from "../config";
import { JOB_CATEGORIES } from "../constants/categories";

const router = Router();

const VALID_CATEGORIES = JOB_CATEGORIES;

function isValidCategory(value: string): boolean {
  return VALID_CATEGORIES.some(
    (c) => c.toLowerCase() === value.trim().toLowerCase(),
  );
}

const JOB_LIST_SELECT = {
  id: true, title: true, description: true, budget: true, status: true,
  category: true, createdAt: true, skills: true, deadline: true,
  escrowStatus: true, clientId: true, freelancerId: true, updatedAt: true,
  client: { select: { id: true, username: true, avatarUrl: true, walletAddress: true } },
  freelancer: { select: { id: true, username: true, avatarUrl: true } },
  _count: { select: { applications: true } },
} satisfies Prisma.JobSelect;

type JobListItem = Prisma.JobGetPayload<{ select: typeof JOB_LIST_SELECT }>;

interface JobListPagination {
  total: number;
  page: number | null;
  limit: number;
  totalPages?: number;
  hasNext: boolean;
  nextCursor?: string | null;
}

// ─── Field projection helpers ─────────────────────────────────────────────────

/** Strip private client fields for unauthenticated callers. */
function toPublicJob(job: JobListItem) {
  const { client, ...rest } = job;
  return {
    id: rest.id,
    title: rest.title,
    description: rest.description,
    budget: rest.budget,
    category: rest.category,
    createdAt: rest.createdAt,
    client: {
      id: client.id,
      username: client.username,
      avatarUrl: client.avatarUrl ?? null,
    },
  };
}

/** Strip client.email (never sent); keep walletAddress for authenticated users. */
function toAuthenticatedJob(job: JobListItem) {
  // JOB_LIST_SELECT never selects `client.email`, so there is nothing to
  // strip here — `client` is already safe to return as-is.
  return job;
}

/**
 * Apply the correct field projection before sending a job list response.
 * Validates the final shape with the matching Zod schema and throws if
 * validation fails (this catches accidental future field additions).
 */
function projectAndValidateList(
  jobs: JobListItem[],
  pagination: JobListPagination,
  isAuthenticated: boolean,
  res: Response,
) {
  if (!isAuthenticated) {
    const payload = { data: jobs.map(toPublicJob), pagination };
    const parsed = publicJobListResponseSchema.parse(payload);
    return res.json(parsed);
  }
  const payload = { data: jobs.map(toAuthenticatedJob), pagination };
  const parsed = authenticatedJobListResponseSchema.parse(payload);
  return res.json(parsed);
}

const JOB_DETAIL_INCLUDE = {
  client: {
    select: { id: true, username: true, avatarUrl: true, bio: true, walletAddress: true },
  },
  freelancer: {
    select: { id: true, username: true, avatarUrl: true, bio: true },
  },
  milestones: { orderBy: { order: "asc" as const } },
  applications: {
    include: {
      freelancer: {
        select: { id: true, username: true, avatarUrl: true },
      },
    },
  },
} satisfies Prisma.JobInclude;

type JobDetail = Prisma.JobGetPayload<{ include: typeof JOB_DETAIL_INCLUDE }>;

/**
 * Extra fields merged onto a JobDetail before sending a single-job response
 * (on-chain escrow status/revision data resolved outside the DB query, plus
 * whether the requesting freelancer has saved this job).
 */
interface JobDetailExtra {
  escrow_status: string;
  escrowStatus: string;
  revisionProposal: RevisionProposalView | null;
  isSaved: boolean;
}

/**
 * Apply the correct field projection before sending a single-job response.
 * Three tiers: public / authenticated-non-owner / owner.
 */
function projectAndValidateSingle(
  job: JobDetail,
  extra: JobDetailExtra,
  requestUserId: string | undefined,
  res: Response,
) {
  const merged = { ...job, ...extra };

  // Unauthenticated
  if (!requestUserId) {
    const { client, ...rest } = merged;
    const publicPayload = {
      id: rest.id,
      title: rest.title,
      description: rest.description,
      budget: rest.budget,
      category: rest.category,
      createdAt: rest.createdAt,
      client: { id: client.id, username: client.username, avatarUrl: client.avatarUrl ?? null },
      milestones: rest.milestones,
      isSaved: rest.isSaved,
      escrow_status: rest.escrow_status,
      escrowStatus: rest.escrowStatus,
      revisionProposal: rest.revisionProposal,
    };
    const parsed = publicSingleJobResponseSchema.parse(publicPayload);
    return res.json(parsed);
  }

  // Authenticated — client select never includes `email`, so there is
  // nothing to strip here (kept structurally identical to the public branch).
  const { client, ...rest } = merged;
  const authPayload = { ...rest, client };

  // Owner gets the full authenticated record (no extra gating needed beyond
  // email removal, which is already applied above)
  if (rest.clientId === requestUserId) {
    const parsed = ownerSingleJobResponseSchema.parse(authPayload);
    return res.json(parsed);
  }

  const parsed = authenticatedSingleJobResponseSchema.parse(authPayload);
  return res.json(parsed);
}

/**
 * @swagger
 * tags:
 *   name: Jobs
 *   description: Job management endpoints
 */
const prisma = new PrismaClient();

// Get all jobs with optional filters and pagination
router.get(
  "/",
  /**
   * @swagger
   * /jobs:
   *   get:
   *     summary: Get all jobs with search and filters
   *     tags: [Jobs]
   *     parameters:
   *       - in: query
   *         name: page
   *         schema:
   *           type: integer
   *         description: Page number
   *       - in: query
   *         name: limit
   *         schema:
   *           type: integer
   *         description: Items per page (max 100)
   *       - in: query
   *         name: search
   *         schema:
   *           type: string
   *         description: Full-text search on title and description (uses PostgreSQL tsvector)
   *       - in: query
   *         name: token
   *         schema:
   *           type: string
   *           example: XLM
   *         description: Filter by payment token (e.g. XLM, USDC)
   *       - in: query
   *         name: minBudget
   *         schema:
   *           type: number
   *         description: Minimum budget filter
   *       - in: query
   *         name: maxBudget
   *         schema:
   *           type: number
   *         description: Maximum budget filter
   *       - in: query
   *         name: status
   *         schema:
   *           type: string
   *         description: Filter by job status (comma-separated for multiple)
   *       - in: query
   *         name: sort
   *         schema:
   *           type: string
   *           enum: [newest, oldest, budget_desc, budget_asc, budget_high, budget_low]
   *         description: Sort order
   *       - in: query
   *         name: cursor
   *         schema:
   *           type: string
   *         description: Cursor for cursor-based pagination
   *     responses:
   *       200:
   *         description: List of jobs
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/JobsResponse'
   */
  /**
   * @swagger
   * /jobs/{id}:
   *   get:
   *     summary: Get job by ID
   *     tags: [Jobs]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *         description: Job ID
   *     responses:
   *       200:
   *         description: Job details
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/JobResponse'
   *       404:
   *         description: Job not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  validate({ query: getJobsQuerySchema }),
  optionalAuthenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const {
      page = 1,
      limit = 20,
      search,
      category,
      skill,
      skills,
      status,
      minBudget,
      maxBudget,
      clientId,
      token,
      sort,
      postedAfter,
      cursor,
    } = req.query as unknown as z.infer<typeof getJobsQuerySchema>;
    // Ensure limit is within bounds
    const safeLimit = Math.min(Math.max(1, Number(limit)), 100);
    const safePage = Math.max(1, Number(page));

    const cacheKey = generateJobsCacheKey({
      page: safePage,
      limit: safeLimit,
      search,
      skill,
      skills,
      category,
      status,
      minBudget,
      maxBudget,
      clientId,
      token,
      sort,
      postedAfter,
      cursor,
    });

    const { data, hit } = await cache(cacheKey, 30, async () => {
      const where: Prisma.JobWhereInput = { deletedAt: null };

      // Full-text search using PostgreSQL tsvector/tsquery with relevance ranking.
      // Falls back to Prisma contains (LIKE) if raw query fails.
      if (search) {
        try {
          const ftsResults = await prisma.$queryRaw<
            { id: string; rank: number }[]
          >`
            SELECT id, ts_rank(
              to_tsvector('english', title || ' ' || description || ' ' || array_to_string(skills, ' ')),
              plainto_tsquery('english', ${search})
            ) AS rank
            FROM "Job"
            WHERE to_tsvector('english', title || ' ' || description || ' ' || array_to_string(skills, ' '))
              @@ plainto_tsquery('english', ${search})
            ORDER BY rank DESC
          `;
          const matchedIds = ftsResults.map((r) => r.id);
          where.id = matchedIds.length > 0 ? { in: matchedIds } : { in: [] };
        } catch {
          // Fallback to plain case-insensitive LIKE search
          const searchTerms = (search as string)
            .split(/\s+/)
            .map((term) => term.trim())
            .filter(Boolean);

          where.OR = [
            { title: { contains: search, mode: "insensitive" } },
            { description: { contains: search, mode: "insensitive" } },
            ...(searchTerms.length > 0 ? [{ skills: { hasSome: searchTerms } }] : []),
          ];
        }
      }

      if (skills) {
        const skillList = (skills as string)
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean);
        if (skillList.length === 1) {
          where.skills = { has: skillList[0] };
        } else if (skillList.length > 1) {
          where.skills = { hasSome: skillList };
        }
      } else if (skill) {
        where.skills = { has: skill };
      }

      if (category) {
        // Accept slug form (e.g. "smart-contract") or canonical form ("Smart Contract").
        const normalised = (category as string).replace(/-/g, " ");
        where.category = { equals: normalised, mode: "insensitive" };
      }

      if (status) {
        const statusList = (status as string)
          .split(",")
          .map((s: string) => s.trim());
        if (statusList.length === 1) {
          // Query-param values are expected to match JobStatus but aren't
          // validated ahead of time — Prisma enforces the enum at query time.
          where.status = statusList[0] as JobStatus;
        } else {
          where.status = { in: statusList as JobStatus[] };
        }
      }

      if (minBudget || maxBudget) {
        where.budget = {};
        if (minBudget) where.budget.gte = Number(minBudget);
        if (maxBudget) where.budget.lte = Number(maxBudget);
      }

      if (clientId) {
        where.clientId = clientId;
      }

      // Filter by payment token (e.g. ?token=XLM).
      if (token) {
        where.paymentToken = {
          equals: token,
          mode: "insensitive",
        };
      }

      if (postedAfter) {
        where.createdAt = { gte: new Date(postedAfter) };
      }

      // Resolve sort — supports legacy names and new aliases
      const resolveOrderBy = (
        sortParam: string | undefined,
      ): Prisma.JobOrderByWithRelationInput => {
        switch (sortParam) {
          case "oldest":
            return { createdAt: "asc" };
          case "budget_high":
          case "budget_desc":
            return { budget: "desc" };
          case "budget_low":
          case "budget_asc":
            return { budget: "asc" };
          case "created_at":
          case "newest":
          default:
            return { createdAt: "desc" };
        }
      };

      // Cursor-based pagination — preferred when `cursor` is supplied.
      if (cursor) {
        const sortDirection: "asc" | "desc" = sort === "oldest" ? "asc" : "desc";

        let cursorId: string | undefined;
        let cursorCreatedAt: Date | undefined;
        try {
          const decoded = JSON.parse(
            Buffer.from(cursor, "base64").toString("utf8"),
          ) as { id?: string; createdAt?: string };
          cursorId = decoded.id;
          cursorCreatedAt = decoded.createdAt ? new Date(decoded.createdAt) : undefined;
        } catch {
          cursorId = cursor as string;
        }

        if (!cursorId || !cursorCreatedAt || Number.isNaN(cursorCreatedAt.getTime())) {
          const anchor = cursorId
            ? await prisma.job.findUnique({
                where: { id: cursorId },
                select: { id: true, createdAt: true },
              })
            : null;
          if (!anchor) {
            return { data: [], pagination: { total: 0, page: null, limit: safeLimit, hasNext: false, nextCursor: null } };
          }
          cursorId = anchor.id;
          cursorCreatedAt = anchor.createdAt;
        }

        const cursorClause =
          sortDirection === "desc"
            ? {
                OR: [
                  { createdAt: { lt: cursorCreatedAt } },
                  {
                    AND: [
                      { createdAt: cursorCreatedAt },
                      { id: { lt: cursorId } },
                    ],
                  },
                ],
              }
            : {
                OR: [
                  { createdAt: { gt: cursorCreatedAt } },
                  {
                    AND: [
                      { createdAt: cursorCreatedAt },
                      { id: { gt: cursorId } },
                    ],
                  },
                ],
              };

        const paginatedWhere: Prisma.JobWhereInput = { ...where };
        paginatedWhere.AND = Array.isArray(where.AND)
          ? [...where.AND, cursorClause]
          : [cursorClause];

        const orderBy: Prisma.JobOrderByWithRelationInput[] = [
          { createdAt: sortDirection },
          { id: sortDirection },
        ];

        const jobs = await prisma.job.findMany({
          where: paginatedWhere,
          select: JOB_LIST_SELECT,
          orderBy,
          take: safeLimit + 1,
        });

        const hasMore = jobs.length > safeLimit;
        const pageData = hasMore ? jobs.slice(0, safeLimit) : jobs;
        const lastJob = pageData[pageData.length - 1];
        const nextCursor =
          hasMore && lastJob
            ? Buffer.from(
                JSON.stringify({
                  id: lastJob.id,
                  createdAt: lastJob.createdAt,
                }),
              ).toString("base64")
            : null;

        const total = await prisma.job.count({ where });

        return {
          data: pageData,
          pagination: {
            total,
            page: null,
            limit: safeLimit,
            hasNext: hasMore,
            nextCursor,
          },
        };
      }

      // Offset-based pagination
      const skip = (safePage - 1) * safeLimit;
      const orderBy = resolveOrderBy(sort);

      const [jobs, total] = await Promise.all([
        prisma.job.findMany({
          where,
          select: JOB_LIST_SELECT,
          orderBy,
          skip,
          take: safeLimit,
        }),
        prisma.job.count({ where }),
      ]);

      const totalPages = Math.ceil(total / safeLimit);
      const hasNext = safePage < totalPages;
      const lastJob = jobs[jobs.length - 1];
      const nextCursor = lastJob
        ? Buffer.from(
            JSON.stringify({ id: lastJob.id, createdAt: lastJob.createdAt }),
          ).toString("base64")
        : null;

      return {
        data: jobs,
        pagination: {
          total,
          page: safePage,
          limit: safeLimit,
          totalPages,
          hasNext,
          nextCursor,
        },
      };
    });

    res.set("X-Cache-Hit", hit.toString());
    res.setHeader("X-Max-Page-Size", String(MAX_PAGE_SIZE));
    return projectAndValidateList(data.data, data.pagination, !!req.userId, res);
  }),
);

// Get jobs for the authenticated user (client or freelancer)
router.get(
  "/mine",
  authenticate,
  validate({ query: paginationSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { page = 1, limit = 20, status } = req.query as unknown as z.infer<
      typeof paginationSchema
    > & { status?: string };

    // Ensure limit is within bounds
    const safeLimit = Math.min(Math.max(1, Number(limit)), 100);
    const safePage = Math.max(1, Number(page));
    const skip = (safePage - 1) * safeLimit;

    const where: Prisma.JobWhereInput = {
      OR: [{ clientId: req.userId }, { freelancerId: req.userId }],
      deletedAt: null,
    };
    if (status) where.status = status as JobStatus;

    const [jobs, total] = await Promise.all([
      prisma.job.findMany({
        where,
        select: JOB_LIST_SELECT,
        skip,
        take: safeLimit,
        orderBy: { createdAt: "desc" },
      }),
      prisma.job.count({ where }),
    ]);

    const totalPages = Math.ceil(total / safeLimit);
    const hasNext = safePage < totalPages;

    res.setHeader("X-Max-Page-Size", String(MAX_PAGE_SIZE));
    res.json({
      data: jobs,
      pagination: {
        total,
        page: safePage,
        limit: safeLimit,
        totalPages,
        hasNext,
      },
    });
  }),
);

// Get saved jobs for authenticated freelancer
router.get(
  "/saved",
  authenticate,
  validate({ query: getSavedJobsQuerySchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { role: true },
    });

    if (!user || user.role !== "FREELANCER") {
      throw new AppError(ErrorCodes.FORBIDDEN, "Only freelancers can view saved jobs.", 403);
    }

    const {
      page = 1,
      limit = 20,
      search,
      category,
      skill,
      minBudget,
      maxBudget,
    } = req.query as unknown as z.infer<typeof getSavedJobsQuerySchema>;

    // Ensure limit is within bounds
    const safeLimit = Math.min(Math.max(1, Number(limit)), 100);
    const safePage = Math.max(1, Number(page));
    const skip = (safePage - 1) * safeLimit;

    const jobWhere: Prisma.JobWhereInput = {
      status: "OPEN",
      deletedAt: null,
    };

    if (search) {
      jobWhere.OR = [
        { title: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
      ];
    }

    if (skill) {
      jobWhere.skills = { has: skill };
    }

    if (category) {
      jobWhere.category = { equals: category, mode: "insensitive" };
    }

    if (minBudget || maxBudget) {
      jobWhere.budget = {};
      if (minBudget) jobWhere.budget.gte = Number(minBudget);
      if (maxBudget) jobWhere.budget.lte = Number(maxBudget);
    }

    const savedJobWhere: Prisma.SavedJobWhereInput = {
      freelancerId: req.userId,
      job: jobWhere,
    };

    const [savedJobs, total] = await Promise.all([
      prisma.savedJob.findMany({
        where: savedJobWhere,
        select: {
          jobId: true,
          createdAt: true,
          job: { select: JOB_LIST_SELECT },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: safeLimit,
      }),
      prisma.savedJob.count({
        where: savedJobWhere,
      }),
    ]);

    const jobs = savedJobs.map((savedJob) => ({
      ...savedJob.job,
      savedAt: savedJob.createdAt,
      isSaved: true,
    }));

    const totalPages = Math.ceil(total / safeLimit);
    const hasNext = safePage < totalPages;

    res.json({
      data: jobs,
      pagination: {
        total,
        page: safePage,
        limit: safeLimit,
        totalPages,
        hasNext,
      },
    });
  }),
);

// Get a single job by ID
router.get(
  "/:id",
  validate({ params: getJobByIdParamSchema }),
  optionalAuthenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = req.params.id as string;
    const job = await prisma.job.findFirst({
      where: {
        id,
        deletedAt: null,
      },
      include: JOB_DETAIL_INCLUDE,
    });

    if (!job) {
      throw new AppError(ErrorCodes.NOT_FOUND, "Job not found.", 404);
    }

    const lastModified = job.updatedAt ?? job.createdAt;
    const etag = `W/"job:${id}:${new Date(lastModified).toISOString()}"`;
    res.setHeader("ETag", etag);
    res.setHeader("Last-Modified", new Date(lastModified).toUTCString());
    if (!req.userId && req.headers["if-none-match"] === etag) {
      return res.status(304).end();
    }

    let isSaved = false;
    if (req.userId) {
      const user = await prisma.user.findUnique({
        where: { id: req.userId },
        select: { role: true },
      });

      if (user && user.role === "FREELANCER") {
        const savedJob = await prisma.savedJob.findUnique({
          where: {
            freelancerId_jobId: {
              freelancerId: req.userId,
              jobId: id,
            },
          },
        });
        isSaved = !!savedJob;
      }
    }

    let escrowStatus = job.escrowStatus as string;
    let revisionProposal: RevisionProposalView | null = null;

    if (job.contractJobId) {
      try {
        const cacheKey = generateJobOnChainStatusCacheKey(id);
        const { data: onChainStatus } = await cache(cacheKey, 30, async () => {
          return await ContractService.getOnChainJobStatus(job.contractJobId!);
        });
        escrowStatus = onChainStatus;
      } catch (error) {
        logger.warn(
          { err: error, jobId: id },
          `Could not fetch on-chain status for job ${id}, falling back to DB:`,
        );
      }

      try {
        const p = await ContractService.getRevisionProposal(job.contractJobId);
        revisionProposal = p && p.status === "PENDING" ? p : null;
      } catch (error) {
        logger.warn({ err: error, jobId: id }, `Could not fetch revision proposal for job ${id}:`);
      }
    }

    return projectAndValidateSingle(
      job,
      {
        escrow_status: escrowStatus,
        escrowStatus: escrowStatus,
        revisionProposal,
        isSaved,
      },
      req.userId,
      res,
    );
  }),
);

// Create a new job
router.post(
  "/",
  /**
   * @swagger
   * /jobs:
   *   post:
   *     summary: Create a new job
   *     tags: [Jobs]
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/CreateJobRequest'
   *           examples:
   *             example:
   *               value:
   *                 title: Sample Job
   *                 description: Job description...
   *                 budget: 1000
   *                 skills: ["React", "Node.js"]
   *                 deadline: "2026-03-01T00:00:00Z"
   *                 category: Development
   *     responses:
   *       201:
   *         description: Job created
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/JobResponse'
   *       400:
   *         description: Invalid input
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  authenticate,
  validate({ body: createJobSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { role: true },
    });

    if (!user || user.role !== "CLIENT") {
      throw new AppError(ErrorCodes.FORBIDDEN, "Only clients can post jobs.", 403);
    }

    const { title, description, budget, skills, deadline } = req.body;
    const category = req.body.category as string | undefined;

    if (category && !isValidCategory(category)) {
      return res.status(422).json({
        code: "InvalidCategory",
        message: `"${category}" is not a recognised category. Valid categories: ${VALID_CATEGORIES.join(", ")}.`,
      });
    }

    const job = await prisma.job.create({
      data: {
        title,
        description,
        budget,
        category: category || "General",
        skills,
        deadline: new Date(deadline),
        clientId: req.userId!,
      },
      include: {
        milestones: true,
        client: { select: { id: true, username: true, avatarUrl: true } },
        _count: { select: { applications: true } },
      },
    });

    await invalidateCache("jobs:list:*");
    void RecommendationQueueService.enqueueRebuild(job.id);

    // Near-real-time fraud/anomaly scoring (issue #900). Fire-and-forget: this
    // never blocks or fails job creation.
    FraudDetectionService.onJobCreated(job.id, req.userId!);

    try {
      const { getIo } = await import("../socket");
      const io = getIo();
      io.emit("job:created", job);
    } catch {
      // Socket not initialized (e.g., in tests)
    }

    res.status(201).json(job);
  }),
);

// Atomically create a job together with all of its milestones (issue #1125).
//
// This replaces the frontend's old "POST /jobs then N× POST /milestones" loop,
// which could leave a job persisted with a partial milestone set if a milestone
// call failed midway, and could create a duplicate job if the user retried.
//
// Guarantees:
//  - Atomic: the job and every milestone are written in a single transaction —
//    either all succeed or nothing is persisted.
//  - Idempotent: an optional client-supplied `idempotencyKey` is stored uniquely
//    on the job. A retry with the same key returns the original job instead of
//    creating a second one, even across concurrent requests (unique-constraint
//    race is caught and resolved to the existing job).
//  - Consistent budget: the job budget is derived from the sum of milestone
//    amounts, so the persisted total can never diverge from the milestones.
router.post(
  "/with-milestones",
  authenticate,
  validate({ body: createJobWithMilestonesSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { role: true },
    });

    if (!user || user.role !== "CLIENT") {
      throw new AppError(ErrorCodes.FORBIDDEN, "Only clients can post jobs.", 403);
    }

    const {
      title,
      description,
      skills,
      deadline,
      milestones,
    } = req.body as {
      title: string;
      description: string;
      skills: string[];
      deadline: string;
      milestones: Array<{
        title: string;
        description: string;
        amount: number;
        dueDate: string;
      }>;
    };
    const category = req.body.category as string | undefined;
    const paymentToken = req.body.paymentToken as string | undefined;
    const idempotencyKey = req.body.idempotencyKey as string | undefined;

    if (category && !isValidCategory(category)) {
      return res.status(422).json({
        code: "InvalidCategory",
        message: `"${category}" is not a recognised category. Valid categories: ${VALID_CATEGORIES.join(", ")}.`,
      });
    }

    // Budget is the sum of milestone amounts (7-dp rounded to match XLM scale),
    // never taken from the client — this is what keeps the persisted total in
    // lockstep with the milestone set.
    const budget = Number(
      milestones.reduce((sum, m) => sum + m.amount, 0).toFixed(7),
    );
    const platformMinimum = Number.isFinite(config.platformMinBudgetXlm)
      ? config.platformMinBudgetXlm
      : 1;
    if (budget < platformMinimum) {
      return res.status(422).json({
        code: "BudgetBelowMinimum",
        message: `Budget must be at least ${platformMinimum} XLM`,
      });
    }

    // Idempotency fast-path: if we've already recorded this key, return the
    // original job rather than creating another. A retry after a partial failure
    // lands here and gets the completed job back.
    if (idempotencyKey) {
      const existing = await prisma.job.findUnique({
        where: { idempotencyKey },
        include: JOB_DETAIL_INCLUDE,
      });
      if (existing) {
        if (existing.clientId !== req.userId) {
          throw new AppError(
            ErrorCodes.CONFLICT,
            "This idempotency key belongs to another user's request.",
            409,
          );
        }
        return res.status(200).json(existing);
      }
    }

    let job;
    try {
      // Nested writes in a single create are executed in one transaction by
      // Prisma, so the job and all milestones commit together or not at all.
      job = await prisma.$transaction((tx) =>
        tx.job.create({
          data: {
            title,
            description,
            budget,
            category: category || "General",
            skills,
            deadline: new Date(deadline),
            clientId: req.userId!,
            ...(paymentToken ? { paymentToken } : {}),
            ...(idempotencyKey ? { idempotencyKey } : {}),
            milestones: {
              create: milestones.map((m, index) => ({
                title: m.title,
                description: m.description,
                amount: m.amount,
                dueDate: new Date(m.dueDate),
                order: index + 1,
              })),
            },
          },
          include: JOB_DETAIL_INCLUDE,
        }),
      );
    } catch (err) {
      // Concurrent retry raced us to the same idempotency key: the unique
      // constraint fired. Resolve to the job the other request created rather
      // than surfacing an error or duplicating.
      if (
        idempotencyKey &&
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        const existing = await prisma.job.findUnique({
          where: { idempotencyKey },
          include: JOB_DETAIL_INCLUDE,
        });
        if (existing) {
          return res.status(200).json(existing);
        }
      }
      throw err;
    }

    await invalidateCache("jobs:list:*");
    void RecommendationQueueService.enqueueRebuild(job.id);

    // Near-real-time fraud/anomaly scoring (issue #900). Fire-and-forget.
    FraudDetectionService.onJobCreated(job.id, req.userId!);

    try {
      const { getIo } = await import("../socket");
      const io = getIo();
      io.emit("job:created", job);
    } catch {
      // Socket not initialized (e.g., in tests)
    }

    res.status(201).json(job);
  }),
);

// Update a job
router.put(
  "/:id",
  authenticate,
  validate({
    params: getJobByIdParamSchema,
    body: updateJobSchema,
  }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = req.params.id as string;
    const job = await prisma.job.findFirst({
      where: {
        id,
        deletedAt: null,
      },
    });

    if (!job) {
      throw new AppError(ErrorCodes.NOT_FOUND, "Job not found.", 404);
    }
    if (job.clientId !== req.userId) {
      throw new AppError(ErrorCodes.FORBIDDEN, "Not authorized to update this job.", 403);
    }

    const updateData = req.body;

    if (
      updateData.status &&
      ["COMPLETED", "DISPUTED", "CANCELLED", "EXPIRED"].includes(updateData.status)
    ) {
      return res.status(400).json({
        error: `Cannot update job status to ${updateData.status} directly.`,
      });
    }

    if (updateData.category && !isValidCategory(updateData.category)) {
      return res.status(422).json({
        code: "InvalidCategory",
        message: `"${updateData.category}" is not a recognised category. Valid categories: ${VALID_CATEGORIES.join(", ")}.`,
      });
    }

    if (updateData.deadline) {
      updateData.deadline = new Date(updateData.deadline);
    }

    const updated = await prisma.job.update({
      where: { id },
      data: updateData,
      include: { milestones: true },
    });

    await invalidateCache("jobs:list:*");
    await invalidateCacheKey(generateJobCacheKey(id));
    void RecommendationQueueService.enqueueRebuild(id);

    res.json(updated);
  }),
);

// Delete a job (soft delete)
router.delete(
  "/:id",
  authenticate,
  validate({ params: getJobByIdParamSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = req.params.id as string;
    const job = await prisma.job.findFirst({
      where: {
        id,
        deletedAt: null,
      },
    });

    if (!job) {
      throw new AppError(ErrorCodes.NOT_FOUND, "Job not found.", 404);
    }
    if (job.clientId !== req.userId) {
      throw new AppError(ErrorCodes.FORBIDDEN, "Not authorized to delete this job.", 403);
    }

    await prisma.job.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    await invalidateCache("jobs:list:*");
    await invalidateCacheKey(generateJobCacheKey(id));
    void RecommendationQueueService.enqueueRebuild(id);

    res.json({ message: "Job deleted successfully." });
  }),
);

// Chain-owned job statuses must only be changed by the escrow event projection.
router.patch(
  "/:id/status",
  authenticate,
  validate({
    params: getJobByIdParamSchema,
    body: updateJobStatusSchema,
  }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = req.params.id as string;
    const job = await prisma.job.findFirst({
      where: {
        id,
        deletedAt: null,
      },
    });

    if (!job) {
      throw new AppError(ErrorCodes.NOT_FOUND, "Job not found.", 404);
    }
    if (job.clientId !== req.userId) {
      throw new AppError(ErrorCodes.FORBIDDEN, "Not authorized to update this job.", 403);
    }

    return res.status(403).json({
      error: "Job status is derived from verified escrow events and cannot be updated directly.",
    });
  }),
);

// Complete a job (client only)
router.patch(
  "/:id/complete",
  authenticate,
  validate({ params: getJobByIdParamSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = req.params.id as string;

    const job = await prisma.job.findFirst({ where: { id, deletedAt: null } });

    if (!job) {
      throw new AppError(ErrorCodes.NOT_FOUND, "Job not found.", 404);
    }
    if (job.clientId !== req.userId) {
      throw new AppError(ErrorCodes.FORBIDDEN, "Only the client can mark the job as complete.", 403);
    }

    return res.status(403).json({
      error: "Job completion is derived from a verified escrow release and cannot be set directly.",
    });
  }),
);

// Save/bookmark a job
router.post(
  "/:id/save",
  authenticate,
  validate({ params: getJobByIdParamSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { role: true },
    });

    if (!user || user.role !== "FREELANCER") {
      throw new AppError(ErrorCodes.FORBIDDEN, "Only freelancers can save jobs.", 403);
    }

    const id = req.params.id as string;
    const job = await prisma.job.findFirst({
      where: {
        id,
        deletedAt: null,
      },
    });

    if (!job) {
      throw new AppError(ErrorCodes.NOT_FOUND, "Job not found.", 404);
    }

    const existingSave = await prisma.savedJob.findUnique({
      where: {
        freelancerId_jobId: {
          freelancerId: req.userId!,
          jobId: id,
        },
      },
    });

    if (existingSave) {
      throw new AppError(ErrorCodes.CONFLICT, "Job already saved.", 409);
    }

    const savedJob = await prisma.savedJob.create({
      data: {
        freelancerId: req.userId!,
        jobId: id,
      },
    });

    res.status(201).json({
      message: "Job saved successfully.",
      savedJob,
    });
  }),
);

// Remove saved/bookmarked job
router.delete(
  "/:id/save",
  authenticate,
  validate({ params: getJobByIdParamSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { role: true },
    });

    if (!user || user.role !== "FREELANCER") {
      throw new AppError(ErrorCodes.FORBIDDEN, "Only freelancers can unsave jobs.", 403);
    }

    const id = req.params.id as string;

    const savedJob = await prisma.savedJob.findUnique({
      where: {
        freelancerId_jobId: {
          freelancerId: req.userId!,
          jobId: id,
        },
      },
    });

    if (!savedJob) {
      throw new AppError(ErrorCodes.NOT_FOUND, "Job was not saved.", 404);
    }

    await prisma.savedJob.delete({
      where: {
        freelancerId_jobId: {
          freelancerId: req.userId!,
          jobId: id,
        },
      },
    });

    res.json({ message: "Job unsaved successfully." });
  }),
);

export default router;
