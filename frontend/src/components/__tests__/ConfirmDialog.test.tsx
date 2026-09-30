/**
 * ConfirmDialog — accessible confirmation for destructive actions.
 *
 * Mirrors the modal contract already covered by modalEscape.test.tsx (#819):
 * dialog semantics, Escape to dismiss, focus trapped inside and restored to the
 * trigger, and clicks no longer escaping to clickable ancestors.
 */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import ConfirmDialog from "@/components/ConfirmDialog";

function renderDialog(
  overrides: Partial<React.ComponentProps<typeof ConfirmDialog>> = {},
) {
  const onConfirm = jest.fn();
  const onCancel = jest.fn();

  render(
    <ConfirmDialog
      isOpen
      title="Delete notification?"
      description="This action cannot be undone."
      confirmLabel="Delete"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...overrides}
    />,
  );

  return { onConfirm, onCancel };
}

describe("ConfirmDialog", () => {
  it("renders nothing while closed", () => {
    renderDialog({ isOpen: false });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("exposes dialog semantics wired to its title and description", () => {
    renderDialog();

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("Delete notification?");
    expect(dialog).toHaveAccessibleDescription("This action cannot be undone.");
  });

  it("focuses Cancel first so a stray Enter cannot confirm by accident", () => {
    renderDialog();

    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("calls onConfirm only when the confirm button is used", () => {
    const { onConfirm, onCancel } = renderDialog();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    });

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("cancels via the cancel button", () => {
    const { onConfirm, onCancel } = renderDialog();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("cancels via the close button", () => {
    const { onCancel } = renderDialog();

    act(() => {
      fireEvent.click(screen.getByLabelText("Close confirmation dialog"));
    });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("cancels when the backdrop is clicked", () => {
    const { onCancel } = renderDialog();

    const backdrop = document.querySelector('[aria-hidden="true"]');
    expect(backdrop).not.toBeNull();

    act(() => {
      fireEvent.click(backdrop as Element);
    });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("dismisses on Escape", () => {
    const { onCancel } = renderDialog();

    act(() => {
      fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("stops clicks from bubbling to clickable ancestors", () => {
    const ancestorClick = jest.fn();
    const onConfirm = jest.fn();

    render(
      <div onClick={ancestorClick}>
        <ConfirmDialog
          isOpen
          title="Delete notification?"
          onConfirm={onConfirm}
          onCancel={jest.fn()}
        />
      </div>,
    );

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    });

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(ancestorClick).not.toHaveBeenCalled();
  });
});
