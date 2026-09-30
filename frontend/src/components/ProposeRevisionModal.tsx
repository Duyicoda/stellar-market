"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import { Loader2, Plus, Trash2, X } from "lucide-react";
import { useFocusTrap } from "@/hooks/useFocusTrap";

export type ProposeRevisionMilestoneInput = {
  title: string;
  amount: number;
  deadline: string;
};

type Row = {
  key: string;
  title: string;
  amount: string;
  deadline: string;
};

function newRow(): Row {
  return {
    key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    title: "",
    amount: "",
    deadline: "",
  };
}

type DiffEntry =
  | { kind: "removed"; milestone: ProposeRevisionMilestoneInput }
  | { kind: "added"; milestone: ProposeRevisionMilestoneInput }
  | {
      kind: "changed";
      title: string;
      current: ProposeRevisionMilestoneInput;
      proposed: ProposeRevisionMilestoneInput;
    };

function computeDiff(
  current: ProposeRevisionMilestoneInput[],
  proposed: ProposeRevisionMilestoneInput[]
): DiffEntry[] {
  const entries: DiffEntry[] = [];
  const currentByTitle = new Map(current.map((m) => [m.title.trim(), m]));
  const proposedByTitle = new Map(proposed.map((m) => [m.title.trim(), m]));

  for (const [title, cur] of currentByTitle) {
    const prop = proposedByTitle.get(title);
    if (!prop) {
      entries.push({ kind: "removed", milestone: cur });
    } else if (cur.amount !== prop.amount || cur.deadline !== prop.deadline) {
      entries.push({ kind: "changed", title, current: cur, proposed: prop });
    }
  }

  for (const [title, prop] of proposedByTitle) {
    if (!currentByTitle.has(title)) {
      entries.push({ kind: "added", milestone: prop });
    }
  }

  return entries;
}

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (milestones: ProposeRevisionMilestoneInput[]) => Promise<void>;
  initialRows: ProposeRevisionMilestoneInput[];
  currentMilestones?: ProposeRevisionMilestoneInput[];
  processing: boolean;
};

