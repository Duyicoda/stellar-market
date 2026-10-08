/**
 * Regression test: the "Total Budget" shown on the Milestones step and the
 * Preview step used a useMemo keyed on `watch("milestones")`. watch() isn't
 * guaranteed to return a new array reference on every render it's read in,
 * so the memo compared equal by reference against genuinely-changed content
 * and silently kept a stale sum — editing a second milestone's amount never
 * updated the displayed total. Fixed by computing the sum inline (no memo).
 */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";

jest.mock("axios", () => ({
  post: jest.fn(),
  isAxiosError: (e: unknown) => Boolean((e as { isAxiosError?: boolean })?.isAxiosError),
}));

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

jest.mock("@/context/AuthContext", () => ({
  useAuth: () => ({ user: { id: "client-1", role: "CLIENT" }, isLoading: false }),
}));

jest.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: { success: jest.fn(), error: jest.fn() } }),
}));

jest.mock("@/components/SkillCombobox", () => ({
  __esModule: true,
  default: ({ onChange }: { onChange: (s: string[]) => void }) => {
    React.useEffect(() => { onChange(["React"]); }, []);
    return null;
  },
}));

import JobWizard from "@/app/post-job/JobWizard";

const futureDate = (days: number) => {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return d.toISOString().split("T")[0];
};

test("Total Budget reflects both milestones' amounts after editing the second one", async () => {
  localStorage.clear();
  localStorage.setItem("stellarmarket_jwt", "test-token");

  render(<JobWizard />);

  const textboxes = screen.getAllByRole("textbox");
  fireEvent.change(textboxes[0], { target: { value: "Build a landing page with Tailwind CSS" } });
  fireEvent.change(textboxes[1], {
    target: { value: "Need a responsive landing page built with Next.js and Tailwind CSS matching a design." },
  });
  fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "Frontend" } });
  fireEvent.change(document.querySelectorAll('input[type="date"]')[0], { target: { value: futureDate(14) } });

  fireEvent.click(screen.getByText(/Next: Milestones & Budget/i));
  await screen.findByRole("heading", { name: "Milestones & Budget" });

  // Milestone 1
  let numberInputs = document.querySelectorAll('input[type="number"]');
  let allTextboxes = screen.getAllByRole("textbox");
  let allDateInputs = document.querySelectorAll('input[type="date"]');
  fireEvent.change(allTextboxes[allTextboxes.length - 2], { target: { value: "Design mockup approval" } });
  fireEvent.change(allTextboxes[allTextboxes.length - 1], { target: { value: "Convert Figma design into HTML/CSS" } });
  fireEvent.change(numberInputs[0], { target: { value: "100" } });
  fireEvent.change(allDateInputs[allDateInputs.length - 1], { target: { value: futureDate(7) } });

  // Add and fill milestone 2
  fireEvent.click(screen.getByText(/Add Milestone/i));
  allTextboxes = screen.getAllByRole("textbox");
  numberInputs = document.querySelectorAll('input[type="number"]');
  allDateInputs = document.querySelectorAll('input[type="date"]');
  fireEvent.change(allTextboxes[allTextboxes.length - 2], { target: { value: "Final implementation" } });
  fireEvent.change(allTextboxes[allTextboxes.length - 1], { target: { value: "Complete responsive build" } });
  fireEvent.change(numberInputs[1], { target: { value: "150" } });
  fireEvent.change(allDateInputs[allDateInputs.length - 1], { target: { value: futureDate(14) } });

  // 100 + 150 = 250, not 100 (the bug: total stuck at only the first milestone's amount)
  await screen.findByText("250 XLM");

  fireEvent.click(screen.getByText(/Preview & Publish/i));
  await screen.findByText("Publish Job");
  expect(screen.getByText("250 XLM")).toBeInTheDocument();
});
