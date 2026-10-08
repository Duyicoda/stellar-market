# DisputeVoteProgress Component

A real-time dispute vote progress tracker for community arbitration disputes. It renders the current vote split between the client and the freelancer, progress towards the minimum number of votes required to resolve the dispute, and (optionally) the most recent voters with anonymized wallet addresses.

## Features

- **Real-time Updates**: Polls `GET /disputes/:id` through the `useDisputeStatus` hook with exponential backoff (2s → 4s → 8s → 16s → 30s max) and stops automatically for terminal dispute statuses
- **Optional Static Snapshot**: Pass `initialDispute` to render already-fetched data immediately and skip polling entirely (`useDisputeStatus` is invoked with `enabled: false`)
- **Split Progress Bar**: One segment per side, each with its own gradient and vote count, so the client/freelancer split is visible at a glance
- **Vote Counting**: Shows `cast / required` votes and progress towards `minVotes` as a percentage
- **Voter Privacy**: The last 5 voters are listed as anonymized wallet addresses (e.g. `GABC...L9KZ`); missing or short addresses fall back to `Anonymous`
- **Visual Feedback**: A `ring-2 ring-stellar-blue` highlight is applied for 2 seconds when the total vote count increases
- **Loading Skeleton**: An animated skeleton card is rendered until the first dispute payload is available
- **Announced Updates**: The status message is a polite live region, so vote changes are announced to assistive technology
- **Theme-aware Styling**: Uses theme CSS variables and design tokens, so dark mode needs no extra props

## Usage

### Basic Usage (polls for updates)

```tsx
import DisputeVoteProgress from "@/components/DisputeVoteProgress";

function DisputePage() {
  return <DisputeVoteProgress disputeId="dispute-123" />;
}
```

### With Voter Details

```tsx
<DisputeVoteProgress disputeId="dispute-123" showVoterDetails={true} />
```

### With a Pre-fetched Dispute (no polling)

```tsx
<DisputeVoteProgress disputeId={dispute.id} initialDispute={dispute} />
```

When `initialDispute` is supplied the component renders that object immediately, never shows the loading skeleton, and does not start the polling hook. This is the pattern used by the Storybook story (`DisputeVoteProgress.stories.tsx`).

## Props

| Prop               | Type      | Default     | Description                                                              |
| ------------------ | --------- | ----------- | ------------------------------------------------------------------------ |
| `disputeId`        | `string`  | Required    | ID of the dispute to track; used for the polling request                 |
| `showVoterDetails` | `boolean` | `false`     | Renders the "Recent Voters (Anonymized)" list (last 5 votes)             |
| `initialDispute`   | `Dispute` | `undefined` | Dispute rendered immediately; when set, polling is disabled and its result is ignored |

`initialDispute` is declared as `any` in `DisputeVoteProgressProps` so partial fixtures (as in Storybook) can be passed; in application code pass a full `Dispute` from `@/types`.

Only these fields are read from the dispute:

- `votesForClient`, `votesForFreelancer` (split bar and vote counter)
- `minVotes` (overall progress and remaining votes)
- `votes[].id`, `votes[].choice`, `votes[].voter.walletAddress` (voter list, only when `showVoterDetails` is enabled)

## Component Structure

```
DisputeVoteProgress
├── Header (Vote Progress title + cast / required vote count)
├── Split Progress Bar (Client vs Freelancer votes)
├── Overall Progress Bar (towards dispute.minVotes)
├── Status Message (live region: "Ready to resolve" or "N more votes needed")
└── Voter Details (optional: last 5 votes with anonymized addresses)
```

## Styling

The component uses Tailwind CSS with the design tokens declared in `tailwind.config.ts`:

| Token                            | Where it is used                                                       |
| -------------------------------- | ---------------------------------------------------------------------- |
| `theme-heading`                  | Card title, vote counters, percentage labels                           |
| `theme-text`                     | Muted labels and the "N more votes needed" message                     |
| `theme-bg-secondary`             | Progress-bar tracks and skeleton blocks                                |
| `theme-border`                   | Card dividers and bar outlines                                         |
| `theme-success`                  | Completed progress gradient start and "Ready to resolve" text          |
| `theme-warning`                  | Freelancer label and freelancer voter pills                            |
| `stellar-blue`                   | Brand accent: client label, new-vote ring, header icon                 |
| `stellar-purple`                 | Second stop of the client and in-progress gradients                    |
| `amber-500` / `amber-600`        | Freelancer split-bar gradient stops                                    |
| `emerald-500`                    | Second stop of the completed overall-progress gradient                 |

### Color Coding

- **Client votes**: `stellar-blue` → `stellar-purple` gradient and `stellar-blue` label
- **Freelancer votes**: `amber-500` → `amber-600` gradient with a `theme-warning` label
- **Overall progress**: `stellar-blue` → `stellar-purple` while incomplete, `theme-success` → `emerald-500` once `minVotes` is reached
- **Voter pills**: `stellar-blue` tint for `CLIENT` votes, `theme-warning` tint for `FREELANCER` votes

