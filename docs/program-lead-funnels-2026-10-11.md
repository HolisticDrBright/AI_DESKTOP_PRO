# Program lead funnels, phase 1 — October 11, 2026

Public pages that describe a built program and end in a consult request, built natively from
fixed sections, on a separate branch from `e3f39a6`. No payment, no form, no health question,
no third-party script, pixel, embed, font or analytics, and no new unauthenticated API route.
Every funnel hands off to the consult link the Desktop already offers a stranger.

## The defect that came first

A stranger following a consult link landed on the practitioner sign-in page: `src/middleware.ts`
redirected every signed-out page request except `/login` and `/reset`. The failing test was
written first (`src/middleware.test.ts`: a signed-out request to `/consult/<slug>` must pass
through, not answer 307). On `e3f39a6` it failed with 307. The repair is an exact allow-list,
`PUBLIC_VISITOR_PAGE = /^\/(?:consult|learn)\/[A-Za-z0-9][A-Za-z0-9_-]{0,119}\/?$/`: one slug
segment under either prefix and nothing else. The prefixes themselves (`/consult`, `/learn`),
their neighbours (`/consultations/x`, `/learning/x`, `/learn-more/x`) and every other page still
redirect, and the existing "everything else redirects" tests are unweakened.

## What was built

| Piece | Where | Notes |
| --- | --- | --- |
| Funnel definitions | `src/funnels/schema.ts`, `src/funnels/definitions/*.ts`, `src/funnels/index.ts` | One typed, zod-validated file per funnel, validated at import. Fixed section kinds: hero, who-it-is-for, what-is-included, how-it-works, practitioner, FAQ, call-to-action. No form, embed, testimonial or image kind exists. |
| Text rules, enforced by shape | `funnelTextIssue` | Refused anywhere in copy: any address or domain, markup, a dose, a drug or brand name, a promised amount or pace of change, added years or reversed age, a claim to cure, reverse or guarantee (saying something is *not* guaranteed is allowed and required on the weight loss page), and any suggestion to change or stop medication. |
| Publication gate | `funnelDefinition` | `published` requires a recorded approval (who, when, whether an attorney reviewed), a "what is included" section whose `source` is `published_program` with items, and no draft note. A draft must say why it is a draft. |
| Public route | `src/app/learn/[slug]/page.tsx` | Server-rendered from the definition alone: no session, no API call, no data read. A draft and an unknown slug both answer not-found. `noindex` and no canonical unless indexing is allowed and the funnel is indexable. |
| Page component | `src/components/funnels/FunnelPage.tsx` | Plain text; its only links are the consult address (built from the configured origin, else the same-origin `/consult/<slug>` path). A footer names the operator and says the page is not medical advice and does not replace the visitor's own doctor. |
| Indexing posture | `src/lib/publicSite.ts`, `src/app/sitemap.ts` | No host name in source. Indexing is allowed only when `NEXT_PUBLIC_SITE_ORIGIN` is a configured https origin, `APP_RUNTIME_ENV` is `production-clinical`, and nothing (runtime, environment, host name) says staging, synthetic, dev, test or localhost. Otherwise every funnel page is `noindex` and the sitemap is empty, whatever the definition says. The sitemap lists only published, indexable funnels; the consult page is never listed. |
| Shell | `src/components/shell/AppShell.tsx` | `/learn` joins `/consult` as a shell-less public path, with a wider column (960px) because a program page is not a form. |
| Headers | `next.config.ts` | `/learn/:slug` is served a strict policy: `default-src 'self'`, `connect-src 'self'`, `frame-src 'none'`, `media-src 'none'`, no external script source, `form-action 'self'`; asserted in `src/lib/funnel-headers.test.ts`. |
| Funnels screen | `src/app/funnels/page.tsx`, `src/components/funnels/FunnelsScreen.tsx`, Sidebar under Business | Read-only. Each funnel's status, public address and consult address (or a plain statement that no public address is configured), its draft note, and the state of its consult link read from the existing link list. A published funnel pointing at a missing, disabled or paused link is called out. A failed link read is shown as a failure, not as "no links". |

## The three funnels

Built in Brandon's order with `indexable: true` on each, one consult slug each
(`longevity-program`, `weight-loss-program`, `diabetes-program`; the links themselves are
created through the existing link administration with visit type `initial` and reason codes
`program_question` and `new_consultation`; queue rows carry the slug, so the practitioner sees
which funnel a request came from with no schema change).

**All three are `draft`.** Two things keep them so, and both are Brandon's to resolve:

