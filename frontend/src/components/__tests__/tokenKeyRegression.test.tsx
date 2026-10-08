import "@testing-library/jest-dom";
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import DeadlineExtensionApprovalCard from "@/components/DeadlineExtensionApprovalCard";
import DeadlineExtensionModal from "@/components/DeadlineExtensionModal";
import { useDisputeStream } from "@/hooks/useDisputeStream";
import axios from "axios";

jest.mock("axios");
const mockedAxios = jest.mocked(axios);

describe("auth token key regression", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("stellarmarket_jwt", "mock-token");
    mockedAxios.post.mockReset();
    mockedAxios.post.mockResolvedValue({ data: {} });
  });

  afterEach(() => {
    localStorage.clear();
    jest.restoreAllMocks();
  });

  it("useDisputeStream reads the stellarmarket_jwt key", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => ({ done: true, value: undefined }),
        }),
      },
    });
    global.fetch = fetchMock as typeof fetch;

    renderHook(() => useDisputeStream("dispute-123"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: expect.objectContaining({
        Authorization: "Bearer mock-token",
      }),
    });
  });

  it("DeadlineExtensionModal submits with the stellarmarket_jwt key", async () => {
    const milestone = {
      id: "milestone-1",
      jobId: "job-1",
      title: "Design milestone",
      description: "Need more time",
      amount: 100,
      status: "IN_PROGRESS" as const,
      order: 1,
      contractDeadline: new Date(Date.now() + 1000 * 60 * 60 * 24 * 2).toISOString(),
    };

    render(
      <DeadlineExtensionModal
        milestone={milestone}
        jobId="job-1"
        isOpen={true}
        onClose={jest.fn()}
        onSuccess={jest.fn()}
      />,
    );

    const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24 * 5)
      .toISOString()
      .slice(0, 16);

    fireEvent.change(screen.getByLabelText("New Deadline *"), {
      target: { value: futureDate },
    });
    fireEvent.change(screen.getByLabelText("Reason for Extension *"), {
      target: { value: "Need extra time to finish the review." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Request Extension" }));

    await waitFor(() => expect(mockedAxios.post).toHaveBeenCalledTimes(1));
    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        milestoneId: "milestone-1",
        jobId: "job-1",
      }),
      expect.objectContaining({
        headers: { Authorization: "Bearer mock-token" },
      }),
    );
  });

  it("DeadlineExtensionApprovalCard approves with the stellarmarket_jwt key", async () => {
    render(
      <DeadlineExtensionApprovalCard
        extensionRequest={{
          id: "request-1",
          milestone: { id: "milestone-1", title: "Design milestone" },
          requestedBy: { id: "user-2", username: "bob" },
          newDeadline: new Date(Date.now() + 1000 * 60 * 60 * 24 * 3).toISOString(),
          reason: "Need more time",
          status: "PENDING",
        }}
        userRole="client"
        onApprove={jest.fn()}
        onReject={jest.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /approve/i }));

    await waitFor(() => expect(mockedAxios.post).toHaveBeenCalledTimes(1));
    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.stringContaining("/deadline-extensions/request-1/approve"),
      {},
      expect.objectContaining({
        headers: { Authorization: "Bearer mock-token" },
      }),
    );
  });

  it("DeadlineExtensionApprovalCard rejects with the stellarmarket_jwt key", async () => {
    render(
      <DeadlineExtensionApprovalCard
        extensionRequest={{
          id: "request-1",
          milestone: { id: "milestone-1", title: "Design milestone" },
          requestedBy: { id: "user-2", username: "bob" },
          newDeadline: new Date(Date.now() + 1000 * 60 * 60 * 24 * 3).toISOString(),
          reason: "Need more time",
          status: "PENDING",
        }}
        userRole="client"
        onApprove={jest.fn()}
        onReject={jest.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /reject/i }));
    const rejectionInput = document.querySelector("textarea");
    if (!rejectionInput) {
      throw new Error("Reject textarea did not render");
    }
    fireEvent.change(rejectionInput, {
      target: { value: "I cannot approve this extension." },
    });
    fireEvent.click(screen.getByRole("button", { name: /confirm rejection/i }));

    await waitFor(() => expect(mockedAxios.post).toHaveBeenCalledTimes(1));
    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.stringContaining("/deadline-extensions/request-1/reject"),
      { rejectionReason: "I cannot approve this extension." },
      expect.objectContaining({
        headers: { Authorization: "Bearer mock-token" },
      }),
    );
  });
});
