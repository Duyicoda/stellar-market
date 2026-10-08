import { BadgeTier } from "@prisma/client";
import RedisClient from "../lib/redis";
import { logger } from "../lib/logger";
import { config } from "../config";
import { Contract, Address, rpc, scValToNative } from "@stellar/stellar-sdk";
import { CircuitBreaker } from "../lib/circuit-breaker";

/**
 * On-chain reputation data structure
 */
export interface OnChainReputation {
  tier: BadgeTier | null;
  score: number;
  disputeLossRate: number;
  endorsementWeight: number;
  lastUpdated: number;
}

/**
 * Leaderboard entry structure
 */
interface LeaderboardEntry {
  address: string;
  score: bigint;
}

const CACHE_TTL_SECONDS = 1800; // 30 minutes
const CACHE_REFRESH_INTERVAL_MS = 1500000; // 25 minutes (stale-while-revalidate)
const LEADERBOARD_SIZE = 200;
const CACHE_KEY_PREFIX = "rep:";

// Circuit breaker for reputation contract calls
const reputationCB = new CircuitBreaker({
  failureThreshold: 5,
  openDurationMs: 60_000,
  name: "ReputationContract",
});

/**
 * Service for caching on-chain reputation data with stale-while-revalidate pattern
 */
export class ReputationCacheService {
  private static refreshIntervalId: NodeJS.Timeout | null = null;
  private static isWarmedUp = false;

  /**
   * Get cached reputation for a wallet address
   * Falls back to on-chain fetch if cache miss
   */
  static async getCachedReputation(
    walletAddress: string
  ): Promise<OnChainReputation | null> {
    if (!walletAddress) return null;

    try {
      // Try Redis cache first
      if (RedisClient.isRedisConnected()) {
        const redis = RedisClient.getInstance();
        const cached = await redis.get(`${CACHE_KEY_PREFIX}${walletAddress}`);

        if (cached) {
          logger.debug(
            { walletAddress },
            "Reputation cache HIT"
          );
          return JSON.parse(cached) as OnChainReputation;
        }
      }

      // Cache miss - fetch from chain
      logger.debug({ walletAddress }, "Reputation cache MISS - fetching on-chain");
      const onChainData = await this.fetchOnChainReputation(walletAddress);

      if (onChainData && RedisClient.isRedisConnected()) {
        await this.cacheReputation(walletAddress, onChainData);
      }

      return onChainData;
    } catch (error) {
      logger.warn(
        { err: error, walletAddress },
        "Error getting cached reputation"
      );
      return null;
    }
  }

  /**
   * Fetch reputation data from on-chain contract
   */
  private static async fetchOnChainReputation(
    walletAddress: string
  ): Promise<OnChainReputation | null> {
    const contractId = config.stellar.reputationContractId;
    if (!contractId) {
      logger.warn("REPUTATION_CONTRACT_ID not configured");
      return null;
    }

    // Check circuit breaker before proceeding
    if (!reputationCB.allowRequest()) {
      logger.debug("Circuit breaker OPEN - skipping reputation fetch");
      return null;
    }

    try {
      const server = new rpc.Server(config.stellar.rpcUrl);
      const contract = new Contract(contractId);
      const address = new Address(walletAddress);

      // Import stellar-sdk types
      const { TransactionBuilder, Account } = await import("@stellar/stellar-sdk");

      // Call get_reputation on contract
      const result = await server.simulateTransaction(
        new TransactionBuilder(
          new Account(
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
            "0"
          ),
          {
            fee: "100",
            networkPassphrase: config.stellar.networkPassphrase,
          }
        )
          .addOperation(contract.call("get_reputation", address.toScVal()))
          .setTimeout(30)
          .build()
      );

      // Check for successful simulation
      if ("result" in result && result.result) {
        const native = scValToNative(result.result.retval) as {
          tier?: unknown;
          total_jobs?: number | bigint;
          dispute_losses?: number | bigint;
          endorsement_weight?: number | bigint;
          value?: number | bigint;
        };

          // Extract badge tier
          const tier = this.extractBadgeTier(native.tier);

          // Calculate dispute loss rate
          const totalJobs = Number(native.total_jobs ?? 0);
          const disputeLosses = Number(native.dispute_losses ?? 0);
          const disputeLossRate =
            totalJobs > 0 ? disputeLosses / totalJobs : 0;

          // Normalize endorsement weight (assuming max reasonable weight is 100000)
          const rawEndorsementWeight = BigInt(native.endorsement_weight ?? 0);
          const endorsementWeight = Number(rawEndorsementWeight) / 100000;

        reputationCB.onSuccess();

        return {
          tier,
          score: Number(native.value ?? 0),
          disputeLossRate,
          endorsementWeight: Math.min(endorsementWeight, 1.0), // Cap at 1.0
          lastUpdated: Date.now(),
        };
      }

      reputationCB.onSuccess();
      return null;
    } catch (error) {
      // User might not have on-chain reputation yet
      reputationCB.onFailure();
      logger.debug(
        { walletAddress, err: error },
        "No on-chain reputation found"
      );
      return null;
    }
  }

