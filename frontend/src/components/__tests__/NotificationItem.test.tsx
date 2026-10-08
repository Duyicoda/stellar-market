/**
 * NotificationItem — delete confirmation.
 *
 * Regression: the trash button used to call `onDelete` immediately, so a single
 * stray click permanently destroyed a notification. It now opens a confirmation
 * dialog first; `onDelete` only fires once the user explicitly confirms.
 */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import NotificationItem from "@/components/NotificationItem";
import type { Notification } from "@/types";

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
    [key: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const notification: Notification = {
  id: "n1",
  userId: "u1",
  type: "NEW_MESSAGE",
  title: "New message from alice",
  message: "Hey, are you available?",
  read: false,
  createdAt: new Date("2026-01-01T10:00:00.000Z").toISOString(),
  metadata: { jobId: "j1" },
};

function renderItem(onDelete?: (n: Notification) => void) {
  return render(
    <NotificationItem notification={notification} onDelete={onDelete} />,
  );
}

function openConfirmation() {
  act(() => {
    fireEvent.click(screen.getByLabelText("Delete notification"));
  });
}

describe("NotificationItem delete confirmation", () => {
  it("renders no delete button when no onDelete handler is provided", () => {
    renderItem();

    expect(
      screen.queryByLabelText("Delete notification"),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("asks for confirmation instead of deleting immediately", () => {
    const onDelete = jest.fn();
    renderItem(onDelete);

    openConfirmation();

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Delete notification?")).toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("deletes the notification once the user confirms", () => {
    const onDelete = jest.fn();
    renderItem(onDelete);

    openConfirmation();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    });

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith(notification);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("leaves the notification untouched when the user cancels", () => {
    const onDelete = jest.fn();
    renderItem(onDelete);

    openConfirmation();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });

    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("dismisses the confirmation on Escape without deleting", () => {
    const onDelete = jest.fn();
    renderItem(onDelete);

    openConfirmation();
    act(() => {
      fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    });

    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("returns focus to the trash button after the confirmation closes", () => {
    const onDelete = jest.fn();
    renderItem(onDelete);

    const trash = screen.getByLabelText("Delete notification");
    trash.focus();
    openConfirmation();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });

    expect(trash).toHaveFocus();
  });
});
