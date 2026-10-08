import "@testing-library/jest-dom";
import { act, render, screen } from "@testing-library/react";
import {
  DisputeOpenedElapsed,
  VoteDeadlineCountdown,
  formatElapsed,
  formatVoteCountdown,
} from "@/components/DisputeElapsedTime";

const NOW = new Date("2026-06-15T12:00:00Z");

describe("formatElapsed", () => {
  it('shows "Opened 3 days ago" for a dispute opened 3 days ago', () => {
    const openedAt = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatElapsed(openedAt, NOW)).toBe("Opened 3 days ago");
  });

  it('shows "Opened just now" for a dispute opened seconds ago', () => {
    const openedAt = new Date(NOW.getTime() - 5000).toISOString();
    expect(formatElapsed(openedAt, NOW)).toBe("Opened just now");
  });

  it('shows hours when under a day old', () => {
    const openedAt = new Date(NOW.getTime() - 5 * 60 * 60 * 1000).toISOString();
    expect(formatElapsed(openedAt, NOW)).toBe("Opened 5 hours ago");
  });
});

describe("formatVoteCountdown", () => {
  it('shows amber-eligible "Vote closes in 2 hours" for a deadline 2 hours away', () => {
    const deadline = new Date(NOW.getTime() + 2 * 60 * 60 * 1000).toISOString();
    const result = formatVoteCountdown(deadline, NOW);
    expect(result.text).toBe("Vote closes in 2 hours");
    expect(result.urgent).toBe(true);
  });

  it("is not urgent when the deadline is more than 24 hours away", () => {
    const deadline = new Date(NOW.getTime() + 48 * 60 * 60 * 1000).toISOString();
    const result = formatVoteCountdown(deadline, NOW);
    expect(result.text).toBe("Vote closes in 2 days");
    expect(result.urgent).toBe(false);
  });

  it("reports expired once the deadline has passed", () => {
    const deadline = new Date(NOW.getTime() - 60 * 1000).toISOString();
    const result = formatVoteCountdown(deadline, NOW);
    expect(result.expired).toBe(true);
    expect(result.urgent).toBe(true);
  });
});

describe("DisputeOpenedElapsed component", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  it('renders "Opened 3 days ago" for a dispute opened 3 days ago', () => {
    const openedAt = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    render(<DisputeOpenedElapsed isoString={openedAt} />);
    expect(screen.getByRole("time")).toHaveTextContent("Opened 3 days ago");
  });

  it("updates the displayed text every minute without unmounting", () => {
    const openedAt = new Date(NOW.getTime() - 59 * 60 * 1000).toISOString();
    render(<DisputeOpenedElapsed isoString={openedAt} />);
    expect(screen.getByRole("time")).toHaveTextContent("Opened 59 minutes ago");

    act(() => {
      jest.setSystemTime(new Date(NOW.getTime() + 2 * 60 * 1000));
      jest.advanceTimersByTime(60_000);
    });

    expect(screen.getByRole("time")).toHaveTextContent("Opened 1 hour ago");
  });
});

describe("VoteDeadlineCountdown component", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  it('shows amber "Vote closes in 2 hours" when the deadline is under 24 hours away', () => {
    const deadline = new Date(NOW.getTime() + 2 * 60 * 60 * 1000).toISOString();
    render(<VoteDeadlineCountdown deadlineIso={deadline} />);

    const el = screen.getByText("Vote closes in 2 hours");
    expect(el).toHaveClass("text-theme-warning");
  });

  it("does not use the amber styling when the deadline is more than 24 hours away", () => {
    const deadline = new Date(NOW.getTime() + 48 * 60 * 60 * 1000).toISOString();
    render(<VoteDeadlineCountdown deadlineIso={deadline} />);

    const el = screen.getByText("Vote closes in 2 days");
    expect(el).not.toHaveClass("text-theme-warning");
  });
});
