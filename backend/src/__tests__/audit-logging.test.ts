/**
 * Tests for the unified, tamper-evident audit trail (issue #875).
 *
 * Covers:
 *  - Guaranteed write: a transient DB failure during an admin action does not
 *    silently drop the audit entry — the outbox retries until it lands.
 *  - Security events (virus scanner / blocked uploads) are actually persisted
 *    to the DB, not merely logged to pino.
 *  - Tamper detection: altering or deleting a historical row breaks the chain
 *    and is flagged by verifyChain(), while an untampered chain verifies clean.
 *  - The admin query/verify API returns filtered entries and chain status.
 */

// ─── Prisma mock ─────────────────────────────────────────────────────────────
type MockPrismaClient = {
  auditLog: {
    findFirst: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    count: jest.Mock;
  };
  user: {
    findUnique: jest.Mock;
  };
  $disconnect: jest.Mock;
};

jest.mock("@prisma/client", () => {
  const mockPrisma: MockPrismaClient = {
    auditLog: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      count: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
    $disconnect: jest.fn(),
  };
  return {
    PrismaClient: jest.fn(() => mockPrisma),
    Prisma: { JsonNull: "JsonNull" },
    UserRole: { CLIENT: "CLIENT", FREELANCER: "FREELANCER", ADMIN: "ADMIN" },
    DisputeStatus: { OPEN: "OPEN", IN_PROGRESS: "IN_PROGRESS", RESOLVED: "RESOLVED" },
  };
});

// ─── JWT / auth mock (for the route tests) ────────────────────────────────────
jest.mock("jsonwebtoken", () => ({
  verify: jest.fn().mockReturnValue({ userId: "admin-user-id" }),
  sign: jest.fn().mockReturnValue("mock-token"),
}));

// ─── Config mock (jwtSecret needed by requireAdmin) ───────────────────────────
jest.mock("../config", () => ({
  config: {
    jwtSecret: "test-secret",
    stellar: {
      rpcUrl: "https://soroban-testnet.stellar.org",
      escrowContractId: "",
      disputeContractId: "",
      reputationContractId: "",
    },
    smtp: { host: "smtp.test", port: 587, user: "", pass: "", from: "noreply@test.io" },
  },
}));

jest.mock("../services/notification.service", () => ({
  NotificationService: { sendNotification: jest.fn().mockResolvedValue(undefined) },
}));

import { PrismaClient } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import express from "express";
import request from "supertest";
import {
  AuditService,
  computeRowHash,
  __clearMemoryOutbox,
  __GENESIS_HASH,
} from "../services/audit.service";
import { auditLogger } from "../utils/auditLogger";
import adminRouter from "../routes/admin";

const prismaMock = new PrismaClient() as unknown as MockPrismaClient;

