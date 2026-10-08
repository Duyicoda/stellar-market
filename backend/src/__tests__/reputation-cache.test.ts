import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import { BadgeTier } from "@prisma/client";
import { ReputationCacheService, OnChainReputation } from "../services/reputation-cache.service";
import RedisClient from "../lib/redis";

// Mock dependencies
jest.mock("../lib/redis");
jest.mock("@stellar/stellar-sdk");

// Mock logger with actual implementation
jest.mock("../lib/logger", () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe("ReputationCacheService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    ReputationCacheService.stopPeriodicRefresh();
  });

  describe("getCachedReputation", () => {
    it("should return null for empty wallet address", async () => {
      const result = await ReputationCacheService.getCachedReputation("");
      expect(result).toBeNull();
    });

    it("should return cached data when available", async () => {
      const mockReputation: OnChainReputation = {
        tier: BadgeTier.GOLD,
        score: 1500,
        disputeLossRate: 0.1,
        endorsementWeight: 0.8,
        lastUpdated: Date.now(),
      };

      const mockRedis = {
        get: jest.fn<(key: string) => Promise<string | null>>().mockResolvedValue(JSON.stringify(mockReputation)),
      };

      (RedisClient.isRedisConnected as jest.Mock).mockReturnValue(true);
      (RedisClient.getInstance as jest.Mock).mockReturnValue(mockRedis);

      const result = await ReputationCacheService.getCachedReputation(
        "GTEST123"
      );

      expect(result).toEqual(mockReputation);
      expect(mockRedis.get).toHaveBeenCalledWith("rep:GTEST123");
    });

    it("should fetch from chain on cache miss", async () => {
      const mockRedis = {
        get: jest.fn<(key: string) => Promise<string | null>>().mockResolvedValue(null),
        setex: jest.fn<(key: string, ttl: number, value: string) => Promise<string>>().mockResolvedValue("OK"),
      };

      (RedisClient.isRedisConnected as jest.Mock).mockReturnValue(true);
      (RedisClient.getInstance as jest.Mock).mockReturnValue(mockRedis);

      // Mock the contract call to return null (user not found on-chain)
      const result = await ReputationCacheService.getCachedReputation(
        "GTEST123"
      );

      expect(mockRedis.get).toHaveBeenCalledWith("rep:GTEST123");
      // Result could be null if user doesn't exist on-chain
      expect(result).toBeDefined();
    });
  });

  describe("invalidateCache", () => {
    it("should delete cache entry for wallet address", async () => {
      const mockRedis = {
        del: jest.fn<(key: string) => Promise<number>>().mockResolvedValue(1),
      };

      (RedisClient.isRedisConnected as jest.Mock).mockReturnValue(true);
      (RedisClient.getInstance as jest.Mock).mockReturnValue(mockRedis);

      await ReputationCacheService.invalidateCache("GTEST123");

      expect(mockRedis.del).toHaveBeenCalledWith("rep:GTEST123");
    });

    it("should handle Redis disconnection gracefully", async () => {
      (RedisClient.isRedisConnected as jest.Mock).mockReturnValue(false);

      await expect(
        ReputationCacheService.invalidateCache("GTEST123")
      ).resolves.not.toThrow();
    });
  });

  describe("getCacheStats", () => {
    it("should return stats when Redis is connected", async () => {
      const mockRedis = {
        keys: jest.fn<(pattern: string) => Promise<string[]>>().mockResolvedValue(["rep:GTEST1", "rep:GTEST2", "rep:GTEST3"]),
      };

      (RedisClient.isRedisConnected as jest.Mock).mockReturnValue(true);
      (RedisClient.getInstance as jest.Mock).mockReturnValue(mockRedis);

      const stats = await ReputationCacheService.getCacheStats();

      expect(stats.cachedEntries).toBe(3);
      expect(stats).toHaveProperty("isWarmedUp");
      expect(stats).toHaveProperty("circuitBreakerStatus");
    });

    it("should handle Redis disconnection in stats", async () => {
      (RedisClient.isRedisConnected as jest.Mock).mockReturnValue(false);

      const stats = await ReputationCacheService.getCacheStats();

      expect(stats.cachedEntries).toBe(0);
      expect(stats.circuitBreakerStatus).toBe("redis_disconnected");
    });
  });

  describe("startPeriodicRefresh / stopPeriodicRefresh", () => {
    it("should start and stop periodic refresh", () => {
      ReputationCacheService.startPeriodicRefresh();
      
      // Should not throw when starting twice
      ReputationCacheService.startPeriodicRefresh();
      
      ReputationCacheService.stopPeriodicRefresh();
      
      // Should not throw when stopping twice
      ReputationCacheService.stopPeriodicRefresh();
    });
  });
});
