import "fake-indexeddb/auto";
import {
  negotiateRecordingFormat,
  isMimeTypeSupported,
  RecordingController,
  listRecoverableRecordings,
  clearRecording,
  formatTimestamp,
  buildTimestampHash,
  parseTimestampFromHash,
  isVideoEvidence,
  acquireStream,
  RecordingError,
} from "@/lib/mediaRecording";
import { hashFile, uploadFileResumable } from "@/lib/evidenceUpload";

jest.setTimeout(20000);

// ---- Mock MediaRecorder ----
// A minimal, controllable MediaRecorder. `supported` drives isTypeSupported so a
// test can simulate different browsers' codec support. Instances register
// themselves so a test can push `dataavailable` chunks and trigger `stop`.
class MockMediaRecorder {
  static supported = new Set<string>();
  static instances: MockMediaRecorder[] = [];
  static isTypeSupported(type: string): boolean {
    return MockMediaRecorder.supported.has(type);
  }

  state: "inactive" | "recording" | "paused" = "inactive";
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;

  constructor(
    public stream: unknown,
    opts?: { mimeType?: string },
  ) {
    this.mimeType = opts?.mimeType ?? "";
    MockMediaRecorder.instances.push(this);
  }
  start(_timeslice?: number) {
    this.state = "recording";
  }
  pause() {
    this.state = "paused";
  }
  resume() {
    this.state = "recording";
  }
  requestData() {
    /* no-op; tests push chunks explicitly */
  }
  stop() {
    this.state = "inactive";
    this.onstop?.();
  }
  /** test helper */
  emit(blob: Blob) {
    this.ondataavailable?.({ data: blob });
  }
}

