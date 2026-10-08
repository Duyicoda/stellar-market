# Open Issues

## #733 — PWA install prompt is shown on every session
**Status:** Open  
Users who dismissed the PWA install / push notification banner see it again on every page load. No persistence of the user's decision exists — the component does not check `localStorage` before rendering.

**Required Changes — Frontend**
- On dismiss, write `pwa_prompt_dismissed: true` and `pwa_prompt_dismissed_at: <timestamp>` to `localStorage`.
- On mount, read `localStorage` and skip rendering if dismissed within the last 30 days.
- On accept (permission granted), write `pwa_prompt_accepted: true` and never show again.
- Provide a way to re-surface the prompt from the user settings page ("Enable notifications").

**Acceptance Criteria**
- [ ] Dismissed prompt does not re-appear within 30 days
- [ ] Accepted prompt never re-appears
- [ ] User can re-enable from settings

**Labels:** `frontend` `enhancement` `ux`  
**Effort:** 1 day


---

## #736 — Frontend has no global loading indicator for slow navigations
**Status:** Open  
Next.js App Router does not show a native loading bar between route transitions when data fetching happens server-side. Users on slow connections see a frozen UI for 1–3 seconds with no indication that navigation is in progress.

**Required Changes — Frontend**
- Install `nprogress` (or implement a custom top-of-page progress bar).
- Wire it to the router using the App Router `usePathname` / `useSearchParams` change detection pattern.
- Start the bar on navigation start, complete on the new page render.
- Match the bar colour to the brand accent colour.

**Acceptance Criteria**
- [ ] Progress bar appears at the top of the page on every navigation
- [ ] Bar completes when the new page renders
- [ ] No flash or double-render of the bar

**Labels:** `frontend` `enhancement` `ux`  
**Effort:** < 1 day


---

## #735 — Dispute raise modal does not show escrow balance before submission
**Status:** Open  
The `RaiseDisputeModal` collects dispute details and submits without first showing the current escrow balance. If the escrow has already been partially or fully released, the client may raise a dispute expecting funds that are not there.

**Required Changes — Frontend**
- On modal open, call `GET /escrow/:jobId` to fetch current balance and milestone release status.
- Display a summary: "Escrow balance: X XLM — Y of Z milestones released."
- If balance is 0, show a warning: "This escrow has no remaining balance. Raising a dispute will not result in a payout."
- Allow submission regardless (the dispute may still be valid for reputational reasons).

**Acceptance Criteria**
- [ ] Escrow balance is shown before dispute submission
- [ ] Zero-balance warning is clear and visible
- [ ] User can still submit despite zero balance

**Labels:** `frontend` `enhancement` `ux`  
**Effort:** 1 day


---

## #732 — Freelancer profile has no availability status toggle
**Status:** Open  
Freelancer profiles show no availability signal. Clients have no way to know if a freelancer is actively accepting jobs, currently at capacity, or on a break.

**Required Changes**

**Backend:**
- Add `availabilityStatus: "available" | "busy" | "unavailable"` to the `FreelancerProfile` Prisma model.
- Default to `"available"` on profile creation.
- Add `PATCH /freelancers/me/availability { status }` with freelancer auth.
- Include `availabilityStatus` in the public profile response.

**Frontend:**
- Add a toggle/select on the freelancer dashboard settings: "Available", "Busy", "Unavailable".
- Render a coloured badge on the freelancer profile card and detail page: green / amber / grey.
- Clients browsing job applications see the badge next to each applicant name.

**Acceptance Criteria**
- [ ] Freelancer can set availability from their dashboard
- [ ] Status badge is visible on profile cards and detail pages
- [ ] Clients see availability status on job applicant lists

**Labels:** `frontend` `backend` `enhancement`  
**Effort:** 1–2 days
