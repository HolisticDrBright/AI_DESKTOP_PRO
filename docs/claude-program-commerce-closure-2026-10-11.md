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

### What the existing Stripe source is, and is not

`src/server/stripe-boundary.ts` is a disabled TEST-MODE subscription boundary (customers and
subscriptions for Core, raw-body signature verification, live keys refused, no fixture fallback)
and `src/app/api/live/stripe/webhook/route.ts` writes a deduplicating billing ledger. Neither is
course checkout, and neither was repurposed: program checkout reuses `verifyWebhookSignature`,
`getStripeConfig` and the default-off rules unchanged, and adds its own contract, ledger, processor
boundary and routes. No Core or telehealth invoice is read as a course entitlement.

### The contract: `program-checkout/1` (`src/contracts/programCheckout.ts`)

- **Order**: opaque uuid; organization, program, offer id and **offer revision**; the funnel slug it
  started from; the curriculum binding and the **terms snapshot** (pricing, provider price
  reference, access terms version, access duration) copied at admission and immutable after; the
  SHA-256 of the browser's attempt key; `subject` (`unclaimed` only in this unit); `state`;
  `revision`; the processor binding (test-mode session reference, expiry, the two return
  destinations the server chose); the verification (event id, session, amount, currency, payment
  status, account, time). No email, name, card, PAN, CVC or health field exists, and the candidate
  test asserts no such column is added.
- **States and transitions** (`ORDER_TRANSITIONS`): `admitted → checkout_open | creation_unresolved
  | refused`; `creation_unresolved → checkout_open | checkout_expired | refused`; `checkout_open →
  checkout_expired | checkout_cancelled | payment_verified | payment_failed`; the rest terminal;
  nothing returns to `admitted`. Settlement states (entitlement, enrollment, refund, dispute) are
  unit 3's contract, on top of `payment_verified`.
- **Return destinations**: only `https://<configured public origin>/buy/return?order=<uuid>&returned=success|cancel`.
  The path names no program, so the processor learns nothing about what was bought from the address
  it redirects to. `allowedReturnUrl` refuses every other origin, scheme, path, extra key, fragment,
  credential or outcome word; a browser never supplies a return address at all.
- **Verification** (`verifySessionAgainstOrder`): the retrieved object must name the bound session,
  the order (as `client_reference_id` AND as the only metadata key), test mode, the expected
  account, the mode implied by the billing kind, the snapshot's currency and amount, exactly the one
  price reference, and a known payment status; each substitution is refused by name.
- **Intake record**: event id (unique), type, raw-body SHA-256, account and API version as
  received, session reference, state (`pending | processed | unhandled | refused |
  failed_retryable | exhausted`), attempts (bound 8), next attempt time, last outcome, order id.
- **Processor contract**: a test-mode Checkout Session only (`cs_test_…`), https url, status,
  payment status, mode, livemode, amount, currency, client reference, metadata, price references,
  account.

### The boundary (`src/server/commerce/program-checkout.ts`)

`start`: refuses before any admission when the page is unbound, the public origin is unconfigured,
no processor is selected or the offer is unavailable (every hold from unit 1 applies); admits the
order **durably with the snapshot before anything outbound**; creates the hosted session under the
idempotency key `program-order:<orderId>` with the price reference, the order id, the two return
destinations and nothing else; checks the reply (not live, our account, our order, only our
metadata key, exactly our price, our destinations) before binding it; answers the processor's URL.
A repeated start from the same browser reuses the open session; concurrent starts share one order
(a lost race re-reads the order and answers the session another start opened); a lost reply or a
timeout leaves `creation_unresolved` and the next start reconciles by the idempotency key; an
expired open checkout is closed and a fresh one started; a completed one is `attempt_in_progress`.
Every transport failure is a named hold with nothing charged.

`admitEvent`: the verified event is refused when it names another account or an unpinned API
version, then admitted by id (raw-body digest kept); a replay is a recorded duplicate; a store
failure is reported so the route answers 500 and the processor retries. `processEvent`: one
bounded attempt; unknown types `unhandled`; a session we never opened `refused`; the authoritative
session is retrieved and bound; `expired` settles `checkout_expired`, `complete + paid` settles
`payment_verified` with the verification recorded, `complete + unpaid` settles `payment_failed`; a
still-open session is retried; a terminal order that disagrees with a late event is a recorded,
visible refusal; transport failures retry with backoff until the attempt bound, then `exhausted`.
`returnStatus`: state only. `processDue`: the retry worker.