beforeEach(() => {
  jest.clearAllMocks();
  __clearMemoryOutbox();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a genuinely-chained set of rows the way the outbox worker would. */
function buildChain(
  entries: Array<{
    category: "ADMIN_ACTION" | "SECURITY_EVENT";
    action: string;
    actorId?: string | null;
    target?: string | null;
    metadata?: Prisma.JsonValue | null;
    ipAddress?: string | null;
  }>,
) {
  let prevHash = __GENESIS_HASH;
  let sequence = 1;
  return entries.map((e, i) => {
    const base = {
      sequence,
      category: e.category,
      action: e.action,
      actorId: e.actorId ?? null,
      target: e.target ?? null,
      metadata: e.metadata ?? null,
      ipAddress: e.ipAddress ?? null,
      timestamp: new Date(`2026-07-2${i}T00:00:00.000Z`),
    };
    const hash = computeRowHash(base, prevHash);
    const row = { id: `row-${sequence}`, ...base, prevHash, hash };
    prevHash = hash;
    sequence += 1;
    return row;
  });
}

// ─── Guaranteed write via the outbox ──────────────────────────────────────────

describe("AuditService — guaranteed write", () => {
  it("retries until the audit entry lands after a transient DB failure", async () => {
    prismaMock.auditLog.findFirst.mockResolvedValue(null); // genesis
    prismaMock.auditLog.create
      .mockRejectedValueOnce(new Error("connection reset")) // DB blip
      .mockResolvedValue({});

    // Admin action's audit record is enqueued (never written inline).
    await AuditService.record({
      category: "ADMIN_ACTION",
      action: "SUSPEND_USER",
      actorId: "admin-1",
      target: "user-9",
      metadata: { reason: "spam" },
    });

    // First drain: the write fails and the entry is re-queued, not lost.
    await AuditService.processOutboxOnce();
    expect(prismaMock.auditLog.create).toHaveBeenCalledTimes(1);

    // Second drain: the retry succeeds.
    await AuditService.processOutboxOnce();
    expect(prismaMock.auditLog.create).toHaveBeenCalledTimes(2);

    const persisted = prismaMock.auditLog.create.mock.calls[1][0].data;
    expect(persisted).toMatchObject({
      sequence: 1,
      category: "ADMIN_ACTION",
      action: "SUSPEND_USER",
      actorId: "admin-1",
      target: "user-9",
      prevHash: __GENESIS_HASH,
    });
    expect(typeof persisted.hash).toBe("string");
    expect(persisted.hash).toHaveLength(64); // sha256 hex

    // Nothing left in the outbox — no duplicate write on a further drain.
    await AuditService.processOutboxOnce();
    expect(prismaMock.auditLog.create).toHaveBeenCalledTimes(2);
  });

  it("assigns a contiguous sequence and chains to the previous row's hash", async () => {
    prismaMock.auditLog.findFirst.mockResolvedValue({ sequence: 41, hash: "abc123" });
    prismaMock.auditLog.create.mockResolvedValue({});

    await AuditService.record({ category: "ADMIN_ACTION", action: "DELETE_JOB", actorId: "a" });
    await AuditService.processOutboxOnce();

    const data = prismaMock.auditLog.create.mock.calls[0][0].data;
    expect(data.sequence).toBe(42);
    expect(data.prevHash).toBe("abc123");
  });
});

// ─── Security events are persisted ────────────────────────────────────────────

describe("auditLogger.log — security events reach the database", () => {
  it("persists a blocked-upload event through the unified table", async () => {
    prismaMock.auditLog.findFirst.mockResolvedValue(null);
    prismaMock.auditLog.create.mockResolvedValue({});

    auditLogger.log({
      action: "INFECTED_FILE_UPLOAD_BLOCKED",
      userId: "user-7",
      details: { filename: "evil.pdf", viruses: ["Eicar-Test"] },
      ipAddress: "203.0.113.5",
    });

    await AuditService.processOutboxOnce();

    expect(prismaMock.auditLog.create).toHaveBeenCalledTimes(1);
    const data = prismaMock.auditLog.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      category: "SECURITY_EVENT",
      action: "INFECTED_FILE_UPLOAD_BLOCKED",
      actorId: "user-7",
      ipAddress: "203.0.113.5",
    });
    expect(data.metadata).toEqual({ filename: "evil.pdf", viruses: ["Eicar-Test"] });
  });
});

// ─── Tamper detection ─────────────────────────────────────────────────────────