function fakeStream() {
  const track = { stop: jest.fn(), addEventListener: jest.fn() };
  return {
    getVideoTracks: () => [track],
    getTracks: () => [track],
    _track: track,
  } as unknown as MediaStream;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

let disputeCounter = 0;
function uniqueDispute(): string {
  return `dispute-${Date.now()}-${disputeCounter++}`;
}

beforeEach(() => {
  MockMediaRecorder.supported = new Set();
  MockMediaRecorder.instances = [];
  (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder =
    MockMediaRecorder;
});

// ==========================================================
// Codec negotiation across "browsers"
// ==========================================================

describe("codec negotiation", () => {
  it("negotiates a supported format instead of assuming one codec (two browsers)", () => {
    // "Chrome": supports WebM/VP9.
    MockMediaRecorder.supported = new Set(["video/webm;codecs=vp9,opus"]);
    const chrome = negotiateRecordingFormat();
    expect(chrome.mimeType).toBe("video/webm;codecs=vp9,opus");
    expect(chrome.extension).toBe("webm");

    // "Safari": no WebM at all, only MP4/H.264.
    MockMediaRecorder.supported = new Set(["video/mp4;codecs=h264,aac"]);
    const safari = negotiateRecordingFormat();
    expect(safari.mimeType).toBe("video/mp4;codecs=h264,aac");
    expect(safari.extension).toBe("mp4");

    // Neither is the same codec — the negotiation adapted per browser.
    expect(chrome.mimeType).not.toBe(safari.mimeType);
  });

  it("falls back to the browser default (empty mimeType) when nothing matches, not a silent failure", () => {
    MockMediaRecorder.supported = new Set(); // supports nothing in our list
    const fmt = negotiateRecordingFormat();
    expect(fmt.mimeType).toBe("");
    expect(fmt.label).toBe("browser default");
  });

  it("isMimeTypeSupported is a safe wrapper", () => {
    MockMediaRecorder.supported = new Set(["video/webm"]);
    expect(isMimeTypeSupported("video/webm")).toBe(true);
    expect(isMimeTypeSupported("video/mp4")).toBe(false);
  });
});

// ==========================================================
// Recording → existing chunked upload pipeline (with integrity hash)
// ==========================================================

// A tiny in-memory stand-in for the backend chunked-upload protocol. It
// reassembles received chunks on `complete` and computes the SHA-256 itself, so
// the test proves the recorded blob's integrity survives the pipeline.
function installBackend() {
  const sessions = new Map<
    string,
    { chunks: Map<number, Buffer>; meta: Record<string, unknown> }
  >();
  let counter = 0;
  const okJson = (obj: unknown) => ({ ok: true, json: async () => obj });

  (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(
    async (url: string, init: { method?: string; body?: unknown } = {}) => {
      const u = String(url);
      const method = init.method ?? "GET";

      if (u.endsWith("/evidence/sessions") && method === "POST") {
        const meta = JSON.parse(init.body as string);
        const sid = `s${counter++}`;
        sessions.set(sid, { chunks: new Map(), meta });
        return okJson({ sessionId: sid, receivedChunks: [] });
      }
      const chunk = /\/sessions\/([^/]+)\/chunks\/(\d+)$/.exec(u);
      if (chunk && method === "PUT") {
        const [, sid, idx] = chunk;
        const s = sessions.get(sid)!;
        s.chunks.set(Number(idx), Buffer.from(init.body as ArrayBuffer));
        return okJson({ receivedChunks: [...s.chunks.keys()] });
      }
      const complete = /\/sessions\/([^/]+)\/complete$/.exec(u);
      if (complete && method === "POST") {
        const [, sid] = complete;
        const s = sessions.get(sid)!;
        const ordered = [...s.chunks.entries()]
          .sort((a, b) => a[0] - b[0])
          .map((e) => e[1]);
        const full = Buffer.concat(ordered);
        const digest = await crypto.subtle.digest("SHA-256", full);
        const sha = Array.from(new Uint8Array(digest))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        return okJson({
          attachment: {
            id: sid,
            sha256: sha,
            size: full.length,
            originalName: s.meta.originalName,
          },
        });
      }
      return okJson({});
    },
  );
  return sessions;
}

async function recordClip(
  source: "screen" | "camera",
  chunks: Uint8Array[],
): Promise<File> {
  MockMediaRecorder.supported = new Set(["video/webm;codecs=vp9,opus"]);
  const controller = new RecordingController({
    disputeId: uniqueDispute(),
    source,
    persist: false,
    acquire: async () => fakeStream(),
  });
  await controller.start();
  const recorder = MockMediaRecorder.instances.at(-1)!;
  for (const c of chunks) recorder.emit(new Blob([c as BlobPart]));
  await flush();
  return controller.stop();
}

describe("recorded video flows through the existing chunked upload pipeline", () => {
  it("uploads a screen-capture recording with a matching integrity hash", async () => {
    installBackend();
    const file = await recordClip("screen", [
      new Uint8Array([1, 2, 3, 4, 5]),
      new Uint8Array([6, 7, 8, 9, 10]),
    ]);
    expect(file.size).toBe(10);
    expect(file.type).toContain("video/webm");

    const clientHash = await hashFile(file);
    const { attachment } = await uploadFileResumable(
      "http://api",
      "token",
      "d1",
      file,
      "file-1",
      { name: file.name, mimeType: file.type, sha256: clientHash },
    );

    // Server recomputed the hash over the reassembled chunks — it matches.
    expect(attachment.sha256).toBe(clientHash);
    expect(attachment.size).toBe(file.size);
  });

  it("uploads a webcam recording through the same path", async () => {
    installBackend();
    const file = await recordClip("camera", [new Uint8Array([42, 43, 44])]);
    const clientHash = await hashFile(file);
    const { attachment } = await uploadFileResumable(
      "http://api",
      "token",
      "d2",
      file,
      "file-2",
      { name: file.name, mimeType: file.type, sha256: clientHash },
    );
    expect(attachment.sha256).toBe(clientHash);
  });
});

// ==========================================================
// Interruption recovery
// ==========================================================

describe("interruption recovery", () => {
  it("preserves partially-captured content when a recording is interrupted", async () => {
    const disputeId = uniqueDispute();
    MockMediaRecorder.supported = new Set(["video/webm"]);
    const controller = new RecordingController({
      disputeId,
      source: "screen",
      persist: true, // periodic IndexedDB persistence
      acquire: async () => fakeStream(),
    });
    await controller.start();
    const recorder = MockMediaRecorder.instances.at(-1)!;

    // Two timeslices land and are persisted...
    recorder.emit(new Blob([new Uint8Array([1, 1, 1, 1])]));
    recorder.emit(new Blob([new Uint8Array([2, 2, 2, 2])]));
    await controller.flushPersistence();

    // ...then the session is interrupted (permission revoked / tab closed):
    // `stop()` is NEVER called cleanly, so the persisted chunks remain.
    const recoverable = await listRecoverableRecordings(disputeId);
    expect(recoverable).toHaveLength(1);
    expect(recoverable[0].chunkCount).toBe(2);
    expect(recoverable[0].size).toBe(8); // 4 + 4 bytes preserved
    expect(recoverable[0].file).toBeInstanceOf(File);

    // The recovered partial is a usable File that hashes fine.
    const hash = await hashFile(recoverable[0].file);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("clears the persisted partial after a clean stop (no false recovery)", async () => {
    const disputeId = uniqueDispute();
    MockMediaRecorder.supported = new Set(["video/webm"]);
    const controller = new RecordingController({
      disputeId,
      source: "camera",
      persist: true,
      acquire: async () => fakeStream(),
    });
    await controller.start();
    const recorder = MockMediaRecorder.instances.at(-1)!;
    recorder.emit(new Blob([new Uint8Array([9, 9])]));
    await controller.flushPersistence();
    await controller.stop();

    const recoverable = await listRecoverableRecordings(disputeId);
    expect(recoverable).toHaveLength(0);
  });

  it("clearRecording removes a recovered recording", async () => {
    const disputeId = uniqueDispute();
    MockMediaRecorder.supported = new Set(["video/webm"]);
    const controller = new RecordingController({
      disputeId,
      source: "screen",
      persist: true,
      acquire: async () => fakeStream(),
    });
    await controller.start();
    MockMediaRecorder.instances.at(-1)!.emit(new Blob([new Uint8Array([5])]));
    await controller.flushPersistence();

    let recoverable = await listRecoverableRecordings(disputeId);
    expect(recoverable).toHaveLength(1);
    await clearRecording(disputeId, recoverable[0].recordingId);
    recoverable = await listRecoverableRecordings(disputeId);
    expect(recoverable).toHaveLength(0);
  });
});

// ==========================================================
// Stream acquisition (getDisplayMedia / getUserMedia)
// ==========================================================

describe("stream acquisition", () => {
  afterEach(() => {
    delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
  });

  it("uses getDisplayMedia for screen and getUserMedia for camera", async () => {
    const getDisplayMedia = jest.fn(async () => fakeStream());
    const getUserMedia = jest.fn(async () => fakeStream());
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getDisplayMedia, getUserMedia },
      configurable: true,
    });

    await acquireStream("screen");
    await acquireStream("camera");
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("maps a denied permission to a permission RecordingError", async () => {
    const denied = Object.assign(new Error("denied"), {
      name: "NotAllowedError",
    });
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: jest.fn(async () => Promise.reject(denied)) },
      configurable: true,
    });
    await expect(acquireStream("camera")).rejects.toMatchObject({
      name: "RecordingError",
      kind: "permission",
    });
  });
});

// ==========================================================
// Player timestamp helpers (stable, shareable references)
// ==========================================================

describe("timestamp helpers", () => {
  it("formats seconds as m:ss and h:mm:ss", () => {
    expect(formatTimestamp(0)).toBe("0:00");
    expect(formatTimestamp(9)).toBe("0:09");
    expect(formatTimestamp(75)).toBe("1:15");
    expect(formatTimestamp(3661)).toBe("1:01:01");
    expect(formatTimestamp(-5)).toBe("0:00");
  });

  it("round-trips a shareable media-fragment deep link", () => {
    const hash = buildTimestampHash(12.53);
    expect(hash).toBe("#t=12.5");
    expect(parseTimestampFromHash(hash)).toBeCloseTo(12.5);
  });

  it("parses both #t=seconds and #t=clock forms", () => {
    expect(parseTimestampFromHash("#t=42")).toBe(42);
    expect(parseTimestampFromHash("#t=1:02:03")).toBe(3723);
    expect(parseTimestampFromHash("#nope")).toBeNull();
    expect(parseTimestampFromHash("")).toBeNull();
  });

  it("classifies video evidence by mime or extension", () => {
    expect(isVideoEvidence("video/webm")).toBe(true);
    expect(isVideoEvidence("recording.mp4")).toBe(true);
    expect(isVideoEvidence("application/pdf")).toBe(false);
    expect(isVideoEvidence(undefined)).toBe(false);
  });
});

describe("RecordingError", () => {
  it("carries a kind", () => {
    const e = new RecordingError("permission", "nope");
    expect(e.kind).toBe("permission");
    expect(e.message).toBe("nope");
    expect(e).toBeInstanceOf(Error);
  });
});
