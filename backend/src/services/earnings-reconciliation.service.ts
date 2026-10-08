import { Horizon } from "@stellar/stellar-sdk";
import { PrismaClient, TransactionType } from "@prisma/client";
import { config } from "../config";
import { logger } from "../lib/logger";
import { withUpstreamTimeout } from "../lib/upstream-timeout";
import { cache, generateOnChainPaymentsCacheKey } from "../lib/cache";
import { AuditService } from "./audit.service";

const prisma = new PrismaClient();

/**
 * A payment that settled on-chain to the freelancer's wallet, as reported by Horizon.
 * Escrow releases carry the related `jobId` in the transaction memo (memo_type "text").
 */
export interface OnChainPayment {
  txHash: string;
  /** jobId parsed from the transaction memo, when present. */
  memoJobId: string | null;
  /** Amount of the payment (Horizon reports issued/native amounts as decimal strings). */
  amount: number;
  /** Asset code — "XLM" for native, otherwise the issued asset code. */
  assetCode: string;
  createdAt: string;
  from: string;
}

const HORIZON_PAGE_LIMIT = 200;
const CACHE_TTL_SECONDS = 60; // 60 seconds

/** DB earnings record shape used for matching against on-chain payments. */
export interface EarningsRecord {
  txHash: string;
  jobId: string | null;
  jobTitle: string | null;
  clientName: string | null;
  category: string | null;
  amount: number;
  createdAt: Date;
}

export const EARNING_TX_TYPES = ["RELEASE", "DISPUTE_PAYOUT"] as const;

/** The type assigned to a Transaction row created by automated remediation. */
const REMEDIATION_TX_TYPE = "RELEASE" as const;

let cachedServer: Horizon.Server | null = null;

function getServer(): Horizon.Server {
  if (!cachedServer) {
    cachedServer = new Horizon.Server(config.stellar.horizonUrl);
  }
  return cachedServer;
}

/**
 * Minimal shape of the Horizon payment records we consume. Typed locally rather
 * than via deep `Horizon.ServerApi.*` aliases so the service is resilient to
 * SDK minor-version type churn.
 */
interface HorizonPaymentRecord {
  type: string;
  to?: string;
  from?: string;
  amount?: string;
  asset_type?: string;
  asset_code?: string;
  created_at: string;
  transaction_hash: string;
  transaction: () => Promise<{ memo_type?: string; memo?: string }>;
}

const PAYMENT_TYPES = new Set([
  "payment",
  "path_payment_strict_send",
  "path_payment_strict_receive",
]);

async function fetchOnChainPaymentsUncached(
  walletAddress: string,
  from: Date,
  to: Date,
): Promise<OnChainPayment[]> {
  const server = getServer();
  const results: OnChainPayment[] = [];

  let page = await withUpstreamTimeout(
    () =>
      server
        .payments()
        .forAccount(walletAddress)
        .order("asc")
        .limit(HORIZON_PAGE_LIMIT)
        .call(),
    { route: "earnings.reconcile", target: "horizon.payments" },
  );

  while (page.records.length > 0) {
    for (const raw of page.records as unknown as HorizonPaymentRecord[]) {
      const createdAt = new Date(raw.created_at);
      if (createdAt < from) continue;
      if (createdAt > to) return results;

      if (!PAYMENT_TYPES.has(raw.type)) continue;
      // Only inbound payments to the freelancer count as earnings.
      if (raw.to !== walletAddress) continue;

      let memoJobId: string | null = null;
      try {
        const tx = await raw.transaction();
        if (tx.memo_type === "text" && tx.memo) {
          memoJobId = tx.memo;
        }
      } catch (err) {
        logger.warn(
          { err, txHash: raw.transaction_hash },
          "[Reconciliation] Failed to load tx memo",
        );
      }

      results.push({
        txHash: raw.transaction_hash,
        memoJobId,
        amount: Number(raw.amount ?? 0),
        assetCode: raw.asset_type === "native" ? "XLM" : raw.asset_code ?? "UNKNOWN",
        createdAt: raw.created_at,
        from: raw.from ?? "",
      });
    }

    page = await withUpstreamTimeout(() => page.next(), {
      route: "earnings.reconcile",
      target: "horizon.payments",
    });
  }

  return results;
}

/**
 * Fetch every inbound payment credited to `walletAddress` between `from` and
 * `to`, walking Horizon's pagination cursor until the window closes.
 *
 * Results are cached in the shared Redis instance for `CACHE_TTL_SECONDS` so
 * every backend instance sees the same recently-fetched window instead of each
 * process building its own independent, inconsistent view under horizontal
 * scaling (issue #874). Redis is unreachable-safe: `cache()` falls back to a
 * direct Horizon fetch (no caching) rather than failing the request.
 */
export async function fetchOnChainPayments(
  walletAddress: string,
  from: Date,
  to: Date,
): Promise<OnChainPayment[]> {
  const key = generateOnChainPaymentsCacheKey(walletAddress, from, to);
  const { data } = await cache(key, CACHE_TTL_SECONDS, () =>
    fetchOnChainPaymentsUncached(walletAddress, from, to),
  );
  return data;
}

