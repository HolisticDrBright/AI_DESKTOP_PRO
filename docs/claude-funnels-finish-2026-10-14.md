# Finishing the program pages (marketing wiring, workstream 1) — 2026-10-14

- **Branch:** `claude/funnels-finish-20261014`.
- **Base:** `agent/qualification-range-release-store-20261014` at `22053299`. That is the newest integration branch
  containing `97779ab7`, `e69f96cb` and `16651909` (the clinical-source integration head `19beb703` plus one
  commit).

This is workstream 1 of the marketing-wiring handoff. The phase-1 funnel design it extends is
`docs/program-lead-funnels-2026-10-11.md`.

**Scope.** Source only:

- no AWS write, DNS change, deployment, send or merge to `main`;
- no funnel changed to `published`: all three stay `draft`;
- the lesson-media, lab and clinical-source work is untouched.

## What was built

| Piece | Where | What it does |
| --- | --- | --- |
| Second next step | `src/funnels/schema.ts`, `src/lib/campaignSignupUrl.ts`, `src/components/funnels/FunnelPage.tsx` | See "The updates link" below. |
| Channel without tracking the person | `src/funnels/channels.ts`, `src/lib/funnelPageLinks.ts`, `src/app/learn/[slug]/page.tsx` | See "The channel" below. |
| Requests tagged in the queue | `src/components/consult/ConsultRequestQueue.tsx` (`requestSource`) | Each waiting request says "From Longevity Program page · email" (or "link `<slug>`" for a link no program page uses), from the slug the row already carries. |
| Counts on the Funnels screen | `src/components/funnels/funnelRequestCounts.ts`, `src/components/funnels/FunnelsScreen.tsx`, `src/app/funnels/page.tsx` | See "The Funnels screen" below. |
| Staff preview | `src/app/funnels/[slug]/preview/page.tsx` | Shows the updates link exactly as a visitor would, or says it is not configured. |

### The updates link

- **The definition.** Each funnel gains an optional `updates: { programKey }`.
- **The address.** The page's `updatesUrl` is built at render from `CAMPAIGN_SIGNUP_ORIGIN` plus
  `/signup/<programKey>`. It accepts a bare https origin only: no path, query, fragment, credentials or port.
- **Placement.** It is rendered as "Get updates about this program" beside the consult button, at the top and
  in the closing section.
- **Unset.** With the setting unset there is no link, and the page says nothing about updates.
- **No address in source.** No host is written into a definition.

### The channel

- **The definition.** Each funnel gains `channelConsultSlugs: { email }`:
  - `longevity-program-email`
  - `weight-loss-program-email`
  - `diabetes-program-email`

  A `text` slot exists for later.
- **What `?via=` does.** It is accepted only as exactly `email` or `text`; anything else is the web. It chooses
  which consult slug the button points at, and does nothing else.
- **What it does not do.** It is never returned, echoed, stored, logged or set as a cookie, and the canonical
  address never carries it.
- **Fallback.** A channel with no link of its own falls back to the web link.

### The Funnels screen

**Request counts.**

- **The table.** Each funnel shows a small table of requests per channel for the last 7 and 30 days, read
  from the queue (`surface: "queue"`, `list`, limit 200, newest first) by slug.
- **Counts only.** The reader keeps only `slug` and `receivedAt` from each row.
- **A full page.** When a full page comes back, a window reaching past its oldest row is shown as
  "at least N", never as the whole count.
- **A failed read.** A queue that cannot be read says "Requests could not be counted … This is not the same as
  no requests", distinct from a read that found none.

**Other additions.**

- **Email link state.** Each program's email link state is read from the link list. A missing link says
  "Create it through the link administration before campaign emails point at this page".
- **Updates link.** Whether the page shows "Get updates", from the sign-up origin the server read.

## The content security policy is unchanged

The sign-up origin is used for the link and nothing else. `src/lib/funnel-headers.test.ts` now asserts that
the `/learn/:slug` policy is byte-identical with and without `CAMPAIGN_SIGNUP_ORIGIN` set, and never names
that host. The page adds no form, field, script or cross-site request.

## Settings added

| Setting | Default | Turns on |
| --- | --- | --- |
| `CAMPAIGN_SIGNUP_ORIGIN` (server-only) | unset | "Get updates about this program" on each page with a list |

No other setting was added. With it unset, every page renders exactly as before (the existing
"only the consult address" test is unchanged and passes).

## Consult links to create (the existing link administration; not done here)

