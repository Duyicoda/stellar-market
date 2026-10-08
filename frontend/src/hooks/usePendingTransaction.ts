import { useState, useEffect, useRef, useCallback } from "react";

export type TxResolutionStatus = "PENDING" | "SUCCESS" | "FAILED" | "EXPIRED";

export interface PendingTransactionState {
  status: TxResolutionStatus | null;
  ledger: number | null;
  canRetry: boolean;
  isLoading: boolean;
  error: string | null;
}

const POLL_INTERVAL_MS = 5_000;
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

/**
 * Polls /api/transactions/:txHash/status at 5-second intervals until the
 * transaction reaches a terminal state (SUCCESS | FAILED | EXPIRED).
 *
 * Usage:
 *   const { status, ledger, canRetry } = usePendingTransaction(txHash);
 *
 * When canRetry is true the transaction expired on-chain (max_ledger_version
 * passed without inclusion). The caller should build a new transaction with a
 * fresh sequence number and prompt the user to re-sign.
 */
export function usePendingTransaction(txHash: string | null): PendingTransactionState {
  const [state, setState] = useState<PendingTransactionState>({
    status: null,
    ledger: null,
    canRetry: false,
    isLoading: false,
    error: null,
  });

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const stopPolling = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    abortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!txHash) {
      setState({ status: null, ledger: null, canRetry: false, isLoading: false, error: null });
      return;
    }

    setState({ status: "PENDING", ledger: null, canRetry: false, isLoading: true, error: null });

    const check = async () => {
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch(`${API_URL}/api/transactions/${txHash}/status`, {
          signal: controller.signal,
          credentials: "include",
        });

        if (!res.ok) {
          // Non-fatal — keep polling
          return;
        }

        const data: {
          status: TxResolutionStatus;
          ledger?: number;
          canRetry?: boolean;
        } = await res.json();

        setState({
          status: data.status,
          ledger: data.ledger ?? null,
          canRetry: data.canRetry ?? false,
          isLoading: data.status === "PENDING",
          error: null,
        });

        // Terminal states — stop polling
        if (data.status !== "PENDING") {
          stopPolling();
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        // Keep polling on transient network errors
      }
    };

    check();
    intervalRef.current = setInterval(check, POLL_INTERVAL_MS);

    return () => {
      stopPolling();
    };
  }, [txHash, stopPolling]);

  return state;
}
