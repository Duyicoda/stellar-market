"use client";

import { useState, useEffect, useRef, useCallback } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api/v1";

export type DisputeEventType =
  | "DISPUTE_OPENED"
  | "EVIDENCE_SUBMITTED"
  | "ARBITRATOR_ASSIGNED"
  | "VOTE_CAST"
  | "VERDICT_REACHED";

export interface DisputeEvent {
  id: number;
  disputeId: string;
  type: DisputeEventType;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

interface UseDisputeStreamOptions {
  initialEvents?: DisputeEvent[];
  enabled?: boolean;
  onEvent?: (event: DisputeEvent) => void;
}

interface UseDisputeStreamReturn {
  events: DisputeEvent[];
  isLive: boolean;
}

function parseSseChunk(chunk: string): Array<{ id?: string; data?: string }> {
  const messages: Array<{ id?: string; data?: string }> = [];
  const blocks = chunk.split("\n\n");

  for (const block of blocks) {
    if (!block.trim() || block.startsWith(":")) {
      continue;
    }

    let id: string | undefined;
    let data: string | undefined;

    for (const line of block.split("\n")) {
      if (line.startsWith("id:")) {
        id = line.slice(3).trim();
      } else if (line.startsWith("data:")) {
        data = line.slice(5).trim();
      }
    }

    if (data !== undefined) {
      messages.push({ id, data });
    }
  }

  return messages;
}

async function consumeDisputeStream(
  disputeId: string,
  lastEventId: number,
  signal: AbortSignal,
  onMessage: (event: DisputeEvent) => void,
  onConnected: () => void,
  onDisconnected: () => void,
): Promise<void> {
  const token = localStorage.getItem("stellarmarket_jwt");
  const headers: Record<string, string> = {
    Accept: "text/event-stream",
    "Last-Event-ID": String(lastEventId),
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_URL}/disputes/${disputeId}/stream`, {
    headers,
    signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`SSE connection failed (${response.status})`);
  }

  onConnected();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lastDelimiter = buffer.lastIndexOf("\n\n");
    if (lastDelimiter === -1) {
      continue;
    }

    const complete = buffer.slice(0, lastDelimiter + 2);
    buffer = buffer.slice(lastDelimiter + 2);

    for (const message of parseSseChunk(complete)) {
      if (!message.data) {
        continue;
      }
      const event = JSON.parse(message.data) as DisputeEvent;
      onMessage(event);
    }
  }

  onDisconnected();
  throw new Error("SSE stream closed");
}

export function useDisputeStream(
  disputeId: string,
  {
    initialEvents = [],
    enabled = true,
    onEvent,
  }: UseDisputeStreamOptions = {},
): UseDisputeStreamReturn {
  const [events, setEvents] = useState<DisputeEvent[]>(initialEvents);
  const [isLive, setIsLive] = useState(false);
  const seenIds = useRef(new Set<number>(initialEvents.map((event) => event.id)));
  const onEventRef = useRef(onEvent);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  const appendEvent = useCallback((event: DisputeEvent) => {
    if (seenIds.current.has(event.id)) {
      return;
    }
    seenIds.current.add(event.id);
    setEvents((prev) => [...prev, event]);
    onEventRef.current?.(event);
  }, []);

  useEffect(() => {
    if (!enabled || !disputeId) {
      return;
    }

    let retryDelay = 1000;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let abortController: AbortController | null = null;
    let disposed = false;

    const connect = () => {
      if (disposed) {
        return;
      }

      abortController?.abort();
      abortController = new AbortController();

      const lastId = seenIds.current.size > 0
        ? Math.max(...Array.from(seenIds.current))
        : 0;

      consumeDisputeStream(
        disputeId,
        lastId,
        abortController.signal,
        (event) => {
          appendEvent(event);
        },
        () => {
          if (!disposed) {
            setIsLive(true);
            retryDelay = 1000;
          }
        },
        () => {
          if (!disposed) {
            setIsLive(false);
          }
        },
      ).catch(() => {
        if (disposed || abortController?.signal.aborted) {
          return;
        }

        setIsLive(false);
        retryTimer = setTimeout(() => {
          retryDelay = Math.min(retryDelay * 2, 30_000);
          connect();
        }, retryDelay);
      });
    };

    connect();

    return () => {
      disposed = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      abortController?.abort();
      setIsLive(false);
    };
  }, [appendEvent, disputeId, enabled]);

  return { events, isLive };
}
