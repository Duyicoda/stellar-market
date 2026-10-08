import { openDB, IDBPDatabase } from "idb";

/**
 * In-browser media-recording layer for dispute evidence (issue #901).
 *
 * This module is intentionally framework-agnostic so it can be unit-tested
 * without React. It handles three hard parts the issue calls out:
 *
 *  1. **Cross-browser codec negotiation** — `MediaRecorder`'s supported
 *     `mimeType` varies across Chrome/Firefox/Safari. We probe a preference list
 *     with `MediaRecorder.isTypeSupported` and pick the first that works, rather
 *     than assuming one codec is universal.
 *
 *  2. **Integration with the existing chunked upload pipeline** — a recording is
 *     assembled into a plain `File` on stop, which then flows through the very
 *     same `hashFile` + `uploadFileResumable` path used for hand-picked files
 *     (see `evidenceUpload.ts`). No separate upload path.
 *
 *  3. **Interruption resilience** — every `MediaRecorder` timeslice is persisted
 *     to IndexedDB as it arrives (not a single blob assembled only at the end).
 *     A revoked permission, closed tab, or crash therefore leaves a recoverable
 *     partial recording behind, which `listRecoverableRecordings` surfaces.
 */

// ---- codec negotiation ----

export interface RecordingFormat {
  /** The negotiated MediaRecorder mimeType, or "" to use the browser default. */
  mimeType: string;
  /** File extension implied by the container ("webm" or "mp4"). */
  extension: string;
  /** Human-readable label for the UI, e.g. "WebM (VP9)". */
  label: string;
}

/**
 * Preference order, most-to-least desirable. VP9/Opus in WebM is the modern
 * Chrome/Firefox default; H.264/AAC in MP4 is the Safari fallback. The bare
 * container entries catch browsers that support the container but not the
 * codec-qualified string.
 */
export const PREFERRED_VIDEO_MIME_TYPES: string[] = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm;codecs=h264",
  "video/webm",
  "video/mp4;codecs=h264,aac",
  "video/mp4;codecs=avc1",
  "video/mp4",
];

/** Safe wrapper around `MediaRecorder.isTypeSupported` (absent in some envs). */
export function isMimeTypeSupported(mimeType: string): boolean {
  try {
    return (
      typeof MediaRecorder !== "undefined" &&
      typeof MediaRecorder.isTypeSupported === "function" &&
      MediaRecorder.isTypeSupported(mimeType)
    );
  } catch {
    return false;
  }
}

function labelFor(mimeType: string): string {
  if (!mimeType) return "browser default";
  const container = mimeType.includes("mp4") ? "MP4" : "WebM";
  const codecMatch = /codecs=([^;]+)/i.exec(mimeType);
  const codec = codecMatch
    ? codecMatch[1].split(",")[0].trim().toUpperCase()
    : "";
  return codec ? `${container} (${codec})` : container;
}

export function toRecordingFormat(mimeType: string): RecordingFormat {
  return {
    mimeType,
    extension: mimeType.includes("mp4") ? "mp4" : "webm",
    label: labelFor(mimeType),
  };
}

/**
 * Negotiate the best supported recording format for the current browser.
 *
 * Returns the first supported mimeType from `preferred`. If none are supported
 * (or the API is unavailable), returns an empty `mimeType` so `MediaRecorder`
 * falls back to its own default — the `label` ("browser default") lets the UI
 * communicate that the exact format could not be pinned down, rather than
 * failing silently.
 */
export function negotiateRecordingFormat(
  preferred: string[] = PREFERRED_VIDEO_MIME_TYPES,
): RecordingFormat {
  for (const mimeType of preferred) {
    if (isMimeTypeSupported(mimeType)) {
      return toRecordingFormat(mimeType);
    }
  }
  return { mimeType: "", extension: "webm", label: "browser default" };
}

// ---- errors ----

export type RecordingErrorKind =
  | "unsupported"
  | "permission"
  | "aborted"
  | "no-input"
  | "unknown";

export class RecordingError extends Error {
  kind: RecordingErrorKind;
  constructor(kind: RecordingErrorKind, message: string) {
    super(message);
    this.name = "RecordingError";
    this.kind = kind;
  }
}

/** Classify a raw getUserMedia/getDisplayMedia rejection into a stable kind. */
export function classifyMediaError(err: unknown): RecordingError {
  if (err instanceof RecordingError) return err;
  const name = (err as { name?: string })?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new RecordingError(
      "permission",
      "Recording permission was denied. Allow access to continue.",
    );
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return new RecordingError(
      "no-input",
      "No camera/microphone or screen source was available.",
    );
  }
  if (name === "AbortError") {
    return new RecordingError("aborted", "Recording was interrupted.");
  }
  const message =
    (err as { message?: string })?.message ?? "Could not start recording.";
  return new RecordingError("unknown", message);
}

