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

## Unit 3 — account access and enrollment settlement

### The contract: `program-education-access/1` (`src/contracts/programEducationAccess.ts`)

- **Entitlement**: one per order (unique), the right of one subject to the exact purchased
  curriculum on the saved terms, copied from the order (offer revision, curriculum id/number/digest,
  access terms version, duration) and immutable; `subject` `unclaimed` or `claimed` (the identity
  API's opaque consumer subject, bound once, never transferred); `state`
  `awaiting_claim | active | expired | held_refund | held_dispute | held_policy | revoked`;
  `revision`; `window` opened at claim from the saved duration (null end = no end decided);
  `settlement` (the verification event id); the last `policy` event.
- **Transitions** (`ENTITLEMENT_TRANSITIONS`): nothing returns to `awaiting_claim` (the SQL allows
  an operator release of a never-claimed hold back to it); `expired` and `revoked` are final.
- **Claim**: a token HASH with an expiry (`CLAIM_VALIDITY_DAYS` = 7, a bound not a policy),
  single-use; using it binds the subject, opens the window and creates the one enrollment in one
  step. The token exists once, in the settlement reply, and goes to the delivery dependency.
- **Enrollment** (education, standalone): the learner's own progress through the purchased lessons
  and habits; separate from the clinical `program_assignments`; never a patient record, membership,
  consent or practitioner assignment.
- **Policy events**: `refund | dispute | chargeback | renewal_cancelled | renewal_payment_failed`
  put the entitlement in a HELD state; `operator_release | operator_revoke` are recorded operator
  decisions. No automatic refund, revocation, renewal charge or deletion.
- **Reads**: the owner's own `access` view; the `curriculum` read serves the EXACT purchased version
  (re-digested against the pinned digest) only to the active owner, else `withheld` with a reason;
  the staff status view lists every state with subjects only in opaque form.

### Settlement (`src/server/commerce/program-settlement.ts`)

Durable admitted work = the order row in `payment_verified`; receipt = the entitlement row that
references it. `settleOrder` is idempotent per order (whichever of a concurrent webhook, a second
distinct event or a poll arrives first creates it; the rest find it and receive no token);
`settleDue` recovers a crash between verification and settlement; settlement refuses an order that
is not verified-and-paid, or whose verification names another processor account or mode, and the
refusal is visible (`settlement_refused:<reason>`). `claim` binds the verified subject (from the
identity context, never the body); `access` applies expiry on read so a cached positive is never
served past its window; `curriculum` withholds for a non-owner, an inactive entitlement, a missing
version or a digest that no longer matches; `recordPolicy` holds; `expireDue` is the worker.
Delivery of the claim token to the processor-verified address is a named dependency
(`deliver`); the fixture records deliveries, and no email provider exists in this source.

### Ledgers and the bridge

- `program-education-ledger.ts` (fictional, reading the fictional checkout ledger's orders) and
  `program-education-ledger-sql.ts` (over the BLOCKED candidate through the API role; disabled unless
  evidence names all three candidates).
- `education-access-service.ts`: the narrowly admitted server bridge, shaped for the identity API's
  dispatch (`context + body`): consumer pool only, synthetic boundary only, `clinical_data` purpose,
  the subject from the verified context, three actions (`access`, `claim`, `curriculum`), and
  `activation_refused` without exact evidence. Its route seam is named
  (`POST /clinical-core/consumer/education`, `EDUCATION_ACCESS_ROUTE_SEAM`) and **registered
  nowhere** in this source (the Lambda route table, the API template and the route inventory are
  untouched; the test asserts it). Registration is in Codex's lane.
- Runtime (`program-commerce-runtime.ts`): under the fixture, the webhook route settles verified
  orders after processing (`settleDue`), the offers route registers the published content behind
  the binding so the fixture's curriculum read serves the exact version, and deliveries are recorded.
  Outside the fixture nothing settles, because nothing is verified.

### BLOCKED candidate: `infra/aws-clinical-core/source-candidates/program-education-access.sql`

- SHA-256 `e4f11e29f1b6a68f1478dbc112aaac1ea2bbf72adf86f9458dd5a20c8151df93`, pinned in
  `PROGRAM_EDUCATION_SCHEMA_CANDIDATE_SHA256`. Parents: the identity migration (`c4ca9673…`) and
  the checkout candidate (`767ac13b…`), applied after the offer candidate.
- Tables: `program_entitlements` (snapshot checked against the order by the protect trigger on
  insert; order verified-and-paid; identity and subject immutable; revision +1; the transition
  table; one per order), `program_claims` (token hash unique, one issued per entitlement, settled
  rows cannot reopen), `program_education_enrollments` (one per entitlement),
  `program_entitlement_events` (append-only).
- Functions executed by the API role: `settle_program_order`, `unsettled_program_orders`,
  `claim_program_entitlement`, `read_program_entitlement`, `entitlement_for_order`,
  `education_access`, `education_curriculum` (reads the published version table for the pinned
  version and re-digests it), `record_entitlement_policy`, `transition_program_entitlement`,
  `expire_program_entitlements`, `program_education_status` (orders, entitlements, claims, enrollments),
  `education_curriculum_staff` (the clinic's own read of the exact purchased version, under a
  workforce request context with a clinical role); all refuse until the activation row is
  enabled. `rds-data-database.ts` classifies `program_entitlement_*` and `program_claim_*` tokens.

### Tests (after)

| File | Cases |
| --- | --- |
| `src/server/commerce/program-settlement.test.ts` (fictional: idempotent settlement, crash recovery, concurrent convergence, account/mode refusal, single-use claim, cross-owner isolation, receipt substitution, expired token, exact-version read, policy holds, expiry, store failure) | 9 |
| `src/server/commerce/program-education-access-candidate.database.test.ts` (PGlite, manifest + three candidates, API role, through the same settlement boundary) | 5 |
| `src/server/commerce/education-access-service.test.ts` (activation, identity, body shape, subject binding, no route registration) | 3 |

Handoff outcomes, where proven: cross-owner and cross-clinic isolation (`not_owner`,
`already_claimed_by_other`, empty access for a stranger); receipt substitution (an order id, a
session reference or a forged token is `claim_invalid`); a different provider account or mode
refuses settlement; revoked authority withholds the curriculum and is final; both event orders
(settle first vs. claim-expired first) and duplicate settlement produce one entitlement; partial
persistence and retry after restart (`settleDue`, `unsettled_program_orders`); withholding after
an enrollment/link change is unit 4's clinical bridge (not built: a purchaser is a learner only).

### Decisions named for Brandon

1. **Claim delivery**: which provider sends the claim to the processor-verified address, and the
   7-day validity.
2. **Refund, dispute, chargeback and renewal policy**: every such event holds; what releases or
   revokes, and whether a refund ever follows automatically, are not decided here.
3. **Whether a purchaser may claim before holding a consumer account** (no: a verified consumer
   identity is required by the bridge).
4. **Whether education access needs ALP Core** (unit 4): the bridge does not check Core; the
   access read is not a Core surface unless Brandon says so.

## Unit 4 — Desktop and V2 course access

### Desktop (this commit)

- `POST /api/live/commerce/status` (`src/app/api/live/commerce/status/route.ts`): same-origin,
  cookie session, the clinic from the session; `status` returns the program's orders,
  entitlements, claims and enrollments under the `commercial` key (program-education-access/1
  `commercialStatus`); `curriculum` returns the clinic's own read of the exact version a purchaser
  was sold (`education_curriculum_staff`, workforce context with a clinical role; another clinic
  is `not_owner`). 503 `commerce_disabled` outside the fixture; never an empty list for a failure.
  No claim token or token hash is ever returned.
- `src/lib/programs/purchaseStatus.ts`: every order lands in exactly one kind:
  `checkout_open | checkout_unresolved | checkout_closed | payment_failed | order_refused |
  paid_not_fulfilled | pending_account | claim_expired | access_active | access_expired |
  held_refund | held_dispute | held_policy | revoked`, each with one sentence that says what it
  means; a verified payment without an entitlement is "paid, not fulfilled" and never enrolled;
  `clinicalDelivery` is `pending_review` for every claimed purchase, because a purchase never
  starts it.
- `src/components/programs/ProgramPurchasesPanel.tsx` beside the offer editor in the Studio:
  "not connected", "could not be read" and "no purchases" are three screens; rows carry
  `data-kind` and `data-clinical-delivery`; the exact purchased version opens read-only or says why
  it is withheld (`digest_mismatch`, `version_missing`, `not_owner`). The panel imports nothing
  clinical.
- The contract `programEducationAccess.ts` is now self-contained (the curriculum binding spelled
  inline) so it mirrors byte for byte into V2; digest after this commit:
  `af2af740c349e8b1344e870ba8b0bb2426558b6ef2defbb6e4b60d66aa474a4f`.

Tests: `src/lib/programs/purchaseStatus.test.ts` (1, every kind), `ProgramPurchasesPanel.render.test.ts`
(4), `src/app/api/live/commerce/status/route.test.ts` (3).

### V2 (next commit, in the V2 repository)

See the V2 summary `expo/docs/claude-program-commerce-closure-2026-10-11.md`.

## Unit 5 — the consultation dual path: acceptance and failure tests

### The two choices, and what convergence means

| Choice | Authority | Record it makes | Record it never makes |
| --- | --- | --- | --- |
| Request a consultation | the consult domain (`src/server/consult`, `src/app/api/public/consult`) | a consult request, "requested", in the clinic's inbox | an order, an entitlement, a claim, an enrollment |
| Buy the program | the commercial domain (`src/server/commerce`, `/buy/<slug>`, `/api/live/commerce/*`) | an order → a verified payment → an entitlement → a claim → an enrollment (account read) | a consult request, a clinic connection, a patient record, a membership, a consent grant, a program assignment |

A person who does both holds one record of each kind. Clinical adoption of a purchased program is the existing reviewed path (the Desktop assignments inbox, V2 "My programs") and is not started by a purchase: `src/server/commerce/program-education-access-candidate.database.test.ts` counts every clinical table before and after a settled purchase and finds them unchanged, and `src/server/commerce/dual-path.test.ts` proves the two module trees do not import one another and that a consult request racing a purchase (both webhook orders, four concurrent settlements) yields exactly one entitlement, one claim token, two consult requests and no clinical word in any commercial store.

### The mounted browser (`e2e/live-program-commerce.spec.ts`)

Five serial cases under the CI recipe (contract fixture, stub backend, dev server, 375 px for the preview). They run in the ordered battery like every other live spec and call `resetBackend()` first.

| # | What it proves |
| --- | --- |
| 1 | The Studio's offer editor and purchases panel open in their honest first states: `data-state="read"`, "an offer cannot be written until it does" (nothing published), no offer form, "no purchases" as a state distinct from "could not be read" and from "disabled". |
| 2 | The staff preview of a draft funnel shows both choices; the buy choice carries `data-available="false"` and the exact reason (`program_unbound`); the consult choice is a same-origin link; the funnel itself holds no form, field or button; no `/buy/` link, no price, no horizontal overflow at a phone width. |
| 3 | From a fresh browser: `/buy/longevity-program` is 404 (not a login redirect); `/buy/return?order=…` for an order nobody opened says "We do not recognise this order" with the "not proof of purchase" sentence; the checkout route answers 404 for a draft funnel, 403 cross-site and 400 oversized. |
| 4 | The webhook answers 503 `not_configured` to an unsigned and to a signed-looking event while the Stripe boundary is unconfigured, so nothing is ever recorded from a stray post. |
| 5 | The commercial status read for a program with nothing sold is 200 with empty `orders`, `entitlements`, `claims`, `enrollments` under `commercial` and no other top-level key; the same read cross-site is 403. |

No purchase can be made in the mounted run: every funnel is a draft and no program is bound. That is the posture of this branch, not a gap in the test; the purchase journey itself is proven at the module boundary (`program-checkout.test.ts`, `program-settlement.test.ts`) and in the candidate databases.

### Repairs the mounted run found (none visible from the unit tests alone)

1. **The Studio commerce routes refused the fixture session.** They required the cookie session's clinic and email; the contract-fixture suite, like every other live route, runs on the env fallback (demo credentials, `CLINICAL_ORG_ID`) inside the fixture boundary. `src/server/commerce/workforce-identity.ts` now resolves the identity cookie-first, env-fallback only inside the boundary, and null otherwise (a deployed process with no cookie answers `reauth_required`, never a guessed clinic). Four unit cases.
2. **`data-state` never reached the DOM.** `Card` forwards only `data-testid`; the offer editor and the purchases panel now wrap it in an element that carries both, so the state the e2e asserts on is the state on screen.
3. **The stub's program ids were refused as "invalid".** `scripts/live-stub-server.mjs` minted uuid-shaped ids outside the RFC 4122 layout (`-1111-2222-3333-`); the commerce contracts check the layout (the clinical service mints v4), so every offer list for a fixture program was a 400. The stub now mints `-1111-4222-8333-`. The programs spec ran alongside unchanged (14 passed).

### Hostile-input coverage inventory

| Handoff item | Where it is refused | Test |
| --- | --- | --- |
| Body limits | every commerce route reads a bounded body before parsing; V2 bounds replies at 1 MB and checks `content-length` | `offers/route.test.ts` "an oversized body"; `status/route.test.ts`; `checkout/route.test.ts` "an oversized body"; `webhook/route.test.ts` "refuses an oversized body before verifying anything"; e2e case 3; V2 `education-access-client.test.ts` "bounds the reply size", `education-dual-path.test.ts` "an oversized or non-JSON reply" |
| Hostile return URLs | the return page treats the address as a claim and the ledger as the fact; a redirect never moves an order; a forged attempt cookie is replaced | `ReturnPage.render.test.ts`; `program-checkout.test.ts` "a browser redirect … never moves an order"; `checkout/route.test.ts` "a forged attempt cookie"; e2e case 3 |
| Unsigned or tampered webhooks | signature over the raw bytes, tolerance, livemode, account and API version at the boundary; 503 when unconfigured | `webhook/route.test.ts`; `program-checkout.test.ts` "refuses the wrong account or API version"; `program-checkout-stripe.test.ts` "refuses a live key, a missing account, and an unpinned API version"; e2e case 4 |
| Duplicate, delayed, out-of-order events | durable intake deduplicated by event id; expired-then-paid is a recorded conflict; the retry worker | `program-checkout.test.ts` "admits an event durably …", "out-of-order and delayed outcomes", "the retry worker"; `program-checkout-orders-candidate.database.test.ts` "intake is durable, deduplicated and bounded"; `dual-path.test.ts` race |
| Replay and claim theft | one token, one subject, single use; an order number, a receipt, a forged, expired or malformed token change nothing; a view carrying somebody else's claimed entitlement is not this owner's view | `program-settlement.test.ts` "binds the first verified subject …", "refuses a forged, expired or malformed token …"; `program-education-access-candidate.database.test.ts` "the claim is single-use …"; V2 `education-dual-path.test.ts` (order number, path, under/oversized token refused before leaving; receipt-shaped strings reach the service and the refusal is reported; another subject's entitlement inside the view, or answering a claim, refused) |
| Stale price revisions | published terms immutable; a stale revision cannot overwrite; the order snapshot must equal the published offer; a verification whose amount disagrees cannot be written | `program-offer-ledger.test.ts`; `program-offer-revisions-candidate.database.test.ts` "a stale revision …"; `program-checkout.test.ts` "a retired or changed offer cannot start a checkout"; `program-checkout-orders-candidate.database.test.ts` "the snapshot must equal …", "a verification whose amount disagrees …"; `offers/route.test.ts` "stale revisions refused" |
| Wrong targets | a session we never opened; another processor account; another clinic (not found, never forbidden); another subject; a foreign origin | `program-checkout.test.ts` "a session the event names that we never opened"; `program-settlement.test.ts` "another processor account"; `offers/route.test.ts` "another clinic"; `status/route.test.ts` "unsafe origin"; V2 client "a reply for another subject", "a foreign origin"; e2e cases 3 and 5 |
| Live-mode events in synthetic execution | `livemode: true` refused at the Stripe boundary and again at the binding check; a live key refused at configuration | `src/server/stripe-boundary.test.ts`; `program-checkout.test.ts` binding outcome `livemode`; `program-checkout-stripe.test.ts`; V2 production channel refused |
| Missing activation | no ledger outside the fixture; the SQL ledgers refuse without exact evidence, with another candidate's digest, and while the row is off; the education bridge is disabled without activation evidence | `funnel-purchase.test.ts`; all three candidate database tests; `education-access-service.test.ts`; e2e cases 3 to 5 (503 and 404, never a saved-looking state) |

### No simulated purchase satisfies live access

- On the Desktop the fictional ledgers and the fictional processor exist only inside the contract-fixture boundary (`selectProgramCheckout`), and even there settlement requires the retrieved, bound processor object: `processor.settle(...)` in a test is the fixture's stand-in for the processor's own record, not a shortcut past verification.
- In V2 there is no stored, mocked, fixture, simulated or flag-driven source of access anywhere in the education tree, and the client can post to exactly one path on the configured origin (`education-dual-path.test.ts` scans for all of it).
- The mirrored contract now carries the state machine's invariant: an entitlement that says `active` without a claimed subject and an open window is not a row of the contract (`programEntitlement.superRefine`). A hand-made "active" row therefore fails to parse on both sides. This changed the mirror digest to `af2af740c349e8b1344e870ba8b0bb2426558b6ef2defbb6e4b60d66aa474a4f`; both repositories carry the same bytes and the V2 pin test holds.

### Decisions

None new. The verified-account-first versus anonymous-plus-claim question (unit 3) still decides which of the two convergence journeys the hosted service will offer first; both are implemented as the safe state.

## Unit 6 — verification, the authority map, and what Codex runs next

### Authority map: offer → checkout → receipt → entitlement → account read → clinical adoption

| Stage | Who may say it | The record | Where it lives | What can never say it |
| --- | --- | --- | --- | --- |
| An offer exists on these terms | a clinician of the clinic, through the Studio, bound to the published curriculum the ledger read | `program-offer/1` revision (append-only log) | `program_offers` + `program_offer_revisions` (BLOCKED candidate), fictional ledger under the fixture | a funnel page, a request body, a caller-named curriculum, a free or zero price, text inference |
| A visitor may buy now | the stored offer evaluated against the program as it is now (`availability`) | a hold or `available` on exact terms | `funnel-purchase.ts` over the offer ledger | the funnel's own text; a stale revision; a changed curriculum |
| An order was opened | the checkout boundary, after the order row is admitted with its terms snapshot | `program-checkout/1` order, state `checkout_open` | `program_orders` (BLOCKED candidate), fictional ledger | the processor page, the browser, the attempt cookie |
| A payment was made | the retrieved processor object, bound to the saved order, amount, currency, mode, account and price | `payment_verified` with the verification columns | `program_orders` verification columns; intake in `program_checkout_intake` | a redirect to `/buy/return`, a `success` query, an unsigned or live-mode event, an event naming a session we never opened |
| Access exists | settlement, from one verified order, once | `program-education-access/1` entitlement `awaiting_claim` + one claim token (hash stored) | `program_entitlements`, `program_claims` (BLOCKED candidate) | an order number, a receipt, an email address |
| This person owns it | the claim, bound to the verified consumer subject in the request context | `active`, window opened from the saved duration, one enrollment | the same ledger; bridge `education-access-service.ts` (route seam not registered) | a forged, expired, replayed or second-use token; a view carrying another subject's row |
| What the account may read | the owner's own view and the exact purchased version, read-only | `educationAccessView`, `educationCurriculumRead` | V2 `lib/education/awsEducationAccess.ts` → `/clinical-core/consumer/education` (unmounted); Desktop staff read via `/api/live/commerce/status` | device state, a mock, a flag, a previous positive; a curriculum whose digest moved |
| Clinical adoption | a practitioner, through the existing reviewed assignment path, after a purchase and never because of one | a program assignment (clinical) | the assignments inbox (Desktop), My programs (V2) | settlement, the claim, the course read; the commercial status view is `pending_review` for every claimed purchase |

Commercial data never touches clinical data: the three candidates live in `commercial_education`, no clinical function names that schema, no commerce module imports a clinical one, and the status route returns everything under `commercial` and nothing else.

### Inventory of what this branch adds

| Kind | Name | Digest / pin |
| --- | --- | --- |
| Contract | `src/contracts/programOffers.ts` (`program-offer/1`) | — |
| Contract | `src/contracts/programCheckout.ts` (`program-checkout/1`) | — |
| Contract (mirrored) | `src/contracts/programEducationAccess.ts` = `expo/contracts/programEducationAccess.ts` (`program-education-access/1`) | `af2af740c349e8b1344e870ba8b0bb2426558b6ef2defbb6e4b60d66aa474a4f`, pinned by V2 `__tests__/education-access-contract.test.ts` |
| BLOCKED candidate | `infra/aws-clinical-core/source-candidates/program-offer-revisions.sql` (parents: identity consent `c4ca9673…`, programs inbox `6ba42349…`, assignments `8d6bcac8…`) | `4973461564e6812906403525cb3aa109d6fd569eec159c9400fcf568a90b321f` = `PROGRAM_OFFER_SCHEMA_CANDIDATE_SHA256` |
| BLOCKED candidate | `…/program-checkout-orders.sql` (parents: identity consent, the offer candidate) | `767ac13bc111a15b98bdc2978a5e42a33f5f1ab61f010061907787040b0c37ee` = `PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256` |
| BLOCKED candidate | `…/program-education-access.sql` (parents: identity consent, the checkout candidate) | `e4f11e29f1b6a68f1478dbc112aaac1ea2bbf72adf86f9458dd5a20c8151df93` = `PROGRAM_EDUCATION_SCHEMA_CANDIDATE_SHA256` |
| Routes (workforce, same-origin, cookie) | `POST /api/live/commerce/offers`, `POST /api/live/commerce/status` | identity via `workforce-identity.ts` |
| Routes (public) | `POST /api/live/commerce/checkout` (303 back to the page or to the processor; HttpOnly attempt cookie), `POST /api/live/commerce/webhook` (provider-authenticated; 503 while unconfigured) | — |
| Pages (public, allow-listed in middleware, funnel CSP) | `/buy/[slug]`, `/buy/return` | — |
| Route seam (not registered) | `POST /clinical-core/consumer/education` (`education-access-service.ts`) | asserted absent in `aws-identity-api.ts`, the check script and `identity-api-extension.json` |
| Studio | `ProgramOfferEditor.tsx`, `ProgramPurchasesPanel.tsx`; `offerAuthoring.ts`, `purchaseStatus.ts` | — |
| Funnels | `FunnelPage.tsx` (both choices), `PurchasePage.tsx`, `ReturnPage.tsx` | — |
| Runtime selection | `program-commerce-runtime.ts`: fictional ledgers only inside the contract-fixture boundary; otherwise `commerce_disabled` / `checkout_unconfigured`; the Stripe transport and the SQL ledgers are never constructed by any Desktop runtime | — |
| V2 | `lib/education/awsEducationAccess.ts`, `app/education.tsx`; tests `education-access-{contract,client}`, `education-screen-journey`, `education-dual-path` | — |
| Stub | `scripts/live-stub-server.mjs` mints RFC-layout program ids; no new mutable binding (`check:stub-reset` unchanged at 141 bindings) | — |

### The repair the scripted unit run found

`npm run test:unit` runs under `TZ=America/Los_Angeles`. PGlite renders `timestamptz` in the process's session zone, so the education candidate's claim test, which compared the claim window's rendering (`2026-10-11T12:00:00+00:00`), received `2026-10-11T04:00:00-08:00`: the same instant, a different presentation. The declared contract is `z.string().datetime({ offset: true })` in all three commerce contracts, so an offset rendering is admitted and the instant is the fact. The assertion now compares the instant (`Date.parse`) beside the unchanged ownership, revision, single-use and stranger checks, and a new case reads the same entitlement under `UTC`, `America/Los_Angeles` and `Asia/Kolkata` session zones: one instant, three distinct renderings, each a contract timestamp, the claim still used and the stranger still empty under every zone. The file passes under `TZ=UTC` and `TZ=America/Los_Angeles` from the shell as well. No runtime changed, no assertion was removed, no environment was forced.

### Verification record — Desktop (`claude/program-commerce-closure-20261011`, head `the unit-6 commit that carries this record`)

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | PASS |
| `npm run lint` | PASS, 0 errors, 0 warnings |
| `npm run test:unit` (full, `TZ=America/Los_Angeles` as CI runs it) | PASS: 493 files; 7676 tests passed, 11 skipped |
| `APP_EDITION=clinical NEXT_PUBLIC_USE_LIVE_API=true npm run build` | PASS (exit 0; `/buy/[slug]` and `/buy/return` in the route table) |
| Gate battery (`check:aws-desktop-operation-inventory` plus the 32 checks the CI job runs after the unit step, among them the strict client scan and the mock-import, security, inventory and compatibility gates) | 33/33 PASS; `qualify:security` 29/29 (its first local attempt exited 1 only because the report file from the unit-2 run still existed and the CLI creates it exclusively; CI starts clean) |
| `npm run check:stub-reset` | PASS — 141 mutable bindings, every one covered |
| CI-recipe e2e, forward and reverse in one process (`E2E_LIVE=1 E2E_DEV_SERVER=1 APP_EDITION=clinical CLINICAL_CONTRACT_FIXTURE=1`, `env -u NODE_OPTIONS`, `E2E_DEV_HEAP_MB=6144`, `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium`) | NOT a clean pass, recorded as observed. Forward: 299 passed, **1 failed**, 19 skipped (provider-gated by design), 14 did not run (serial followers of the failure). Reverse: 312 passed, **1 failed**, 19 skipped, 1 did not run. The forward failure is `live-plans.spec.ts` case 4 (a complimentary grant not seen after reload, 50 s); the reverse failure is `live-telehealth.spec.ts` chart placement (`page.goto` exceeded the 120 s test timeout while the dev server restarted at its memory threshold). Each failing case passed in the other direction, neither spec touches commerce code, and `live-plans` case 4 passed in CI on `d14522b`. Not retried, not reclassified: CI's battery on the pushed head is the authority, and the reliability return records it. |

Runner memory: the dev server is started with a 6144 MB heap on a 16 GB container (constrained to about 13.4 GB); the memory probe samples are in the e2e logs. The battery is one process per direction.

### Verification record — V2 (`claude/program-commerce-closure-20261011`, head `1a9fd82`)

| Check | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS, 0 errors, 0 warnings |
| `npm test` (full) | 274 files passed, 1 skipped; 3251 tests passed, 1 skipped |
| `npm run build:production-patient-api` | PASS |
| `check:testflight` | PASS (395 production source files scanned) |
| `check:surface-disclosure` | PASS (4 declared surfaces, 4 asked through the recorded gate) |
| `check:core-launch-scope` | PASS (mirror of `core-launch-scope.json` at digest `e2248e1be632`, add-on programs unavailable) |
| `check:billing-configuration` | PASS (Core-only $19.99/month; not a program price) |
| `check:launch-acceptance` | WITHHELD by design: the 11 source-runner cases observed; the 9 hosted, device and human cases unobserved (`j1`–`j7` hosted/device, `j7-human-paid-build-and-store-authorization`), each recorded only by its own observer |
| `check:store-readiness` | runs clean and lists the standing blockers (owner, business, engineering, qa); none is this branch's to clear |

### CI

| Repository | Run | Head | Result |
| --- | --- | --- | --- |
| AI_DESKTOP_PRO | 38189223349 | `2be1922` (unit 2) | failed only at `check:aws-desktop-operation-inventory` (stale line numbers); regenerated in `9787a98` |
| AI_DESKTOP_PRO | 38192228557 | `d14522b` (unit 5) | failed only at `test:unit`: one assertion in `program-education-access-candidate.database.test.ts` compared a claim window's rendering (`+00:00`) rather than its instant, and PGlite renders timestamptz in the runner's Pacific session zone (`-08:00`). The other 10 jobs succeeded, among them the three live-fixture browser suites (which include `live-program-commerce.spec.ts`), the backend-down suite and the care-messaging database job. Fixed in unit 6 by comparing the instant. |
| AI_LONGEVITY_PRO_V2 | 38192230619 | `1a9fd82` (unit 5) | success (01:35Z) |
| AI_DESKTOP_PRO | recorded in `docs/claude-program-commerce-reliability-learner-journeys-2026-10-11.md` | unit-6 head | observed after this commit is pushed; a record cannot contain its own commit's run |

### Hosted verification matrix — not claimed run

Nothing in this branch was run against AWS, Stripe, a device or a store. The matrix says what each hosted step would prove and what it needs; every row is **not run**.

| Step | Proves | Needs (names only) | Status |
| --- | --- | --- | --- |
| Register and apply the three candidates to the qualification database, in order | the SQL ledgers behave as the PGlite tests say under the real role grants | reviewed successors of the three BLOCKED files; the migration ledger read first | not run |
| Activation row with evidence | the ledgers refuse until the exact digest is recorded, then admit | `program_commerce_activation` evidence + reviewer + time | not run |
| Offer authoring through the clinical service | the Lambda-side ledger over RDS Data API | Codex's route family behind `clinical_core_api` | not run |
| Stripe test-mode checkout session | the transport creates, retrieves and binds a session on the pinned account and API version | `STRIPE_TEST_MODE_ENABLED`, `STRIPE_TEST_SECRET_KEY`, `STRIPE_TEST_ACCOUNT_ID`, `STRIPE_API_VERSION_PINNED`, `NEXT_PUBLIC_SITE_ORIGIN` | not run |
| Webhook endpoint registered on that account | signed test events reach durable intake; replays are duplicates; live-mode refused | `STRIPE_TEST_WEBHOOK_SECRET`, the endpoint URL | not run |
| Settlement worker | a verified order becomes one entitlement and one claim; a crash is recovered | the scheduled invocation Codex chooses | not run |
| Claim delivery | the token reaches the processor-verified address once | the provider decision (owner) | not run |
| Consumer education route registered | V2 reads its own view; 404 becomes a view | `identity-api-extension.json` successor, `aws-identity-api.ts` registration | not run |
| Device read on a TestFlight build | the screen shows courses only from the service | a synthetic build authorization (owner) | not run |
| Any PHI | — | — | never: the branch is synthetic end to end |

### Ordered execution inputs for Codex (secret names only; no values exist in this branch)

1. **Review units 1 and 2** (the offer contract and the checkout boundary) before anything is registered; the fictional ledgers are the behavioural specification for the SQL adapters.
2. **Read the migration ledger**, then register `program-offer-revisions.sql` as a successor against its three parents at the digests above; apply to the qualification database only; rename the local file to the stamped version.
3. Register and apply `program-checkout-orders.sql`, then `program-education-access.sql`, each against the previous one's recorded digest; re-run the three PGlite candidate tests against the registered text and update the three `*_SCHEMA_CANDIDATE_SHA256` pins in the same change.
4. **Route families behind `clinical_core_api`**: offer authoring (`list`, `create`, `revise`, `approve_provider_mapping`, `publish`, `retire`), checkout (`start`, `admit_event`, `process`, `settle_due`), education (`access`, `claim`, `curriculum`, `staff_curriculum`, `list_for_program`), modelled on the fictional ledgers' refusal categories; the Desktop routes then call them with the workforce token instead of the fictional ledgers.
5. **Stripe test account**: create the test-mode products and prices Brandon approves (none exist); record `STRIPE_TEST_ACCOUNT_ID` and `STRIPE_API_VERSION_PINNED`; register the webhook endpoint; store `STRIPE_TEST_SECRET_KEY` and `STRIPE_TEST_WEBHOOK_SECRET` in the secret store under exactly those names; set `STRIPE_TEST_MODE_ENABLED` last.
6. **Activation**: one reviewed change recording the registered digests on `program_commerce_activation` with reviewer and time; until then every runtime answers `commerce_disabled`.
7. **Register `/clinical-core/consumer/education`** in `aws-identity-api.ts`, the check script and `identity-api-extension.json`, and remove the three "absent" assertions in the same commit; the V2 client needs no change.
8. **Hosted matrix** above, in order, with fictional data only; record each row's evidence where the launch-acceptance observers expect it.

### Owner decisions (consolidated; each is implemented as the safe unavailable state)

1. Access terms version (`education-access-terms/N`); no offer publishes without it.
2. Program binding per funnel (clinic id, program id); every buy choice is unavailable until then.
3. Prices, billing frequency and access duration per program; nothing is assumed; Core's $19.99 is not a program price.
4. Whether provider-mapping approval needs a second person.
5. Supported currencies beyond `USD`.
6. Whether an offer may exist before the program is published (refused today).
7. Verified-account-first or anonymous order plus claim (built: anonymous plus claim; both convergence journeys are the safe state).
8. The Stripe account, the API version to pin, webhook registration.
9. Session lifetime (30 minutes) and attempt-cookie lifetime (24 hours).
10. Whether a subscription-mode purchase is offered before refund, cancellation and renewal policies exist.
11. Claim delivery provider and the 7-day validity.
12. Refund, dispute, chargeback and renewal policy: what releases, what revokes, whether a refund ever follows automatically.
13. Whether a purchaser may claim without a consumer account (no, today).
14. Whether education access needs ALP Core (not checked today).
15. Native purchase classification (V2 checklist): nothing in the app sells, links to or prices a program until it is decided.
16. Children and guardians: deferred; nothing here admits a minor's purchase or a guardian's claim.

### Remaining defects and limits

- **Fixture only.** No Desktop runtime constructs the Stripe transport or a SQL ledger; the mounted browser proves refusals and honest first states, not a purchase. The purchase journey is proven at the module boundary and in PGlite.
- **The consumer education route is a seam.** Until it is registered, every V2 call answers `unavailable`; the screen and tests are ready.
- **Token shape.** A receipt-shaped string of token length reaches the service, which refuses it; the device cannot tell a receipt from a token by shape, and does not try.
- **The attempt cookie** is a convenience for reusing an open checkout, not identity; a forged one is replaced.
- **The stub's older id layout** was a fixture defect, not a product one; fixed in unit 5 and covered by the ordered battery.
- **Legacy modes** (`free`, `manual_comp`, `stripe` in older Supabase-era source) are refused by the candidate's check constraint and are not reachable from the new routes; their removal is a separate clean-up.

### Graphify — append-ready (continues after section 572)

```
573. Program commerce closure (2026-10-11/12) — branch claude/program-commerce-closure-20261011
     Desktop e69f96c (U1) 2be1922 (U2) f207cba (U3) dc90d5e (U4) 9787a98 (inventory) d14522b (U5) + unit 6 (this record and the instant repair)
     V2 1f2de21 (U4) 1a9fd82 (U5)
     Node | Implemented | Locally verified | CI verified | Hosted | Device | PHI
     program-offer/1 contract + fictional/SQL ledgers + BLOCKED candidate 4973461… | yes | yes (unit + PGlite) | unit-5 head red at one assertion, repaired in unit 6 | no | n/a | never
     program-checkout/1 contract + boundary + durable intake + BLOCKED candidate 767ac13… | yes | yes | unit-5 head red at one assertion, repaired in unit 6 | no | n/a | never
     Stripe test-mode transport (source only, never constructed) | yes | yes (fictional fetch) | unit-5 head red at one assertion, repaired in unit 6 | no | n/a | never
     program-education-access/1 mirrored contract af2af740… + settlement + claim + BLOCKED candidate e4f11e2… | yes | yes | unit-5 head red at one assertion, repaired in unit 6 | no | no | never
     Studio offer editor + purchases panel + status route | yes | yes (unit + mounted browser) | unit-5 head red at one assertion, repaired in unit 6 | no | n/a | never
     Funnel both choices, /buy/[slug], /buy/return, checkout + webhook routes | yes | yes (unit + mounted browser) | unit-5 head red at one assertion, repaired in unit 6 | no | n/a | never
     Consultation dual path: separation + race + hostile-input inventory | yes | yes | unit-5 head red at one assertion, repaired in unit 6 | no | no | never
     V2 My courses screen + owner-bound client + dual-path tests | yes | yes (3251 tests) | green | no | no (route seam unregistered) | never
     Consumer education route /clinical-core/consumer/education | seam only | asserted absent | unit-5 head red at one assertion, repaired in unit 6 | no | no | never
     Activation, prices, products, webhook registration, claim delivery | no (owner/Codex) | — | — | no | — | never
```
