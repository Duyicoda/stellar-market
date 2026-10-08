"use client";

import { useEffect, useState } from "react";
import { formatLocalTimestamp, formatUtcTimestamp } from "@/components/LocalTimestamp";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Formats how long ago `isoString` was, e.g. "Opened 3 days ago".
 */
export function formatElapsed(isoString: string, now: Date = new Date()): string {
  const diffMs = Math.max(0, now.getTime() - new Date(isoString).getTime());

  if (diffMs < MINUTE_MS) return "Opened just now";

  if (diffMs < HOUR_MS) {
    const minutes = Math.floor(diffMs / MINUTE_MS);
    return `Opened ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }

  if (diffMs < DAY_MS) {
    const hours = Math.floor(diffMs / HOUR_MS);
    return `Opened ${hours} hour${hours === 1 ? "" : "s"} ago`;
  }

  const days = Math.floor(diffMs / DAY_MS);
  return `Opened ${days} day${days === 1 ? "" : "s"} ago`;
}

export interface VoteCountdown {
  text: string;
  /** True when the deadline is under 24 hours away — used for amber styling. */
  urgent: boolean;
  expired: boolean;
}

/**
 * Formats the time remaining until a vote deadline, e.g. "Vote closes in 2 hours".
 */
export function formatVoteCountdown(
  deadlineIso: string,
  now: Date = new Date(),
): VoteCountdown {
  const diffMs = new Date(deadlineIso).getTime() - now.getTime();

  if (diffMs <= 0) {
    return { text: "Vote deadline has passed", urgent: true, expired: true };
  }

  const urgent = diffMs < DAY_MS;

  if (diffMs < HOUR_MS) {
    const minutes = Math.max(1, Math.round(diffMs / MINUTE_MS));
    return { text: `Vote closes in ${minutes} minute${minutes === 1 ? "" : "s"}`, urgent, expired: false };
  }

  if (diffMs < DAY_MS) {
    const hours = Math.floor(diffMs / HOUR_MS);
    return { text: `Vote closes in ${hours} hour${hours === 1 ? "" : "s"}`, urgent, expired: false };
  }

  const days = Math.floor(diffMs / DAY_MS);
  return { text: `Vote closes in ${days} day${days === 1 ? "" : "s"}`, urgent, expired: false };
}

/** Ticks a `Date` once a minute so relative-time text stays fresh without refetching. */
function useMinuteTick(): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), MINUTE_MS);
    return () => clearInterval(id);
  }, []);

  return now;
}

interface DisputeOpenedElapsedProps {
  isoString: string;
  className?: string;
}

/** Renders "Opened X days ago", updating every minute, with the exact time as a tooltip. */
export function DisputeOpenedElapsed({ isoString, className }: DisputeOpenedElapsedProps) {
  const now = useMinuteTick();

  return (
    <time
      dateTime={isoString}
      title={`${formatLocalTimestamp(isoString)} (${formatUtcTimestamp(isoString)})`}
      className={className}
    >
      {formatElapsed(isoString, now)}
    </time>
  );
}

interface VoteDeadlineCountdownProps {
  deadlineIso: string;
  className?: string;
}

/** Renders a live "Vote closes in X hours" countdown, styled amber under 24 hours. */
export function VoteDeadlineCountdown({ deadlineIso, className = "" }: VoteDeadlineCountdownProps) {
  const now = useMinuteTick();
  const { text, urgent } = formatVoteCountdown(deadlineIso, now);

  return (
    <span
      title={formatLocalTimestamp(deadlineIso)}
      className={`${urgent ? "text-theme-warning" : "text-theme-text"} ${className}`}
    >
      {text}
    </span>
  );
}
