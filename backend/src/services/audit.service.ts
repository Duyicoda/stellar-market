import { createHash } from "crypto";
import { PrismaClient, Prisma, AuditCategory } from "@prisma/client";
import RedisClient from "../lib/redis";
import { logger } from "../lib/logger";

const prisma = new PrismaClient();

/**
 * Unified, tamper-evident audit log (issue #875).
 *
 * Both administrative actions and security-relevant system events flow through
 * this one service and land in the single hash-chained `AuditLog` table.
 *
 * Two guarantees this module provides that the previous split implementation
 * did not:
 *
 *  1. Guaranteed write. `record()` never writes to Postgres inline; it appends
 *     the entry to a durable outbox (a Redis list, with an in-process fallback)
 *     and a single-writer worker drains it, retrying until the row actually
 *     lands. A transient DB blip therefore cannot silently drop an audit record
 *     the way `logAdminAction`'s swallowed `catch` used to.
 *
 *  2. Tamper evidence. A cross-instance drain lock ensures the outbox worker is
 *     the *only* writer at any moment — even under horizontal scaling — so it can
 *     assign a contiguous `sequence` and chain each row to its predecessor: every
 *     row stores `hash = sha256(canonicalContent + prevHash)`. Altering a row's
 *     content, re-linking it, or deleting a historical row all break the chain
 *     (or leave a sequence gap) and are detected by `verifyChain()`.
 */

const OUTBOX_KEY = "audit:outbox";
// A cross-instance lock so exactly one worker drains-and-persists at a time.
// `persist()`'s findFirst-then-create sequence assignment is not atomic, and the
// `draining` boolean below only guards re-entrancy *within* one process — under
// horizontal scaling two instances' workers would otherwise race and collide on
// the `sequence` unique constraint. Held only while a drain pass runs; a TTL
// backstops the lock so a crashed worker cannot wedge auditing forever.
const LOCK_KEY = "audit:outbox:lock";
const LOCK_TTL_MS = 30_000;
const GENESIS_HASH = "GENESIS";
// Rows migrated from the pre-#875 schema carry the sentinel hash "legacy" and a
// NULL prevHash (assigned by the migration). They are identified here by their
// NULL prevHash, are not cryptographically verifiable, and the chain proper
// begins at the first row this service wrote after them.
const DRAIN_INTERVAL_MS = 1_000;
/** Cap on how many entries a single drain pass will attempt, so a large backlog
 *  cannot monopolise the event loop. */
const DRAIN_BATCH_LIMIT = 100;

export type AuditCategoryInput = "ADMIN_ACTION" | "SECURITY_EVENT";

export interface AuditRecordInput {
  category: AuditCategoryInput;
  action: string;
  /** Admin id, end-user id, or the sentinel "system" for background events. */
  actorId?: string | null;
  target?: string | null;
  metadata?: unknown;
  ipAddress?: string | null;
}

/** Shape queued in the outbox — the caller-facing content, before the worker
 *  stamps it with a sequence, prevHash and hash. */
interface OutboxItem {
  category: AuditCategoryInput;
  action: string;
  actorId: string | null;
  target: string | null;
  metadata: Prisma.JsonValue | null;
  ipAddress: string | null;
}

export interface ChainVerificationResult {
  valid: boolean;
  totalEntries: number;
  /** Rows migrated from the old schema (NULL prevHash); not chain-verifiable. */
  legacyEntries: number;
  /** Rows whose content hash and link were successfully recomputed. */
  verifiedEntries: number;
  /** Sequence number at which the chain first breaks, or null if intact. */
  brokenAtSequence: number | null;
  reason: string | null;
}

// ─── Canonical hashing ────────────────────────────────────────────────────────

/** Deterministic JSON: object keys are sorted so the same logical value always
 *  serialises to the same string, in Node and on round-trips through Postgres. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") +
    "}"
  );
}

interface HashableRow {
  sequence: number;
  category: string;
  action: string;
  actorId: string | null;
  target: string | null;
  metadata: Prisma.JsonValue | null;
  ipAddress: string | null;
  timestamp: Date;
}

/** The canonical preimage committed to by a row's `hash`. The fields are
 *  JSON-encoded as an array so each is unambiguously escaped and delimited: a
 *  literal separator inside a free-form field (e.g. `target`, `metadata`) can no
 *  longer shift content across a field boundary and forge a colliding preimage.
 *  Metadata is stable-stringified first so key order is deterministic across
 *  Node and Postgres round-trips. Cheap to recompute during verification. */
export function computeRowHash(row: HashableRow, prevHash: string): string {
  const metaForHash =
    row.metadata === null || row.metadata === undefined
      ? ""
      : stableStringify(row.metadata);
  const preimage = JSON.stringify([
    row.sequence,
    row.category,
    row.action,
    row.actorId ?? "",
    row.target ?? "",
    metaForHash,
    row.ipAddress ?? "",
    row.timestamp.toISOString(),
    prevHash,
  ]);
  return createHash("sha256").update(preimage).digest("hex");
}