One link per program for the email channel, created by staff through the existing link administration.
There is no button for it on any screen; it is the API's `create` action. The request is:

```json
{ "surface": "links", "request": { "action": "create", "slug": "longevity-program-email",
  "label": "Longevity Program (email)", "visitTypes": ["initial"],
  "reasonCodes": ["program_question", "new_consultation"] } }
```

This goes to `POST /api/live/consult-requests`, repeated with `weight-loss-program-email` and
`diabetes-program-email`.

Note that the workforce consult adapters refuse any context that is not `synthetic-staging`
(`src/server/clinical-core/consult-requests.ts`). The consult queue is therefore a synthetic-only path today,
for the web links as much as the email ones; production activation of consult intake is separate,
reviewed work.

## Tests

**New.**

- `src/funnels/channels.test.ts` (5):
  - `?via=` is accepted from the fixed list only;
  - fallback when a channel has no link;
  - every consult slug is a valid contract slug, unique, and maps back to its funnel and channel;
  - definitions cannot share a link or write an address.
- `src/lib/funnelPageLinks.test.ts` (5):
  - the sign-up address refuses anything but a bare https origin;
  - the consult link is chosen per channel;
  - only the two addresses come back.
- `src/components/funnels/funnelRequestCounts.test.ts` (3): counts by channel and window, an exact zero, and
  the lower bound on a full page.
- `src/app/learn/funnel-route.test.ts` (4), on the route itself with a published fictional clone:
  - `?via=email` points at the email link, and every other value at the web link;
  - "Get updates" appears only with the setting;
  - the canonical address carries no channel;
  - a source guard: no cookie, header read, storage, fetch or log call in the route or its helpers.
- `src/components/consult/ConsultRequestSource.test.ts` (1): the queue's "From …" tag.

**Added to existing files.**

- `src/components/funnels/FunnelPage.render.test.ts` (+2):
  - with the sign-up page configured, the outbound addresses are exactly the consult page and the sign-up
    page, plus the buy page only when an offer is available;
  - still no form; no link and no word of updates when unset.
- `src/components/funnels/FunnelsScreen.render.test.ts` (+4):
  - counts;
  - a failed queue against an empty one;
  - email link states;
  - the updates line.
- `src/lib/funnel-headers.test.ts` (+1): the policy is unchanged by the sign-up origin.
- `e2e/live-funnel-page.spec.ts`: `/learn/longevity-program?via=email` answers the same not-found for a draft,
  with no redirect to sign-in and no `Set-Cookie`, like every other path in that loop.

**Failing before.** The new tests were copied onto the unchanged base `22053299` and run there:

- 14 tests fail;
- `funnelPageLinks` and `funnelRequestCounts` cannot load, because their modules do not exist;
- the policy test and the "no updates link when unset" test pass on base, as they should.

The gate results are in "Verification" below.

## Stopped for content and approval (nothing guessed)

1. **"What is included" for all three programs.**
   - **What was searched.** No published program content exists in program data or source at this base.
   - **What was found.** The only Longevity material is a mock catalog entry ("Longevity Membership Content
     Hub" in `src/adapters/programs-studio.mock.ts`), which is not a published program. Nothing exists for
     weight loss or diabetes.
   - **What stays.** Each section stays `source: 'pending'` with no items, and the schema refuses to publish it.
   - **Needed from Brandon.** The published Longevity Program, the weight loss program and the diabetes
     program (their phases and lessons as delivered), so the section can be written from them.
2. **Approval of the exact text.**
   - Brandon's, for all three pages.
   - His attorney's as well for the weight loss and diabetes pages.
   - This now includes the "Get updates" sentence in the footer.
3. **Publishing** stays Brandon's. No `status` was changed.

## Not verified

- No campaign service is running, so the sign-up page the link points at has not been reached from a
  browser. It is built in workstream 2.
- The email consult links do not exist in any database.
- The counts were exercised against fictional queue rows only.

## Verification

- **Unit suite.** `npm run test:unit`, full run on this branch: 552 files, 8,729 tests; 8,718 passed, 11 skipped
  (the existing declared skips), 0 failed.
- **Typecheck and lint.** `tsc --noEmit` clean, and `eslint` clean on every changed file.
- **Clinical build.** `APP_EDITION=clinical NEXT_PUBLIC_USE_LIVE_API=true npm run build` passes.
- **Browser battery.** Run once on the integration branch that carries every workstream (workstream 7), not
  per branch. Its result is recorded in `docs/claude-outreach-wiring-2026-10-14.md`.
