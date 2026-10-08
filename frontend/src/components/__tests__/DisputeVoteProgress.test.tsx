import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import DisputeVoteProgress from "../DisputeVoteProgress";
import type { Dispute } from "@/types";

// #1126: the component now reads from the shared dispute state (or an explicit
// `initialDispute` prop) instead of its own poll. These tests feed the dispute
// via `initialDispute`, exercising the identical rendering logic.
describe("DisputeVoteProgress", () => {
  const mockDispute = {
    id: "1",
    jobId: "job-1",
    initiatorId: "user-1",
    respondentId: "user-2",
    reason: "Test dispute",
    status: "VOTING" as const,
    votesForClient: 2,
    votesForFreelancer: 3,
    minVotes: 5,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    job: {
      id: "job-1",
      title: "Test Job",
      budget: 1000,
    },
    initiator: {
      id: "user-1",
      username: "client",
      walletAddress: "GABC123",
    },
    respondent: {
      id: "user-2",
      username: "freelancer",
      walletAddress: "GDEF456",
    },
    votes: [
      {
        id: "vote-1",
        disputeId: "1",
        voterId: "voter-1",
        choice: "CLIENT" as const,
        reason: "Client is right",
        createdAt: new Date().toISOString(),
        voter: {
          id: "voter-1",
          username: "voter1",
          walletAddress: "GVOTAT123",
        },
      },
      {
        id: "vote-2",
        disputeId: "1",
        voterId: "voter-2",
        choice: "FREELANCER" as const,
        reason: "Freelancer is right",
        createdAt: new Date().toISOString(),
        voter: {
          id: "voter-2",
          username: "voter2",
          walletAddress: "GVOTAT456",
        },
      },
    ],
  } as unknown as Dispute;

  it("renders loading state initially", () => {
    const { container } = render(<DisputeVoteProgress />);

    expect(container.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  it("displays vote counts correctly", async () => {
    render(<DisputeVoteProgress initialDispute={mockDispute} />);

    await waitFor(() => {
      expect(screen.getByText("5")).toBeInTheDocument(); // totalVotes
      expect(screen.getByText("/ 5")).toBeInTheDocument(); // minVotes
      expect(screen.getByText("Client (2)")).toBeInTheDocument();
      expect(screen.getByText("Freelancer (3)")).toBeInTheDocument();
    });
  });

  it("shows correct progress percentage", async () => {
    render(<DisputeVoteProgress initialDispute={mockDispute} />);

    await waitFor(() => {
      expect(screen.getByText("100%")).toBeInTheDocument(); // 5/5 votes = 100%
    });
  });

  it("displays 'Ready to resolve' when minimum votes reached", async () => {
    render(<DisputeVoteProgress initialDispute={mockDispute} />);

    await waitFor(() => {
      expect(screen.getByText("Ready to resolve")).toBeInTheDocument();
    });
  });

  it("displays votes remaining when below minimum", async () => {
    const disputeNeedingVotes = {
      ...mockDispute,
      votesForClient: 1,
      votesForFreelancer: 1,
    };

    render(<DisputeVoteProgress initialDispute={disputeNeedingVotes} />);

    await waitFor(() => {
      expect(screen.getByText("3 more votes needed")).toBeInTheDocument();
    });
  });

  it("anonymizes voter addresses when showVoterDetails is true", async () => {
    render(<DisputeVoteProgress initialDispute={mockDispute} showVoterDetails={true} />);

    await waitFor(() => {
      expect(screen.getByText("Recent Voters (Anonymized)")).toBeInTheDocument();
      expect(screen.getByText("GVOT...T123")).toBeInTheDocument();
      expect(screen.getByText("GVOT...T456")).toBeInTheDocument();
    });
  });

  it("does not show voter details when showVoterDetails is false", async () => {
    render(<DisputeVoteProgress initialDispute={mockDispute} showVoterDetails={false} />);

    await waitFor(() => {
      expect(screen.queryByText("Recent Voters (Anonymized)")).not.toBeInTheDocument();
    });
  });
});
