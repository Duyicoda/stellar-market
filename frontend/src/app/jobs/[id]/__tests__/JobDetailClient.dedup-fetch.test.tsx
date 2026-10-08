/**
 * Tests for #972 (initialData for instant first paint) and its follow-up fix:
 * #972 originally skipped the on-mount fetch entirely whenever initialData
 * was present, to avoid a wasted duplicate request. That's only safe if
 * initialData is trustworthy — but it comes from an unauthenticated
 * server-side fetch (SSR has no access to the browser's auth token), which
 * deliberately returns a reduced public shape missing fields like `status`,
 * `deadline` and `skills`. Skipping the refetch meant a logged-in viewer's
 * own authenticated, complete data never loaded — e.g. the freelancer Apply
 * button stayed hidden because `job.status` looked missing, even after a
 * hard refresh, since a fresh SSR fetch just re-seeds the same reduced data.
 * `refetchOnMount: "always"` fixes that: initialData still gives an instant
 * first paint, but every mount also fetches the real, complete data.
 */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import axios from "axios";

jest.mock("axios", () => ({ get: jest.fn(), put: jest.fn(), isAxiosError: jest.fn() }));
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock("next/navigation", () => ({ useParams: () => ({ id: "job-1" }) }));

jest.mock("@/context/WalletContext", () => ({
  useWallet: () => ({
    address: "GCLIENT_WALLET",
    balances: [],
    signAndBroadcastTransaction: jest.fn(),
  }),
}));

jest.mock("@/context/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "client-1", role: "CLIENT" },
  }),
}));

jest.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: { success: jest.fn(), error: jest.fn() } }),
}));

jest.mock("@/components/ApplyModal", () => () => null);
jest.mock("@/components/RaiseDisputeModal", () => () => null);
jest.mock("@/components/ReviewModal", () => () => null);
jest.mock("@/components/MilestoneTimeline", () => ({
  __esModule: true,
  default: () => null,
  getMilestoneDraftKey: () => "draft",
}));
jest.mock("@/components/MilestoneProgressTracker", () => () => null);
jest.mock("@/components/TransactionConfirmationModal", () => () => null);
jest.mock("@/components/DepositRateInfo", () => () => null);
jest.mock("@/components/ProposeRevisionModal", () => () => null);
jest.mock("@/components/ApproveMilestoneModal", () => () => null);
jest.mock("@/components/ShareMenu", () => () => null);
jest.mock("@/components/StatusBadge", () => ({ status }: { status: string }) => <span>{status}</span>);
jest.mock("@/components/WalletAddress", () => ({ address }: { address: string }) => <span>{address}</span>);
jest.mock("next/link", () => ({ href, children, ...rest }: any) => <a href={href} {...rest}>{children}</a>);
jest.mock("@/utils/stellar", () => ({ parseJobIdFromResult: jest.fn() }));
jest.mock("@/constants/jobs", () => ({
  PAYMENT_TOKENS: ["XLM"],
  TOKEN_EXCHANGE_RATES: { XLM: 1 },
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Job } from "@/types";

function makeApp(children: React.ReactNode, queryClient?: QueryClient) {
  const qc = queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function buildJob(override: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    title: "Test Job",
    description: "Desc",
    budget: 100,
    category: "Dev",
    skills: [],
    status: "OPEN",
    escrowStatus: "UNFUNDED",
    contractJobId: undefined,
    createdAt: new Date().toISOString(),
    deadline: new Date().toISOString(),
    client: { id: "client-1", username: "Client", walletAddress: "GCLIENT_WALLET", bio: "", role: "CLIENT" },
    freelancer: undefined,
    milestones: [],
    revisionProposal: null,
    ...override,
  };
}

describe("JobDetailClient initialData + refetch-on-mount", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("paints instantly from initialData, then replaces it with the authenticated fetch", async () => {
    mockedAxios.get.mockImplementation((url: string) => {
      if (url.includes("/jobs/job-1") && !url.includes("applications")) {
        // The real, authenticated fetch returns the complete shape —
        // distinct from the reduced initialJob passed in below.
        return Promise.resolve({ data: buildJob({ title: "Complete Job" }) });
      }
      if (url.includes("/reviews")) {
        return Promise.resolve({ data: { data: [], total: 0 } });
      }
      if (url.includes("/applications")) {
        return Promise.resolve({ data: { data: [], total: 0 } });
      }
      return Promise.resolve({ data: {} });
    });

    // Simulates the reduced public shape SSR would have provided.
    const initialJob = buildJob({ title: "Initial Job" });
    const { default: JobDetailClient } = await import("../JobDetailClient");

    render(makeApp(<JobDetailClient initialJob={initialJob} />));

    // Instant first paint from initialData, before the network call resolves.
    expect(screen.getByText("Initial Job")).toBeInTheDocument();

    // The on-mount refetch replaces it with the real, complete data.
    await waitFor(() => {
      expect(screen.getByText("Complete Job")).toBeInTheDocument();
    });

    const jobCalls = mockedAxios.get.mock.calls.filter(
      ([url]) => url.includes("/jobs/job-1") && !url.includes("applications"),
    );
    expect(jobCalls).toHaveLength(1);
  });

  it("still re-fetches again when the query is explicitly invalidated (live refresh)", async () => {
    let callCount = 0;
    mockedAxios.get.mockImplementation((url: string) => {
      if (url.includes("/jobs/job-1") && !url.includes("applications")) {
        callCount += 1;
        return Promise.resolve({
          data: buildJob({ title: callCount === 1 ? "Complete Job" : "Updated Job" }),
        });
      }
      if (url.includes("/reviews")) {
        return Promise.resolve({ data: { data: [], total: 0 } });
      }
      if (url.includes("/applications")) {
        return Promise.resolve({ data: { data: [], total: 0 } });
      }
      return Promise.resolve({ data: {} });
    });

    const initialJob = buildJob({ title: "Initial Job" });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { default: JobDetailClient } = await import("../JobDetailClient");

    render(makeApp(<JobDetailClient initialJob={initialJob} />, queryClient));

    // Mount-triggered refetch resolves first.
    await waitFor(() => {
      expect(screen.getByText("Complete Job")).toBeInTheDocument();
    });

    // Invalidate the job query to simulate a live refresh trigger.
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["job", "job-1"] });
    });

    await waitFor(() => {
      expect(screen.getByText("Updated Job")).toBeInTheDocument();
    });

    // One fetch on mount, one more from the explicit invalidation.
    const jobCalls = mockedAxios.get.mock.calls.filter(
      ([url]) => url.includes("/jobs/job-1") && !url.includes("applications"),
    );
    expect(jobCalls).toHaveLength(2);
  });
});