/** Load DB earnings (RELEASE / DISPUTE_PAYOUT) for a wallet within a date range. */
export async function loadDbEarnings(
  wallet: string,
  from: Date,
  to: Date,
): Promise<EarningsRecord[]> {
  const txs = await prisma.transaction.findMany({
    where: {
      toAddress: wallet,
      type: { in: [...EARNING_TX_TYPES] as TransactionType[] },
      createdAt: { gte: from, lte: to },
    },
    orderBy: { createdAt: "desc" },
    include: {
      job: {
        select: {
          id: true,
          title: true,
          category: true,
          client: { select: { username: true } },
        },
      },
    },
  });

  return txs.map((tx) => ({
    txHash: tx.txHash,
    jobId: tx.jobId,
    jobTitle: tx.job?.title ?? null,
    clientName: tx.job?.client?.username ?? null,
    category: tx.job?.category ?? null,
    amount: tx.amount ?? 0,
    createdAt: tx.createdAt,
  }));
}

export interface MatchedEarning {
  txHash: string;
  jobId: string | null;
  jobTitle: string | null;
  amount: number;
  onChainAmount: number;
  createdAt: string;
}

export interface OnChainOnlyEarning {
  txHash: string;
  memoJobId: string | null;
  amount: number;
  assetCode: string;
  createdAt: string;
  horizonUrl: string;
}

export interface DbOnlyEarning {
  txHash: string;
  jobId: string | null;
  jobTitle: string | null;
  amount: number;
  createdAt: string;
}

export interface ReconciliationResult {
  range: { from: string; to: string };
  summary: {
    onChainCount: number;
    dbCount: number;
    matchedCount: number;
    onChainOnlyCount: number;
    dbOnlyCount: number;
    allMatched: boolean;
  };
  matched: MatchedEarning[];
  onChainOnly: OnChainOnlyEarning[];
  dbOnly: DbOnlyEarning[];
}

function horizonTxUrl(txHash: string): string {
  return `${config.stellar.horizonUrl.replace(/\/+$/, "")}/transactions/${txHash}`;
}

/**
 * Cross-check DB earnings records against on-chain escrow releases from
 * Horizon for a single wallet/window. Pure classification — no side effects —
 * shared by the on-demand route and the proactive background job so the
 * matching logic has a single source of truth.
 */
export async function reconcileEarnings(
  wallet: string,
  from: Date,
  to: Date,
): Promise<ReconciliationResult> {
  const [dbRecords, onChainPayments] = await Promise.all([
    loadDbEarnings(wallet, from, to),
    fetchOnChainPayments(wallet, from, to),
  ]);

  const dbByTxHash = new Map(dbRecords.map((r) => [r.txHash, r]));
  const dbByJobId = new Map(dbRecords.filter((r) => r.jobId).map((r) => [r.jobId as string, r]));

  const matchedTxHashes = new Set<string>();
  const matched: MatchedEarning[] = [];
  const onChainOnly: OnChainOnlyEarning[] = [];

  for (const payment of onChainPayments) {
    const dbRecord =
      dbByTxHash.get(payment.txHash) ??
      (payment.memoJobId ? dbByJobId.get(payment.memoJobId) : undefined);

    if (dbRecord) {
      matchedTxHashes.add(dbRecord.txHash);
      matched.push({
        txHash: payment.txHash,
        jobId: dbRecord.jobId,
        jobTitle: dbRecord.jobTitle,
        amount: dbRecord.amount,
        onChainAmount: payment.amount,
        createdAt: payment.createdAt,
      });
    } else {
      onChainOnly.push({
        txHash: payment.txHash,
        memoJobId: payment.memoJobId,
        amount: payment.amount,
        assetCode: payment.assetCode,
        createdAt: payment.createdAt,
        horizonUrl: horizonTxUrl(payment.txHash),
      });
    }
  }

  const dbOnly = dbRecords
    .filter((r) => !matchedTxHashes.has(r.txHash))
    .map((r) => ({
      txHash: r.txHash,
      jobId: r.jobId,
      jobTitle: r.jobTitle,
      amount: r.amount,
      createdAt: r.createdAt.toISOString(),
    }));

  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    summary: {
      onChainCount: onChainPayments.length,
      dbCount: dbRecords.length,
      matchedCount: matched.length,
      onChainOnlyCount: onChainOnly.length,
      dbOnlyCount: dbOnly.length,
      allMatched: onChainOnly.length === 0 && dbOnly.length === 0,
    },
    matched,
    onChainOnly,
    dbOnly,
  };
}

export interface RemediationSummary {
  backfilled: number;
  alreadyRemediated: number;
  flaggedForReview: number;
}

