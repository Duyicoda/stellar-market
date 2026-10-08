import { Router, Response } from "express";
import { z } from "zod";
import { authenticate, AuthRequest } from "../middleware/auth";
import { validate } from "../middleware/validation";
import { asyncHandler } from "../middleware/error";
import { getRecommendationsQuerySchema } from "../schemas";
import { RecommendationService } from "../services/recommendation.service";

const router = Router();

// GET /api/jobs/recommended — personalized job recommendations for freelancers
router.get(
  "/",
  authenticate,
  validate({ query: getRecommendationsQuerySchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { page, limit } = req.query as unknown as z.infer<
      typeof getRecommendationsQuerySchema
    >;

    const result = await RecommendationService.getRecommendedJobs(
      req.userId!,
      page,
      limit
    );

    if (!result) {
      return res
        .status(403)
        .json({ error: "Recommendations are only available for freelancers." });
    }

    res.json(result);
  })
);

export default router;
