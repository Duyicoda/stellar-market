import crypto from "crypto";
import {
  FakeEvidenceObjectStore,
  FakeRedisStore,
} from "./testUtils/evidenceSessionFakes";

const fakeRedis = new FakeRedisStore();
const fakeStore = new FakeEvidenceObjectStore();

jest.mock("../lib/redis", () => ({
  __esModule: true,
  default: { getInstance: () => fakeRedis },
}));

jest.mock("../services/evidence-storage.service", () => ({
  uploadEvidenceBuffer: jest.fn(async ({ key, body }: { key: string; body: Buffer }) => {
    fakeStore.put(key, body);
  }),
  readEvidenceObject: jest.fn(async (key: string) => fakeStore.get(key)),
  deleteEvidenceObjects: jest.fn(async (keys: string[]) => {
    fakeStore.delete(keys);
  }),
}));

import {
  validateInitiateInput,
  initiateSession,
  saveChunk,
  assembleAndVerify,
  cleanupSession,
  getSession,
  getReceivedChunks,
  deriveSessionId,
  CHUNK_SIZE,
  MIN_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
  MAX_TOTAL_CHUNKS,
} from "../services/evidence-upload-session.service";

describe("Evidence Upload Session Service", () => {
  afterEach(() => {
    fakeRedis.clear();
    fakeStore.clear();
  });

  describe("validateInitiateInput", () => {
    const validInput = {
      size: 5 * 1024 * 1024,
      chunkSize: CHUNK_SIZE,
      totalChunks: 3,
      sha256: "a".repeat(64),
    };

    it("should accept valid input", () => {
      expect(validateInitiateInput(validInput)).toBeNull();
    });

    it("should reject invalid sha256", () => {
      expect(validateInitiateInput({ ...validInput, sha256: "short" })).toBe("sha256 must be a 64-character hex digest");
    });

    it("should reject invalid size", () => {
      expect(validateInitiateInput({ ...validInput, size: -1 })).toBe("size must be a non-negative integer");
      expect(validateInitiateInput({ ...validInput, size: 10 * 1024 * 1024 + 1 })).toBe("File exceeds the maximum allowed size");
    });

    it("should reject invalid chunkSize", () => {
      expect(validateInitiateInput({ ...validInput, chunkSize: MIN_CHUNK_SIZE - 1 })).toBe(`chunkSize must be an integer >= ${MIN_CHUNK_SIZE}`);
      expect(validateInitiateInput({ ...validInput, chunkSize: MAX_CHUNK_SIZE + 1 })).toBe("chunkSize exceeds the maximum allowed");
    });

    it("should reject invalid totalChunks", () => {
      expect(validateInitiateInput({ ...validInput, totalChunks: -1 })).toBe("totalChunks must be a positive integer");
      expect(validateInitiateInput({ ...validInput, totalChunks: MAX_TOTAL_CHUNKS + 1 })).toBe("Too many chunks");
    });

    it("should reject mismatched chunks", () => {
      expect(validateInitiateInput({ ...validInput, totalChunks: 5 })).toBe("totalChunks is inconsistent with size and chunkSize");
    });
  });

  describe("Session Lifecycle", () => {
    const input = {
      disputeId: "dispute123",
      uploaderId: "user123",
      originalName: "test.mp4",
      sha256: "a".repeat(64),
      size: CHUNK_SIZE + 1024,
      mimeType: "video/mp4",
      chunkSize: CHUNK_SIZE,
      totalChunks: 2,
      createdAt: new Date().toISOString(),
    };

    it("should initiate session idempotently", async () => {
      const result1 = await initiateSession(input);
      const sessionId = result1.sessionId;
      expect(result1.manifest.disputeId).toBe(input.disputeId);

      const result2 = await initiateSession(input);
      expect(result2.sessionId).toBe(sessionId);
      expect(result2.receivedChunks).toEqual([]);
    });

    it("should wipe session on identity mismatch", async () => {
      const { sessionId } = await initiateSession(input);
      const mismatchedInput = { ...input, size: CHUNK_SIZE + 2048 };

      // Same (disputeId, uploaderId, sha256) => same derived id, different identity.
      const result = await initiateSession(mismatchedInput);
      expect(result.sessionId).toBe(sessionId);
      expect(result.manifest.size).toBe(mismatchedInput.size);
    });

    it("should validate chunk sizes and indexes", async () => {
      const { sessionId } = await initiateSession(input);
      const data = Buffer.alloc(CHUNK_SIZE);

      await expect(saveChunk(sessionId, 5, data)).rejects.toThrow("Chunk index out of range");
      await expect(saveChunk(sessionId, 0, Buffer.alloc(MAX_CHUNK_SIZE + 1))).rejects.toThrow(
        "Chunk larger than declared chunkSize",
      );
      await expect(saveChunk(sessionId, 0, Buffer.alloc(CHUNK_SIZE - 1))).rejects.toThrow(
        "Non-final chunk must be exactly chunkSize bytes",
      );
    });

    it("should save valid chunks and persist chunk bytes in the object store", async () => {
      const { sessionId } = await initiateSession(input);

      const chunk0 = Buffer.alloc(CHUNK_SIZE, "0");
      const result0 = await saveChunk(sessionId, 0, chunk0);
      expect(result0.receivedChunks).toEqual([0]);

      const chunk1 = Buffer.alloc(1024, "1");
      const result1 = await saveChunk(sessionId, 1, chunk1);
      expect(result1.receivedChunks).toEqual([0, 1]);

      expect(await getReceivedChunks(sessionId)).toEqual([0, 1]);
    });

    it("re-saving an already-stored chunk is idempotent", async () => {
      const { sessionId } = await initiateSession(input);
      const chunk0 = Buffer.alloc(CHUNK_SIZE, "0");

      await saveChunk(sessionId, 0, chunk0);
      const result = await saveChunk(sessionId, 0, chunk0);
      expect(result.receivedChunks).toEqual([0]);
    });

    it("should reject a chunk for a session that doesn't exist", async () => {
      const bogusId = "0".repeat(64);
      await expect(saveChunk(bogusId, 0, Buffer.alloc(CHUNK_SIZE))).rejects.toThrow("Session not found");
    });

    it("should assemble and verify (verified: false on hash mismatch)", async () => {
      const chunk0 = Buffer.alloc(CHUNK_SIZE, "0");
      const chunk1 = Buffer.alloc(1024, "1");
      const actualSha256 = crypto.createHash("sha256").update(Buffer.concat([chunk0, chunk1])).digest("hex");
      const declaredWrongSha256 = "b".repeat(64);

      const { sessionId } = await initiateSession({ ...input, sha256: declaredWrongSha256 });
      await saveChunk(sessionId, 0, chunk0);
      await saveChunk(sessionId, 1, chunk1);

      const assembled = await assembleAndVerify(sessionId);
      expect(assembled.verified).toBe(false);
      expect(assembled.computedSha256).toBe(actualSha256);
    });

    it("should assemble and verify (verified: true on match)", async () => {
      const chunk0 = Buffer.alloc(CHUNK_SIZE, "0");
      const chunk1 = Buffer.alloc(1024, "1");
      const realSha256 = crypto.createHash("sha256").update(Buffer.concat([chunk0, chunk1])).digest("hex");

      const { sessionId } = await initiateSession({ ...input, sha256: realSha256 });
      await saveChunk(sessionId, 0, chunk0);
      await saveChunk(sessionId, 1, chunk1);

      const assembled = await assembleAndVerify(sessionId);
      expect(assembled.verified).toBe(true);
      expect(assembled.computedSha256).toBe(realSha256);
    });

    it("should reject assembly while a chunk is still missing", async () => {
      const { sessionId } = await initiateSession(input);
      await saveChunk(sessionId, 0, Buffer.alloc(CHUNK_SIZE));
      await expect(assembleAndVerify(sessionId)).rejects.toThrow("Missing chunk 1");
    });

    it("should cleanup a session's manifest, chunk index, and object-store bytes", async () => {
      const { sessionId } = await initiateSession(input);
      await saveChunk(sessionId, 0, Buffer.alloc(CHUNK_SIZE));

      expect(await getSession(sessionId)).not.toBeNull();

      await cleanupSession(sessionId);

      expect(await getSession(sessionId)).toBeNull();
      expect(await getReceivedChunks(sessionId)).toEqual([]);
    });

    it("cleanupSession on a session that never existed is a no-op, not an error", async () => {
      const bogusId = "f".repeat(64);
      await expect(cleanupSession(bogusId)).resolves.toBeUndefined();
    });
  });

  describe("deriveSessionId", () => {
    it("is a pure function of (disputeId, uploaderId, sha256)", () => {
      const a = deriveSessionId("d1", "u1", "a".repeat(64));
      const b = deriveSessionId("d1", "u1", "a".repeat(64));
      const c = deriveSessionId("d1", "u1", "b".repeat(64));
      expect(a).toBe(b);
      expect(a).not.toBe(c);
    });
  });
});