// ---- stream acquisition ----

export type RecordingSource = "screen" | "camera";

/**
 * Acquire a MediaStream for the given source. `getDisplayMedia` for screen
 * share, `getUserMedia` for webcam+mic. Kept tiny and dependency-free so tests
 * can mock `navigator.mediaDevices` directly.
 */
export async function acquireStream(
  source: RecordingSource,
): Promise<MediaStream> {
  const md =
    typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  if (!md) {
    throw new RecordingError(
      "unsupported",
      "Media capture is not supported in this browser.",
    );
  }
  try {
    if (source === "screen") {
      if (typeof md.getDisplayMedia !== "function") {
        throw new RecordingError(
          "unsupported",
          "Screen capture is not supported in this browser.",
        );
      }
      return await md.getDisplayMedia({ video: true, audio: true });
    }
    if (typeof md.getUserMedia !== "function") {
      throw new RecordingError(
        "unsupported",
        "Camera capture is not supported in this browser.",
      );
    }
    return await md.getUserMedia({ video: true, audio: true });
  } catch (err) {
    throw classifyMediaError(err);
  }
}

// ---- in-progress recording persistence (interruption recovery) ----

interface RecordingChunkRecord {
  disputeId: string;
  recordingId: string;
  index: number;
  /** Raw chunk bytes. Stored as an ArrayBuffer rather than a Blob because raw
   * buffers structured-clone reliably across environments (a Blob does not). */
  bytes: ArrayBuffer;
  mimeType: string;
  source: RecordingSource;
  updatedAt: number;
}

/** Blob → ArrayBuffer with a FileReader fallback for environments (jsdom, older
 * browsers) that lack `Blob.arrayBuffer`. */
async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") {
    return blob.arrayBuffer();
  }
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

const REC_DB_NAME = "evidence-recording-store";
const REC_STORE = "chunks";

let recDbPromise: Promise<IDBPDatabase> | null = null;

function getRecDB(): Promise<IDBPDatabase> {
  if (!recDbPromise) {
    recDbPromise = openDB(REC_DB_NAME, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(REC_STORE)) {
          const store = db.createObjectStore(REC_STORE, {
            keyPath: ["disputeId", "recordingId", "index"],
          });
          store.createIndex("byDispute", "disputeId");
        }
      },
    });
  }
  return recDbPromise;
}

/** Persist a single in-progress timeslice chunk so it survives an interruption. */
export async function persistRecordingChunk(record: {
  disputeId: string;
  recordingId: string;
  index: number;
  blob: Blob;
  mimeType: string;
  source: RecordingSource;
}): Promise<void> {
  const db = await getRecDB();
  const bytes = await blobToArrayBuffer(record.blob);
  const stored: RecordingChunkRecord = {
    disputeId: record.disputeId,
    recordingId: record.recordingId,
    index: record.index,
    bytes,
    mimeType: record.mimeType,
    source: record.source,
    updatedAt: Date.now(),
  };
  await db.put(REC_STORE, stored);
}

/** Delete all persisted chunks for one recording (after a clean hand-off). */
export async function clearRecording(
  disputeId: string,
  recordingId: string,
): Promise<void> {
  const db = await getRecDB();
  const all = (await db.getAllFromIndex(
    REC_STORE,
    "byDispute",
    disputeId,
  )) as RecordingChunkRecord[];
  const tx = db.transaction(REC_STORE, "readwrite");
  await Promise.all(
    all
      .filter((r) => r.recordingId === recordingId)
      .map((r) => tx.store.delete([r.disputeId, r.recordingId, r.index])),
  );
  await tx.done;
}

export interface RecoverableRecording {
  recordingId: string;
  disputeId: string;
  mimeType: string;
  source: RecordingSource;
  chunkCount: number;
  size: number;
  updatedAt: number;
  /** The partial recording assembled into a playable/uploadable File. */
  file: File;
}

function extensionForMime(mimeType: string): string {
  return mimeType.includes("mp4") ? "mp4" : "webm";
}

function assembleFile(
  recordingId: string,
  chunks: BlobPart[],
  mimeType: string,
): File {
  const type = mimeType || "video/webm";
  const blob = new Blob(chunks, { type });
  const name = `dispute-recording-${recordingId}.${extensionForMime(type)}`;
  return new File([blob], name, { type });
}

/**
 * Return any recoverable partial recordings persisted for a dispute, assembled
 * (in chunk order) into Files. Used to surface evidence left behind by an
 * interrupted session so it is not silently lost.
 */