### Ledgers, processors, runtime

- `program-checkout-ledger.ts`: the interface and the fictional ledger (orders, intake, append-only
  history, fault injection before any operation).
- `program-checkout-ledger-sql.ts`: the same interface over the BLOCKED candidate through the API
  role; constructed disabled unless evidence names the offer candidate AND this candidate's digest;
  every function re-checks the activation row. No request context is needed (visitors have none);
  the server names clinic and program.
- `program-checkout-processor.ts`: the processor interface and the fictional processor with every
  transport fault (`unavailable`, `timeout`, `refused`, `malformed_reply`, `redirect_reply`,
  `lost_response`) and every object substitution (`live_object`, `other_account`, `amount_drift`,
  `extra_metadata`, `wrong_order`) injectable, plus `settle()` for the fictional visitor.
- `program-checkout-stripe.ts`: the Stripe test-mode transport as source for the clinical
  service's reviewed wiring: fetch injected, `redirect: "error"`, 15 s deadline, 256 KB reply
  bound, live objects refused, malformed replies refused, request body = mode, one line item
  (price reference, quantity 1), the two return destinations, `client_reference_id` and
  `metadata[order_id]`, expiry, `expand[0]=line_items`. **Never constructed by any runtime in this
  repository**, and the test proves the default-off and live-key refusals hold with the added
  account and API-version requirements.
- `program-commerce-runtime.ts` → `selectProgramCheckout()`: the fictional ledger + processor under
  the local contract fixture only; otherwise `checkout_unconfigured`. This Desktop process has no
  durable order store and no processor; the real wiring (SQL ledger + Stripe transport behind the
  clinical service, Desktop pages calling it) is Codex's lane and is named in the execution inputs.

### BLOCKED candidate: `infra/aws-clinical-core/source-candidates/program-checkout-orders.sql`

- SHA-256 `767ac13bc111a15b98bdc2978a5e42a33f5f1ab61f010061907787040b0c37ee`, pinned in `PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256` and held equal to the
  file by its test. Parents: the identity migration (`c4ca9673…`) and the unit 1 offer candidate
  (`4973461564e6812906403525cb3aa109d6fd569eec159c9400fcf568a90b321f`), applied first.
- `commercial_education.program_orders`: the snapshot copied from the published, paid, approved
  offer and checked against it by the protect trigger on insert (`program_order_snapshot_mismatch`);
  identity immutable; revision +1; the transition table; session binding recorded once; return
  destinations constrained to the opaque return path and to this order's id; verification recorded
  once, only with `payment_verified | payment_failed`, currency equal to the snapshot and amount
  equal for a verified payment; one open order per (attempt key, offer, offer revision); one order
  per session.
- `commercial_education.program_checkout_intake`: one row per event id, admitted `pending`,
  identity immutable, settled rows cannot reopen, attempts +1 and bounded at 8.
- Functions executed by the API role: `admit_program_order`, `read_program_order`,
  `find_program_order_by_session`, `transition_program_order`, `admit_checkout_intake`,
  `read_checkout_intake`, `settle_checkout_intake`, `due_checkout_intake`; all refuse until the
  activation row is enabled. `rds-data-database.ts` classifies `program_order_*` and
  `program_intake_*` tokens as it does `program_offer_*`.

### Routes and pages

- `POST /api/live/commerce/checkout` (public, visitor): same-origin from this site's own page, 1 KB
  bound, body = the funnel slug (form or JSON) and nothing else; the funnel must be published;
  attempt key = a server-issued 24-byte HttpOnly Secure SameSite=Lax cookie (a forged one is
  replaced); 303 to the processor page, or 303 back to `/buy/<slug>?hold=<reason>` with the
  specific hold; outside the fixture always `checkout_unconfigured`, with no cookie set.
