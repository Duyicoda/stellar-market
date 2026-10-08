import { PrismaClient, BadgeTier } from "@prisma/client";
import { 
  cache,
  generateRecommendationsCacheKey,
  invalidateCache
} from "../lib/cache";
import { ReputationCacheService, OnChainReputation } from "./reputation-cache.service";
import { logger } from "../lib/logger";

const prisma = new PrismaClient();

/**
 * Weight configuration for scoring components
 * 
 * These weights balance traditional signals (skills, history) with on-chain trust signals.
 * The distribution reflects that skill match is most critical, followed by on-chain reputation,
 * then completion history, dispute record, endorsements, and response time.
 * 
 * Weights should be revisited once real user data is available for A/B testing.
 */
interface ScoringWeights {
  skillOverlap: number;       // Skill match to job requirements
  completionRate: number;     // Jobs completed / jobs accepted from DB
  onChainTier: number;        // Badge tier from reputation contract
  disputeLossRate: number;    // Penalty for dispute losses
  endorsementWeight: number;  // Stake-weighted endorsements
  responseTime: number;       // Average time to first message (future)
  recency: number;            // How recently the job was posted
  clientReputation: number;   // Client average rating (normalized)
}

export const WEIGHTS: ScoringWeights = {
  skillOverlap: 0.20,
  completionRate: 0.15,
  onChainTier: 0.20,
  disputeLossRate: 0.10,
  endorsementWeight: 0.08,
  responseTime: 0.05,
  recency: 0.12,
  clientReputation: 0.10,
};

/** Max age in days for recency scoring — jobs older than this get 0 recency score */
const RECENCY_WINDOW_DAYS = 30;

/**
 * Computes Jaccard similarity between two string arrays.
 * J(A, B) = |A ∩ B| / |A ∪ B|
 * Returns 0 when both sets are empty.
 */
export function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a.map((s) => s.toLowerCase()));
  const setB = new Set(b.map((s) => s.toLowerCase()));

  if (setA.size === 0 && setB.size === 0) return 0;

  let intersectionSize = 0;
  for (const item of setA) {
    if (setB.has(item)) intersectionSize++;
  }

  const unionSize = new Set([...setA, ...setB]).size;
  return intersectionSize / unionSize;
}

/**
 * Computes category affinity score.
 * Returns 1 if the job's category is in the freelancer's completed categories, 0 otherwise.
 */
export function categoryAffinityScore(
  jobCategory: string,
  completedCategories: string[]
): number {
  const normalizedJob = jobCategory.toLowerCase();
  return completedCategories.some((c) => c.toLowerCase() === normalizedJob)
    ? 1
    : 0;
}

/**
 * Computes recency score based on how recently a job was posted.
 * Returns a value between 0 and 1. Jobs posted today score 1,
 * jobs older than RECENCY_WINDOW_DAYS score 0.
 */
export function recencyScore(createdAt: Date, now: Date = new Date()): number {
  const ageMs = now.getTime() - createdAt.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  // Clamp age to prevent negative values (future dates) from producing scores > 1
  if (ageDays <= 0) return 1;
  if (ageDays >= RECENCY_WINDOW_DAYS) return 0;
  return 1 - ageDays / RECENCY_WINDOW_DAYS;
}

/**
 * Computes reputation score for a client.
 * Normalizes the average rating to a 0–1 scale (rating / 5).
 * Returns 0 if no reviews exist.
 */
export function reputationScore(averageRating: number): number {
  return Math.min(Math.max(averageRating / 5, 0), 1);
}

/**
 * Computes on-chain badge tier score.
 * Maps BadgeTier enum to normalized scores:
 * - BRONZE: 0.2
 * - SILVER: 0.4
 * - GOLD: 0.7
 * - PLATINUM: 1.0
 * - No tier: 0.5 (neutral fallback when RPC unavailable)
 */
export function badgeTierScore(tier: BadgeTier | null, isFallback: boolean = false): number {
  if (!tier) return isFallback ? 0.5 : 0;
  
  switch (tier) {
    case BadgeTier.BRONZE:
      return 0.2;
    case BadgeTier.SILVER:
      return 0.4;
    case BadgeTier.GOLD:
      return 0.7;
    case BadgeTier.PLATINUM:
      return 1.0;
    default:
      return 0;
  }
}

