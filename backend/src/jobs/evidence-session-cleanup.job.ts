import Redis from "ioredis";
import {
  cleanupSession,
  getSession,
  listActiveSessionIds,
} from "../services/evidence-upload-session.service";
import { logger } from "../lib/logger";

/** Sessions older than this with no assembled file are purged. Default: 24 h. */
export const SESSION_TTL_MS =
  Number(process.env.EVIDENCE_SESSION_TTL_MS) || 24 * 60 * 60 * 1000;

/** How often the sweep runs. Default: 1 h. */
const SWEEP_INTERVAL_MS =
  Number(process.env.EVIDENCE_SESSION_SWEEP_INTERVAL_MS) || 60 * 60 * 1000;

const LOCK_KEY = "lock:evidence-session-cleanup-job";
const LOCK_TTL_MS = 55_000;

// ---------------------------------------------------------------------------
// Redis distributed lock helpers (mirrors expiry.job.ts)
// ---------------------------------------------------------------------------

function getRedisClient(): Redis | null {
  const url = process.env.REDIS_URL || "redis://localhost:6379";
  if (!url) return null;
  try {
    return new Redis(url, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      enableReadyCheck: false,
    });
  } catch {
    return null;
  }
}

async function acquireLock(redis: Redis): Promise<boolean> {
  const result = await redis.set(LOCK_KEY, "1", "PX", LOCK_TTL_MS, "NX");
  return result === "OK";
}

async function releaseLock(redis: Redis): Promise<void> {
  await redis.del(LOCK_KEY);
}

// ---------------------------------------------------------------------------
// Core sweep logic (pure Redis/S3 side effects via the session service; no
// direct Redis dependency of its own — testable by mocking the service).
// ---------------------------------------------------------------------------

/**
 * Every session still listed in the active-session index that:
 *   1. Has a readable manifest with a parseable `createdAt`, AND
 *   2. Was created more than `ttlMs` milliseconds ago
 * is discarded (Redis manifest/chunk-set entries, S3 chunk objects, and its
 * slot in the index).
 *
 * A session only reaches this sweep by being abandoned: both the happy path
 * (`POST .../complete`) and the explicit abort (`DELETE .../sessions/:id`)
 * call `cleanupSession`, which removes it from the index immediately. So
 * anything still indexed past the TTL was never finished by its client —
 * unlike the old disk-backed sweep, there's no need to special-case "has an
 * assembled file" here, since a session that reached completion is already
 * gone from the index by the time this runs.
 *
 * Sessions with a missing/corrupt manifest (index entry outlived its data,
 * e.g. a crash between `sadd` and `set`) are swept unconditionally — they're
 * definitively unrecoverable.
 *
 * @param now   - Current time (injectable for testing)
 * @param ttlMs - Age threshold in milliseconds (injectable for testing)
 * @returns     - Number of sessions cleaned up
 */
export async function sweepStaleSessions(
  now: Date = new Date(),
  ttlMs: number = SESSION_TTL_MS,
): Promise<number> {
  let sessionIds: string[];
  try {
    sessionIds = await listActiveSessionIds();
  } catch (err) {
    logger.error(
      { err },
      "[EvidenceSessionCleanup] Failed to read the active-session index",
    );
    return 0;
  }

  const cutoff = now.getTime() - ttlMs;
  let cleaned = 0;

  for (const sessionId of sessionIds) {
    let manifest;
    try {
      manifest = await getSession(sessionId);
    } catch (err) {
      logger.error({ err, sessionId }, "[EvidenceSessionCleanup] Failed to read session manifest");
      continue;
    }

    let isStale: boolean;
    if (!manifest) {
      // Indexed but no manifest — an orphaned index entry from a partial write.
      isStale = true;
    } else {
      const createdAt = new Date(manifest.createdAt).getTime();
      isStale = Number.isNaN(createdAt) ? true : createdAt <= cutoff;
    }

    if (!isStale) continue;

    try {
      await cleanupSession(sessionId);
      logger.info(
        { sessionId, createdAt: manifest?.createdAt, ttlMs },
        "[EvidenceSessionCleanup] Removed stale evidence session",
      );
      cleaned += 1;
    } catch (err) {
      logger.error(
        { err, sessionId },
        "[EvidenceSessionCleanup] Failed to remove stale session",
      );
    }
  }

  return cleaned;
}

// ---------------------------------------------------------------------------
// Scheduled execution with distributed lock
// ---------------------------------------------------------------------------

async function executeWithLock(): Promise<void> {
  const redis = getRedisClient();

  if (redis) {
    try {
      await redis.connect();
      const acquired = await acquireLock(redis);
      if (!acquired) {
        logger.debug(
          "[EvidenceSessionCleanup] Lock not acquired — another instance is handling the sweep",
        );
        await redis.quit();
        return;
      }
    } catch (err) {
      logger.warn(
        { err },
        "[EvidenceSessionCleanup] Redis lock error, proceeding without lock",
      );
    }
  } else {
    logger.debug(
      "[EvidenceSessionCleanup] No Redis configured, proceeding without distributed lock",
    );
  }

  try {
    logger.info(
      { at: new Date().toISOString(), ttlMs: SESSION_TTL_MS },
      "[EvidenceSessionCleanup] Running sweep",
    );
    const cleaned = await sweepStaleSessions();
    logger.info(
      { cleaned },
      "[EvidenceSessionCleanup] Sweep complete",
    );
  } finally {
    if (redis) {
      try {
        await releaseLock(redis);
        await redis.quit();
      } catch {
        // Best-effort lock release
      }
    }
  }
}

export function startEvidenceSessionCleanupJob(): void {
  void executeWithLock();
  setInterval(() => void executeWithLock(), SWEEP_INTERVAL_MS);
  logger.info(
    {
      intervalMs: SWEEP_INTERVAL_MS,
      ttlMs: SESSION_TTL_MS,
    },
    "[EvidenceSessionCleanup] Scheduled — runs periodically with distributed lock",
  );
}
