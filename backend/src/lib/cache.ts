import RedisClient from "./redis";
import { logger } from "./logger";

interface CacheResult<T> {
  data: T;
  hit: boolean; // true if cache hit, false if cache miss
}

/**
 * Generic cache helper that checks Redis before executing a function
 * @param key - Cache key
 * @param ttl - Time to live in seconds
 * @param fn - Function to execute if cache miss
 * @returns Promise with data and cache hit status
 */
export async function cache<T>(
  key: string,
  ttl: number,
  fn: () => Promise<T>
): Promise<CacheResult<T>> {
  try {
    // Try to connect to Redis if not already connected
    if (!RedisClient.isRedisConnected()) {
      await RedisClient.connect();
    }

    const redis = RedisClient.getInstance();
    
    // Try to get cached data
    const cached = await redis.get(key);
    
    if (cached) {
      logger.debug({ key }, "Cache HIT");
      return {
        data: JSON.parse(cached) as T,
        hit: true,
      };
    }

    // Cache miss - execute the function
    logger.debug({ key }, "Cache MISS");
    const result = await fn();
    
    // Cache the result
    await redis.setex(key, ttl, JSON.stringify(result));
    logger.debug({ key, ttl }, "Cached data");
    
    return {
      data: result,
      hit: false,
    };
  } catch (error) {
    logger.warn({ err: error, key }, "Cache error, falling back to direct execution");
    // Graceful degradation - execute the function directly
    const result = await fn();
    return {
      data: result,
      hit: false,
    };
  }
}

/**
 * Invalidate cache by key pattern
 * @param pattern - Redis key pattern (supports wildcards)
 */
export async function invalidateCache(pattern: string): Promise<void> {
  try {
    if (!RedisClient.isRedisConnected()) {
      logger.debug("Redis not connected, skipping cache invalidation");
      return;
    }

    const redis = RedisClient.getInstance();

    // SCAN replaces KEYS so we never block Redis's single-threaded event loop.
    // scanStream yields keys in cursor-sized batches (non-blocking per batch).
    // All deletes are batched into a single pipeline to minimise round-trips.
    const pipeline = redis.pipeline();
    let count = 0;

    await new Promise<void>((resolve, reject) => {
      const stream = redis.scanStream({ match: pattern, count: 100 });
      stream.on("data", (keys: string[]) => {
        for (const key of keys) {
          pipeline.del(key);
          count++;
        }
      });
      stream.on("end", resolve);
      stream.on("error", reject);
    });

    if (count > 0) {
      await pipeline.exec();
      logger.debug({ count, pattern }, "Invalidated cache keys");
    }
  } catch (error) {
    logger.warn({ err: error, pattern }, "Cache invalidation error");
  }
}

/**
 * Invalidate cache by specific key
 * @param key - Cache key to invalidate
 */
export async function invalidateCacheKey(key: string): Promise<void> {
  try {
    if (!RedisClient.isRedisConnected()) {
      logger.debug("Redis not connected, skipping cache invalidation");
      return;
    }

    const redis = RedisClient.getInstance();
    await redis.del(key);
    logger.debug({ key }, "Invalidated cache key");
  } catch (error) {
    logger.warn({ err: error, key }, "Cache invalidation error");
  }
}

/**
 * Generate cache key for job listings with query parameters
 */
export function generateJobsCacheKey(params: Record<string, unknown>): string {
  const sortedParams = Object.keys(params)
    .sort()
    .reduce((result, key) => {
      if (params[key] !== undefined && params[key] !== null) {
        result[key] = params[key];
      }
      return result;
    }, {} as Record<string, unknown>);
  
  const paramString = JSON.stringify(sortedParams);
  return `jobs:list:${Buffer.from(paramString).toString("base64")}`;
}

/**
 * Generate cache key for user profile
 */
export function generateUserCacheKey(userId: string): string {
  return `user:profile:${userId}`;
}

/**
 * Generate cache key for user reviews
 */
export function generateUserReviewsCacheKey(userId: string, type: string = "received"): string {
  return `user:reviews:${type}:${userId}`;
}

/**
 * Generate cache key for job recommendations
 */
export function generateRecommendationsCacheKey(userId: string, page: number, limit: number): string {
  return `recommendations:${userId}:${page}:${limit}`;
}

/**
 * Generate cache key for single job
 */
export function generateJobCacheKey(jobId: string): string {
  return `job:single:${jobId}`;
}
/**
 * Generate cache key for job on-chain status
 */
export function generateJobOnChainStatusCacheKey(jobId: string): string {
  return `job:onchain-status:${jobId}`;
}

/**
 * Generate cache key for a freelancer's Horizon on-chain payment window
 * (issue #874). Shared across every backend instance via Redis so a payment
 * fetched by one instance is visible to all others, rather than each process
 * building its own independent, inconsistent view.
 */
export function generateOnChainPaymentsCacheKey(
  walletAddress: string,
  from: Date,
  to: Date,
): string {
  return `earnings:onchain:${walletAddress}:${from.toISOString()}:${to.toISOString()}`;
}