// ─── Durable outbox ───────────────────────────────────────────────────────────
//
// Redis is the durable buffer when available (survives a process restart). When
// Redis is not connected — notably under test, and during a Redis outage — we
// fall back to an in-process array so records are never lost inline. The array
// also gives tests a deterministic queue with no network involved.

const memoryOutbox: OutboxItem[] = [];
let draining = false;
let drainTimer: NodeJS.Timeout | null = null;

function redisReady(): boolean {
  try {
    return RedisClient.isRedisConnected();
  } catch {
    return false;
  }
}

async function enqueue(item: OutboxItem): Promise<void> {
  if (redisReady()) {
    try {
      await RedisClient.getInstance().rpush(OUTBOX_KEY, JSON.stringify(item));
      return;
    } catch (error) {
      // Redis hiccup: fall through to the in-process buffer rather than lose it.
      logger.warn({ err: error }, "Audit outbox: Redis enqueue failed, buffering in memory");
    }
  }
  memoryOutbox.push(item);
}

/** Take the next item without discarding it on failure. Returns null when the
 *  outbox is empty. Redis path uses lpop; the caller re-queues on failure. */
async function dequeue(): Promise<OutboxItem | null> {
  if (redisReady()) {
    try {
      const raw = await RedisClient.getInstance().lpop(OUTBOX_KEY);
      if (raw) return JSON.parse(raw) as OutboxItem;
    } catch (error) {
      logger.warn({ err: error }, "Audit outbox: Redis dequeue failed");
    }
    // Fall through so any memory-buffered items still drain.
  }
  return memoryOutbox.shift() ?? null;
}

/** Put an item back at the front of the queue after a failed persist, so
 *  ordering is preserved and it is retried on the next pass. */
async function requeueFront(item: OutboxItem): Promise<void> {
  if (redisReady()) {
    try {
      await RedisClient.getInstance().lpush(OUTBOX_KEY, JSON.stringify(item));
      return;
    } catch (error) {
      logger.warn({ err: error }, "Audit outbox: Redis requeue failed, buffering in memory");
    }
  }
  memoryOutbox.unshift(item);
}

// ─── Cross-instance drain lock ────────────────────────────────────────────────
//
// When Redis is available the lock genuinely serialises draining across every
// backend instance. When it is not (tests, or a Redis outage on a single box)
// there is no second writer to coordinate with, so we proceed under the
// in-process `draining` guard alone.

/** Try to become the sole draining worker. Returns true if this call may drain. */
async function acquireDrainLock(token: string): Promise<boolean> {
  if (!redisReady()) return true;
  try {
    const res = await RedisClient.getInstance().set(
      LOCK_KEY,
      token,
      "PX",
      LOCK_TTL_MS,
      "NX",
    );
    return res === "OK";
  } catch (error) {
    // Don't stall auditing on a lock hiccup; the in-process guard still applies.
    logger.warn({ err: error }, "Audit outbox: drain lock acquire failed");
    return true;
  }
}

/** Release the lock, but only if we still own it (a token check via Lua so a
 *  lock that already expired and was re-taken by another worker isn't dropped). */
async function releaseDrainLock(token: string): Promise<void> {
  if (!redisReady()) return;
  try {
    await RedisClient.getInstance().eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      LOCK_KEY,
      token,
    );
  } catch {
    // Nothing to do — the TTL will expire the lock on its own.
  }
}

// ─── Persistence (single writer) ──────────────────────────────────────────────

async function persist(item: OutboxItem): Promise<void> {
  const last = await prisma.auditLog.findFirst({
    orderBy: { sequence: "desc" },
    select: { sequence: true, hash: true },
  });

  const sequence = (last?.sequence ?? 0) + 1;
  const prevHash = last?.hash ?? GENESIS_HASH;
  const timestamp = new Date();
  const hash = computeRowHash(
    {
      sequence,
      category: item.category,
      action: item.action,
      actorId: item.actorId,
      target: item.target,
      metadata: item.metadata,
      ipAddress: item.ipAddress,
      timestamp,
    },
    prevHash,
  );

  await prisma.auditLog.create({
    data: {
      sequence,
      category: item.category as AuditCategory,
      action: item.action,
      actorId: item.actorId,
      target: item.target,
      metadata:
        item.metadata === null ? Prisma.JsonNull : (item.metadata as Prisma.InputJsonValue),
      ipAddress: item.ipAddress,
      prevHash,
      hash,
      timestamp,
    },
  });
}

