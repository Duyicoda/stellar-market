"use client";

import { useRef } from "react";
import { motion } from "framer-motion";
import {
  CheckCircle,
  FileText,
  Scale,
  Gavel,
  Clock,
  Users,
} from "lucide-react";
import LocalTimestamp from "@/components/LocalTimestamp";
import type { DisputeEvent, DisputeEventType } from "@/hooks/useDisputeStream";

interface DisputeTimelineProps {
  events: DisputeEvent[];
  isLive: boolean;
}

type TimelinePresentation = {
  icon: React.ReactNode;
  label: string;
  detail?: string;
};

function describeEvent(event: DisputeEvent): TimelinePresentation {
  const payload = event.payload ?? {};

  switch (event.type as DisputeEventType) {
    case "DISPUTE_OPENED":
      return {
        icon: <Scale size={16} />,
        label: "Dispute opened",
        detail: payload.initiatorUsername
          ? `Initiated by ${String(payload.initiatorUsername)}`
          : "Dispute opened by participant",
      };
    case "EVIDENCE_SUBMITTED": {
      const fileCount = Number(payload.fileCount ?? 1);
      return {
        icon: <FileText size={16} />,
        label: "Evidence submitted",
        detail: `${fileCount} file${fileCount === 1 ? "" : "s"}`,
      };
    }
    case "ARBITRATOR_ASSIGNED":
      return {
        icon: <Users size={16} />,
        label: "Arbitrator panel assigned",
      };
    case "VOTE_CAST": {
      const voteCount = Number(payload.voteCount ?? 0);
      return {
        icon: <Gavel size={16} />,
        label: "Vote cast",
        detail: voteCount > 0 ? `${voteCount} vote${voteCount === 1 ? "" : "s"} recorded` : undefined,
      };
    }
    case "VERDICT_REACHED":
      return {
        icon: <CheckCircle size={16} />,
        label: "Verdict reached",
        detail: payload.outcome
          ? `Resolved in favour of ${String(payload.outcome).toLowerCase()}`
          : undefined,
      };
    default:
      return {
        icon: <Clock size={16} />,
        label: event.type.replace(/_/g, " ").toLowerCase(),
      };
  }
}

function TimelineItem({
  event,
  animate,
  isLast,
}: {
  event: DisputeEvent;
  animate: boolean;
  isLast: boolean;
}) {
  const presentation = describeEvent(event);

  return (
    <motion.li
      initial={animate ? { opacity: 0, y: 20 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className={`mb-6 ml-6 ${isLast ? "mb-0" : ""}`}
    >
      <span className="absolute -left-3 flex items-center justify-center w-6 h-6 rounded-full border bg-stellar-blue border-stellar-blue text-white">
        {presentation.icon}
      </span>
      <div>
        <p className="text-sm font-semibold text-theme-heading">{presentation.label}</p>
        {presentation.detail && (
          <p className="text-xs text-theme-text mt-0.5">{presentation.detail}</p>
        )}
        <LocalTimestamp
          isoString={event.createdAt}
          className="text-[10px] text-theme-text-muted"
        />
      </div>
    </motion.li>
  );
}

export default function DisputeTimeline({ events, isLive }: DisputeTimelineProps) {
  const baselineIds = useRef<Set<number> | null>(null);

  if (events.length > 0 && baselineIds.current === null) {
    baselineIds.current = new Set(events.map((event) => event.id));
  }

  const baseline = baselineIds.current ?? new Set<number>();
  const historicalEvents = events.filter((event) => baseline.has(event.id));
  const liveEvents = events.filter((event) => !baseline.has(event.id));

  const renderList = (list: DisputeEvent[], animate: boolean) => (
    <ol className="relative border-l border-theme-border ml-3">
      {list.map((event, idx) => (
        <TimelineItem
          key={event.id}
          event={event}
          animate={animate}
          isLast={idx === list.length - 1}
        />
      ))}
    </ol>
  );

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-theme-heading flex items-center gap-2">
          <Clock size={18} className="text-stellar-blue" />
          Dispute Timeline
        </h3>
        <span className="flex items-center gap-1.5 text-xs font-medium text-theme-text">
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              isLive ? "bg-theme-success" : "bg-theme-text-muted"
            }`}
            aria-hidden
          />
          {isLive ? "Live" : "Offline"}
        </span>
      </div>

      {events.length === 0 ? (
        <p className="text-sm text-theme-text-muted italic text-center py-4">
          Waiting for dispute activity…
        </p>
      ) : (
        <>
          {historicalEvents.length > 0 && renderList(historicalEvents, false)}

          {(historicalEvents.length > 0 || liveEvents.length > 0) && (
            <div className="relative flex items-center gap-3 my-4 text-[10px] uppercase tracking-wide text-theme-text-muted">
              <div className="flex-1 border-t border-dashed border-theme-border" />
              <span>now</span>
              <div className="flex-1 border-t border-dashed border-theme-border" />
            </div>
          )}

          {liveEvents.length > 0 && renderList(liveEvents, true)}
        </>
      )}
    </div>
  );
}