/**
 * Computes dispute loss rate penalty.
 * Higher dispute loss rate = lower score.
 * - 0% disputes: 1.0
 * - 30%+ disputes: 0.0
 * - Neutral fallback: 0.5 (when RPC unavailable)
 */
export function disputeLossRateScore(rate: number, isFallback: boolean = false): number {
  if (isFallback) return 0.5;
  
  // Linear penalty: 1.0 at 0%, 0.0 at 30%+
  const threshold = 0.3;
  if (rate >= threshold) return 0;
  return 1 - (rate / threshold);
}

/**
 * Computes completion rate score from DB history.
 * - completion_rate = completed_jobs / (completed_jobs + cancelled_jobs + disputed_jobs)
 * - Normalized to 0-1 range
 */
export function completionRateScore(completedJobs: number, totalJobs: number): number {
  if (totalJobs === 0) return 0.5; // Neutral for new users
  return completedJobs / totalJobs;
}

/**
 * Computes the combined relevance score for a job given a freelancer's profile.
 * Integrates both traditional DB signals and on-chain reputation signals.
 */
export function computeRelevanceScore(params: {
  freelancerSkills: string[];
  jobSkills: string[];
  jobCategory: string;
  completedCategories: string[];
  jobCreatedAt: Date;
  clientAverageRating: number;
  onChainReputation: OnChainReputation | null;
  completedJobsCount: number;
  totalJobsCount: number;
  isRpcFallback?: boolean; // True when RPC is unavailable
  now?: Date;
}): number {
  // Traditional signals
  const skillScore = jaccardSimilarity(
    params.freelancerSkills,
    params.jobSkills
  );
  // On-chain signals (with fallback to neutral when unavailable)
  const isFallback = params.isRpcFallback || !params.onChainReputation;
  const tierScore = badgeTierScore(
    params.onChainReputation?.tier ?? null,
    isFallback
  );
  const disputeScore = disputeLossRateScore(
    params.onChainReputation?.disputeLossRate ?? 0,
    isFallback
  );
  const endorsementScore = params.onChainReputation?.endorsementWeight ?? (isFallback ? 0.5 : 0);
  
  // DB-based completion rate
  const completionScore = completionRateScore(
    params.completedJobsCount,
    params.totalJobsCount
  );
  
  // Response time (placeholder - always neutral for now)
  const responseScore = 0.5;

  return (
    WEIGHTS.skillOverlap * skillScore +
    WEIGHTS.completionRate * completionScore +
    WEIGHTS.onChainTier * tierScore +
    WEIGHTS.disputeLossRate * disputeScore +
    WEIGHTS.endorsementWeight * endorsementScore +
    WEIGHTS.responseTime * responseScore +
    WEIGHTS.recency * recencyScore(params.jobCreatedAt, params.now ?? new Date()) +
    WEIGHTS.clientReputation * reputationScore(params.clientAverageRating)
  );
}