/**
 * Automatically remediate an `onChainOnly` discrepancy: a payment Horizon
 * confirms but the DB has no record of, indicating a DB sync failure. Backfills
 * the missing Transaction row from the on-chain data.
 *
 * Idempotent: `txHash` is uniquely constrained, so upserting with an empty
 * `update` is a no-op on a record that already exists — running reconciliation
 * twice (e.g. the on-demand route and the scheduled job overlapping, or two
 * job ticks in a row) never creates a duplicate or double-counts earnings.
 *
 * Every backfill is recorded in the tamper-evident audit trail so the
 * correction is traceable (issue #874's auditability requirement).
 *
 * Returns "created" only when this call actually inserted the row, so callers
 * can distinguish a fresh backfill from a no-op replay.
 */
export async function remediateOnChainOnly(
  wallet: string,
  payment: OnChainOnlyEarning,
): Promise<"created" | "already_remediated"> {
  // Only attach a jobId FK if the memo actually names a real job — an
  // unrelated or malformed memo must not corrupt the ledger with a false link.
  let jobId: string | null = null;
  if (payment.memoJobId) {
    const job = await prisma.job.findUnique({
      where: { id: payment.memoJobId },
      select: { id: true },
    });
    if (job) jobId = job.id;
  }

  const before = await prisma.transaction.findUnique({
    where: { txHash: payment.txHash },
    select: { id: true },
  });

  await prisma.transaction.upsert({
    where: { txHash: payment.txHash },
    update: {}, // Already present — idempotent no-op, not a second insert.
    create: {
      txHash: payment.txHash,
      jobId,
      toAddress: wallet,
      amount: payment.amount,
      type: REMEDIATION_TX_TYPE,
      status: "SUCCESS",
      createdAt: new Date(payment.createdAt),
    },
  });

  if (before) {
    return "already_remediated";
  }

  await AuditService.record({
    category: "ADMIN_ACTION",
    action: "earnings_reconciliation.onchain_only_backfilled",
    actorId: "system",
    target: payment.txHash,
    metadata: {
      wallet,
      jobId,
      memoJobId: payment.memoJobId,
      amount: payment.amount,
      assetCode: payment.assetCode,
      onChainCreatedAt: payment.createdAt,
      horizonUrl: payment.horizonUrl,
    },
  });

  return "created";
}

/**
 * Flag a `dbOnly` discrepancy (a DB record with no matching on-chain payment
 * in the window) for manual review. Unlike `onChainOnly`, this path is
 * deliberately non-destructive: a missing on-chain match could mean the
 * payment hasn't settled yet, settled outside the queried window, or the DB
 * record is genuinely wrong — none of which an automated job can safely
 * disambiguate, so it never deletes or mutates the Transaction row. The flag
 * itself is the audit entry a human reviewer later triages.
 */
export async function flagDbOnlyForReview(wallet: string, record: DbOnlyEarning): Promise<void> {
  await AuditService.record({
    category: "ADMIN_ACTION",
    action: "earnings_reconciliation.db_only_flagged_for_review",
    actorId: "system",
    target: record.txHash,
    metadata: {
      wallet,
      jobId: record.jobId,
      jobTitle: record.jobTitle,
      amount: record.amount,
      dbCreatedAt: record.createdAt,
      reason: "No matching on-chain payment found in the reconciliation window.",
    },
  });
}

/**
 * Reconcile a single freelancer's earnings and automatically remediate what
 * can be safely remediated: backfill `onChainOnly` discrepancies (idempotent)
 * and flag `dbOnly` discrepancies for manual review (never auto-deleted).
 *
 * Shared by the on-demand `/earnings/reconcile` route and the proactive
 * scheduled job, so a discrepancy gets fixed whether a freelancer happens to
 * load the page or not.
 */
export async function reconcileAndRemediate(
  wallet: string,
  from: Date,
  to: Date,
): Promise<ReconciliationResult & { remediation: RemediationSummary }> {
  const result = await reconcileEarnings(wallet, from, to);

  const remediation: RemediationSummary = {
    backfilled: 0,
    alreadyRemediated: 0,
    flaggedForReview: 0,
  };

  for (const payment of result.onChainOnly) {
    try {
      const outcome = await remediateOnChainOnly(wallet, payment);
      if (outcome === "created") {
        remediation.backfilled += 1;
      } else {
        remediation.alreadyRemediated += 1;
      }
    } catch (err) {
      logger.error(
        { err, wallet, txHash: payment.txHash },
        "[Reconciliation] Failed to remediate onChainOnly discrepancy",
      );
    }
  }

  for (const record of result.dbOnly) {
    try {
      await flagDbOnlyForReview(wallet, record);
      remediation.flaggedForReview += 1;
    } catch (err) {
      logger.error(
        { err, wallet, txHash: record.txHash },
        "[Reconciliation] Failed to flag dbOnly discrepancy for review",
      );
    }
  }

  if (result.onChainOnly.length > 0) {
    logger.warn(
      { wallet, count: result.onChainOnly.length, remediation },
      "[Reconciliation] On-chain payments missing from DB — auto-remediated",
    );
  }

  return { ...result, remediation };
}
