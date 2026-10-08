# Atomic, Idempotent Job + Milestone Creation (issue #1125)

Fixes the non-transactional, non-idempotent job-creation flow in `JobWizard`.

## The bug

`JobWizard.onSubmit` used to `POST /jobs`, then loop `POST /milestones` one by
one. If the job was created but a milestone POST failed partway through:

- the job was left persisted with a **partial milestone set**;
- the localStorage draft was **not** cleared, but re-clicking "Publish Job" ran
  the whole sequence again, creating a **duplicate job**;
- the client-computed `totalBudget` could **diverge** from what was persisted.

## The fix

### Backend — one atomic, idempotent endpoint

New `POST /jobs/with-milestones` (`backend/src/routes/job.routes.ts`):

- **Atomic**: the job and all milestones are created inside a single
  `prisma.$transaction` (a nested `job.create`), so it is all-or-nothing. A
  failure on any milestone rolls the entire thing back — no partial job.
- **Idempotent (DB-guaranteed)**: an optional client `idempotencyKey` is stored
  on a new unique `Job.idempotencyKey` column. A retry with the same key returns
  the original job (`200`) instead of creating a second one. A concurrent race
  that trips the unique constraint (`P2002`) is caught and resolved to the
  existing job, so duplication is impossible even under concurrency — and this
  holds regardless of Redis availability (unlike the Redis-only idempotency
  middleware, which fails open).
- **Consistent budget**: the job budget is **derived server-side** from the sum
  of milestone amounts, so the persisted total can never diverge from the
  milestone set. It is validated against the platform minimum.
- A key belonging to another user returns `409`; non-clients `403`; unknown
  category `422`; empty milestones `400`.

Schema: `backend/prisma/schema.prisma` adds `idempotencyKey String? @unique`;
migration `20260801000000_add_job_idempotency_key`. NULL keys stay distinct under
Postgres, so existing/legacy jobs are unaffected.

The original `POST /jobs` and `POST /milestones` endpoints are left intact for
backward compatibility.

### Frontend — single call + safe draft lifecycle

`frontend/src/app/post-job/JobWizard.tsx`:

- `onSubmit` now makes the single atomic call instead of the job-then-loop.
- A stable `idempotencyKey` is generated once and persisted
  (`job-wizard-idempotency-key`). A retry after a failure reuses the **same**
  key, so the backend cannot create a duplicate.
- The draft **and** the key are cleared only on confirmed success; on failure
  both are kept so the user can retry without re-entering anything.
- A `published` guard stops the draft auto-save effect from re-writing a draft
  we just cleared on success (a real lifecycle race the old code was exposed to).

## Tests

- `backend/src/routes/__tests__/job-atomic-creation.test.ts` (10): happy-path
  atomic create + derived budget + 1-based order; **mid-sequence failure rolls
  back with no partial job**; **retry with the same key returns the original job
  and never calls create twice**; **P2002 race resolves to the existing job**;
  cross-user key `409`; non-client `403`; below-minimum budget `422`; bad
  category `422`; empty milestones `400`; auth required.
- `frontend/src/app/post-job/__tests__/JobWizard.atomic.test.tsx` (4): single
  atomic call carrying all milestones + a key; draft/key cleared only on success;
  **draft + key preserved on failure (no navigation)**; **retry reuses the same
  key (no duplicate)** and clears it after the eventual success.

All 11 backend job/milestone suites and the full 232-test frontend suite pass;
both typechecks are clean.