  /**
   * Extract BadgeTier from on-chain enum variant
   */
  private static extractBadgeTier(raw: unknown): BadgeTier | null {
    if (!raw) return null;

    let tierStr: string;
    if (typeof raw === "string") {
      tierStr = raw;
    } else if (Array.isArray(raw) && raw.length > 0) {
      tierStr = String(raw[0]);
    } else {
      tierStr = String(raw);
    }

    const normalized = tierStr.toUpperCase();
    if (normalized === "BRONZE") return BadgeTier.BRONZE;
    if (normalized === "SILVER") return BadgeTier.SILVER;
    if (normalized === "GOLD") return BadgeTier.GOLD;
    if (normalized === "PLATINUM") return BadgeTier.PLATINUM;

    return null;
  }

  /**
   * Cache reputation data with TTL
   */
  private static async cacheReputation(
    walletAddress: string,
    reputation: OnChainReputation
  ): Promise<void> {
    try {
      if (!RedisClient.isRedisConnected()) {
        await RedisClient.connect();
      }

      const redis = RedisClient.getInstance();
      await redis.setex(
        `${CACHE_KEY_PREFIX}${walletAddress}`,
        CACHE_TTL_SECONDS,
        JSON.stringify(reputation)
      );

      logger.debug({ walletAddress }, "Cached reputation data");
    } catch (error) {
      logger.warn(
        { err: error, walletAddress },
        "Failed to cache reputation"
      );
    }
  }

  /**
   * Invalidate cache for a specific wallet address
   */
  static async invalidateCache(walletAddress: string): Promise<void> {
    try {
      if (!RedisClient.isRedisConnected()) {
        logger.debug("Redis not connected, skipping cache invalidation");
        return;
      }

      const redis = RedisClient.getInstance();
      await redis.del(`${CACHE_KEY_PREFIX}${walletAddress}`);

      logger.info({ walletAddress }, "Invalidated reputation cache");
    } catch (error) {
      logger.warn(
        { err: error, walletAddress },
        "Failed to invalidate reputation cache"
      );
    }
  }

  /**
   * Warm cache with top leaderboard users
   * Called on service startup
   */
  static async warmCache(): Promise<void> {
    const contractId = config.stellar.reputationContractId;
    if (!contractId) {
      logger.warn("REPUTATION_CONTRACT_ID not configured - skipping cache warm");
      return;
    }

    try {
      logger.info("Warming reputation cache with leaderboard...");

      const leaderboard = await this.fetchLeaderboard();
      if (!leaderboard || leaderboard.length === 0) {
        logger.warn("No leaderboard data available for cache warming");
        return;
      }

      // Fetch and cache reputation for top users
      const warmPromises = leaderboard.map(async (entry) => {
        try {
          const reputation = await this.fetchOnChainReputation(entry.address);
          if (reputation) {
            await this.cacheReputation(entry.address, reputation);
          }
        } catch {
          logger.debug(
            { address: entry.address },
            "Failed to warm cache for address"
          );
        }
      });

      await Promise.allSettled(warmPromises);

      logger.info(
        { count: leaderboard.length },
        "Reputation cache warmed successfully"
      );
      this.isWarmedUp = true;
    } catch (error) {
      logger.error({ err: error }, "Failed to warm reputation cache");
    }
  }

