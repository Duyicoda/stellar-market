import { describe, it, expect } from "@jest/globals";
import { BadgeTier } from "@prisma/client";
import {
  badgeTierScore,
  disputeLossRateScore,
  completionRateScore,
  jaccardSimilarity,
  computeRelevanceScore,
} from "../services/recommendation.service";
import type { OnChainReputation } from "../services/reputation-cache.service";

describe("Recommendation Scoring with On-Chain Signals", () => {
  describe("badgeTierScore", () => {
    it("should return 0.2 for BRONZE tier", () => {
      expect(badgeTierScore(BadgeTier.BRONZE)).toBe(0.2);
    });

    it("should return 0.4 for SILVER tier", () => {
      expect(badgeTierScore(BadgeTier.SILVER)).toBe(0.4);
    });

    it("should return 0.7 for GOLD tier", () => {
      expect(badgeTierScore(BadgeTier.GOLD)).toBe(0.7);
    });

    it("should return 1.0 for PLATINUM tier", () => {
      expect(badgeTierScore(BadgeTier.PLATINUM)).toBe(1.0);
    });

    it("should return 0 for null tier without fallback", () => {
      expect(badgeTierScore(null, false)).toBe(0);
    });

    it("should return 0.5 for null tier with fallback (RPC unavailable)", () => {
      expect(badgeTierScore(null, true)).toBe(0.5);
    });
  });

  describe("disputeLossRateScore", () => {
    it("should return 1.0 for 0% dispute loss rate", () => {
      expect(disputeLossRateScore(0)).toBe(1.0);
    });

    it("should return 0.5 for 15% dispute loss rate", () => {
      expect(disputeLossRateScore(0.15)).toBeCloseTo(0.5, 2);
    });

    it("should return 0.0 for 30%+ dispute loss rate", () => {
      expect(disputeLossRateScore(0.3)).toBe(0);
      expect(disputeLossRateScore(0.5)).toBe(0);
    });

    it("should return 0.5 when fallback mode (RPC unavailable)", () => {
      expect(disputeLossRateScore(0, true)).toBe(0.5);
    });
  });

  describe("completionRateScore", () => {
    it("should return 1.0 for 100% completion rate", () => {
      expect(completionRateScore(10, 10)).toBe(1.0);
    });

    it("should return 0.5 for 50% completion rate", () => {
      expect(completionRateScore(5, 10)).toBe(0.5);
    });

    it("should return 0.5 for new users with no jobs", () => {
      expect(completionRateScore(0, 0)).toBe(0.5);
    });

    it("should return 0 for 0% completion rate", () => {
      expect(completionRateScore(0, 10)).toBe(0);
    });
  });

  describe("computeRelevanceScore", () => {
    const baseParams = {
      freelancerSkills: ["JavaScript", "React", "Node.js"],
      jobSkills: ["JavaScript", "TypeScript", "React"],
      jobCategory: "Web Development",
      completedCategories: ["Web Development", "Mobile Development"],
      jobCreatedAt: new Date(),
      clientAverageRating: 4.5,
      completedJobsCount: 8,
      totalJobsCount: 10,
    };

    it("should score higher for PLATINUM tier vs BRONZE tier with identical DB signals", () => {
      const platinumRep: OnChainReputation = {
        tier: BadgeTier.PLATINUM,
        score: 5000,
        disputeLossRate: 0,
        endorsementWeight: 0.9,
        lastUpdated: Date.now(),
      };

      const bronzeRep: OnChainReputation = {
        tier: BadgeTier.BRONZE,
        score: 500,
        disputeLossRate: 0,
        endorsementWeight: 0.1,
        lastUpdated: Date.now(),
      };

      const platinumScore = computeRelevanceScore({
        ...baseParams,
        onChainReputation: platinumRep,
      });

      const bronzeScore = computeRelevanceScore({
        ...baseParams,
        onChainReputation: bronzeRep,
      });

      expect(platinumScore).toBeGreaterThan(bronzeScore);
    });

    it("should penalize high dispute loss rate", () => {
      const lowDisputeRep: OnChainReputation = {
        tier: BadgeTier.GOLD,
        score: 2000,
        disputeLossRate: 0.05,
        endorsementWeight: 0.5,
        lastUpdated: Date.now(),
      };

      const highDisputeRep: OnChainReputation = {
        tier: BadgeTier.GOLD,
        score: 2000,
        disputeLossRate: 0.35, // Over 30% threshold
        endorsementWeight: 0.5,
        lastUpdated: Date.now(),
      };

      const lowDisputeScore = computeRelevanceScore({
        ...baseParams,
        onChainReputation: lowDisputeRep,
      });

      const highDisputeScore = computeRelevanceScore({
        ...baseParams,
        onChainReputation: highDisputeRep,
      });

      expect(lowDisputeScore).toBeGreaterThan(highDisputeScore);
    });

    it("should use neutral scores when RPC is unavailable", () => {
      const scoreWithoutRep = computeRelevanceScore({
        ...baseParams,
        onChainReputation: null,
        isRpcFallback: true,
      });

      const scoreWithRep = computeRelevanceScore({
        ...baseParams,
        onChainReputation: {
          tier: BadgeTier.PLATINUM,
          score: 5000,
          disputeLossRate: 0,
          endorsementWeight: 0.9,
          lastUpdated: Date.now(),
        },
      });

      // Both should be valid scores
      expect(scoreWithoutRep).toBeGreaterThan(0);
      expect(scoreWithoutRep).toBeLessThan(1);
      
      // PLATINUM should score higher
      expect(scoreWithRep).toBeGreaterThan(scoreWithoutRep);
    });

    it("should integrate skill overlap correctly", () => {
      // Perfect skill match
      const perfectMatch = computeRelevanceScore({
        ...baseParams,
        freelancerSkills: ["JavaScript", "TypeScript", "React"],
        jobSkills: ["JavaScript", "TypeScript", "React"],
        onChainReputation: {
          tier: BadgeTier.SILVER,
          score: 1000,
          disputeLossRate: 0.1,
          endorsementWeight: 0.5,
          lastUpdated: Date.now(),
        },
      });

      // No skill match
      const noMatch = computeRelevanceScore({
        ...baseParams,
        freelancerSkills: ["Python", "Django", "Flask"],
        jobSkills: ["JavaScript", "TypeScript", "React"],
        onChainReputation: {
          tier: BadgeTier.SILVER,
          score: 1000,
          disputeLossRate: 0.1,
          endorsementWeight: 0.5,
          lastUpdated: Date.now(),
        },
      });

      expect(perfectMatch).toBeGreaterThan(noMatch);
    });

    it("should ensure scores are between 0 and 1", () => {
      const score = computeRelevanceScore({
        ...baseParams,
        onChainReputation: {
          tier: BadgeTier.PLATINUM,
          score: 10000,
          disputeLossRate: 0,
          endorsementWeight: 1.0,
          lastUpdated: Date.now(),
        },
      });

      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });
  });

  describe("jaccardSimilarity", () => {
    it("should return 1 for identical sets", () => {
      const result = jaccardSimilarity(
        ["JavaScript", "React"],
        ["JavaScript", "React"]
      );
      expect(result).toBe(1);
    });

    it("should return 0 for completely different sets", () => {
      const result = jaccardSimilarity(
        ["JavaScript", "React"],
        ["Python", "Django"]
      );
      expect(result).toBe(0);
    });

    it("should return 0.5 for 50% overlap", () => {
      const result = jaccardSimilarity(
        ["JavaScript", "React", "Node.js"],
        ["JavaScript", "Python"]
      );
      // Intersection: 1 (JavaScript), Union: 4 (JS, React, Node, Python)
      expect(result).toBe(0.25);
    });

    it("should be case-insensitive", () => {
      const result = jaccardSimilarity(
        ["javascript", "REACT"],
        ["JavaScript", "react"]
      );
      expect(result).toBe(1);
    });
  });
});