- `POST /api/live/commerce/webhook` (provider-authenticated, no browser origin): raw body first,
  256 KB bound; 503 when no checkout runtime or the Stripe boundary is unconfigured (never a
  fixture fallback); signature, tolerance and livemode by the existing boundary (400); account and
  pinned API version (400); durable admission then 200 (`admitted` or `duplicate`); 500 when the
  store cannot record. Processing is started after the acknowledgement and never settles in the
  route.
- `/buy/<slug>` now carries one form (posting the slug and nothing else) when the server has a
  checkout, prints a returned hold in words, and otherwise says checkout is not available.
- `/buy/return` (`src/app/buy/return/page.tsx`, `ReturnPage`): reads the order's state and says
  it; "confirmed" only for `payment_verified`; "success" in the address with an open order is
  "being confirmed" plus a line that the redirect is not proof; an unknown order is unknown; links
  to the program page and the consultation; noindex; mints nothing. `/buy/return` sits inside the
  existing allow-list (one slug segment under `/buy`) and precedes the dynamic page.
- Secret and configuration **names only** (`STRIPE_CHECKOUT_CONFIG_NAMES`): `STRIPE_TEST_MODE_ENABLED`,
  `STRIPE_TEST_SECRET_KEY`, `STRIPE_TEST_WEBHOOK_SECRET`, `STRIPE_TEST_ACCOUNT_ID`,
  `STRIPE_API_VERSION_PINNED`; plus `NEXT_PUBLIC_SITE_ORIGIN` for the return origin. No value exists
  in this repository.

### Subject binding (a decision implemented as the safe state)

The Desktop's public pages carry no consumer session, so a verified-account-first checkout is not
possible from them; orders start `unclaimed`. Possession of an email string, an order number or
the success URL is not ownership: nothing in this unit attributes an order to a person, and unit 3
adds the separately verified, expiring, one-time account claim before any fulfilment. If Brandon
prefers to require sign-in to the consumer app before purchase, the boundary accepts a claimed
subject at admission; that path is not built here.

### Tests (after)

| File | Cases |
| --- | --- |
| `src/contracts/programCheckout.test.ts` (return allow-list, order shape, transitions, binding refusals) | 19 |
| `src/server/commerce/program-checkout.test.ts` (fictional ledger + processor; faults, races, lost reply, intake, out-of-order, bounded retry) | 28 |
| `src/server/commerce/program-checkout-stripe.test.ts` (default off, live key, request shape, every transport refusal) | 15 |
| `src/server/commerce/program-checkout-orders-candidate.database.test.ts` (PGlite, manifest + both candidates, API role, through the same boundary) | 5 |
| `src/app/api/live/commerce/checkout/route.test.ts` | 11 |
| `src/app/api/live/commerce/webhook/route.test.ts` | 11 |
| `src/components/funnels/ReturnPage.render.test.ts`, `PurchasePage.render.test.ts` (form only when ready) | 3 + 4 |

Handoff outcomes, where proven: no PAN/CVC anywhere (the processor request and every column are
asserted); the server selects offer and amount (the browser sends a slug; a caller-named amount,
owner or version is a 400); return destinations allow-listed (contract test, 14 hostile cases);
bodies, deadlines and replies bounded (route and transport tests); opaque order ids and minimal
metadata (request assertion, `extra_metadata` refusal); admission before outbound (history
`['admitted','checkout_open']`, store fault leaves the processor untouched); concurrent starts and
lost replies reuse one checkout; webhook admission verifies raw body, signature, tolerance, account,
API version and mode; ack only after durable intake, then bounded retryable processing; unknown
events unhandled; redirect not evidence (return page and boundary tests); the authoritative object
retrieved and bound to order, offer, amount, currency, owner-less subject, mode and account;
delayed success and failure, duplicate and out-of-order events, cancellation, expiry, outages and
unknown replies each covered.

### Decisions named for Brandon

1. **Verified-account-first vs. anonymous order + claim** (above). Built: anonymous + claim.
2. **The Stripe account and API version** to pin; **webhook endpoint registration** on that account
   (names only here).
3. **Session lifetime** (30 minutes in source) and **attempt cookie lifetime** (24 hours).
4. **Whether a recurring (subscription-mode) purchase is offered at all** before the refund,
   cancellation and renewal policies exist; the boundary supports the mode, nothing publishes one.