  /**
   * Fetch leaderboard from on-chain contract
   */
  private static async fetchLeaderboard(): Promise<LeaderboardEntry[]> {
    const contractId = config.stellar.reputationContractId;
    if (!contractId) return [];

    // Check circuit breaker before proceeding
    if (!reputationCB.allowRequest()) {
      logger.debug("Circuit breaker OPEN - skipping leaderboard fetch");
      return [];
    }

    try {
      const server = new rpc.Server(config.stellar.rpcUrl);
      const contract = new Contract(contractId);

      // Import stellar-sdk types
      const { TransactionBuilder, Account, xdr } = await import("@stellar/stellar-sdk");

      const result = await server.simulateTransaction(
        new TransactionBuilder(
          new Account(
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
            "0"
          ),
          {
            fee: "100",
            networkPassphrase: config.stellar.networkPassphrase,
          }
        )
          .addOperation(
            contract.call(
              "get_leaderboard",
              xdr.ScVal.scvU32(LEADERBOARD_SIZE)
            )
          )
          .setTimeout(30)
          .build()
      );

      // Check for successful simulation
      if ("result" in result && result.result) {
        const native = scValToNative(result.result.retval);

        if (Array.isArray(native)) {
          reputationCB.onSuccess();
          return native.map((entry: unknown[]) => ({
            address: String(entry[0] ?? ""),
            score: BigInt((entry[1] as string | number | bigint | boolean | undefined) ?? 0),
          }));
        }
      }

      reputationCB.onSuccess();
      return [];
    } catch (error) {
      reputationCB.onFailure();
      logger.warn({ err: error }, "Failed to fetch leaderboard");
      return [];
    }
  }

  /**
   * Start periodic cache refresh (stale-while-revalidate pattern)
   */
  static startPeriodicRefresh(): void {
    if (this.refreshIntervalId) {
      logger.warn("Reputation cache refresh already running");
      return;
    }

    logger.info(
      { intervalMs: CACHE_REFRESH_INTERVAL_MS },
      "Starting reputation cache periodic refresh"
    );

    this.refreshIntervalId = setInterval(async () => {
      try {
        await this.warmCache();
      } catch (error) {
        logger.error({ err: error }, "Periodic cache refresh failed");
      }
    }, CACHE_REFRESH_INTERVAL_MS);
  }

  /**
   * Stop periodic cache refresh
   */
  static stopPeriodicRefresh(): void {
    if (this.refreshIntervalId) {
      clearInterval(this.refreshIntervalId);
      this.refreshIntervalId = null;
      logger.info("Stopped reputation cache periodic refresh");
    }
  }

  /**
   * Get cache statistics
   */
  static async getCacheStats(): Promise<{
    hitRate: number;
    cachedEntries: number;
    isWarmedUp: boolean;
    circuitBreakerStatus: string;
  }> {
    try {
      if (!RedisClient.isRedisConnected()) {
        return {
          hitRate: 0,
          cachedEntries: 0,
          isWarmedUp: this.isWarmedUp,
          circuitBreakerStatus: "redis_disconnected",
        };
      }

      const redis = RedisClient.getInstance();
      const keys = await redis.keys(`${CACHE_KEY_PREFIX}*`);

      return {
        hitRate: 0, // Would need request tracking to calculate
        cachedEntries: keys.length,
        isWarmedUp: this.isWarmedUp,
        circuitBreakerStatus: reputationCB.getStatus().state,
      };
    } catch (error) {
      logger.error({ err: error }, "Failed to get cache stats");
      return {
        hitRate: 0,
        cachedEntries: 0,
        isWarmedUp: this.isWarmedUp,
        circuitBreakerStatus: "error",
      };
    }
  }
}
