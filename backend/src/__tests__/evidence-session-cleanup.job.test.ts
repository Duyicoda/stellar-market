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
  initiateSession,
  getSession,
  saveChunk,
} from "../services/evidence-upload-session.service";
import { sweepStaleSessions, SESSION_TTL_MS } from "../jobs/evidence-session-cleanup.job";

const OLD_CREATED_AT = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(); // 26 h ago
const NEW_CREATED_AT = new Date().toISOString(); // just now

function makeInput(overrides: Partial<{ sha256: string; createdAt: string }> = {}) {
  return {
    disputeId: "dispute-sweep-test",
    uploaderId: "user-sweep-test",
    originalName: "video.mp4",
    sha256: overrides.sha256 ?? "a".repeat(64),
    size: 1024,
    mimeType: "video/mp4",
    chunkSize: 1024,
    totalChunks: 1,
    createdAt: overrides.createdAt ?? NEW_CREATED_AT,
  };
}

describe("sweepStaleSessions", () => {
  afterEach(() => {
    fakeRedis.clear();
    fakeStore.clear();
  });

  it("removes a session older than the TTL that was never completed", async () => {
    const { sessionId } = await initiateSession(
      makeInput({ sha256: "1".repeat(64), createdAt: OLD_CREATED_AT }),
    );

    expect(await getSession(sessionId)).not.toBeNull();

    const cleaned = await sweepStaleSessions(new Date(), SESSION_TTL_MS);

    expect(cleaned).toBe(1);
    expect(await getSession(sessionId)).toBeNull();
  });

  it("does NOT remove a fresh session still within the TTL", async () => {
    const { sessionId } = await initiateSession(
      makeInput({ sha256: "2".repeat(64), createdAt: NEW_CREATED_AT }),
    );

    expect(await getSession(sessionId)).not.toBeNull();

    await sweepStaleSessions(new Date(), SESSION_TTL_MS);

    expect(await getSession(sessionId)).not.toBeNull();
  });

  it("removes the stale session while leaving the fresh one intact", async () => {
    const { sessionId: staleId } = await initiateSession(
      makeInput({ sha256: "3".repeat(64), createdAt: OLD_CREATED_AT }),
    );
    const { sessionId: freshId } = await initiateSession(
      makeInput({ sha256: "4".repeat(64), createdAt: NEW_CREATED_AT }),
    );

    await sweepStaleSessions(new Date(), SESSION_TTL_MS);

    expect(await getSession(staleId)).toBeNull();
    expect(await getSession(freshId)).not.toBeNull();
  });

  it("removes a stale session's chunk bytes from the object store too", async () => {
    const { sessionId } = await initiateSession(
      makeInput({ sha256: "5".repeat(64), createdAt: OLD_CREATED_AT }),
    );
    await saveChunk(sessionId, 0, Buffer.alloc(1024));
    expect(fakeStore.has(`evidence-sessions/${sessionId}/chunk_0`)).toBe(true);

    await sweepStaleSessions(new Date(), SESSION_TTL_MS);

    expect(fakeStore.has(`evidence-sessions/${sessionId}/chunk_0`)).toBe(false);
  });

  it("a session already completed (removed from the index by cleanupSession) is not re-swept", async () => {
    // The route's happy path calls cleanupSession itself once the assembled
    // file is uploaded; simulate that by initiating and then completing the
    // same lifecycle a completed upload would (session leaves the index).
    const { sessionId } = await initiateSession(
      makeInput({ sha256: "6".repeat(64), createdAt: OLD_CREATED_AT }),
    );
    const { cleanupSession } = await import("../services/evidence-upload-session.service");
    await cleanupSession(sessionId);

    const cleaned = await sweepStaleSessions(new Date(), SESSION_TTL_MS);
    expect(cleaned).toBe(0);
  });

  it("returns 0 when there are no active sessions", async () => {
    const cleaned = await sweepStaleSessions(new Date(), SESSION_TTL_MS);
    expect(cleaned).toBe(0);
  });
});
