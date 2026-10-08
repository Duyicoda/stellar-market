/**
 * Tests for #1125: JobWizard uses an atomic, idempotent job+milestone creation
 * call, and manages the localStorage draft lifecycle so a partial/failed publish
 * is never lost and a retry never produces a duplicate job.
 */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import axios from "axios";

jest.mock("axios", () => ({
  post: jest.fn(),
  isAxiosError: (e: unknown) => Boolean((e as { isAxiosError?: boolean })?.isAxiosError),
}));
const mockedAxios = axios as jest.Mocked<typeof axios>;

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
}));

jest.mock("@/context/AuthContext", () => ({
  useAuth: () => ({ user: { id: "client-1", role: "CLIENT" }, isLoading: false }),
}));

jest.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: { success: jest.fn(), error: jest.fn() } }),
}));

// SkillCombobox pulls in async data we don't need here.
jest.mock("@/components/SkillCombobox", () => ({
  __esModule: true,
  default: () => null,
}));

import JobWizard from "../JobWizard";

const STORAGE_KEY = "job-wizard-draft";
const IDEMPOTENCY_KEY_STORAGE = "job-wizard-idempotency-key";
const ATOMIC_ENDPOINT = "/jobs/with-milestones";

/** Shape of the atomic-create request body the wizard sends. */
type AtomicJobBody = {
  milestones: unknown[];
  idempotencyKey: string;
};
/** Read the request body of the Nth axios.post call, typed. */
function postBody(callIndex: number): AtomicJobBody {
  return mockedAxios.post.mock.calls[callIndex][1] as AtomicJobBody;
}

const futureDate = (days: number) => {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return d.toISOString().split("T")[0]; // YYYY-MM-DD, matches the date inputs
};

/** A complete, valid draft so the wizard mounts pre-filled and can be submitted. */
function seedValidDraft() {
  const formData = {
    title: "Build a Soroban DEX frontend interface",
    description:
      "Develop a responsive Stellar dApp frontend with full escrow integration and a complete test suite.",
    category: "Frontend",
    deadline: futureDate(30),
    milestones: [
      { title: "Wireframes", description: "Design all the screens", amount: "100", deadline: futureDate(7) },
      { title: "Implementation", description: "Build all the components", amount: "200", deadline: futureDate(14) },
      { title: "Testing", description: "Write the full test suite", amount: "150", deadline: futureDate(21) },
    ],
  };
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ formData, skills: ["React", "TypeScript"], paymentToken: "XLM" }),
  );
}

/** Drive the wizard from step 1 → 3 and click Publish. */
async function publish() {
  render(<JobWizard />);
  fireEvent.click(screen.getByText(/Next: Milestones & Budget/i));
  await screen.findByText(/Preview & Publish/i);
  fireEvent.click(screen.getByText(/Preview & Publish/i));
  await screen.findByText("Publish Job");
  fireEvent.click(screen.getByText("Publish Job"));
}

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  localStorage.setItem("token", "test-token");
  seedValidDraft();
});

describe("JobWizard — atomic job creation (#1125)", () => {
  it("submits a single atomic call with all milestones and an idempotency key", async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { id: "job-1" } });

    await publish();

    await waitFor(() => expect(mockedAxios.post).toHaveBeenCalledTimes(1));
    const url = mockedAxios.post.mock.calls[0][0];
    const body = postBody(0);
    expect(url).toContain(ATOMIC_ENDPOINT);
    // All milestones sent in one payload — no N+1 loop.
    expect(body.milestones).toHaveLength(3);
    expect(body.idempotencyKey).toBeTruthy();
    // Navigated to the created job.
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/jobs/job-1"));
  });

  it("clears the draft and idempotency key only after a confirmed success", async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { id: "job-1" } });

    await publish();

    await waitFor(() => expect(mockPush).toHaveBeenCalled());
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(IDEMPOTENCY_KEY_STORAGE)).toBeNull();
  });

  it("preserves the draft (and does not navigate) when creation fails", async () => {
    mockedAxios.post.mockRejectedValueOnce({
      isAxiosError: true,
      response: { data: { error: "boom" } },
    });

    await publish();

    await waitFor(() => expect(screen.getByText("boom")).toBeInTheDocument());
    // The draft survives a failure so nothing the user typed is lost.
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    // The idempotency key is retained so a retry reuses it.
    expect(localStorage.getItem(IDEMPOTENCY_KEY_STORAGE)).not.toBeNull();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("reuses the same idempotency key on retry after a failure (no duplicate job)", async () => {
    // First publish fails...
    mockedAxios.post.mockRejectedValueOnce({
      isAxiosError: true,
      response: { data: { error: "temporary failure" } },
    });
    await publish();
    await waitFor(() => expect(screen.getByText("temporary failure")).toBeInTheDocument());

    const firstKey = postBody(0).idempotencyKey;
    expect(firstKey).toBeTruthy();

    // ...user clicks Publish again; the retry succeeds.
    mockedAxios.post.mockResolvedValueOnce({ data: { id: "job-1" } });
    fireEvent.click(screen.getByText("Publish Job"));

    await waitFor(() => expect(mockedAxios.post).toHaveBeenCalledTimes(2));
    const secondKey = postBody(1).idempotencyKey;

    // Same key on both attempts → the backend treats the retry as the same
    // request and cannot create a second job.
    expect(secondKey).toBe(firstKey);

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/jobs/job-1"));
    // After the confirmed success, the key is finally cleared.
    expect(localStorage.getItem(IDEMPOTENCY_KEY_STORAGE)).toBeNull();
  });
});