export async function listRecoverableRecordings(
  disputeId: string,
): Promise<RecoverableRecording[]> {
  const db = await getRecDB();
  const all = (await db.getAllFromIndex(
    REC_STORE,
    "byDispute",
    disputeId,
  )) as RecordingChunkRecord[];

  const byRecording = new Map<string, RecordingChunkRecord[]>();
  for (const rec of all) {
    const list = byRecording.get(rec.recordingId) ?? [];
    list.push(rec);
    byRecording.set(rec.recordingId, list);
  }

  const result: RecoverableRecording[] = [];
  for (const [recordingId, records] of byRecording) {
    records.sort((a, b) => a.index - b.index);
    const blobs = records.map((r) => r.bytes);
    const mimeType = records[0]?.mimeType ?? "video/webm";
    const file = assembleFile(recordingId, blobs, mimeType);
    result.push({
      recordingId,
      disputeId,
      mimeType,
      source: records[0]?.source ?? "screen",
      chunkCount: records.length,
      size: file.size,
      updatedAt: records.reduce((m, r) => Math.max(m, r.updatedAt), 0),
      file,
    });
  }
  // Most recent first.
  result.sort((a, b) => b.updatedAt - a.updatedAt);
  return result;
}

// ---- recording controller ----

export type RecordingStatus =
  | "idle"
  | "recording"
  | "paused"
  | "stopping"
  | "stopped"
  | "error";

