import { PrismaClient } from "@prisma/client";
import { logger } from "../lib/logger";
import { reconcileAndRemediate } from "../services/earnings-reconciliation.service";

const prisma = new PrismaClient();

// Reconciliation is heavier than a plain DB poll (it calls out to Horizon per
// freelancer), so this runs far less often than pending-tx/escrow-ttl's 30s.
const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
// Trailing window re-checked every sweep. Wider than the poll interval so a
// payment that settles on-chain slightly late, or a sweep that runs behind
// schedule, still gets caught on the next pass instead of falling through a
// gap between two non-overlapping windows.
const RECONCILIATION_WINDOW_MS = 48 * 60 * 60 * 1000; // 48 hours
const BATCH_SIZE = 25;

/**
 * "Active" freelancers eligible for proactive reconciliation: have a wallet
 * (reconciliation is meaningless without one), and are not deleted or
 * suspended. Deliberately not gated on any "recently logged in" signal — the
 * entire point of this job (issue #874) is to catch discrepancies for
 * freelancers who are *not* currently loading the earnings page, so gating on
 * recent activity would defeat its purpose.
 */
async function loadActiveFreelancerWallets(): Promise<Array<{ id: string; walletAddress: string }>> {
  const users = await prisma.user.findMany({
    where: {
      role: "FREELANCER",
      walletAddress: { not: null },
      deletedAt: null,
      isSuspended: false,
    },
    select: { id: true, walletAddress: true },
  });
  return users.filter((u): u is { id: string; walletAddress: string } => u.walletAddress !== null);
}

/**
 * Proactively reconcile every active freelancer's earnings against Horizon on
 * a fixed interval, rather than only when a freelancer happens to load the
 * earnings page (issue #874). Each freelancer is processed independently so
 * one failure (a bad wallet, a transient Horizon error) does not stop the
 * sweep for everyone else.
 */
export async function runEarningsReconciliationSweep(): Promise<void> {
  const freelancers = await loadActiveFreelancerWallets();
  if (freelancers.length === 0) return;

  logger.info(
    { count: freelancers.length },
    "[EarningsReconciliationJob] Starting proactive reconciliation sweep",
  );

  const to = new Date();
  const from = new Date(to.getTime() - RECONCILIATION_WINDOW_MS);

  let processed = 0;
  let backfilled = 0;
  let flagged = 0;
  let failed = 0;

  for (let i = 0; i < freelancers.length; i += BATCH_SIZE) {
    const batch = freelancers.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (freelancer) => {
        try {
          const result = await reconcileAndRemediate(freelancer.walletAddress, from, to);
          processed += 1;
          backfilled += result.remediation.backfilled;
          flagged += result.remediation.flaggedForReview;
        } catch (err) {
          failed += 1;
          logger.error(
            { err, userId: freelancer.id, wallet: freelancer.walletAddress },
            "[EarningsReconciliationJob] Failed to reconcile freelancer",
          );
        }
      }),
    );
  }

  logger.info(
    { processed, backfilled, flagged, failed },
    "[EarningsReconciliationJob] Sweep complete",
  );
}

export function startEarningsReconciliationJob(): void {
  void runEarningsReconciliationSweep();
  setInterval(() => {
    void runEarningsReconciliationSweep();
  }, POLL_INTERVAL_MS);
  logger.info("[EarningsReconciliationJob] Scheduled — runs every 15 minutes");
}
