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
| Second next step | `src/funnels/schema.ts`, `src/lib/marketingSignupLink.ts`, `src/funnels/marketingSignup.ts`, `src/components/funnels/FunnelPage.tsx` | See "The updates link" below. |
| Channel without tracking the person | `src/funnels/channels.ts`, `src/lib/funnelPageLinks.ts`, `src/app/learn/[slug]/page.tsx` | See "The channel" below. |
| Requests tagged in the queue | `src/components/consult/ConsultRequestQueue.tsx` (`requestSource`) | Each waiting request says "From Longevity Program page · email" (or "link `<slug>`" for a link no program page uses), from the slug the row already carries. |
| Counts on the Funnels screen | `src/components/funnels/funnelRequestCounts.ts`, `src/components/funnels/FunnelsScreen.tsx`, `src/app/funnels/page.tsx` | See "The Funnels screen" below. |
| Staff preview | `src/app/funnels/[slug]/preview/page.tsx` | Shows the updates link exactly as a visitor would, or says no practice offering the list holds the marketing package. |

### The updates link

- **The definition.** Each funnel gains an optional `updates: { programKey }`.
- **The address (revised 2026-10-15).** The handoff revised on 2026-10-14 moved the sign-up page into the
  Desktop: the link is now the offering practice's own `/join/<practice>/<programKey>` page, prefixed with the
  public site origin when one is set and same-origin otherwise. `CAMPAIGN_SIGNUP_ORIGIN` is gone.
- **When it is shown.** Only when a `MarketingSignupDirectory` says a practice offering the program's list
  holds the `marketing` entitlement (`src/lib/marketingSignupLink.ts`). An unentitled, unreadable or
  malformed answer hides the link: a link to a sign-up page that would refuse the visitor is worse than none.
- **On this branch.** `src/funnels/marketingSignup.ts` returns the "no practice" directory, so no page shows
  the link. The campaign engine (workstream 2, `claude/campaign-engine-20261015`, cut from this branch's
  head) supplies the real directory from its commercial store.
- **Placement.** It is rendered as "Get updates about this program" beside the consult button, at the top and
  in the closing section.
- **No address in source.** No host or practice is written into a definition.

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
- **Updates link.** Whether each page shows "Get updates", and its exact address, as the server decided it.

## The content security policy is unchanged

The sign-up link is a same-origin `/join` path, so it needs no policy allowance. `src/lib/funnel-headers.test.ts`
asserts the `/learn/:slug` policy is unchanged by the public origin and names no sign-up path or host. The
page adds no form, field, script or cross-site request.

## Settings added

| Setting | Default | Turns on |
| --- | --- | --- |
| The practice's `marketing` entitlement (data in the campaign engine's store, workstream 2) | not held | "Get updates about this program" on each page with a list |

No environment setting was added (the revision removed `CAMPAIGN_SIGNUP_ORIGIN`). Without an entitled practice, every page renders exactly as before (the existing
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
- `src/lib/funnelPageLinks.test.ts` (7):
  - the sign-up address is the practice's `/join/<practice>/<program>` page only when the directory names an
    entitled practice; an unentitled, failing or malformed answer hides it;
  - the directory is asked only for the list's program key, and on this branch names no practice;
  - the consult link is chosen per channel;
  - only the two addresses come back.
- `src/components/funnels/funnelRequestCounts.test.ts` (3): counts by channel and window, an exact zero, and
  the lower bound on a full page.
- `src/app/learn/funnel-route.test.ts` (4), on the route itself with a published fictional clone:
  - `?via=email` points at the email link, and every other value at the web link;
  - "Get updates" appears only when a practice holds the marketing entitlement;
  - the canonical address carries no channel;
  - a source guard: no cookie, header read, storage, fetch or log call in the route or its helpers.
- `src/components/consult/ConsultRequestSource.test.ts` (1): the queue's "From …" tag.

**Added to existing files.**

- `src/components/funnels/FunnelPage.render.test.ts` (+2):
  - with a sign-up page, the outbound addresses are exactly the consult page and the sign-up page, plus the
    buy page only when an offer is available;
  - still no form; no link and no word of updates without one.
- `src/components/funnels/FunnelsScreen.render.test.ts` (+4):
  - counts;
  - a failed queue against an empty one;
  - email link states;
  - the updates line.
- `src/lib/funnel-headers.test.ts` (+1): the sign-up link needs no policy allowance; the policy names no sign-up
  path or host.
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

- The `/join` sign-up page the link points at is built in workstream 2 (the campaign engine branch); on this
  branch no practice is entitled, so no page shows the link.
- The email consult links do not exist in any database.
- The counts were exercised against fictional queue rows only.

## Verification

- **Unit suite.** `npm run test:unit`, full run on this branch after the 2026-10-15 revision: 552 files; 8,720 passed,
  11 skipped (the existing declared skips), 0 failed. (Before the revision: 8,718 passed.)
- **Typecheck and lint.** `tsc --noEmit` clean, and `eslint` clean on every changed file.
- **Clinical build.** `APP_EDITION=clinical NEXT_PUBLIC_USE_LIVE_API=true npm run build` passes.
- **Browser battery.** Run once on the integration branch that carries every workstream (workstream 7), not
  per branch. Its result is recorded in `docs/claude-outreach-wiring-2026-10-14.md`.