1. **"What is included" must come from the real program.** No published Longevity, weight
   loss or diabetes program was found in this repository (the only mention of the Longevity
   Program here is the Core launch scope; `src/adapters/programs.longevity.ts` exists only in an
   older working copy on Brandon's machine, which this branch cannot read). Each definition's
   section is `source: 'pending'` with no items, and the page says so rather than showing a
   curriculum drafted from general knowledge. The schema refuses to publish a pending section.
2. **The exact text needs approval.** Brandon's for all three; his attorney's as well for the
   weight loss and diabetes pages. The draft notes say so on the Funnels screen.

Content rules kept in the drafts: no drug or brand names, no promised amount or speed of weight
loss, no before-and-after figures, "any prescription is a clinician's decision after an
evaluation and is not guaranteed"; the diabetes page says who it is for, claims nothing about
curing, reversing or treating, suggests no change to medication, and states that the program
does not replace the visitor's own doctor; the Longevity page makes no claim of added years or
reversed age and names no dose. The text rules enforce these by shape, so a later edit that
breaks one fails the build.

## Tests

- Middleware: the allow-list is exact; the consult page and the funnel route pass through
  signed out; neighbouring paths redirect (`src/middleware.test.ts`, 11).
- Definitions and rules: order, draft state, indexability, consult slugs, every refused phrase,
  publication gating, section uniqueness, no form/embed/testimonial/image kind
  (`src/funnels/funnels.test.ts`, 21).
- Rendered page: every section kind, the pending "what is included" wording, no form control,
  image, script or `src`, only the consult address as a link, same-origin fallback
  (`src/components/funnels/FunnelPage.render.test.ts`, 4).
- Indexing: origin parsing, the production-only posture, the empty sitemap without the
  production origin, draft and unknown slugs `noindex` with no canonical
  (`src/lib/publicSite.test.ts`, 9).
- Headers and routes: the funnel CSP; no API route added, the only unauthenticated Desktop
  route is still the consult intake (`src/lib/funnel-headers.test.ts`, 2).
- Funnels screen: no-origin statement, failed read distinct from empty, every funnel's rows, the
  published-with-bad-link warning (`src/components/funnels/FunnelsScreen.render.test.ts`, 5).
- End to end (`e2e/live-funnel-page.spec.ts`, in the ordered battery): a signed-out visitor gets
  not-found, never sign-in, on a draft and an unknown funnel slug, with the strict policy on the
  answer; the consult page loads signed out; neighbouring paths still go to sign-in.

## Boundaries honoured

No new unauthenticated API route; no table, migration or ledger change; funnel code imports
nothing clinical except the consult link helper; no health question, quiz or free text on a
funnel page; no third-party script, pixel, embed, font or analytics; nothing `published`. The
lesson-media work on `claude/program-media-repair-20261011` was not touched. No merge to main,
force-push, deployment, AWS write, activation or PHI enablement.

## Still open for Brandon

1. The public web address (`NEXT_PUBLIC_SITE_ORIGIN`), and the production runtime that turns
   indexing on; until then every page is `noindex` and the sitemap is empty.
2. The published Longevity, weight loss and diabetes program content, so "what is included"
   can be written from it.
3. Approval of the exact text (and attorney approval for two pages); then `status: 'published'`
   with the approval recorded in the definition.
4. Whether testimonials will be used at all, and with what permission; how long unconverted
   enquiries are kept. Neither is built.

## Not verified here

The pages were not viewed in a browser on a configured public origin; the Funnels screen's
link read was exercised against rendered states, not a live link list; no funnel is published,
so the end-to-end battery exercises the not-found and no-redirect behaviour, not a rendered
funnel page; nothing hosted, and no search engine, was involved.

## Verification record (added October 12, 2026)

- Focused suites on `97779ab`: 7 files / 56 tests; typecheck and lint clean; full unit suite 468 files, 7432 passed / 11 skipped; `check:stub-reset` PASS (141 bindings).
- Hosted CI: run 38179747460 on `97779ab` **failed** on one case only, `e2e/live-funnel-page.spec.ts` case 2 (it expected neighbouring paths to redirect to sign-in; under the contract-fixture suite the documented local fallback session renders pages instead). Repaired in `ecc21ca` (asserts not-found-or-sign-in and no funnel page). Run 38181203437 on `ecc21ca` **succeeded** (all 11 jobs).
- The documented battery (`APP_EDITION=clinical NEXT_PUBLIC_USE_LIVE_API=true npm run build` then `npm run test:e2e:order` under `next start` with the CLAUDE.md environment) fails wholesale on this tree and on its base alike: forward 20 passed / 44 failed / 83 skipped, reverse identical, exit 1. Cause: the contract fixture is refused under the deployed posture (`NODE_ENV=production`) without `CLINICAL_CONTRACT_FIXTURE=1`, so sign-in itself fails. The refusal is correct and was not weakened; CI runs the suite with `E2E_DEV_SERVER=1` and `CLINICAL_CONTRACT_FIXTURE=1`.
- The CI recipe locally (dev server, `CLINICAL_CONTRACT_FIXTURE=1`, every `live-` spec in one process, `env -u NODE_OPTIONS`, `E2E_DEV_HEAP_MB=6144`): forward 304 passed / 1 failed / 19 skipped / 4 did not run; reverse 305 passed / 1 failed / 19 skipped / 3 did not run. The one failure in each pass was a different `e2e/live-programs.spec.ts` case (8+9 forward, 10+11 reverse) timing out at 45 s in the draft editor, a spec this branch does not touch and which is green in CI; the spec alone afterwards passed 9/9. The container restarted once during the reverse pass and it was rerun from the start. These are local runner-memory observations, not a claim about the branch.
- Codex's audit of `ecc21ca` produced the successor `08d07b3` on `agent/program-funnels-audit-20261011` (`docs/program-funnels-audit-2026-10-11.md`); this branch remains the audited predecessor and is not merged.