describe("AuditService.verifyChain — tamper detection", () => {
  it("verifies an untampered chain as valid", async () => {
    const rows = buildChain([
      { category: "ADMIN_ACTION", action: "SUSPEND_USER", actorId: "a1", target: "u1" },
      { category: "SECURITY_EVENT", action: "VIRUS_DETECTED", actorId: "system" },
      { category: "ADMIN_ACTION", action: "DELETE_JOB", actorId: "a1", target: "j1" },
    ]);
    prismaMock.auditLog.findMany.mockResolvedValue(rows);

    const result = await AuditService.verifyChain();
    expect(result.valid).toBe(true);
    expect(result.verifiedEntries).toBe(3);
    expect(result.brokenAtSequence).toBeNull();
  });

  it("flags an altered historical row", async () => {
    const rows = buildChain([
      { category: "ADMIN_ACTION", action: "SUSPEND_USER", actorId: "a1", target: "u1" },
      { category: "ADMIN_ACTION", action: "DELETE_JOB", actorId: "a1", target: "j1" },
      { category: "ADMIN_ACTION", action: "RESTORE_JOB", actorId: "a1", target: "j1" },
    ]);
    // Tamper: rewrite row 2's target but leave its stored hash untouched.
    rows[1].target = "j-999";
    prismaMock.auditLog.findMany.mockResolvedValue(rows);

    const result = await AuditService.verifyChain();
    expect(result.valid).toBe(false);
    expect(result.brokenAtSequence).toBe(2);
    expect(result.reason).toMatch(/hash mismatch/i);
  });

  it("flags a deleted historical row via the sequence gap", async () => {
    const rows = buildChain([
      { category: "ADMIN_ACTION", action: "SUSPEND_USER", actorId: "a1" },
      { category: "ADMIN_ACTION", action: "DELETE_JOB", actorId: "a1" },
      { category: "ADMIN_ACTION", action: "RESTORE_JOB", actorId: "a1" },
    ]);
    // Delete the middle row (sequence 2).
    const withGap = [rows[0], rows[2]];
    prismaMock.auditLog.findMany.mockResolvedValue(withGap);

    const result = await AuditService.verifyChain();
    expect(result.valid).toBe(false);
    expect(result.brokenAtSequence).toBe(2);
    expect(result.reason).toMatch(/deleted/i);
  });

  it("does not let a separator inside a field forge a colliding hash", async () => {
    // Two logically distinct rows that would share one preimage under naive
    // separator-joining: ("a", "b|c") vs ("a|b", "c"). Proper encoding must keep
    // their hashes distinct, or an attacker could swap one for the other unseen.
    const base = {
      sequence: 1,
      category: "ADMIN_ACTION" as const,
      actorId: null,
      metadata: null,
      ipAddress: null,
      timestamp: new Date("2026-07-20T00:00:00.000Z"),
    };
    const rowA = computeRowHash({ ...base, action: "a", target: "b|c" }, __GENESIS_HASH);
    const rowB = computeRowHash({ ...base, action: "a|b", target: "c" }, __GENESIS_HASH);
    expect(rowA).not.toBe(rowB);
  });

  it("treats leading legacy (pre-chain) rows as unverifiable but still chains new rows", async () => {
    // A legacy row (NULL prevHash, sentinel hash) followed by a real chained row
    // whose prevHash links to the legacy row's hash.
    const legacy = {
      id: "legacy-1",
      sequence: 1,
      category: "ADMIN_ACTION",
      action: "OLD_ACTION",
      actorId: "a0",
      target: null,
      metadata: null,
      ipAddress: null,
      timestamp: new Date("2026-07-01T00:00:00.000Z"),
      prevHash: null,
      hash: "legacy",
    };
    const chainedBase = {
      sequence: 2,
      category: "ADMIN_ACTION" as const,
      action: "SUSPEND_USER",
      actorId: "a1",
      target: "u1",
      metadata: null,
      ipAddress: null,
      timestamp: new Date("2026-07-02T00:00:00.000Z"),
    };
    const chainedHash = computeRowHash(chainedBase, "legacy");
    const chained = { id: "row-2", ...chainedBase, prevHash: "legacy", hash: chainedHash };

    prismaMock.auditLog.findMany.mockResolvedValue([legacy, chained]);

    const result = await AuditService.verifyChain();
    expect(result.valid).toBe(true);
    expect(result.legacyEntries).toBe(1);
    expect(result.verifiedEntries).toBe(1);
  });
});

// ─── Admin query / verify API ─────────────────────────────────────────────────

describe("Admin audit-log API", () => {
  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api/admin", adminRouter);
    return app;
  }

  function asAdmin(req: request.Test): request.Test {
    prismaMock.user.findUnique.mockResolvedValueOnce({ role: "ADMIN", deletedAt: null });
    return req.set("Authorization", "Bearer mock-admin-token");
  }

  it("GET /audit-logs returns filtered, paginated entries", async () => {
    const rows = buildChain([
      { category: "SECURITY_EVENT", action: "VIRUS_DETECTED", actorId: "system" },
    ]);
    prismaMock.auditLog.findMany.mockResolvedValue(rows);
    prismaMock.auditLog.count.mockResolvedValue(1);

    const res = await asAdmin(
      request(buildApp()).get("/api/admin/audit-logs?category=SECURITY_EVENT&limit=10"),
    );

    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.pagination).toMatchObject({ total: 1, page: 1, limit: 10 });
    expect(prismaMock.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { category: "SECURITY_EVENT" } }),
    );
  });

  it("GET /audit-logs/verify returns 200 for an intact chain", async () => {
    const rows = buildChain([
      { category: "ADMIN_ACTION", action: "SUSPEND_USER", actorId: "a1" },
    ]);
    prismaMock.auditLog.findMany.mockResolvedValue(rows);

    const res = await asAdmin(request(buildApp()).get("/api/admin/audit-logs/verify"));
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });

  it("GET /audit-logs/verify returns 409 when the chain is broken", async () => {
    const rows = buildChain([
      { category: "ADMIN_ACTION", action: "SUSPEND_USER", actorId: "a1" },
      { category: "ADMIN_ACTION", action: "DELETE_JOB", actorId: "a1" },
    ]);
    rows[1].action = "TAMPERED";
    prismaMock.auditLog.findMany.mockResolvedValue(rows);

    const res = await asAdmin(request(buildApp()).get("/api/admin/audit-logs/verify"));
    expect(res.status).toBe(409);
    expect(res.body.valid).toBe(false);
    expect(res.body.brokenAtSequence).toBe(2);
  });
});
