# Program commerce closure — October 11, 2026

Paid-program purchase and enrollment, built as disabled, source-only functionality with fictional
transports and reproducible database tests, on `claude/program-commerce-closure-20261011` in both
repositories. Nothing here contacted AWS or Stripe, retrieved a secret, created a provider product,
set a real price, published marketing, applied a migration, activated anything, opened a PR, merged
main, force-pushed, launched PHI or started a mobile build.

| Repository | Base (exact) | Branch | Head |
| --- | --- | --- | --- |
| HolisticDrBright/AI_DESKTOP_PRO | `08d07b3dbe5fc268bc289edab8bb55bc709a0bdd` (agent/program-funnels-audit-20261011; its CI 38183493842 succeeded) | `claude/program-commerce-closure-20261011` | filled in per unit below |
| HolisticDrBright/AI_LONGEVITY_PRO_V2 | `9f7fd652ed0f8025f2976a8688a25a67da4b7489` (agent/v2-followup-integration-20261011; its CI 38175276539 succeeded) | `claude/program-commerce-closure-20261011` | no V2 commit until unit 4 |

Units are separate commits. Units 1 and 2 are returned first for Codex's review of the design
and the offer contract; units 3 to 6 follow on the same branch.

## Unit 1 — explicit offers and truthful funnel choices

### Reproduced first

`src/app/api/live/programs/offer/route.ts` on 08d07b3 turned a payment mode it did not know into
`free`, a non-finite price into `0` and absent flags into open/active, and read the body with no
byte bound and no origin check. `src/adapters/programs.live.ts` repeated the defaults.

- Failing-before: `src/app/api/live/programs/offer/route.test.ts` on the unmodified route:
  **20 failed / 1 passed**. `{ paymentMode: 'complimentary', priceCents: '19.99' }` and fourteen
  other malformed bodies answered 200 and reached the dispatcher; a cross-site origin answered 200;
  a 9 KB body was accepted. (Scratch log `commerce-u1-failing-before-offer-route.txt`.)
- After: the route parses an exact `zod` shape with every term required (mode, integer cents 0 to
  1,000,000, `usd`, boolean flags, enum status), `sameBrowserOrigin`, 4 KB bound; the adapter
  forwards every term and defaults nothing; the legacy Studio panel converts the typed amount
  exactly or refuses. **21 passed.**

What the trace showed about the dispatcher seam, so nobody declares an incident from the spelling:
the Desktop's legacy vocabulary is `free | manual_comp | stripe`; the production program
artifact (`production-migrations/20260827140000_production_programs.sql`,
`clinical_core.invoke_program_operation`) admits `complimentary | invoice_required` by check
constraint. Through `aws-production-desktop.ts` every legacy mode the Desktop could send is refused
by that constraint, so on the production artifact the old defaults could not have created a free
offer; on the Supabase legacy migration and the local stub they could (`greatest(price,0)`, mode
admitted). The legacy route is kept as terms storage for that legacy family and is not the paid
path. Paid program sales use the new contract.

### The contract: `program-offer/1` (`src/contracts/programOffers.ts`)

An offer revision is bound to organization, program, and the **exact published curriculum**
(`versionId`, `version`, `sourceDigest`: the digest the assignment service computes over the
patient-facing phases). It carries an immutable `revision` that every change raises, a `state`
(`draft | published | retired`), a `mode` chosen by name (`paid | complimentary`), and for a paid
offer: `pricing` (`currency` from the supported list, today `USD` only; integer `amountMinor`
1 to 1,000,000; `billing` `one_time` or `recurring` with an explicit interval), a `providerPrice`
(`stripe`, `test` mode only, `price_…` reference, separate recorded `approval`), an
`accessTermsVersion` (`education-access-terms/N`, none written yet) and `accessDurationDays`
(null means undecided, never forever). A complimentary offer carries an authorizer, a time and a
written reason and no pricing. Nothing defaults: non-integers, negatives, overflow, unsupported
currencies, unsupported intervals, arbitrary references and unknown modes are refused as invalid,
and a paid offer with pricing left empty is a draft that cannot publish, never complimentary, free
or zero.

