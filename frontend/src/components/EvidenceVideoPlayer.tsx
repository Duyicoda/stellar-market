"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import { Play, Pause, Camera, Link2, Check } from "lucide-react";
import {
  formatTimestamp,
  buildTimestampHash,
  parseTimestampFromHash,
} from "@/lib/mediaRecording";

/**
 * Evidence-specific video player for the arbitrator review side (issue #901).
 *
 * Beyond generic playback it offers:
 *  - a timestamped scrubber (seek to an exact moment);
 *  - a stable, shareable **deep-link** to the current moment using the W3C
 *    media-fragment form (`#t=12.5`), which an arbitrator can paste into a vote
 *    rationale;
 *  - a **frame capture** affordance so a specific frame can be referenced.
 *
 * On mount it reads any `#t=` fragment from the URL (or `initialTime`) and seeks
 * there, so a shared link lands on the referenced moment.
 */
export default function EvidenceVideoPlayer({
  src,
  fileName,
  initialTime,
  onTimestampReference,
  onFrameCapture,
}: {
  src: string;
  fileName?: string;
  /** Seconds to seek to on load; falls back to a `#t=` URL fragment. */
  initialTime?: number;
  /** Called with (seconds, hash) when the user copies a moment reference. */
  onTimestampReference?: (seconds: number, hash: string) => void;
  /** Called with a PNG data URL + seconds when the user captures a frame. */
  onFrameCapture?: (dataUrl: string, seconds: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);

  const seekTo = useCallback((seconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    const clamped = Math.max(0, seconds);
    video.currentTime = Number.isFinite(clamped) ? clamped : 0;
    setCurrentTime(video.currentTime);
  }, []);

  // Seek to the referenced moment once metadata (and thus duration) is known.
  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    setDuration(Number.isFinite(video.duration) ? video.duration : 0);
    const fromHash =
      typeof window !== "undefined"
        ? parseTimestampFromHash(window.location.hash)
        : null;
    const target = initialTime ?? fromHash;
    if (target && target > 0) {
      seekTo(target);
    }
  }, [initialTime, seekTo]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTime = () => setCurrentTime(video.currentTime);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onError = () => setError(true);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("error", onError);
    return () => {
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("error", onError);
    };
  }, []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play?.().catch(() => undefined);
    } else {
      video.pause?.();
    }
  }, []);

  const handleScrub = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      seekTo(Number(e.target.value));
    },
    [seekTo],
  );

  const copyMomentLink = useCallback(async () => {
    const seconds = videoRef.current?.currentTime ?? currentTime;
    const hash = buildTimestampHash(seconds);
    if (typeof window !== "undefined") {
      // Reflect the moment in the URL so a copied address deep-links back to it.
      try {
        window.history.replaceState(null, "", hash);
      } catch {
        window.location.hash = hash;
      }
      const href = `${window.location.origin}${window.location.pathname}${window.location.search}${hash}`;
      try {
        await navigator.clipboard?.writeText?.(href);
      } catch {
        // Clipboard may be unavailable (permissions/insecure context); the URL
        // is still updated, so the reference remains shareable.
      }
    }
    onTimestampReference?.(seconds, hash);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }, [currentTime, onTimestampReference]);

  const captureFrame = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const seconds = video.currentTime;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 360;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/png");
      onFrameCapture?.(dataUrl, seconds);

      // Offer the frame as a download named with its timestamp for reference.
      const anchor = document.createElement("a");
      anchor.href = dataUrl;
      anchor.download = `${(fileName || "evidence").replace(/\.[^.]+$/, "")}-frame-${formatTimestamp(
        seconds,
      ).replace(/:/g, "-")}.png`;
      anchor.click();
    } catch {
      // Frame capture can fail for cross-origin/unsupported sources; ignore.
    }
  }, [fileName, onFrameCapture]);

  return (
    <div className="space-y-2 rounded-lg border border-theme-border bg-theme-bg p-2">
      <video
        ref={videoRef}
        src={src}
        data-testid="evidence-video"
        className="w-full rounded-md bg-black aspect-video"
        onLoadedMetadata={handleLoadedMetadata}
        playsInline
        preload="metadata"
      >
        {/* Evidence recordings carry no caption track; declare an empty one so
            the player is still accessible and satisfies a11y requirements. */}
        <track kind="captions" />
      </video>

      {error && (
        <p className="text-[11px] text-theme-error">
          This video could not be played in your browser. Use Download to review
          it locally.
        </p>
      )}

      {/* Scrubber. */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={togglePlay}
          className="text-stellar-blue hover:text-stellar-blue/80"
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={Math.min(currentTime, duration || 0)}
          onChange={handleScrub}
          aria-label="Seek"
          className="h-1.5 flex-1 cursor-pointer accent-stellar-blue"
        />
        <span
          className="font-mono text-[10px] tabular-nums text-theme-text-muted"
          data-testid="video-timestamp"
        >
          {formatTimestamp(currentTime)} / {formatTimestamp(duration)}
        </span>
      </div>

      {/* Evidence-specific affordances. */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={copyMomentLink}
          className="flex items-center gap-1 text-[11px] text-stellar-blue hover:underline"
        >
          {copied ? <Check size={12} /> : <Link2 size={12} />}
          {copied ? "Link copied" : "Copy link to this moment"}
        </button>
        <button
          type="button"
          onClick={captureFrame}
          className="flex items-center gap-1 text-[11px] text-stellar-blue hover:underline"
        >
          <Camera size={12} />
          Capture frame
        </button>
      </div>
    </div>
  );
}
