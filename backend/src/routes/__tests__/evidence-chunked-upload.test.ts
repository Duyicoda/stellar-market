import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { Buffer } from "buffer";
// Imported here (rather than required inside the jest.mock factory below) using
// jest's "mock"-prefixed variable exemption so the factory can reference them
// without violating the out-of-scope-variable restriction on jest.mock factories.
import * as mockJwt from "jsonwebtoken";
import {
  FakeEvidenceObjectStore,
  FakeRedisStore,
} from "../../__tests__/testUtils/evidenceSessionFakes";

// The session manifest/chunk-index state lives in Redis and chunk/assembled
// bytes live in the S3-compatible object store — both mocked below with
// stateful in-memory fakes, since this test exercises real resumability
// (partial upload -> status -> resume), which needs get/set/sadd/smembers to
// actually round-trip. jest.setup.ts's global ../lib/redis stub is stateless
// and doesn't implement sadd/srem/smembers at all, so it's overridden here.
process.env.EVIDENCE_S3_BUCKET = "test-bucket";

const fakeRedis = new FakeRedisStore();
const fakeStore = new FakeEvidenceObjectStore();

jest.mock("../../lib/redis", () => ({
  __esModule: true,
  default: { getInstance: () => fakeRedis },
}));

// `config` is a top-level singleton evaluated at module-load time from
// process.env — it must be required (not statically imported, which ES
// import hoisting would run before the env vars above are set) after the
// env vars are in place.
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const { config: mockAuthConfig } = require("../../config") as typeof import("../../config");

jest.mock("@prisma/client", () => {
  const mockPrisma = {
    job: {
      findUnique: jest
        .fn()
        .mockResolvedValue({
          id: "job-123",
          clientId: "00000000-0000-4000-8000-000000000001",
          freelancerId: "2",
        }),
    },
    dispute: {
      findUnique: jest.fn().mockImplementation((args) =>
        Promise.resolve({
          id: args?.where?.id ?? "dispute-1",
          clientId: "00000000-0000-4000-8000-000000000001",
          freelancerId: "2",
          initiatorId: "2",
        }),
      ),
    },
    disputeVote: { findMany: jest.fn().mockResolvedValue([]) },
    disputeEvent: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: "evt-1" }),
    },
    attachment: {
      create: jest.fn().mockImplementation((args) =>
        Promise.resolve({ id: "att-123", ...args.data }),
      ),
    },
    user: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ role: "CLIENT", emailVerified: true }),
    },
  };
  return {
    PrismaClient: jest.fn(() => mockPrisma),
    DisputeEventType: { EVIDENCE_SUBMITTED: "EVIDENCE_SUBMITTED" },
  };
});

jest.mock("../../services/evidence-storage.service", () => {
  const actual = jest.requireActual("../../services/evidence-storage.service");
  return {
    ...actual,
    uploadEvidenceObject: jest.fn().mockResolvedValue(undefined),
    uploadEvidenceBuffer: jest.fn(async ({ key, body }: { key: string; body: Buffer }) => {
      fakeStore.put(key, body);
    }),
    readEvidenceObject: jest.fn(async (key: string) => fakeStore.get(key)),
    deleteEvidenceObjects: jest.fn(async (keys: string[]) => {
      fakeStore.delete(keys);
    }),
  };
});

jest.mock("../../utils/fileValidation", () => ({
  validateFileMimeType: jest.fn().mockResolvedValue({
    valid: true,
    detectedType: "application/pdf",
  }),
  formatFileSize: jest.fn((bytes: number) => `${bytes} B`),
}));

jest.mock("../../utils/virusScanner", () => ({
  scanFile: jest.fn().mockResolvedValue({ isInfected: false, skipped: true }),
}));

jest.mock("../../utils/auditLogger", () => ({
  auditLogger: { log: jest.fn() },
}));

jest.mock("../../middleware/auth", () => {
  return {
    authenticate: jest.fn((req, res, next) => {
      const header = req.headers.authorization || "";
      const token = header.replace(/^Bearer\s+/i, "");
      try {
        const decoded = mockJwt.verify(token, mockAuthConfig.jwtSecret) as {
          userId: string;
        };
        req.userId = decoded.userId;
        req.userRole = "CLIENT";
      } catch {
        return res.status(401).json({ error: "Invalid token" });
      }
      next();
    }),
    requireAdmin: jest.fn((req, res, next) => next()),
  };
});