export class RecommendationService {
  /**
   * Returns paginated job recommendations for a freelancer, scored by relevance.
   * Integrates on-chain reputation signals with traditional DB signals.
   */
  static async getRecommendedJobs(
    userId: string,
    page: number = 1,
    limit: number = 10
  ) {
    const cacheKey = generateRecommendationsCacheKey(userId, page, limit);

    const { data } = await cache(cacheKey, 60, async () => {
      // 1. Fetch freelancer's skills and wallet address
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { 
          skills: true, 
          role: true,
          walletAddress: true,
        },
      });

      if (!user || user.role !== "FREELANCER") {
        return null;
      }

      // 2. Get categories from freelancer's completed jobs
      const completedJobs = await prisma.job.findMany({
        where: { freelancerId: userId, status: "COMPLETED" },
        select: { category: true },
      });
      const completedCategories = [
        ...new Set(completedJobs.map((j) => j.category)),
      ];

      // 3. Calculate freelancer's completion rate from DB
      const totalJobsCount = await prisma.job.count({
        where: {
          freelancerId: userId,
          status: { in: ["COMPLETED", "CANCELLED", "DISPUTED"] },
        },
      });
      const completedJobsCount = completedJobs.length;

      // 4. Get job IDs the freelancer already applied to (to exclude)
      const appliedApplications = await prisma.application.findMany({
        where: { freelancerId: userId },
        select: { jobId: true },
      });
      const appliedJobIds = appliedApplications.map((a) => a.jobId);

      // 5. Fetch all open, unflagged jobs (excluding own and already applied)
      const openJobs = await prisma.job.findMany({
        where: {
          status: "OPEN",
          isFlagged: false,
          clientId: { not: userId },
          id: { notIn: appliedJobIds.length > 0 ? appliedJobIds : undefined },
        },
        include: {
          client: {
            select: {
              id: true,
              username: true,
              avatarUrl: true,
              walletAddress: true,
              reviewsReceived: { select: { rating: true } },
            },
          },
          freelancer: { select: { id: true, username: true, avatarUrl: true } },
          milestones: true,
          _count: { select: { applications: true } },
        },
      });

      // 6. Fetch on-chain reputation for all clients (in parallel)
      const clientAddresses = openJobs
        .map(job => job.client.walletAddress)
        .filter(Boolean) as string[];

      const uniqueAddresses = [...new Set(clientAddresses)];
      
      const reputationMap: Map<string, OnChainReputation | null> = new Map();
      let isRpcFallback = false;

      try {
        const reputationPromises = uniqueAddresses.map(async (address) => {
          try {
            const rep = await ReputationCacheService.getCachedReputation(address);
            return { address, rep };
          } catch {
            logger.debug({ address }, "Failed to fetch reputation for client");
            return { address, rep: null };
          }
        });

        const results = await Promise.allSettled(reputationPromises);
        
        results.forEach((result) => {
          if (result.status === "fulfilled" && result.value) {
            reputationMap.set(result.value.address, result.value.rep);
          }
        });
      } catch (error) {
        logger.warn(
          { err: error },
          "Failed to fetch on-chain reputations - using neutral fallback"
        );
        isRpcFallback = true;
      }

      // 7. Score and sort
      const now = new Date();
      const scoredJobs = openJobs.map((job) => {
        const clientReviews = job.client.reviewsReceived || [];
        const clientAvgRating =
          clientReviews.length > 0
            ? clientReviews.reduce((sum, r) => sum + r.rating, 0) /
              clientReviews.length
            : 0;

        const clientReputation = job.client.walletAddress
          ? reputationMap.get(job.client.walletAddress) ?? null
          : null;

        const relevanceScore = computeRelevanceScore({
          freelancerSkills: user.skills,
          jobSkills: job.skills,
          jobCategory: job.category,
          completedCategories,
          jobCreatedAt: job.createdAt,
          clientAverageRating: clientAvgRating,
          onChainReputation: clientReputation,
          completedJobsCount,
          totalJobsCount,
          isRpcFallback,
          now,
        });

        // Strip reviewsReceived/walletAddress from client in the response
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { reviewsReceived, walletAddress, ...clientData } = job.client;

        return {
          ...job,
          client: clientData,
          relevanceScore: Math.round(relevanceScore * 1000) / 1000,
        };
      });

      scoredJobs.sort((a, b) => b.relevanceScore - a.relevanceScore);

      // 8. Paginate
      const total = scoredJobs.length;
      const skip = (page - 1) * limit;
      const paginatedJobs = scoredJobs.slice(skip, skip + limit);

      return {
        data: paginatedJobs,
        total,
        page,
        totalPages: Math.ceil(total / limit),
      };
    });

    return data;
  }

  static async rebuildRecommendationsForJob(jobId: string): Promise<void> {
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: { id: true, status: true, deletedAt: true },
    });

    if (!job || job.deletedAt || job.status !== "OPEN") {
      await invalidateCache("recommendations:*");
      return;
    }

    await invalidateCache("recommendations:*");

    const freelancers = await prisma.user.findMany({
      where: {
        role: "FREELANCER",
        emailVerified: true,
      },
      select: { id: true },
    });

    for (const freelancer of freelancers) {
      await RecommendationService.getRecommendedJobs(freelancer.id, 1, 10);
    }
  }

  /**
   * Invalidate recommendation cache for a user when they apply to a job
   */
  static async invalidateUserRecommendations(userId: string) {
    await invalidateCache(`recommendations:${userId}:*`);
  }
}
