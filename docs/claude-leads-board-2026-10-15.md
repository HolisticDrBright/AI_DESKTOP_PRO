# The leads board (marketing wiring, workstream 5) — 2026-10-15

**Branch:** `claude/leads-board-20261015`, cut from workstream 1's head (`3f2b8bbe`). The cards show the program page
and channel each request came from, which is WS1's `requestSource`.

## What was built (no schema change)

**The board is the consult Requests queue's own rows.** It is shown on the Requests page (`/telehealth-requests`)
behind a List | Board switch. The list stays the default and is unchanged.

**Where it is:**

- `src/components/consult/ConsultRequestBoard.tsx`;
- `src/components/consult/ConsultRequestsView.tsx`;
- `src/app/telehealth-requests/page.tsx` (which now mounts the switch).

**How it reads.** It uses the queue's existing `list` (no status named, so every status, newest first, up to 200),
through the existing `/api/live/consult-requests` route.

**Columns.** There is one column per state the queue records: New (`received`), Accepted, Chart created
(`converted`), Declined and Withdrawn.

**Cards.** Each shows:

- the visit type and reason;
- the reference;
- the received date;
- **where it came from** (for example "Longevity Program page · email", or "link `<slug>`");
- the queue's existing actions, where the queue allows them: Accept, Decline as outside scope, Create chart and
  invitation, and Show contact details (opened one request at a time, as in the list).

**States.**

- A failed read is its own state ("not the same as having no requests"), distinct from loading and from empty
  columns.
- A full page says that only the newest 200 are shown.

**Separation.** No request is linked to a marketing list. The board imports nothing from the campaign engine, and a
test asserts that.

**Setting.** None. The board is a view of data the page already reads, and the list remains the default. With the
switch untouched, the page renders exactly as before.

## Stopped: "contacted" and "scheduled" need a schema change

The queue records five states: `received`, `accepted`, `declined`, `withdrawn` and `converted`
(`consult_requests.status`, migration `20260930130000_synthetic_public_consult_requests.sql`). GoHighLevel's
"contacted" and "scheduled" are not among them, so the board does not invent them. This is the change they would
need, for the reviewed schema process:

1. **Contacted.** This needs a new state, or better a separate fact:
   - a nullable `contacted_at timestamptz`, and `contacted_by uuid` referencing the person;
   - set by a new workforce action, `mark_contacted { requestId, expectedRevision }`, allowed only from `received` or
     `accepted`;
   - an audit row for the change;
   - no contact content stored;
   - a revision bump, so a stale board refuses.

   A separate fact is better than a new status because "contacted" is something that happened, not a step that
   replaces accepted or declined.
2. **Scheduled.** An enquirer cannot be scheduled. Visits exist only for a patient, after `convert` creates the chart
   and the invitation is claimed, and appointments live in the telehealth store (DynamoDB), not in the consult
   tables. "Scheduled" therefore needs one of two things:
   - a read joining the converted request's `patient_record_id` to that patient's first appointment request, with
     its own authority review because it crosses the consult and appointment stores; or
   - a `scheduled_at` stamp written by the scheduling path when the first visit for a converted request's patient is
     booked.

   Either is a contract change (`consult-requests` list response) and a migration.
3. **The board change after that** is small: two more columns (or a "contacted" badge on New and Accepted cards),
   reading the new fields.

## Tests

`src/components/consult/ConsultRequestBoard.render.test.ts` (6):

- exactly one column per recorded state, in order, and none for unrecorded states;
- each request in its column, with the program page and channel;
- actions only where the queue allows them;
- a failed read is not an empty board;
- the 200-row notice;
- the same rows as the list, on the same page, with nothing from the campaign engine.

## Gate results (this branch)

| Check | Result |
| --- | --- |
| Unit suite (`npm run test:unit`) | 553 files passed; 8,726 tests passed, 11 skipped (the existing declared skips) |
| Typecheck (`tsc --noEmit`) | clean, after replacing one test regex's `s` flag, which the project's target refuses, with `[\s\S]` |
| ESLint, the changed files, `--max-warnings=0` | clean |
| Build (`APP_EDITION=clinical NEXT_PUBLIC_USE_LIVE_API=true npm run build`) | compiled |

The ordered end-to-end battery runs once, on the integration line (workstream 7). This branch adds no spec.
