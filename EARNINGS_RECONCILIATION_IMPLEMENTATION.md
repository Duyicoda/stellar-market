# Freelancer Earnings — Reconciliation & Tax-Period Export

Extends the freelancer earnings dashboard (#603, #477) with time-series
decomposition, on-chain reconciliation against the Stellar ledger, and a
tax-period CSV export. Closes #672.

Reconciliation was originally read-only and process-local (see below); #874
made the payment cache shared across instances and made reconciliation
proactive and self-healing rather than a passive report.

## Why

The earnings page previously read from PostgreSQL only. With on-chain
settlement, the ground truth is the Stellar ledger — not the database. This work
lets freelancers verify that platform records match what actually settled and
produces an export usable for tax filings.

## Backend

### `GET /api/freelancers/earnings` (extended)

Now accepts optional `from`/`to` ISO dates and additionally returns:

- `weeklyEarnings` — sparse weekly buckets (`DATE_TRUNC('week', ...)`); the
  frontend fills zero-value gaps.
- `categoryBreakdown` — earnings grouped by each job's `category` tag (derived,
  not hardcoded) with per-category percentage.
- `range` — the resolved `{ from, to }` window.

### `GET /api/freelancers/earnings/reconcile?from=<ISO>&to=<ISO>`

Fetches inbound payments to the freelancer's wallet from Horizon for the window
and matches each to a DB earnings record by transaction hash or by the `jobId`
carried in the transaction memo. Returns `matched`, `onChainOnly`, and `dbOnly`
buckets plus a summary. Returns `502` if Horizon is unreachable.

As of #874 this is no longer read-only: the response also includes a
`remediation` summary (`{ backfilled, alreadyRemediated, flaggedForReview }`)
reporting what was automatically corrected on this call. See
[Proactive reconciliation & remediation (#874)](#proactive-reconciliation--remediation-874)
below.

### `GET /api/freelancers/earnings/export?from=<ISO>&to=<ISO>&format=csv`

Streams a CSV with `date, job_title, client_name, amount_xlm, amount_usd,
tx_hash, reconciliation_status`. USD equivalents use `XLM_USD_RATE` when set.
Reconciliation status is computed best-effort against Horizon; if Horizon is
unreachable rows are marked `unverified` and the export still succeeds.

Horizon access is encapsulated in
`src/services/earnings-reconciliation.service.ts`.

## Proactive reconciliation & remediation (#874)

The original implementation had two gaps: the Horizon payment cache was a
module-level `Map`, so under horizontal scaling each backend instance built its
own independent, possibly-stale view; and reconciliation only ever *reported*
`onChainOnly`/`dbOnly` discrepancies — nothing wrote a correction back, and
nothing ran unless a freelancer happened to load the earnings page.

**Shared cache.** `fetchOnChainPayments` now caches through the same Redis
helper (`src/lib/cache.ts`) already used for job listings and user profiles, so
a payment window fetched by one instance is immediately visible to every other
instance (60s TTL). Falls back to a direct Horizon fetch — never a hard
failure — if Redis is unreachable, matching the existing cache-aside
convention.

**Shared reconciliation core.** The bucket-matching logic (`matched` /
`onChainOnly` / `dbOnly`) that used to live inline in the route handler is now
`reconcileEarnings()` in the service, so both the on-demand route and the new
background job compute it identically.

**Automated remediation.** `reconcileAndRemediate()` wraps `reconcileEarnings`
and, for every result:

- **`onChainOnly`** (Horizon confirms a payment, the DB has no record) —
  `remediateOnChainOnly()` backfills the missing `Transaction` row directly
  from the on-chain data (`createdAt` is the on-chain settlement time, not the
  backfill's insertion time, so historical charts stay accurate). Idempotent:
  `Transaction.txHash` is uniquely constrained, so the backfill is an
  `upsert(..., update: {})` — replaying reconciliation for the same payment is
  a no-op, never a duplicate. `jobId` is only attached when the memo actually
  names a real, existing `Job`; an unrelated or malformed memo never corrupts
  the ledger with a false link.
- **`dbOnly`** (a DB record with no matching on-chain payment in the window) —
  deliberately **not** auto-corrected. `flagDbOnlyForReview()` only writes an
  audit entry; the missing on-chain match could mean the payment hasn't
  settled yet, settled outside the window, or the DB record is genuinely
  wrong, and an automated job can't safely tell which. A human reviewer
  triages from the audit trail.

Both remediation paths write through the existing tamper-evident, hash-chained
`AuditService` (`src/services/audit.service.ts`, #875) with `actorId: "system"`
— every automated correction is traceable and independently verifiable via
`AuditService.verifyChain()`.

**Proactive scheduling.** `src/jobs/earnings-reconciliation.job.ts` follows the
existing `setInterval`-based job convention (`pending-tx.job.ts`,
`escrow-ttl.job.ts`): every 15 minutes it reconciles every active freelancer
(has a wallet, not deleted, not suspended — deliberately *not* gated on recent
login, since the entire point is catching freelancers who are *not* currently
loading the page) over a trailing 48-hour window, batched (25 at a time) so one
freelancer's failure doesn't stop the sweep for everyone else.

## Frontend

`src/app/dashboard/earnings-page.tsx`:

- **Time-series chart** — Recharts `ComposedChart` with weekly bars and a 30-day
  (4-week) trailing moving-average line. Gap-filling and the moving average live
  in `earnings/earnings-utils.ts` (unit-tested); the moving average uses a
  partial window for the first three weeks.
- **Category breakdown** — horizontal bars derived from job category tags.
- **Reconciliation panel** — matched-vs-unmatched summary with a warning banner
  and "View unmatched" links to Horizon when on-chain payments are missing from
  the DB.
- **Date-range picker** — applies to the chart, category breakdown, and
  reconciliation simultaneously.
- **CSV export** — downloads via the new endpoint as a Blob URL (no page reload).

## Tests

- `backend/src/routes/__tests__/freelancer.earnings.test.ts` — reconciliation
  response shape (including the `remediation` summary), Horizon-failure
  handling, range validation, role gating, and CSV export shape/escaping.
- `backend/src/services/__tests__/earnings-reconciliation.service.test.ts`
  (#874) — the Redis cache write from one simulated backend instance is
  visible to another without a second Horizon call (and gracefully falls back
  when Redis is down); `onChainOnly` backfill is idempotent and only jobId-links
  a memo that resolves to a real `Job`; the on-chain settlement date is
  preserved on backfill; `dbOnly` discrepancies are audit-flagged and never
  touch the `Transaction` table.
- `backend/src/__tests__/earnings-reconciliation-job.test.ts` (#874) — the
  scheduled sweep reconciles an inactive freelancer (no page load, no route
  call — only the job) purely on its own schedule; batches active freelancers
  and one failure doesn't stop the sweep; no-ops when there are no active
  freelancers or a user has no wallet.
- `frontend/src/app/dashboard/earnings/__tests__/earnings-utils.test.ts` —
  zero-gap filling and partial-window moving average.