> Migration note: earlier revisions of this component used Tailwind's `indigo-*` and `orange-*` palettes (and `green-500` for the completed bar). Those classes were removed in favour of the tokens above — style against the tokens, not the old palettes.

## Edge-case Behaviour

- `totalVotes === 0`: both split segments are rendered at 50% width and no percentage labels are shown inside them.
- A segment's percentage is only printed when that side has votes **and** the segment is wider than 15%, so narrow slices stay readable.
- `progressPercentage` is clamped with `Math.min(100, …)` and `votesRemaining` is floored with `Math.max(0, …)`.
- The voter list only renders when `showVoterDetails` is `true` **and** `dispute.votes` is a non-empty array; only the last 5 entries (`votes.slice(-5)`) are shown.
- The status message uses the singular form when exactly one vote is missing ("1 more vote needed").

## Real-time Polling

Polling is delegated to `useDisputeStatus` (`@/hooks/useDisputeStatus`) and configured by the component as:

```tsx
useDisputeStatus({
  disputeId,
  enabled: !initialDispute,
  initialInterval: 2000,
  maxInterval: 30000,
});
```

The hook:

1. Fetches immediately on mount, then polls at 2-second intervals.
2. Doubles the interval after each poll (2s → 4s → 8s → 16s → 30s) and caps it at `maxInterval`.
3. Stops polling when the dispute reaches a terminal status: `RESOLVED_CLIENT`, `RESOLVED_FREELANCER`, `ESCALATED`.
4. Clears its timer on unmount, so the component itself never schedules timers.
5. Is fully skipped when `initialDispute` is supplied, because `enabled` is `false` in that case.

`useDisputeStatus` also returns `error` and `refetch`, which this component does not consume. See `frontend/src/hooks/README.md` for the hook's full API.

## Visual Feedback

- **New Vote Highlight**: when the total vote count increases compared with the previous render (and at least one vote was already counted), the card receives `ring-2 ring-stellar-blue shadow-lg` for 2 seconds.
- **Smooth Transitions**: progress bars use `transition-all duration-500 ease-out`; the card uses `transition-all duration-300`.
- **Loading State**: while the first payload is loading, or while the dispute is still `null`, an `animate-pulse` skeleton card is rendered.
- **Vote Counter**: displayed in the header as `cast / minVotes` (e.g. `5 / 5`).

## Integration Example

Used in `frontend/src/app/disputes/[id]/page.tsx`:

```tsx
import DisputeVoteProgress from "@/components/DisputeVoteProgress";

export default function DisputeDetailPage() {
  const { id } = useParams();

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
      <div className="lg:col-span-2">{/* Main dispute content */}</div>

      <div className="space-y-6">
        {/* Real-time vote progress */}
        <DisputeVoteProgress disputeId={id as string} showVoterDetails={true} />

        {/* Voting form */}
        <div className="card border-theme-border border-2">{/* Cast Your Vote */}</div>
      </div>
    </div>
  );
}
```

## Storybook

`DisputeVoteProgress.stories.tsx` exposes a `Components/DisputeVoteProgress` story with autodocs enabled and controls for all three props (`disputeId`, `showVoterDetails`, `initialDispute`). The `Default` story passes a static `initialDispute` fixture, so it does not need a running API.

```bash
npm run storybook
```

## Testing

`frontend/src/components/__tests__/DisputeVoteProgress.test.tsx` mocks `@/hooks/useDisputeStatus` and covers:

- Loading skeleton rendering while `isLoading` is `true`
- Vote counts (`5`, `/ 5`, `Client (2)`, `Freelancer (3)`)
- Progress percentage (`100%` when the minimum is reached)
- The `Ready to resolve` message once `minVotes` is met
- The `3 more votes needed` message when below the minimum
- Anonymized voter addresses rendered when `showVoterDetails` is `true`
- Voter details omitted when `showVoterDetails` is `false`

Run the suite from `frontend/`:

```bash
npm test -- DisputeVoteProgress.test.tsx
```

## Dependencies

- `react`: `useEffect`/`useState` power the new-vote highlight
- `lucide-react`: `ShieldCheck` and `Users` icons
- `@/hooks/useDisputeStatus`: polling hook with exponential backoff
- `@/types`: `Dispute` and `Vote` type definitions

## Browser Support

Works in all modern browsers that support:

- CSS Custom Properties (theme tokens)
- Flexbox
- ES6+ JavaScript

## Accessibility

- The status message is wrapped in an `aria-live="polite"` / `aria-atomic="true"` region, so vote progress changes are announced.
- "Vote Progress" is rendered as an `<h3>`, keeping the widget in the page's document outline.
- Vote counts, percentages and the remaining-votes message are plain text, so color is never the only signal.
- The component renders no interactive controls; visual styling (card background, radii, shadows) is inherited from the surrounding `.card`/theme.
