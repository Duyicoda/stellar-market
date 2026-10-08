"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Monitor,
  Camera,
  Circle,
  Pause,
  Play,
  Square,
  Video,
  AlertTriangle,
  RotateCcw,
  Trash2,
  ShieldCheck,
} from "lucide-react";
import {
  RecordingController,
  listRecoverableRecordings,
  clearRecording,
  formatTimestamp,
  type RecordingSource,
  type RecordingStatus,
  type RecordingFormat,
  type RecoverableRecording,
} from "@/lib/mediaRecording";

/**
 * In-browser video/screen recorder for dispute evidence (issue #901).
 *
 * On stop, the recording is handed to the parent as a plain `File` via
 * `onRecordingReady`, so it flows through the *existing* SHA-256 + resumable
 * chunked upload pipeline — this component deliberately owns no upload logic.
 * Partial recordings left by an interruption are surfaced for recovery.
 */
export default function EvidenceRecorder({
  disputeId,
  onRecordingReady,
  disabled = false,
}: {
  disputeId: string;
  onRecordingReady: (file: File) => void;
  disabled?: boolean;
}) {
  const [source, setSource] = useState<RecordingSource>("screen");
  const [status, setStatus] = useState<RecordingStatus>("idle");
  const [durationSec, setDurationSec] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [format, setFormat] = useState<RecordingFormat | null>(null);
  const [recoverable, setRecoverable] = useState<RecoverableRecording[]>([]);

  const controllerRef = useRef<RecordingController | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const isActive = status === "recording" || status === "paused";

  const refreshRecoverable = useCallback(() => {
    listRecoverableRecordings(disputeId)
      .then(setRecoverable)
      .catch(() => setRecoverable([]));
  }, [disputeId]);

  // Surface any partial recordings from a previous interrupted session.
  useEffect(() => {
    refreshRecoverable();
  }, [refreshRecoverable]);

  // Duration timer — ticks only while actively recording.
  useEffect(() => {
    if (status !== "recording") return;
    const id = window.setInterval(() => setDurationSec((d) => d + 1), 1000);
    return () => window.clearInterval(id);
  }, [status]);

  // Release the camera/screen if the component unmounts mid-capture. Persisted
  // chunks are intentionally left behind so the recording remains recoverable.
  useEffect(() => {
    return () => {
      controllerRef.current
        ?.getStream()
        ?.getTracks()
        .forEach((t) => t.stop());
    };
  }, []);

  const handleStart = useCallback(async () => {
    setError(null);
    setDurationSec(0);
    const controller = new RecordingController({
      disputeId,
      source,
      onStatus: setStatus,
      onError: (e) => setError(e.message),
    });
    controllerRef.current = controller;
    try {
      const stream = await controller.start();
      setFormat(controller.format);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.muted = true;
        void videoRef.current.play?.().catch(() => undefined);
      }
    } catch {
      // onError already populated the message; nothing else to do.
      controllerRef.current = null;
    }
  }, [disputeId, source]);

  const handleStop = useCallback(async () => {
    const controller = controllerRef.current;
    if (!controller) return;
    try {
      const file = await controller.stop();
      if (videoRef.current) videoRef.current.srcObject = null;
      if (file.size > 0) {
        onRecordingReady(file);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to finalize recording.");
    } finally {
      controllerRef.current = null;
      refreshRecoverable();
    }
  }, [onRecordingReady, refreshRecoverable]);

  const handleRecover = useCallback(
    (rec: RecoverableRecording) => {
      onRecordingReady(rec.file);
      clearRecording(rec.disputeId, rec.recordingId).catch(() => undefined);
      setRecoverable((prev) =>
        prev.filter((r) => r.recordingId !== rec.recordingId),
      );
    },
    [onRecordingReady],
  );

  const handleDiscard = useCallback((rec: RecoverableRecording) => {
    clearRecording(rec.disputeId, rec.recordingId).catch(() => undefined);
    setRecoverable((prev) =>
      prev.filter((r) => r.recordingId !== rec.recordingId),
    );
  }, []);

  return (
    <div className="space-y-3">
      {/* Recoverable partial recordings from an interrupted session. */}
      {recoverable.length > 0 && (
        <div className="rounded-lg border border-theme-warning/40 bg-theme-warning/5 p-2 space-y-2">
          <p className="flex items-center gap-1.5 text-xs font-medium text-theme-warning">
            <AlertTriangle size={12} />
            Recovered {recoverable.length} interrupted recording
            {recoverable.length !== 1 ? "s" : ""}
          </p>
          <ul className="space-y-1.5">
            {recoverable.map((rec) => (
              <li
                key={rec.recordingId}
                className="flex items-center justify-between gap-2 text-[11px] text-theme-text"
              >
                <span className="truncate">
                  {rec.source === "screen" ? "Screen" : "Camera"} ·{" "}
                  {Math.max(1, Math.ceil(rec.size / 1024))} KB ·{" "}
                  {rec.chunkCount} chunk{rec.chunkCount !== 1 ? "s" : ""}
                </span>
                <span className="flex items-center gap-2 flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => handleRecover(rec)}
                    className="flex items-center gap-1 text-stellar-blue hover:underline"
                  >
                    <RotateCcw size={11} />
                    Recover
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDiscard(rec)}
                    className="flex items-center gap-1 text-theme-text-muted hover:text-theme-error"
                    aria-label="Discard recovered recording"
                  >
                    <Trash2 size={11} />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Source selection (disabled once a recording is in progress). */}
      <div className="flex items-center gap-2" role="radiogroup" aria-label="Recording source">
        <button
          type="button"
          role="radio"
          aria-checked={source === "screen"}
          onClick={() => setSource("screen")}
          disabled={disabled || isActive}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs transition-colors disabled:opacity-50 ${
            source === "screen"
              ? "border-stellar-blue text-stellar-blue"
              : "border-theme-border text-theme-text hover:border-stellar-blue"
          }`}
        >
          <Monitor size={14} />
          Screen
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={source === "camera"}
          onClick={() => setSource("camera")}
          disabled={disabled || isActive}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs transition-colors disabled:opacity-50 ${
            source === "camera"
              ? "border-stellar-blue text-stellar-blue"
              : "border-theme-border text-theme-text hover:border-stellar-blue"
          }`}
        >
          <Camera size={14} />
          Camera
        </button>
      </div>

      {/* Live preview. */}
      <div className="relative overflow-hidden rounded-lg border border-theme-border bg-black/80 aspect-video">
        <video
          ref={videoRef}
          data-testid="recorder-preview"
          className="h-full w-full object-contain"
          autoPlay
          playsInline
          muted
        />
        {!isActive && (
          <div className="absolute inset-0 flex items-center justify-center text-theme-text-muted">
            <Video size={28} />
          </div>
        )}
        {isActive && (
          <div className="absolute left-2 top-2 flex items-center gap-1.5 rounded-full bg-black/60 px-2 py-0.5 text-[10px] text-white">
            <Circle
              size={8}
              className={
                status === "recording"
                  ? "animate-pulse fill-red-500 text-red-500"
                  : "fill-yellow-400 text-yellow-400"
              }
            />
            {status === "paused" ? "Paused" : "Rec"} {formatTimestamp(durationSec)}
          </div>
        )}
      </div>

      {/* Controls. */}
      <div className="flex items-center gap-2">
        {status === "idle" || status === "stopped" || status === "error" ? (
          <button
            type="button"
            onClick={handleStart}
            disabled={disabled}
            className="btn-primary flex flex-1 items-center justify-center gap-2 text-sm disabled:opacity-50"
          >
            <Circle size={14} className="fill-current" />
            Start recording
          </button>
        ) : (
          <>
            {status === "recording" ? (
              <button
                type="button"
                onClick={() => controllerRef.current?.pause()}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-theme-border px-3 py-2 text-sm text-theme-text hover:border-stellar-blue"
              >
                <Pause size={14} />
                Pause
              </button>
            ) : (
              <button
                type="button"
                onClick={() => controllerRef.current?.resume()}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-theme-border px-3 py-2 text-sm text-theme-text hover:border-stellar-blue"
              >
                <Play size={14} />
                Resume
              </button>
            )}
            <button
              type="button"
              onClick={handleStop}
              className="btn-primary flex flex-1 items-center justify-center gap-1.5 text-sm"
            >
              <Square size={14} className="fill-current" />
              Stop &amp; attach
            </button>
          </>
        )}
      </div>

      {format && isActive && (
        <p className="flex items-center gap-1.5 text-[10px] text-theme-text-muted">
          <ShieldCheck size={11} className="text-theme-success" />
          Recording as {format.label}
          {format.mimeType
            ? ` (${format.mimeType})`
            : " — your browser chose the format"}
        </p>
      )}

      {error && (
        <p className="flex items-center gap-1.5 text-xs text-theme-error">
          <AlertTriangle size={12} />
          {error}
        </p>
      )}

      <p className="text-[10px] text-theme-text-muted">
        Recordings are captured in short chunks saved as you go, so an interrupted
        session (denied permission, closed tab) can be recovered rather than lost.
        When you stop, the video is hashed and uploaded like any other evidence
        file.
      </p>
    </div>
  );
}