`purchaseAvailability(offer, currentCurriculum)` is the one function that says whether a visitor
may buy: published, paid, priced, approved, termed, and bound to the program's **current**
published version and digest; otherwise a named hold with a fixed visitor explanation that passes
the funnel text rules (`PURCHASE_HOLD_EXPLANATIONS`).

### The ledgers

- `src/server/commerce/program-offer-ledger.ts`: the interface and the fictional (in-memory)
  implementation with an append-only revision log and audit. Create binds to the curriculum the
  ledger reads (the caller cannot name a version; a program with nothing published gets no offer);
  revise/approve/publish/retire require the expected revision (stale refuses); a published offer's
  terms are immutable (retire only); publish re-reads the curriculum and refuses when it moved; one
  published offer per program; another clinic's offer is not found; a failed curriculum read is
  `service_unavailable`, never "unpublished" or "not found".
- `src/server/commerce/program-offer-ledger-sql.ts`: the same contract over the BLOCKED
  candidate through the API role, constructed disabled unless activation evidence
  (`program-commerce-activation/1`, `src/server/commerce/program-commerce-activation.ts`) names
  the exact candidate digest; the database's own activation row is checked again by every function.
  This is the implementation that belongs behind the clinical service in Codex's lane; no transport
  from the Desktop process to it exists or is configured.
- `src/server/commerce/program-commerce-runtime.ts`: which ledger this Desktop process may use:
  the fictional one under the local contract fixture only (`isContractFixtureAllowed`), otherwise
  none, answered as `commerce_disabled`. The fixture digest is a canonical-JSON digest of the
  published phases, a fictional stand-in for the SQL digest, never compared with a hosted value.

### BLOCKED candidate: `infra/aws-clinical-core/source-candidates/program-offer-revisions.sql`

- SHA-256 `4973461564e6812906403525cb3aa109d6fd569eec159c9400fcf568a90b321f`, pinned in
  `PROGRAM_OFFER_SCHEMA_CANDIDATE_SHA256` and held equal to the file by its test.
- Parents, byte-pinned in the file and refused by the test if moved:
  `20260812010000_synthetic_identity_consent.sql` (`c4ca9673…`),
  `20260903200000_synthetic_desktop_programs_inbox.sql` (`6ba42349…`),
  `20260929120000_synthetic_program_assignments.sql` (`8d6bcac8…`).
- Not registered in `migrations/manifest.json`; not applied anywhere; its activation singleton
  ships disabled with a check that refuses enabling without evidence, and the API role can neither
  read nor flip it.
- Schema `commercial_education`: `program_offers` (one row per offer, every invariant above as
  check constraints and a protect trigger: identity immutable, revision +1, transitions,
  published-immutable, approval bound to the typed reference, at most one published per program),
  `program_offer_revisions` (append-only snapshots), `program_commerce_activation`. Functions
  executed by the API role: `execute_program_offer_command(jsonb)`, `read_program_offer(uuid)`,
  `program_purchase_availability(uuid,uuid)`. The functions read program publication state
  (`synthetic_desktop_programs.published_version_id`, the version's status and content through
  `clinical_private.program_consumer_content`) and no patient, consent, encounter or record table;
  the test asserts no `clinical_core` / `clinical_private` / `clinical_audit` function body names
  the commercial schema and no commercial column is patient-shaped.
- `src/server/clinical-core/rds-data-database.ts` gains one classifier line so a
  `program_offer_*` refusal token (with publish holds after a colon) reaches the SQL ledger as its
  category; tokens only, never SQL text.

### Routes, Studio, funnels

- `POST /api/live/commerce/offers` (`src/app/api/live/commerce/offers/route.ts`): same-origin,
  cookie session (token, clinic and identity), 8 KB bound, body is exactly a `programOfferCommand`;
  actor and clinic from the session; a caller-named curriculum or clinic is a 400; `commerce_disabled`
  503 outside the fixture; under the fixture the published version is read through the same
  authenticated Studio read and registered before create/list; every ledger refusal is returned as
  its category (400/403/404/409/503) with publish holds.