export interface RecordingControllerOptions {
  disputeId: string;
  source: RecordingSource;
  /** Stable id; generated if omitted. */
  recordingId?: string;
  /** How often MediaRecorder emits (and we persist) a chunk. Default 3000 ms. */
  timesliceMs?: number;
  /** Pre-negotiated format; negotiated on demand if omitted. */
  format?: RecordingFormat;
  /** Persist chunks to IndexedDB for crash recovery. Default true. */
  persist?: boolean;
  onStatus?: (status: RecordingStatus) => void;
  onChunk?: (info: { count: number; bytes: number }) => void;
  onError?: (err: RecordingError) => void;
  /** Injection seam for tests: supply a stream instead of hitting the browser. */
  acquire?: (source: RecordingSource) => Promise<MediaStream>;
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `rec_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

/**
 * Wraps a MediaStream + MediaRecorder into a small state machine:
 * `idle → recording ⇄ paused → stopping → stopped` (or `→ error`).
 *
 * Chunks are collected in memory *and* (by default) persisted to IndexedDB as
 * they arrive so an interruption leaves a recoverable partial recording.
 */
export class RecordingController {
  readonly recordingId: string;
  readonly disputeId: string;
  readonly source: RecordingSource;
  format: RecordingFormat;

  status: RecordingStatus = "idle";

  private readonly timesliceMs: number;
  private readonly persist: boolean;
  private readonly opts: RecordingControllerOptions;

  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private chunkIndex = 0;
  private bytes = 0;
  // Serializes best-effort chunk persistence so writes land in order and so
  // callers can await all in-flight persistence (e.g. before reading recovery).
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(opts: RecordingControllerOptions) {
    this.opts = opts;
    this.recordingId = opts.recordingId ?? newId();
    this.disputeId = opts.disputeId;
    this.source = opts.source;
    this.timesliceMs = opts.timesliceMs ?? 3000;
    this.persist = opts.persist ?? true;
    this.format =
      opts.format ?? { mimeType: "", extension: "webm", label: "browser default" };
  }

  getStream(): MediaStream | null {
    return this.stream;
  }

  private setStatus(status: RecordingStatus): void {
    this.status = status;
    this.opts.onStatus?.(status);
  }

  private fail(err: unknown): RecordingError {
    const e = classifyMediaError(err);
    this.setStatus("error");
    this.opts.onError?.(e);
    return e;
  }

  /** Acquire the stream and begin recording. Rejects with a `RecordingError`. */
  async start(): Promise<MediaStream> {
    if (this.status === "recording" || this.status === "paused") {
      throw new RecordingError("unknown", "Recording is already in progress.");
    }
    try {
      const acquire = this.opts.acquire ?? acquireStream;
      const stream = await acquire(this.source);
      this.stream = stream;

      if (!this.format.mimeType) {
        this.format = this.opts.format ?? negotiateRecordingFormat();
      }

      const recorder = new MediaRecorder(
        stream,
        this.format.mimeType ? { mimeType: this.format.mimeType } : undefined,
      );
      this.recorder = recorder;

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          void this.handleChunk(event.data);
        }
      };
      recorder.onerror = () => {
        this.fail(
          new RecordingError("unknown", "The recorder encountered an error."),
        );
      };

      // If the user ends the screen share (or unplugs the camera), the track
      // fires "ended" — treat that as a stop so nothing is lost.
      const videoTrack = stream.getVideoTracks?.()[0];
      videoTrack?.addEventListener?.("ended", () => {
        if (this.status === "recording" || this.status === "paused") {
          void this.stop().catch(() => undefined);
        }
      });

      recorder.start(this.timesliceMs);
      this.setStatus("recording");
      return stream;
    } catch (err) {
      throw this.fail(err);
    }
  }

  private async handleChunk(blob: Blob): Promise<void> {
    this.chunks.push(blob);
    const index = this.chunkIndex++;
    this.bytes += blob.size;
    this.opts.onChunk?.({ count: this.chunks.length, bytes: this.bytes });

    if (this.persist) {
      // Chain onto the queue so writes are ordered and awaitable, and so a
      // failure is swallowed (persistence must never break recording).
      this.persistQueue = this.persistQueue.then(() =>
        persistRecordingChunk({
          disputeId: this.disputeId,
          recordingId: this.recordingId,
          index,
          blob,
          mimeType: this.format.mimeType || "video/webm",
          source: this.source,
        }).catch(() => undefined),
      );
      await this.persistQueue;
    }
  }

  /** Await all in-flight chunk persistence (useful for recovery/tests). */
  async flushPersistence(): Promise<void> {
    await this.persistQueue;
  }

  pause(): void {
    if (this.recorder && this.status === "recording") {
      this.recorder.pause();
      this.setStatus("paused");
    }
  }

  resume(): void {
    if (this.recorder && this.status === "paused") {
      this.recorder.resume();
      this.setStatus("recording");
    }
  }

  private stopTracks(): void {
    this.stream?.getTracks?.().forEach((t) => t.stop());
  }

  /**
   * Stop recording cleanly, assemble the captured chunks into a `File`, and
   * clear the persisted partial (the returned File is handed to the upload
   * pipeline, which has its own persistence). Resolves with the File.
   */
  async stop(): Promise<File> {
    const recorder = this.recorder;
    if (!recorder || (this.status !== "recording" && this.status !== "paused")) {
      // Nothing recording — assemble whatever we have (possibly empty).
      const file = this.assemble();
      this.stopTracks();
      this.setStatus("stopped");
      return file;
    }

    this.setStatus("stopping");
    const file = await new Promise<File>((resolve) => {
      recorder.onstop = () => resolve(this.assemble());
      try {
        // Flush any buffered data, then stop.
        if (
          typeof recorder.requestData === "function" &&
          recorder.state !== "inactive"
        ) {
          recorder.requestData();
        }
        recorder.stop();
      } catch {
        resolve(this.assemble());
      }
    });

    this.stopTracks();
    this.setStatus("stopped");
    // Flush any in-flight chunk writes first, so clearing can't race a late
    // persist and leave a stray chunk behind. Then clear — a clean stop means
    // the file is now owned by the caller/upload pipeline.
    await this.flushPersistence();
    await clearRecording(this.disputeId, this.recordingId).catch(
      () => undefined,
    );
    return file;
  }

  private assemble(): File {
    return assembleFile(
      this.recordingId,
      this.chunks,
      this.format.mimeType || "video/webm",
    );
  }
}

// ---- player timestamp helpers (shareable, stable references) ----

/** Format seconds as `m:ss` or `h:mm:ss`, padded — used by the scrubber. */
export function formatTimestamp(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) totalSeconds = 0;
  const whole = Math.floor(totalSeconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Build a W3C Media-Fragments hash for a timestamp, e.g. `#t=12.5`. This is a
 * stable, shareable reference an arbitrator can paste to point at a moment.
 */
export function buildTimestampHash(seconds: number): string {
  const clamped = Math.max(0, Math.round(seconds * 10) / 10);
  return `#t=${clamped}`;
}

/**
 * Parse a timestamp out of a URL hash. Accepts the media-fragment form
 * `#t=12.5` and a clock form `#t=1:02:03`. Returns seconds, or null.
 */
export function parseTimestampFromHash(hash: string): number | null {
  if (!hash) return null;
  const match = /[#&]?t=([0-9:.]+)/i.exec(hash);
  if (!match) return null;
  const raw = match[1];
  if (raw.includes(":")) {
    const parts = raw.split(":").map((p) => Number(p));
    if (parts.some((n) => Number.isNaN(n))) return null;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** True when an evidence file type/mime represents a playable video. */
export function isVideoEvidence(fileTypeOrMime: string | undefined): boolean {
  if (!fileTypeOrMime) return false;
  const v = fileTypeOrMime.toLowerCase();
  return (
    v.startsWith("video/") ||
    v === "video" ||
    v.endsWith("webm") ||
    v.endsWith("mp4") ||
    v.endsWith("mov") ||
    v.endsWith("ogg")
  );
}