import disputeRouter from "../dispute.routes";

const app = express();
app.use(express.json());
app.use("/api/disputes", disputeRouter);

const CLIENT_ID = "00000000-0000-4000-8000-000000000001";
function authHeader(userId = CLIENT_ID) {
  const token = jwt.sign({ userId }, mockAuthConfig.jwtSecret, { expiresIn: "1h" });
  return { Authorization: `Bearer ${token}` };
}

const CHUNK_SIZE = 2 * 1024 * 1024;

function makeFile(sizeBytes: number): Buffer {
  // Deterministic pseudo-random content so the test is reproducible.
  const buf = Buffer.alloc(sizeBytes);
  for (let i = 0; i < sizeBytes; i++) buf[i] = (i * 31 + 7) % 256;
  return buf;
}

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function chunkify(buf: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  for (let off = 0; off < buf.length; off += CHUNK_SIZE) {
    chunks.push(buf.subarray(off, off + CHUNK_SIZE));
  }
  if (chunks.length === 0) chunks.push(Buffer.alloc(0));
  return chunks;
}

describe("Chunked / resumable evidence upload", () => {
  it("uploads a multi-chunk file and records the server-verified hash", async () => {
    const buf = makeFile(CHUNK_SIZE + 1234); // 2 chunks
    const hash = sha256(buf);
    const chunks = chunkify(buf);

    const initRes = await request(app)
      .post("/api/disputes/dispute-1/evidence/sessions")
      .set(authHeader())
      .send({
        originalName: "proof.pdf",
        sha256: hash,
        size: buf.length,
        mimeType: "application/pdf",
        chunkSize: CHUNK_SIZE,
        totalChunks: chunks.length,
      });
    expect(initRes.status).toBe(200);
    const { sessionId, totalChunks, receivedChunks } = initRes.body;
    expect(totalChunks).toBe(chunks.length);
    expect(receivedChunks).toEqual([]);

    for (let i = 0; i < chunks.length; i++) {
      const put = await request(app)
        .put(
          `/api/disputes/dispute-1/evidence/sessions/${sessionId}/chunks/${i}`,
        )
        .set(authHeader())
        .set("Content-Type", "application/octet-stream")
        .send(chunks[i]);
      expect(put.status).toBe(200);
      expect(put.body.receivedChunks).toContain(i);
    }

    const complete = await request(app)
      .post(
        `/api/disputes/dispute-1/evidence/sessions/${sessionId}/complete`,
      )
      .set(authHeader());
    expect(complete.status).toBe(201);
    expect(complete.body.attachment.sha256).toBe(hash);
    expect(complete.body.attachment.size).toBe(buf.length);
  });

  it("resumes after a dropped connection: only remaining chunks are re-sent", async () => {
    const buf = makeFile(CHUNK_SIZE * 3 + 100); // 4 chunks
    const hash = sha256(buf);
    const chunks = chunkify(buf);

    const { body } = await request(app)
      .post("/api/disputes/dispute-2/evidence/sessions")
      .set(authHeader())
      .send({
        originalName: "big.zip",
        sha256: hash,
        size: buf.length,
        mimeType: "application/zip",
        chunkSize: CHUNK_SIZE,
        totalChunks: chunks.length,
      });
    const { sessionId } = body;

    // Simulate a drop: upload only chunks 0,1,2 then "lose connection".
    for (let i = 0; i < 3; i++) {
      const put = await request(app)
        .put(
          `/api/disputes/dispute-2/evidence/sessions/${sessionId}/chunks/${i}`,
        )
        .set(authHeader())
        .set("Content-Type", "application/octet-stream")
        .send(chunks[i]);
      expect(put.status).toBe(200);
    }

    const status = await request(app)
      .get(`/api/disputes/dispute-2/evidence/sessions/${sessionId}`)
      .set(authHeader());
    expect(status.status).toBe(200);
    expect(status.body.receivedChunks.sort((a: number, b: number) => a - b)).toEqual(
      [0, 1, 2],
    );

    // Re-initiate as the client would on reconnect: server returns the received set.
    const reinit = await request(app)
      .post("/api/disputes/dispute-2/evidence/sessions")
      .set(authHeader())
      .send({
        originalName: "big.zip",
        sha256: hash,
        size: buf.length,
        mimeType: "application/zip",
        chunkSize: CHUNK_SIZE,
        totalChunks: chunks.length,
      });
    expect(reinit.status).toBe(200);
    expect(reinit.body.sessionId).toBe(sessionId);
    expect(reinit.body.receivedChunks.sort((a: number, b: number) => a - b)).toEqual(
      [0, 1, 2],
    );

    // Send ONLY the missing chunk (index 3), not the whole file.
    const put = await request(app)
      .put(
        `/api/disputes/dispute-2/evidence/sessions/${sessionId}/chunks/3`,
      )
      .set(authHeader())
      .set("Content-Type", "application/octet-stream")
      .send(chunks[3]);
    expect(put.status).toBe(200);

    const complete = await request(app)
      .post(
        `/api/disputes/dispute-2/evidence/sessions/${sessionId}/complete`,
      )
      .set(authHeader());
    if (complete.status !== 201) console.log("COMPLETE BODY:", complete.status, JSON.stringify(complete.body));
    expect(complete.status).toBe(201);
    expect(complete.body.attachment.sha256).toBe(hash);
  });

  it("rejects completion when the assembled hash does not match the declared hash", async () => {
    const buf = makeFile(CHUNK_SIZE + 5);
    const chunks = chunkify(buf);
    const wrongHash =
      "deadbeef".repeat(8); // 64 hex chars, never the real hash

    const { body } = await request(app)
      .post("/api/disputes/dispute-3/evidence/sessions")
      .set(authHeader())
      .send({
        originalName: "corrupt.pdf",
        sha256: wrongHash,
        size: buf.length,
        mimeType: "application/pdf",
        chunkSize: CHUNK_SIZE,
        totalChunks: chunks.length,
      });
    const { sessionId } = body;

    for (let i = 0; i < chunks.length; i++) {
      await request(app)
        .put(
          `/api/disputes/dispute-3/evidence/sessions/${sessionId}/chunks/${i}`,
        )
        .set(authHeader())
        .set("Content-Type", "application/octet-stream")
        .send(chunks[i]);
    }

    const complete = await request(app)
      .post(
        `/api/disputes/dispute-3/evidence/sessions/${sessionId}/complete`,
      )
      .set(authHeader());
    expect(complete.status).toBe(422);
    expect(complete.body.error).toMatch(/integrity/i);

    // Session was cleaned up so a retry cannot silently record a bad file.
    const status = await request(app)
      .get(`/api/disputes/dispute-3/evidence/sessions/${sessionId}`)
      .set(authHeader());
    expect(status.status).toBe(404);
  });

  it("returns 404 on status of an unrecognised session", async () => {
    const res = await request(app)
      .get("/api/disputes/dispute-1/evidence/sessions/a".repeat(32))
      .set(authHeader());
    expect(res.status).toBe(404);
  });

  it("aborts a session and discards its partial chunks", async () => {
    const buf = makeFile(CHUNK_SIZE);
    const hash = sha256(buf);
    const chunks = chunkify(buf);

    const { body } = await request(app)
      .post("/api/disputes/dispute-4/evidence/sessions")
      .set(authHeader())
      .send({
        originalName: "partial.pdf",
        sha256: hash,
        size: buf.length,
        mimeType: "application/pdf",
        chunkSize: CHUNK_SIZE,
        totalChunks: chunks.length,
      });
    const { sessionId } = body;

    await request(app)
      .put(`/api/disputes/dispute-4/evidence/sessions/${sessionId}/chunks/0`)
      .set(authHeader())
      .set("Content-Type", "application/octet-stream")
      .send(chunks[0]);

    const del = await request(app)
      .delete(`/api/disputes/dispute-4/evidence/sessions/${sessionId}`)
      .set(authHeader());
    expect(del.status).toBe(200);
    expect(del.body.aborted).toBe(true);

    const status = await request(app)
      .get(`/api/disputes/dispute-4/evidence/sessions/${sessionId}`)
      .set(authHeader());
    expect(status.status).toBe(404);
  });
});
