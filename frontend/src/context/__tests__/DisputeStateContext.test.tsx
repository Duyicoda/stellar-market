/**
 * Tests for #1126: a single shared source of truth for dispute/vote state, with
 * staleness guards so a stale/out-of-order response can never overwrite fresher
 * data, and so the resolve-button gate can never disagree with other displays.
 */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen, act, waitFor } from "@testing-library/react";
import axios from "axios";

jest.mock("axios", () => ({ get: jest.fn(), isAxiosError: jest.fn() }));
const mockedAxios = axios as jest.Mocked<typeof axios>;

// The SSE hook is exercised separately; here we disable the stream and drive
// refetches explicitly so we can control response ordering deterministically.
jest.mock("@/hooks/useDisputeStream", () => ({
  useDisputeStream: () => ({ events: [], isLive: false }),
}));

import {
  DisputeStateProvider,
  useDisputeState,
} from "@/context/DisputeStateContext";
import DisputeVoteProgress from "@/components/DisputeVoteProgress";
import type { Dispute } from "@/types";

function makeDispute(over: Partial<Dispute> = {}): Dispute {
  return {
    id: "d1",
    jobId: "job-1",
    contractDisputeId: undefined,
    initiatorId: "u1",
    respondentId: "u2",
    reason: "Test dispute reason",
    status: "VOTING",
    votesForClient: 0,
    votesForFreelancer: 0,
    minVotes: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    job: { id: "job-1", title: "Test Job" } as unknown as Dispute["job"],
    initiator: { id: "u1", username: "client", walletAddress: "GABC" } as unknown as Dispute["initiator"],
    respondent: { id: "u2", username: "freelancer", walletAddress: "GDEF" } as unknown as Dispute["respondent"],
    votes: [],
    ...over,
  } as Dispute;
}

/** A deferred promise so a test can resolve axios responses out of order. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Harness that surfaces the shared gate + a refetch trigger and the sidebar. */
function Harness() {
  const { dispute, totalVotes, canResolve, refetch } = useDisputeState();
  return (
    <div>
      <span data-testid="total">{totalVotes}</span>
      <span data-testid="can-resolve">{canResolve ? "yes" : "no"}</span>
      <span data-testid="status">{dispute?.status ?? "none"}</span>
      <button onClick={() => refetch()}>refetch</button>
      {/* The sidebar reads the SAME shared state (no props). */}
      <DisputeVoteProgress />
    </div>
  );
}

function renderProvider() {
  return render(
    <DisputeStateProvider disputeId="d1" disableStream>
      <Harness />
    </DisputeStateProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.setItem("token", "t");
});

describe("DisputeStateContext — single source of truth (#1126)", () => {
  it("hydrates all consumers from one fetch", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: makeDispute({ votesForClient: 2, votesForFreelancer: 1, minVotes: 3 }),
    });

    renderProvider();

    await waitFor(() =>
      expect(screen.getByTestId("total")).toHaveTextContent("3"),
    );
    // The gate says resolvable...
    expect(screen.getByTestId("can-resolve")).toHaveTextContent("yes");
    // ...and the sidebar (same source) agrees.
    expect(screen.getByText("Ready to resolve")).toBeInTheDocument();
  });

  it("discards an out-of-order (stale) response so it cannot overwrite fresher data", async () => {
    // Initial load: 0 votes.
    mockedAxios.get.mockResolvedValueOnce({ data: makeDispute() });
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("total")).toHaveTextContent("0"));

    // Two refetches issued back-to-back. The FIRST is slow (stale, older
    // updatedAt) and the SECOND is fast (fresh, newer updatedAt). The fresh one
    // resolves first and commits; the stale one resolves later and must be
    // dropped by the sequence guard.
    const slowStale = deferred<{ data: Dispute }>();
    const fastFresh = deferred<{ data: Dispute }>();
    mockedAxios.get
      .mockReturnValueOnce(slowStale.promise as never)
      .mockReturnValueOnce(fastFresh.promise as never);

    await act(async () => {
      screen.getByText("refetch").click(); // issues seq=2 (slowStale)
      screen.getByText("refetch").click(); // issues seq=3 (fastFresh)
    });

    // Fresh response (5 votes, newer timestamp) resolves first → committed.
    await act(async () => {
      fastFresh.resolve({
        data: makeDispute({
          votesForClient: 3,
          votesForFreelancer: 2,
          updatedAt: "2026-01-01T00:05:00.000Z",
        }),
      });
    });
    await waitFor(() => expect(screen.getByTestId("total")).toHaveTextContent("5"));

    // Stale response (1 vote, older timestamp) resolves late → MUST be ignored.
    await act(async () => {
      slowStale.resolve({
        data: makeDispute({
          votesForClient: 1,
          votesForFreelancer: 0,
          updatedAt: "2026-01-01T00:01:00.000Z",
        }),
      });
    });

    // Still shows the fresher data; the stale late arrival did not clobber it.
    await waitFor(() => expect(screen.getByTestId("total")).toHaveTextContent("5"));
    expect(screen.getByTestId("total")).toHaveTextContent("5");
  });

  it("keeps the resolve gate and the sidebar in agreement across an update", async () => {
    // Start below quorum: gate off, sidebar shows 'more votes needed'.
    mockedAxios.get.mockResolvedValueOnce({
      data: makeDispute({ votesForClient: 1, votesForFreelancer: 0, minVotes: 3 }),
    });
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("can-resolve")).toHaveTextContent("no"));
    expect(screen.getByText(/more votes needed/)).toBeInTheDocument();

    // A refetch crosses quorum: both must flip together (one source).
    mockedAxios.get.mockResolvedValueOnce({
      data: makeDispute({
        votesForClient: 2,
        votesForFreelancer: 1,
        minVotes: 3,
        updatedAt: "2026-01-01T01:00:00.000Z",
      }),
    });
    await act(async () => {
      screen.getByText("refetch").click();
    });

    await waitFor(() => expect(screen.getByTestId("can-resolve")).toHaveTextContent("yes"));
    // The sidebar, reading the same source, now shows 'Ready to resolve' too.
    expect(screen.getByText("Ready to resolve")).toBeInTheDocument();
    // They can never be in the contradictory state the issue describes.
    expect(screen.queryByText(/more votes needed/)).not.toBeInTheDocument();
  });

  it("recovers on SSE reconnection: a refetch after reconnect updates all consumers", async () => {
    // Simulates the reconnection case — after the stream drops and comes back,
    // the provider's onEvent refetch (here invoked explicitly) reconciles state.
    mockedAxios.get.mockResolvedValueOnce({
      data: makeDispute({ votesForClient: 0, votesForFreelancer: 0 }),
    });
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("total")).toHaveTextContent("0"));

    mockedAxios.get.mockResolvedValueOnce({
      data: makeDispute({
        votesForClient: 3,
        votesForFreelancer: 0,
        status: "RESOLVED_CLIENT",
        updatedAt: "2026-01-01T02:00:00.000Z",
      }),
    });
    await act(async () => {
      screen.getByText("refetch").click();
    });

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("RESOLVED_CLIENT"));
    expect(screen.getByTestId("total")).toHaveTextContent("3");
    // Resolved disputes are no longer resolvable via the gate.
    expect(screen.getByTestId("can-resolve")).toHaveTextContent("no");
  });
});