- Facade `api.programs.offers(command)`; `src/adapters/live-client.ts` carries `holds` on a refusal.
- Studio: `src/components/programs/ProgramOfferEditor.tsx` beside the legacy panel, driven by the
  controller `src/lib/programs/offerAuthoring.ts`: billing starts unset and is never assumed; the
  amount converts exactly or is refused; a draft saves incomplete and says it cannot be bought;
  "not connected", "could not be read" and "no offers" are three screens; approval of the processor
  reference is a separate button; publish holds and the visitor's words are shown.
- Funnels: `programBinding` (clinic id + program id, or null) joins the definition; a slug or title
  is not a product identity. All three definitions are unbound (null) and still draft. Copy now
  explains both choices (FAQ "Do I have to pay to start?", what a purchase does not include, "Two
  ways to start"); the approval and attorney gates, draft/preview access and the production-only
  indexing posture are unchanged. `FunnelPage` renders the consult link and the buy choice in the
  hero and the call to action: a link to `/buy/<slug>` only when the offer is available, otherwise
  the specific hold in the visitor's words with no price and no link. `/learn/<slug>` is now
  `force-dynamic` and reads availability on the server (`src/server/commerce/funnel-purchase.ts`);
  no API route was added. New public page `/buy/<slug>` (`src/app/buy/[slug]/page.tsx`,
  `PurchasePage`): the exact terms, what a purchase excludes, checkout "not available yet" (the
  program-checkout boundary is unit 2), the consult address either way, noindex always, not-found
  for a draft or unknown slug. Middleware allow-list is `consult | learn | buy`, one slug segment;
  `/buy/:slug` carries the funnel CSP; the shell is shell-less for `/buy`.

### Tests (after)

| File | Cases |
| --- | --- |
| `src/app/api/live/programs/offer/route.test.ts` (failing-before 20/1) | 21 |
| `src/server/commerce/program-offer-ledger.test.ts` | 9 |
| `src/server/commerce/program-offer-revisions-candidate.database.test.ts` (PGlite, full synthetic manifest + candidate, API role) | 11 |
| `src/app/api/live/commerce/offers/route.test.ts` | 15 |
| `src/lib/programs/offerAuthoring.test.ts` | 19 |
| `src/components/programs/ProgramOfferEditor.render.test.ts` | 8 |
| `src/server/commerce/funnel-purchase.test.ts` | 5 |
| `src/components/funnels/PurchasePage.render.test.ts` | 3 |
| `src/components/funnels/FunnelPage.render.test.ts`, `FunnelDraftPreview.test.ts`, `FunnelsScreen.render.test.ts`, `src/funnels/funnels.test.ts`, `src/middleware.test.ts`, `src/lib/funnel-headers.test.ts` | updated for the buy choice |

The handoff's required outcomes, where proven: malformed/missing paid terms cannot become
complimentary (candidate test "malformed or incomplete paid terms", ledger test, route tests);
authorized complimentary access works (candidate + ledger tests); stale authoring does not
overwrite a newer offer (`revision_stale` in all three); retired, unpublished and changed offers
cannot start checkout (`purchaseAvailability`, candidate "changed curriculum", "retiring is
terminal"); both paths render honest unavailable/error/empty states (editor render test, funnel
page render test, purchase page render test, preview test).

### Decisions named for Brandon (the safe unavailable state is implemented)

1. **Access terms.** No `education-access-terms/N` exists. A paid offer cannot publish without
   one, so no offer can publish until the terms are written and versioned.
2. **Program binding.** No funnel names a program (`programBinding: null`); the buy choice is
   unavailable on every page until the clinic id and program id are supplied.
3. **Prices, billing frequency, access duration** per program: not set; the editor refuses to
   assume any. ALP Core's $19.99 is not a program price and is not referenced.
4. **Provider mapping approval** is recorded by the person who asks; whether a second person must
   approve is not decided here (the contract records who and when).
5. **Supported currencies** is `USD` only; adding one is a reviewed change.
6. **Whether an offer may be created before the program is published**: refused today
   (`curriculum_unpublished`), so the binding is always exact.

## Unit 2 — tokenized checkout and durable payment intake

(Next commit.)
