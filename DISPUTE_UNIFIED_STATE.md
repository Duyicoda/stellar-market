# Unified Dispute Real-Time State (issue #1126)

Consolidates the dispute detail page's three independent, unsynchronized
real-time state sources into one shared, staleness-guarded source of truth.

## The bug

`frontend/src/app/disputes/[id]/page.tsx` had **three** separate mechanisms
fetching the same dispute's vote/status data, none coordinating:

1. the page's own `GET /disputes/:id` state (refetched on SSE events via
   `useDisputeStream`) — gated the "Finalize & Resolve" button;
2. `DisputeVoteProgress` — its own polling loop (`useDisputeStatus`, 2s→30s);
3. `ArbitratorVoteView` — a third independent 30s `/tally` poll.

Under normal network jitter they displayed contradictory information at the same
moment (e.g. the sidebar saying "Ready to resolve" while the gated button stayed
disabled), and a slow response from one could overwrite fresher data already
shown by another — none discarded stale/out-of-order responses.

## The fix

### One shared source of truth — `DisputeStateProvider`

`frontend/src/context/DisputeStateContext.tsx` owns a single dispute state object
that every consumer reads from. SSE (`useDisputeStream`) is the primary live
mechanism: each event triggers **one** coordinated refetch through a single
staleness-guarded path.

**Authoritative gating**: the provider exposes `canResolve` (and the derived
`dispute`/`totalVotes`) as the one gate for the "Finalize & Resolve" button. Every
vote-status display derives from the same object, so the button state can never
visibly disagree with the sidebar or arbitrator tally.

### Two staleness guards (a stale response can never overwrite fresher data)

- **Monotonic request sequence** — every fetch goes through one path that stamps
  an incrementing id; a response older than the newest issued request is
  discarded. This kills the "slow response clobbers fresh data" race, because all
  fetches now share one counter.
- **`updatedAt` high-water mark** — a payload whose `updatedAt` is older than what
  is already committed is dropped, guarding against an out-of-band stale payload
  racing a fresher one. (A missing/invalid timestamp is allowed once it clears the
  sequence check.)

### Consumers now read the shared state

- **`page.tsx`** is split into a thin `DisputeDetailPage` (wraps
  `DisputeStateProvider`) and `DisputeDetailContent` (consumes `useDisputeState`).
  It no longer fetches or subscribes to SSE itself; `handleVote`/`handleResolve`
  call the shared `refetch()`.
- **`DisputeVoteProgress`** reads the shared state via `useOptionalDisputeState()`
  instead of its own poll (an explicit `initialDispute` prop still works for
  standalone/testing use).
- **`ArbitratorVoteView`** derives its tally from the shared dispute (or its
  `dispute` prop) instead of the independent 30s `/tally` poll — removing the
  third source (and a `console.error`).

The `useDisputeStatus` hook is left in the tree (still used by an example) but is
no longer wired into the page.

## Tests

- `frontend/src/context/__tests__/DisputeStateContext.test.tsx` (4):
  - all consumers hydrate from one fetch;
  - **an out-of-order stale response is discarded** (a slow older fetch resolving
    after a fast fresher one never overwrites it);
  - **the resolve gate and the sidebar flip together** across an update — never in
    the contradictory state the issue describes;
  - **SSE-reconnection recovery**: a refetch after reconnect updates every
    consumer consistently.
- `frontend/src/components/__tests__/DisputeVoteProgress.test.tsx` (7): migrated to
  feed the dispute via the shared source / `initialDispute`; same rendering
  assertions.

All 42 frontend suites (232 tests) pass; typecheck and lint are clean.