export default function ProposeRevisionModal({
  isOpen,
  onClose,
  onSubmit,
  initialRows,
  currentMilestones = [],
  processing,
}: Props) {
  const modalRef = useRef<HTMLDivElement>(null);

  useFocusTrap(modalRef, { open: isOpen, onClose });

  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    if (!isOpen) return;
    if (initialRows.length === 0) {
      setRows([newRow(), newRow()]);
      return;
    }
    setRows(
      initialRows.map((m, i) => ({
        key: `seed-${i}`,
        title: m.title,
        amount: String(m.amount),
        deadline: m.deadline.slice(0, 10),
      }))
    );
  }, [isOpen, initialRows]);

  const budgetTotal = useMemo(() => {
    return rows.reduce((sum, r) => {
      const n = parseFloat(r.amount);
      return sum + (Number.isFinite(n) ? n : 0);
    }, 0);
  }, [rows]);

  const diffEntries = useMemo<DiffEntry[]>(() => {
    if (currentMilestones.length === 0) return [];
    const proposed = rows
      .filter((r) => r.title.trim().length > 0)
      .map((r) => ({
        title: r.title.trim(),
        amount: parseFloat(r.amount) || 0,
        deadline: r.deadline,
      }));
    return computeDiff(currentMilestones, proposed);
  }, [currentMilestones, rows]);

  if (!isOpen) return null;

  const handleSubmit = async () => {
    const milestones: ProposeRevisionMilestoneInput[] = [];
    for (const r of rows) {
      const title = r.title.trim();
      const amt = parseFloat(r.amount);
      if (!title || !Number.isFinite(amt) || amt <= 0 || !r.deadline) {
        return;
      }
      milestones.push({
        title,
        amount: amt,
        deadline: new Date(r.deadline + "T12:00:00.000Z").toISOString(),
      });
    }
    if (milestones.length === 0) return;
    await onSubmit(milestones);
  };

  const formValid =
    rows.length > 0 &&
    rows.every(
      (r) =>
        r.title.trim().length > 0 &&
        Number.isFinite(parseFloat(r.amount)) &&
        parseFloat(r.amount) > 0 &&
        !!r.deadline
    );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="propose-revision-modal-title"
    >
      <div ref={modalRef} className="bg-theme-bg border border-theme-border rounded-xl shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-theme-border">
          <h2
            id="propose-revision-modal-title"
            className="text-lg font-semibold text-theme-heading"
          >
            Propose revision
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-theme-text hover:bg-theme-border/30"
            disabled={processing}
            aria-label="Close propose revision modal"
          >
            <X size={20} />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <p className="text-sm text-theme-text">
            Edit milestones and budget. The on-chain escrow will use the sum of
            milestone amounts as the new total if the other party accepts.
          </p>

          {diffEntries.length > 0 && (
            <div
              className="rounded-lg border border-theme-border bg-theme-bg p-3 space-y-2"
              aria-label="Milestone changes summary"
              role="region"
            >
              <p className="text-xs font-semibold text-theme-heading uppercase tracking-wide">
                Changes vs current milestones
              </p>
              <ul className="space-y-1.5" aria-label="List of milestone changes">
                {diffEntries.map((entry, idx) => {
                  if (entry.kind === "removed") {
                    return (
                      <li
                        key={idx}
                        className="flex items-start gap-2 text-sm text-red-500"
                        aria-label={`Removed milestone: ${entry.milestone.title}`}
                      >
                        <span className="mt-0.5 font-bold select-none" aria-hidden>−</span>
                        <span>
                          <span className="line-through">{entry.milestone.title}</span>
                          <span className="ml-2 text-red-400 text-xs">
                            {entry.milestone.amount.toLocaleString()} XLM
                          </span>
                        </span>
                      </li>
                    );
                  }
                  if (entry.kind === "added") {
                    return (
                      <li
                        key={idx}
                        className="flex items-start gap-2 text-sm text-theme-success"
                        aria-label={`Added milestone: ${entry.milestone.title}`}
                      >
                        <span className="mt-0.5 font-bold select-none" aria-hidden>+</span>
                        <span>
                          {entry.milestone.title}
                          <span className="ml-2 text-theme-success text-xs">
                            {entry.milestone.amount.toLocaleString()} XLM
                          </span>
                        </span>
                      </li>
                    );
                  }
                  return (
                    <li
                      key={idx}
                      className="flex items-start gap-2 text-sm text-theme-warning"
                      aria-label={`Changed milestone: ${entry.title}`}
                    >
                      <span className="mt-0.5 font-bold select-none" aria-hidden>~</span>
                      <span>
                        <span className="font-medium">{entry.title}</span>
                        {entry.current.amount !== entry.proposed.amount && (
                          <span className="ml-2 text-xs">
                            <span className="line-through text-red-400">
                              {entry.current.amount.toLocaleString()} XLM
                            </span>
                            {" → "}
                            <span className="text-theme-success">
                              {entry.proposed.amount.toLocaleString()} XLM
                            </span>
                          </span>
                        )}
                        {entry.current.deadline !== entry.proposed.deadline && (
                          <span className="ml-2 text-xs">
                            <span className="line-through text-theme-error">
                              {entry.current.deadline.slice(0, 10)}
                            </span>
                            {" → "}
                            <span className="text-theme-success">
                              {entry.proposed.deadline.slice(0, 10)}
                            </span>
                          </span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <div className="flex items-center justify-between text-sm">
            <span className="text-theme-text">Proposed budget (XLM)</span>
            <span className="font-semibold text-stellar-blue">
              {budgetTotal.toLocaleString(undefined, {
                maximumFractionDigits: 7,
              })}
            </span>
          </div>

          <div className="space-y-3">
            {rows.map((r, idx) => (
              <div
                key={r.key}
                className="p-3 rounded-lg border border-theme-border space-y-2"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-theme-heading">
                    Milestone {idx + 1}
                  </span>
                  {rows.length > 1 && (
                    <button
                      type="button"
                      onClick={() =>
                        setRows((prev) => prev.filter((x) => x.key !== r.key))
                      }
                      className="text-theme-error hover:opacity-80 p-1"
                      disabled={processing}
                      aria-label={`Remove milestone ${idx + 1}`}
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
                <input
                  type="text"
                  placeholder="Title"
                  aria-label={`Milestone ${idx + 1} title`}
                  className="w-full border border-theme-border rounded px-2 py-1.5 text-sm bg-theme-bg text-theme-text"
                  value={r.title}
                  onChange={(e) =>
                    setRows((prev) =>
                      prev.map((x) =>
                        x.key === r.key ? { ...x, title: e.target.value } : x
                      )
                    )
                  }
                  disabled={processing}
                />
                <div className="flex gap-2">
                  <input
                    type="number"
                    min={0}
                    step="0.0000001"
                    placeholder="XLM"
                    aria-label={`Milestone ${idx + 1} amount in XLM`}
                    className="flex-1 border border-theme-border rounded px-2 py-1.5 text-sm bg-theme-bg text-theme-text"
                    value={r.amount}
                    onChange={(e) =>
                      setRows((prev) =>
                        prev.map((x) =>
                          x.key === r.key ? { ...x, amount: e.target.value } : x
                        )
                      )
                    }
                    disabled={processing}
                  />
                  <input
                    type="date"
                    aria-label={`Milestone ${idx + 1} deadline`}
                    className="flex-1 border border-theme-border rounded px-2 py-1.5 text-sm bg-theme-bg text-theme-text"
                    value={r.deadline}
                    onChange={(e) =>
                      setRows((prev) =>
                        prev.map((x) =>
                          x.key === r.key
                            ? { ...x, deadline: e.target.value }
                            : x
                        )
                      )
                    }
                    disabled={processing}
                  />
                </div>
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setRows((prev) => [...prev, newRow()])}
            className="flex items-center gap-2 text-sm text-stellar-blue hover:underline"
            disabled={processing}
          >
            <Plus size={16} /> Add milestone
          </button>
        </div>

        <div className="flex justify-end gap-2 p-4 border-t border-theme-border">
          <button
            type="button"
            onClick={onClose}
            className="btn-secondary py-2 px-4 text-sm"
            disabled={processing}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={processing || !formValid}
            className="btn-primary py-2 px-4 text-sm flex items-center gap-2"
          >
            {processing ? <Loader2 className="animate-spin" size={16} /> : null}
            Submit proposal
          </button>
        </div>
      </div>
    </div>
  );
}
