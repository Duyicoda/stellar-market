import { render, screen } from "@testing-library/react";
import JobHistory from "../JobHistory.server";

describe("JobHistory", () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it("renders jobs from the paginated API response", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: "job-1", title: "Build a Stellar integration" }],
        total: 1,
        page: 1,
        totalPages: 1,
      }),
    } as Response);

    render(
      await JobHistory({
        userPromise: Promise.resolve({ id: "user-1" }),
      }),
    );

    expect(screen.getByText("Build a Stellar integration")).toBeInTheDocument();
    expect(screen.queryByText("No jobs yet.")).not.toBeInTheDocument();
  });

  it("renders the empty state when the request fails", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false } as Response);

    render(
      await JobHistory({
        userPromise: Promise.resolve({ id: "user-1" }),
      }),
    );

    expect(screen.getByText("No jobs yet.")).toBeInTheDocument();
  });
});
