import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import axios from "axios";
import ReferralsPage from "../page";
import { useAuth } from "@/context/AuthContext";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock("@/context/AuthContext", () => ({
  useAuth: jest.fn(),
}));

describe("ReferralsPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("does not stay in infinite loading state when unauthenticated (token is null)", async () => {
    (useAuth as jest.Mock).mockReturnValue({
      token: null,
      isLoading: false,
    });

    render(<ReferralsPage />);

    // Should stop loading and render the Referrals header and empty state
    await waitFor(() => {
      expect(screen.getByText("Referral Programme")).toBeInTheDocument();
    });

    expect(screen.getByText("No referral code assigned yet.")).toBeInTheDocument();
    expect(screen.getByText("No referrals yet. Share your link to get started!")).toBeInTheDocument();
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it("fetches and renders stats when authenticated", async () => {
    (useAuth as jest.Mock).mockReturnValue({
      token: "valid-token",
      isLoading: false,
    });

    mockedAxios.get.mockResolvedValueOnce({
      data: {
        referralCode: "REF123",
        totalReferrals: 2,
        bonusEarned: 100,
        referrals: [
          { id: "ref-1", username: "user_a", createdAt: "2026-01-01T00:00:00Z" },
        ],
      },
    });

    render(<ReferralsPage />);

    await waitFor(() => {
      expect(screen.getByText("Referral Programme")).toBeInTheDocument();
    });

    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText(/100\s*XLM/)).toBeInTheDocument();
    expect(screen.getByText("user_a")).toBeInTheDocument();

    expect(mockedAxios.get).toHaveBeenCalledWith(
      "http://localhost:5000/api/v1/referrals/stats",
      {
        headers: { Authorization: "Bearer valid-token" },
      }
    );
  });
});
