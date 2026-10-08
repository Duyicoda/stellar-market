import { Router, Response } from "express";
import { RiskFlagStatus, RiskLevel, RiskSubjectType } from "@prisma/client";
import { z } from "zod";
import { AuthRequest, requireAdmin } from "../../middleware/auth";
import { validate } from "../../middleware/validation";
import { logAdminAction } from "../../utils/auditLogger";
import {
  listFlags,
  getFlagWithHistory,
  getSubjectHistory,
  reviewFlag,
  getFalsePositiveStats,
  assessUser,
  assessJob,
} from "../../services/fraud-detection.service";
import { RiskTrigger } from "@prisma/client";

const router = Router();

// Every route in this file is admin-only.
router.use(requireAdmin);

const listQuerySchema = z.object({
  status: z.nativeEnum(RiskFlagStatus).optional(),
  level: z.nativeEnum(RiskLevel).optional(),
  subjectType: z.nativeEnum(RiskSubjectType).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

const historyQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * GET /api/admin/fraud/queue
 * The human review queue: subjects whose risk score crossed the review
 * threshold. Nothing here is auto-blocked — this surfaces activity for review.
 */
router.get(
  "/queue",
  validate({ query: listQuerySchema }),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const result = await listFlags(
        req.query as z.infer<typeof listQuerySchema>,
      );
      res.json(result);
    } catch {
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/**
 * GET /api/admin/fraud/stats
 * False-positive feedback aggregated by risk level — the input for tuning
 * thresholds and signal weights.
 */
router.get(
  "/stats",
  async (_req: AuthRequest, res: Response): Promise<void> => {
    try {
      res.json(await getFalsePositiveStats());
    } catch {
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/**
 * GET /api/admin/fraud/flags/:id
 * A single flag together with the full history of assessments (and the signals
 * that produced each) so a reviewer can see why it was flagged.
 */
router.get(
  "/flags/:id",
  validate({ params: z.object({ id: z.string().min(1) }) }),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const result = await getFlagWithHistory(req.params.id as string);
      if (!result) {
        res.status(404).json({ error: "Flag not found" });
        return;
      }
      res.json(result);
    } catch {
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

const reviewSchema = z.object({
  status: z.enum([
    RiskFlagStatus.UNDER_REVIEW,
    RiskFlagStatus.CONFIRMED,
    RiskFlagStatus.FALSE_POSITIVE,
    RiskFlagStatus.DISMISSED,
  ]),
  note: z.string().max(2000).optional(),
});

/**
 * POST /api/admin/fraud/flags/:id/review
 * Record a reviewer's decision. Marking FALSE_POSITIVE captures the feedback
 * used for threshold tuning. Does not block or suspend the subject.
 */
router.post(
  "/flags/:id/review",
  validate({
    params: z.object({ id: z.string().min(1) }),
    body: reviewSchema,
  }),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const { status, note } = req.body as z.infer<typeof reviewSchema>;
      const updated = await reviewFlag(req.params.id as string, {
        status,
        reviewerId: req.userId!,
        note,
      });
      if (!updated) {
        res.status(404).json({ error: "Flag not found" });
        return;
      }
      await logAdminAction(req.userId!, "REVIEW_RISK_FLAG", updated.id, {
        status,
        subjectType: updated.subjectType,
        subjectId: updated.subjectId,
      });
      res.json({ message: "Flag reviewed", flag: updated });
    } catch {
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/**
 * GET /api/admin/fraud/subjects/:type/:id/history
 * Full assessment history for any subject, flagged or not. Paginated with
 * page/pageSize (default 50 per page); `total` and `hasMore` tell reviewers
 * when older assessments exist beyond the current page.
 */
router.get(
  "/subjects/:type/:id/history",
  validate({
    params: z.object({
      type: z.nativeEnum(RiskSubjectType),
      id: z.string().min(1),
    }),
    query: historyQuerySchema,
  }),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const { items, total, page, pageSize, hasMore } = await getSubjectHistory(
        req.params.type as RiskSubjectType,
        req.params.id as string,
        req.query as z.infer<typeof historyQuerySchema>,
      );
      res.json({ history: items, total, page, pageSize, hasMore });
    } catch {
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

const rescoreSchema = z.object({
  subjectType: z.enum([RiskSubjectType.USER, RiskSubjectType.JOB]),
  subjectId: z.string().min(1),
});

/**
 * POST /api/admin/fraud/rescore
 * Manually re-score a user or job on demand (e.g. after tuning thresholds).
 */
router.post(
  "/rescore",
  validate({ body: rescoreSchema }),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const { subjectType, subjectId } = req.body as z.infer<
        typeof rescoreSchema
      >;
      const result =
        subjectType === RiskSubjectType.USER
          ? await assessUser(subjectId, RiskTrigger.MANUAL)
          : await assessJob(subjectId, RiskTrigger.MANUAL);
      if (!result) {
        res.status(404).json({ error: `${subjectType} not found` });
        return;
      }
      await logAdminAction(req.userId!, "RESCORE_RISK_SUBJECT", subjectId, {
        subjectType,
        score: result.score,
        level: result.level,
      });
      res.json(result);
    } catch {
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

export default router;
