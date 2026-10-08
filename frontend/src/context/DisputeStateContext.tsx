"use client";

/**
 * Single shared source of truth for a dispute's live vote/status state
 * (issue #1126).
 *
 * The dispute detail page previously had **three** independent, unsynchronized
 * data sources for the same dispute:
 *   1. the page's own `GET /disputes/:id` state (refetched on SSE events),
 *   2. `DisputeVoteProgress`'s independent polling loop (`useDisputeStatus`),
 *   3. `ArbitratorVoteView`'s independent 30s `/tally` poll.
 * Under normal network jitter these could display contradictory information at
 * the same moment (e.g. the sidebar saying "Ready to resolve" while the gated
 * "Finalize & Resolve" button stayed disabled), and a slow response from one
 * could overwrite fresher data already shown by another.
 *
 * This provider consolidates all of that into ONE state object that every
 * consumer reads from, with two staleness guards so a stale response can never
 * overwrite fresher data:
 *
 *   - **Monotonic request sequence** — every fetch goes through a single path
 *     that stamps an incrementing id; a response older than the newest issued
 *     request is discarded (kills the "slow response clobbers fresh data" race).
 *   - **`updatedAt` high-water mark** — a payload whose `updatedAt` is older than
 *     what is already committed is discarded, guarding against an out-of-band
 *     stale payload (e.g. a cache) racing a fresher one.
 *
 * ## Authoritative gating source
 *
 * SSE (`useDisputeStream`) is the primary live-update mechanism; every SSE event
 * triggers a single coordinated refetch. The `canResolve` flag exposed here is
 * the ONE authoritative gate for the "Finalize & Resolve" button, and the same
 * derived `totalVotes`/`dispute` feed every vote-status display — so the button
 * state can never visibly disagree with the sidebar/tally.
 */

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import axios from "axios";
import type { Dispute } from "@/types";
import { useDisputeStream, type DisputeEvent } from "@/hooks/useDisputeStream";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api/v1";

export interface DisputeStateValue {
  dispute: Dispute | null;
  loading: boolean;
  error: string | null;
  /** Force a coordinated refetch (used after the viewer casts a vote/resolves). */
  refetch: () => Promise<void>;
  /** Timeline events from the SSE stream. */
  timelineEvents: DisputeEvent[];
  /** Whether the SSE stream is currently connected. */
  isLive: boolean;
  /** votesForClient + votesForFreelancer, derived once so all displays agree. */
  totalVotes: number;
  /**
   * The single authoritative gate for the "Finalize & Resolve" button. Every
   * other vote-status display derives from the same `dispute`, so this can never
   * disagree with what's shown elsewhere.
   */
  canResolve: boolean;
}

const DisputeStateContext = createContext<DisputeStateValue | null>(null);

export function DisputeStateProvider({
  disputeId,
  children,
  /** Test seam: skip the SSE subscription (jsdom has no EventSource/stream). */
  disableStream = false,
}: {
  disputeId: string;
  children: ReactNode;
  disableStream?: boolean;
}) {
  const [dispute, setDispute] = useState<Dispute | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Monotonic id of the most recently *issued* fetch. A response carrying an id
  // older than this is out-of-order and must not commit.
  const latestSeq = useRef(0);
  // Epoch-ms of the freshest `updatedAt` already committed. A payload older than
  // this is stale and must not overwrite it.
  const committedUpdatedAt = useRef(0);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  // Reset the guards whenever the dispute being viewed changes.
  useEffect(() => {
    latestSeq.current = 0;
    committedUpdatedAt.current = 0;
    setDispute(null);
    setLoading(true);
    setError(null);
  }, [disputeId]);

  /**
   * Commit an incoming dispute only if it is both the newest request we issued
   * and not older than what we've already shown.
   */
  const commitIfFresher = useCallback((incoming: Dispute, seq: number) => {
    if (!isMounted.current) return;
    // Out-of-order response: a newer fetch has since been issued.
    if (seq < latestSeq.current) return;
    const incomingTs = Date.parse(incoming.updatedAt ?? "");
    // Stale payload: never overwrite fresher data. (A missing/invalid timestamp
    // parses to NaN; `NaN < x` is false, so such payloads are allowed through
    // once the sequence check has passed.)
    if (!Number.isNaN(incomingTs)) {
      if (incomingTs < committedUpdatedAt.current) return;
      committedUpdatedAt.current = incomingTs;
    }
    setDispute(incoming);
  }, []);

  const fetchDispute = useCallback(async () => {
    const seq = ++latestSeq.current;
    try {
      // Must match AuthContext's TOKEN_KEY ("stellarmarket_jwt"); the legacy
      // "token" key is never set, so it would send an unauthenticated request
      // and 401 for every real user (issue #1126 review).
      const token = localStorage.getItem("stellarmarket_jwt");
      const res = await axios.get<Dispute>(`${API_URL}/disputes/${disputeId}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      commitIfFresher(res.data, seq);
      if (isMounted.current) setError(null);
    } catch {
      if (isMounted.current) setError("Failed to fetch dispute details.");
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [disputeId, commitIfFresher]);

  useEffect(() => {
    fetchDispute();
  }, [fetchDispute]);

  // SSE is the primary live-update mechanism: every event triggers ONE
  // coordinated refetch that flows through the same staleness-guarded path.
  const { events, isLive } = useDisputeStream(disputeId, {
    enabled: !disableStream && Boolean(dispute),
    onEvent: () => {
      fetchDispute();
    },
  });

  const totalVotes = dispute
    ? dispute.votesForClient + dispute.votesForFreelancer
    : 0;
  const canResolve =
    !!dispute &&
    totalVotes >= dispute.minVotes &&
    (dispute.status === "OPEN" || dispute.status === "VOTING");

  const value = useMemo<DisputeStateValue>(
    () => ({
      dispute,
      loading,
      error,
      refetch: fetchDispute,
      timelineEvents: events,
      isLive,
      totalVotes,
      canResolve,
    }),
    [dispute, loading, error, fetchDispute, events, isLive, totalVotes, canResolve],
  );

  return (
    <DisputeStateContext.Provider value={value}>
      {children}
    </DisputeStateContext.Provider>
  );
}

/** Read the shared dispute state. Throws if used outside the provider. */
export function useDisputeState(): DisputeStateValue {
  const ctx = useContext(DisputeStateContext);
  if (!ctx) {
    throw new Error("useDisputeState must be used within a DisputeStateProvider");
  }
  return ctx;
}

/**
 * Read the shared dispute state if a provider is present, else `null`. Lets
 * components (e.g. `DisputeVoteProgress`, `ArbitratorVoteView`) subscribe to the
 * shared source when rendered on the dispute page, while remaining usable
 * standalone via their own props.
 */
export function useOptionalDisputeState(): DisputeStateValue | null {
  return useContext(DisputeStateContext);
}
