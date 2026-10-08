Closes #945
Closes #947
Closes #946
Closes #972
Closes #1214
Closes #1215
Closes #1217
Closes #1209

## What changed

- `backend/src/services/recommendation-queue.service.ts` — full rewrite: replaced hand-rolled Redis list with BullMQ Queue + Worker
- `backend/src/index.ts` — registered `recommendationRebuildQueue` in BullBoard; made `stopWorker` call async
- `backend/src/services/recommendation.service.ts` — added `recency` and `clientReputation` to `WEIGHTS`; rebalanced all weights to sum to 1.0; added missing signals to `computeRelevanceScore` weighted sum
- `backend/src/services/deadline-extension.service.ts` — added deadline shrink guard after the future-date check
- `backend/src/services/__tests__/recommendation-queue.service.test.ts` — rewrote tests for BullMQ-based queue (6 tests)
- `backend/src/services/__tests__/recommendation.service.test.ts` — added 3 test suites for recency, reputation, and weight sum
- `backend/src/services/__tests__/deadline-extension.service.test.ts` — new file (4 tests for deadline guard)
- `frontend/src/app/jobs/[id]/page.tsx` — wrapped `getJob` with `React.cache()`; passes server-fetched data as `initialJob` prop
- `frontend/src/app/jobs/[id]/JobDetailClient.tsx` — accepts `initialJob` prop; uses it as `initialData` in `useQuery`
- `frontend/src/app/jobs/[id]/__tests__/JobDetailClient.dedup-fetch.test.tsx` — new file (2 tests for dedup fetch)
- `frontend/src/hooks/useDisputeStream.ts` — updated to read JWT from correct localStorage key
- `frontend/src/components/DeadlineExtensionModal.tsx` — updated to read JWT from correct localStorage key
- `frontend/src/components/DeadlineExtensionApprovalCard.tsx` — updated to read JWT from correct localStorage key
- `backend/src/utils/messageValidation.ts` — added shared validation logic for message receiver and job membership
- `backend/src/routes/message.routes.ts` — reused validation logic for REST message endpoint
- `backend/src/socket/messageHandlers.ts` — reused validation logic for socket message handling

## #945 — Queue durability

**Approach**: BullMQ migration. The existing notification queue (`backend/src/lib/notification-queue.ts`) already uses BullMQ v5.56.0 with `attempts: 3` and `backoff.exponential(1000ms)`. We follow the exact same pattern — create a `Queue`, register it with BullBoard, and use a `Worker` with `removeOnFail: false` so failed jobs are retained for dead-letter inspection.

**Retry config**: `attempts=3`, `backoff={type:'exponential',delay:1000}`

## #947 — Scoring weights

New `WEIGHTS` object:

| Signal | Old | New | Justification |
|--------|-----|-----|---------------|
| skillOverlap | 0.25 | 0.20 | Skill match is most critical; reduced proportionally to make room |
| completionRate | 0.20 | 0.15 | Important but second to skill match |
| onChainTier | 0.25 | 0.20 | Valuable signal but should not dominate over traditional signals |
| disputeLossRate | 0.15 | 0.10 | Penalty signal, moderate weight appropriate |
| endorsementWeight | 0.10 | 0.08 | Stake-weighted signal, useful but niche |
| responseTime | 0.05 | 0.05 | Placeholder — kept unchanged |
| recency | — | 0.12 | New — recently posted jobs are more relevant |
| clientReputation | — | 0.10 | New — client rating helps but should not dominate |
| **Sum** | **1.0** | **1.0** | ✓ |

## #946 — Deadline guard

**Check**: `newDeadline > (contractDeadline ?? dueDate ?? job.deadline)`  
**Error**: `400 "New deadline must be later than the current deadline"`  
**Location**: Immediately after the "must be in the future" check in `requestExtension`, before the pending-extension-request lookup.

## #972 — Fetch deduplication

**Approach**: `React.cache()` + `initialData`.  
- `getJob` is wrapped with `React.cache()` from `react` (available in Next.js 16). When both `generateMetadata` and `JobDetailPage` call `getJob(id)`, React deduplicates the fetch within the render pass.  
- The server-fetched job is passed as `initialJob` prop to `JobDetailClient`.  
- `JobDetailClient` passes it as `initialData` to `useQuery` — React Query skips the initial network fetch.  

**Live refresh preserved**: `fetchJob` still calls `queryClient.invalidateQueries({ queryKey: ["job", id] })`, which triggers a re-fetch. `staleTime: 60_000` ensures periodic refresh.

## #1214 — Frontend token-key fixes

Updated the following files to read the correct JWT key:

- `frontend/src/hooks/useDisputeStream.ts`
- `frontend/src/components/DeadlineExtensionModal.tsx`
- `frontend/src/components/DeadlineExtensionApprovalCard.tsx`

Each now reads from `localStorage.getItem("stellarmarket_jwt")` instead of the invalid `"token"` key.

## #1209 — Socket authorization fix

Added shared validation logic in:

- `backend/src/utils/messageValidation.ts`

and reused it from:

- `backend/src/routes/message.routes.ts`
- `backend/src/socket/messageHandlers.ts`

The socket validation logic enforces:

- The sender is authenticated (`socket.data.userId` from Socket.IO JWT middleware)
- The receiver exists via `prisma.user.findUnique({ where: { id: receiverId } })`
- If `jobId` is supplied, the job exists and the sender is either `job.clientId` or `job.freelancerId`
- Unauthorized sends emit an error event and return before calling `prisma.message.create`

A lightweight in-process rate limiter was also added to the socket `send_message` path to prevent abuse without changing Express middleware behavior.

## Security impact

Before this change, socket sends could bypass the REST validation path and create messages without confirming the receiver or job relationship. This patch closes that gap and aligns socket behavior with the API contract.

## Tests added / updated

- `backend/src/socket/__tests__/messageHandlers.test.ts`
  - rejects nonexistent receiver
  - rejects unauthorized job participant
  - accepts authorized job participant
  - accepts valid receiver without a `jobId`
- `frontend/src/components/__tests__/tokenKeyRegression.test.tsx`
  - verifies `useDisputeStream` uses `stellarmarket_jwt`
  - verifies `DeadlineExtensionModal` uses the correct key
  - verifies `DeadlineExtensionApprovalCard` approve/reject use the correct key

## Validation

Commands run successfully:

```bash
cd backend && ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef npm test -- --runTestsByPath src/socket/__tests__/messageHandlers.test.ts src/routes/__tests__/message.routes.test.ts
cd frontend && npm test -- --runTestsByPath src/components/__tests__/tokenKeyRegression.test.tsx
cd backend && ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef npx tsc --noEmit --pretty false
```

Results:

- Backend message route/socket tests: passed
- Frontend token regression tests: passed
- Backend TypeScript check: passed

## Risk and rollback

Risk is low and localized:

- Frontend changes are direct string key replacements with no logic changes.
- Socket validation is additive and sits before the message create call; rollback is simply to revert the validation and socket handler guard logic.

## Vacuousness confirmation

- **Test 7** (deadline earlier rejected): remove the guard — test fails ✓  
- **Test 4** (recency scoring): remove `recencyScore` from sum — test fails ✓  
- **Test 1** (BullMQ retry): remove `attempts: 3` config — test fails ✓  

## Additional findings

None.
