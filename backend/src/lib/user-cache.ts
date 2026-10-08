import { PrismaClient, UserRole } from "@prisma/client";
import RedisClient from "./redis";
import { logger } from "./logger";

const prisma = new PrismaClient();

const USER_CACHE_TTL_SECONDS = 60;

export interface CachedUserData {
  id: string;
  role: UserRole;
  emailVerified: boolean;
  deletedAt: Date | null;
  isSuspended: boolean;
  suspendReason: string | null;
}

const cacheKey = (userId: string): string => `auth:user:${userId}`;

export async function getCachedUserAuthData(userId: string): Promise<CachedUserData | null> {
  const key = cacheKey(userId);

  try {
    if (!RedisClient.isRedisConnected()) {
      await RedisClient.connect();
    }
    const redis = RedisClient.getInstance();

    const cached = await redis.get(key);
    if (cached !== null) {
      const parsed = JSON.parse(cached);
      if (parsed.deletedAt) {
        parsed.deletedAt = new Date(parsed.deletedAt);
      }
      return parsed as CachedUserData;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        role: true,
        emailVerified: true,
        deletedAt: true,
        isSuspended: true,
        suspendReason: true,
      },
    });

    if (!user) return null;

    await redis.setex(key, USER_CACHE_TTL_SECONDS, JSON.stringify(user));
    return user;
  } catch (err) {
    logger.warn({ err, userId }, "user cache error — reading from database");
    return await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        role: true,
        emailVerified: true,
        deletedAt: true,
        isSuspended: true,
        suspendReason: true,
      },
    });
  }
}

export async function invalidateUserCache(userId: string): Promise<void> {
  try {
    if (!RedisClient.isRedisConnected()) {
      await RedisClient.connect();
    }
    await RedisClient.getInstance().del(cacheKey(userId));
  } catch (err) {
    logger.warn({ err, userId }, "Failed to invalidate user cache");
  }
}
