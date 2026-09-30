import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

import ThemeToggleButton from "@/components/ThemeToggleButton";

// The button reads its state from ThemeContext, so mock the hook rather than
// pulling in next-themes and the real provider: this test is about the label
// the component derives from `theme`, not about how the theme is stored.
const mockToggleTheme = jest.fn();
let mockTheme: "dark" | "light" = "light";

jest.mock("@/context/ThemeContext", () => ({
  useTheme: () => ({ theme: mockTheme, toggleTheme: mockToggleTheme }),
}));

describe("ThemeToggleButton aria-label", () => {
  beforeEach(() => {
    mockToggleTheme.mockClear();
  });

  it("announces the action it will perform, based on the current theme", () => {
    mockTheme = "dark";
    const { rerender } = render(<ThemeToggleButton />);
    // In dark mode the control switches you to light, so it must say so.
    expect(
      screen.getByRole("button", { name: "Switch to light mode" })
    ).toBeInTheDocument();

    mockTheme = "light";
    rerender(<ThemeToggleButton />);
    expect(
      screen.getByRole("button", { name: "Switch to dark mode" })
    ).toBeInTheDocument();
  });

  it("never exposes the old static 'Toggle theme' label", () => {
    for (const theme of ["dark", "light"] as const) {
      mockTheme = theme;
      const { unmount } = render(<ThemeToggleButton />);
      expect(screen.queryByLabelText("Toggle theme")).not.toBeInTheDocument();
      unmount();
    }
  });

  it("keeps the control a single focusable button with no visual change", () => {
    mockTheme = "light";
    const { container } = render(<ThemeToggleButton />);

    const button = screen.getByRole("button");
    expect(container.querySelectorAll("button")).toHaveLength(1);
    // The fix must not alter layout/appearance: the class list is untouched.
    expect(button.className).toContain("p-2");
    expect(button.className).toContain("rounded-lg");
  });
});