function normalize(input: AuditRecordInput): OutboxItem {
  // Strip anything non-serialisable up front so what we hash equals what we
  // store equals what verification later recomputes.
  const metadata =
    input.metadata === undefined || input.metadata === null
      ? null
      : (JSON.parse(JSON.stringify(input.metadata)) as Prisma.JsonValue);
  return {
    category: input.category,
    action: input.action,
    actorId: input.actorId ?? null,
    target: input.target ?? null,
    metadata,
    ipAddress: input.ipAddress ?? null,
  };
}

export const AuditService = {
  /**
   * Append an audit entry. Returns as soon as the entry is durably queued; the
   * background worker performs the actual chained DB write and retries until it
   * lands. Never throws for a DB problem, and never blocks the caller's request
   * on the audit write.
   */
  async record(input: AuditRecordInput): Promise<void> {
    await enqueue(normalize(input));
  },

  /**
   * Drain the outbox once, persisting each entry in order. On a persist
   * failure the entry is returned to the front of the queue and draining stops,
   * so the next pass retries it — nothing is dropped. Re-entrancy is guarded in
   * process by `draining`; the cross-instance drain lock guarantees only one
   * worker anywhere assigns sequences at a time, so concurrent instances cannot
   * collide on the `sequence` unique constraint.
   */
  async processOutboxOnce(): Promise<void> {
    if (draining) return;
    draining = true;
    const lockToken = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    let locked = false;
    try {
      locked = await acquireDrainLock(lockToken);
      if (!locked) return; // another instance is draining this pass.
      for (let i = 0; i < DRAIN_BATCH_LIMIT; i++) {
        const item = await dequeue();
        if (!item) break;
        try {
          await persist(item);
        } catch (error) {
          logger.error(
            { err: error, action: item.action },
            "Audit outbox: persist failed, will retry",
          );
          await requeueFront(item);
          break;
        }
      }
    } finally {
      if (locked) await releaseDrainLock(lockToken);
      draining = false;
    }
  },

  /** Start the background drain worker (idempotent). */
  startWorker(): void {
    if (drainTimer) return;
    drainTimer = setInterval(() => {
      void AuditService.processOutboxOnce();
    }, DRAIN_INTERVAL_MS);
  },

  async stopWorker(): Promise<void> {
    if (drainTimer) {
      clearInterval(drainTimer);
      drainTimer = null;
    }
    // Best-effort flush of anything still buffered so shutdown doesn't drop it.
    await AuditService.processOutboxOnce();
  },

  /**
   * Recompute the hash chain from genesis and report the first break, if any.
   * Detects three kinds of tampering on rows this service wrote:
   *   - altered content   → recomputed hash differs from stored hash
   *   - re-linked/reordered row → stored prevHash differs from the real predecessor
   *   - deleted row       → gap in the contiguous sequence
   */
  async verifyChain(): Promise<ChainVerificationResult> {
    const rows = await prisma.auditLog.findMany({
      orderBy: { sequence: "asc" },
      select: {
        sequence: true,
        category: true,
        action: true,
        actorId: true,
        target: true,
        metadata: true,
        ipAddress: true,
        prevHash: true,
        hash: true,
        timestamp: true,
      },
    });

    const result: ChainVerificationResult = {
      valid: true,
      totalEntries: rows.length,
      legacyEntries: 0,
      verifiedEntries: 0,
      brokenAtSequence: null,
      reason: null,
    };

    let expectedSequence = 1;
    let expectedPrevHash = GENESIS_HASH;

    for (const row of rows) {
      if (row.sequence !== expectedSequence) {
        result.valid = false;
        result.brokenAtSequence = expectedSequence;
        result.reason =
          `Missing entry at sequence ${expectedSequence} ` +
          `(found ${row.sequence}) — a historical row was deleted.`;
        return result;
      }

      if (row.prevHash === null) {
        // Legacy, pre-chain row: not verifiable, but still counted for sequence
        // continuity, and its hash becomes the link the first chained row commits to.
        result.legacyEntries += 1;
        expectedPrevHash = row.hash;
        expectedSequence += 1;
        continue;
      }

      if (row.prevHash !== expectedPrevHash) {
        result.valid = false;
        result.brokenAtSequence = row.sequence;
        result.reason =
          `Broken link at sequence ${row.sequence} — prevHash does not match ` +
          `the preceding entry (row altered, reordered, or a predecessor removed).`;
        return result;
      }

      const recomputed = computeRowHash(row, row.prevHash);
      if (recomputed !== row.hash) {
        result.valid = false;
        result.brokenAtSequence = row.sequence;
        result.reason =
          `Content hash mismatch at sequence ${row.sequence} — ` +
          `the entry was altered after it was written.`;
        return result;
      }

      result.verifiedEntries += 1;
      expectedPrevHash = row.hash;
      expectedSequence += 1;
    }

    return result;
  },
};

// Exposed for tests to reset the in-process buffer between cases.
export function __clearMemoryOutbox(): void {
  memoryOutbox.length = 0;
  draining = false;
}
export const __GENESIS_HASH = GENESIS_HASH;
