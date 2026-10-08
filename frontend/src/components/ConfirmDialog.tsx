"use client";

import { useRef } from "react";
import { AlertTriangle, X } from "lucide-react";
import { useFocusTrap } from "@/hooks/useFocusTrap";

export interface ConfirmDialogProps {
  /** Controls visibility; nothing is rendered while `false`. */
  isOpen: boolean;
  /** Short question shown as the dialog heading, e.g. "Delete notification?". */
  title: string;
  /** Optional supporting copy describing the consequence. */
  description?: string;
  /** Label for the confirming (usually destructive) action. */
  confirmLabel?: string;
  /** Label for the dismissing action. */
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Accessible confirmation dialog for destructive, irreversible actions.
 *
 * Follows the same accessibility contract as the other modals in the app
 * (#819 / #966): `role="dialog"` + `aria-modal`, focus is trapped inside the
 * panel while open, Escape dismisses, and focus returns to the element that
 * opened it once closed. Focus starts on *Cancel* so a stray Enter/Space press
 * can never confirm a destructive action.
 *
 * Callers MUST pass stable `onCancel`/`onConfirm` callbacks (e.g. `useCallback`)
 * so the focus trap does not re-initialise on every parent render.
 */
export default function ConfirmDialog({
  isOpen,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useFocusTrap(dialogRef, {
    open: isOpen,
    onClose: onCancel,
    initialFocusRef: cancelRef,
  });

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      // Defensive: some triggers (e.g. NotificationItem) live inside a <Link>.
      // Stopping propagation keeps dialog interaction from reaching any
      // clickable ancestor, so confirming never navigates away.
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
        onClick={onCancel}
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby={description ? "confirm-dialog-description" : undefined}
        className="relative w-full max-w-md bg-theme-card border border-theme-border rounded-xl shadow-xl p-6 animate-in zoom-in-95 duration-200"
      >
        <div className="flex justify-between items-start mb-4">
          <div className="p-3 bg-theme-error/10 text-theme-error rounded-full">
            <AlertTriangle size={24} />
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="text-theme-text hover:text-theme-heading transition-colors"
            aria-label="Close confirmation dialog"
          >
            <X size={20} />
          </button>
        </div>

        <h2
          id="confirm-dialog-title"
          className="text-xl font-bold text-theme-heading mb-2"
        >
          {title}
        </h2>
        {description && (
          <p id="confirm-dialog-description" className="text-theme-text mb-6">
            {description}
          </p>
        )}

        <div className="flex gap-3 justify-end">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="btn-secondary flex-1 sm:flex-none"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="btn-primary bg-theme-error hover:bg-theme-error/90 text-white flex-1 sm:flex-none border-0"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
