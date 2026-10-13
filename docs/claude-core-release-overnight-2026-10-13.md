# Core release overnight, 2026-10-13: return

Source work only, on `claude/core-release-overnight-20261013` in both repositories.
Nothing was merged, deployed or force-pushed. No AWS, Stripe, Fullscript, Zoom, Apple or Google call was
made, no credential was handled, no real patient data was used, and nothing was activated: no PHI,
pricing, entitlement or feature flag, and no paid mobile build. **Neither app is commercial-ready or
PHI-ready.** Source tests below are source evidence only; they fill no hosted, device, store, provider or
human-review cell.

## Start pair

| | Commit | Branch | Verified |
| --- | --- | --- | --- |
| V2 | `92a750c0a3937fbb9459949e187f693f31959950` | `agent/core-ask-alp-integrated-20261012` | remote head matched; exact-head CI passed (per the handoff) |
| Desktop | `c3f044b121673459182cf9c364d36d2b67543fe7` | `agent/core-ask-alp-integrated-20261012` | remote head matched; CI run 38348478573 **passed**, so there was no failure to classify |

Launch decision applied throughout: the $19.99 education-only Core launch comes first. Lab-derived
supplement directions, purchase links, production Ask ALP, peptides and longevity protocols stay
withheld. Codex's `c3f044b` catalog-label hold was built on, not duplicated.

## Commits

| Repository | Commit | Package |
| --- | --- | --- |
| V2 | `9cdf304` | WP1: keep an already-adopted lab plan current, show none of its withheld directions |
| Desktop | `c012dc05` | WP2: bind consumer offers to the current release's label, refuse ambiguous destinations; offer coverage audit |
| V2 | `28012e2`, `ea1a9e0` | WP3: the lab-derived supplement candidate on the real path, gate OFF (and lint style) |
| Desktop | `fec66354`, `f76a7fd8` | WP4: bound purchase action and purchase admission, disabled; storefront host moved to the reviewed release |
| V2 | `270bb12`, `5939f3f` | WP4: byte-identical contract mirror and pin |
| Desktop | this document's commit | WP5: this return |
| V2 | the acceptance-index rebind commit | WP5: kit rebound to the final pair |

## Evidence per work package

### WP1: an adopted lab plan under education-only Core (V2)

- **Defect.** An already-adopted, lab-derived plan kept its directions on screen even though they are
  withheld in this launch. Today, Tracking, the Today narrative and saved plan copies (personal storage and
  the copy comparison) showed doses, product names, brands, links and peptides from it.
- **Failing-before test.** `expo/__tests__/core-historical-plan-closure.test.tsx` failed 6 of 7 tests on
  `92a750c`. It covers a plan with a generation record, a plan from before generation records existed,
  the narrative, the held-items notice and saved copies.
- **Repair.** `expo/lib/labs/heldPlanContent.ts` decides what a plan may show:
  - a plan counts as lab-derived if its generation source is the AWS lab analysis or if any item is a
    governed product;
  - `releasedPlanContent` returns only what the shipped gates allow, plus a count of held items.
  - `ProtocolProvider` exposes `releasedActivePlan` and `heldPlanContent`. Today, Tracking, the narrative,
    personal storage and the copy review all use them.
  - The plan stays stored and stays current. Nothing is deleted, and no newer plan replaces it.
  - A plan the person typed themselves is not hidden.
- **Passing-after.** 7/7 pass. The existing Plan-tab pins are unchanged.
- **Status.** Local source: pass. CI: see WP5. Hosted, device and PHI: not observed.
- **Residual risks.**
  - The pending-adoption card still shows a plan *name*.
  - The family-records delegate view depends on the server for the same rule and was not changed.

### WP2: catalog provenance and offer coverage (Desktop)

- **Defects.** In `aws-governed-catalog-reader.ts`, two things could still make a consumer offer
  actionable:
  - a label approved for an **earlier** product version unlocked the offer for a changed product;
  - a product with **two** active destinations still gave the consumer an offer.
- **Failing-before test.** `src/server/clinical-core/aws-governed-catalog-label-gate.database.test.ts`
  runs on the real catalog SQL in embedded Postgres under the API role. With the base reader restored it
  fails 2 of 10: "a product with two active destinations is ambiguous" and "a changed current product
  version is not ordered under the label approved for the old one".
- **Repair.** The consumer audience now requires a label from the **same import batch** as the current
  product version, and **exactly one** active offer. The workforce audience still sees every row with its
  true status.
- **Passing-after.** 10/10 pass.
- **Audit.** `catalog-offer-coverage/1` (`src/server/clinical-core/catalog-offer-coverage.ts`, 5 tests)
  reports, for every offer, whether it could be ordered once its release is approved, and every reason if
  not. It also applies the owner holds (NeuroGEVITY, Black Walnut, Scutellaria). Results are in
  `docs/evidence/2026-10-13-catalog-offer-coverage.json`:

| Release | Products | Offers | Actionable after approval | Main reasons withheld |
| --- | ---: | ---: | ---: | --- |
| Original (137) | 137 | 95 | **9** | physical label required 70, shared destination 40, not consumer-open 13, direct order withdrawn 7, conflict 4, practitioner decision 3, owner hold 2 |
| Expanded | 847 | 598 | **0** | no label record 598 (54 also share a destination) |

- **Root cause of "614 vs 21" offers.** The 710 expanded candidates carry **no labels**, and their 598
  offers were commercially activated by the catalog owner anyway.
- **Not reconciled.** Source shows 22 ready labels and 17 label-ready offers; the hosted figures were
  21 and 16. Closing that gap needs a hosted read, which Codex owns.
- **Status.** Local: pass. Hosted: not observed.
- **Risk to check on hosted.** The same-batch label rule may make some hosted label-backed offers
  non-actionable. That is the intended effect, but it should be counted.

### WP3: lab-derived supplement candidate, gate OFF (V2)

- **Defects.** These are in the real path from a lab result to a governed product (accepted measurements →
  ranges → needs → catalog). Each one is shown failing in the test below.
  - Iron was selected automatically.
  - Iron results that contradicted each other across dates were not detected.
  - A lower-bound-only vitamin D range could neither be called low nor rule out "high".
  - A result with no unit was used.
  - Unknown age or physiology was not paused, and neither were minors, pregnancy, nursing or an unsure
    pregnancy status.
  - A kidney or liver flag was not paused.
  - Hormonal contraception and perimenopause were not applied.
  - Product withholdings had no per-product reason or trigger.
- **Failing-before test.** `expo/__tests__/lab-supplement-safety-matrix.test.ts` failed 16 of 17.
- **Repair.**
  - `lab-supplement-candidate/1` (`expo/lib/supplements/labSupplementCandidate.ts`): every recommendation
    names its triggering marker, value, unit, date, direction and range kind, and every withholding has a
    reason. It returns at most 6 products and pads nothing.
  - Measurement review (`labMeasurementQuality.ts`) sets aside readings marked `needs_human_review` or
    missing a unit.
  - Needs (`measuredLabNeeds.ts`): triggers, cross-date conflicts and one-sided ranges.
  - Product withholdings (`governedRecommendations.ts`): reproductive assessment and iron review, without
    changing the recommendation bundle.
  - `released` reports `labInterpretationShown('directive')`, which is **OFF**.
- **Passing-after.** 17/17 pass. The existing `measured-supplement-needs` and `clinical-pipeline-regression`
  pins caught two of my own over-reaches, and the code was changed to comply; the tests were not edited.
- **Status.** Local: pass. Hosted, device and PHI: not observed. Not shown to anyone.
- **Residual risks (preconditions for activation).**
  - The Plan screen still composes the old path behind the OFF gate and must switch to the candidate.
  - The AWS lab worker marks every biomarker `needs_human_review`, so AWS panels give the candidate no
    verified markers.
  - The Desktop worker's considerations carry no biomarker id or date.
  - The iron veto leaves no withholding record.
  - `houseTarget` is unused, and one-sided functional targets cannot be expressed.

### WP4: purchase action contract and jurisdiction admission (Desktop, mirrored in V2)

- **Expectation map.** V2's `/clinical-core/consumer/fullscript/actions` client
  (`fullscript-consumer-action/1`) sends only `{kind, productStableId}` and accepts any destination on
  `fullscript.com` or `*.fullscript.io` with any lifetime. The Desktop had **no** consumer action issuer;
  it has only the practitioner draft routes.
- **Defect.**
  - /1 cannot bind a label or an offer, so a changed label or a second offer goes undetected.
  - Its response check lets through:
    - an onward `redirect=` parameter;
    - a generic dispensary sign-up page;
    - another Fullscript host;
    - another dispensary;
    - a fragment;
    - a 30-day action.
- **Failing-before test.** A scratch test ran those 7 cases through the real /1 client with a stubbed
  fetch. All 7 failed (the client accepted each one). The log was kept and the scratch file was not
  committed.
- **Repair.** `fullscript-consumer-action/2` and `purchase-admission/1`
  (`src/contracts/fullscriptConsumerAction.ts`) are a byte-identical mirror of V2
  `expo/contracts/fullscriptConsumerAction.ts`. Both suites pin SHA-256
  `585fe3f560da04a6d9c57a2a5a1e92f0168446d89f2a8ce4af61884d63f20ee8`. The disabled candidate is
  `src/server/fullscript/consumer-product-action.ts`.
  - **Issue.** The request names the exact product, label and offer versions the person was shown, plus
    the purpose and a request id. The response carries no address. The action expires within
    10 minutes.
  - **Redeem.** Once only, and atomically. The caller must be the same account and session, still fresh
    (signed in within 15 minutes), before expiry. Everything is re-checked: admission, link, catalog
    binding and destination. The reply returns the reviewed offer's own Fullscript **product page** in the
    release's storefront and dispensary. The storefront host is data in the reviewed release, never a
    literal in the contract (V2's readiness test requires this).
  - **Admission.**
    - The person declares a jurisdiction (`US-TX` form) and a practitioner relationship: none, or a named
      care connection.
    - The server validates the declaration against three things: the release's jurisdictions, the
      dispensary practitioner's verified jurisdictions, and the care connection. The connection must be
      verified, not paused, revoked or pending, and must belong to the dispensary's clinic.
    - The clinician-connected tier requires the relationship. A declared relationship is checked on
      every tier.
    - The schemas are strict, so `ipCountry`, `locale` or `timeZone` is refused. A source test confirms
      the module reads no header, address, locale or time zone.
    - Unknown refuses.
  - **Off.**
    - `CONSUMER_PURCHASE_RELEASES` is empty and frozen.
    - Every call refuses `commerce_disabled` before touching a port.
    - Nothing outside the module and its tests constructs it, and no route exists. A test asserts both.
- **Passing-after.**
  - 53 refusal tests over fictional ports cover:
    - changed product and label, plus missing label;
    - multiple offers and changed offer;
    - restricted, practitioner-gated, injectable and absent products;
    - a link revoked before issue and after issue; paused, pending and other-clinic links;
    - expired action (and accepted one second before expiry);
    - another account (told `action_not_found`), and a stale, revoked, future-dated or different
      session;
    - 13 arbitrary or redirecting addresses;
    - a replayed request id (from any account) and concurrent redemption (exactly one succeeds).
  - 8 tests run over the **real consumer catalog SQL**: changed product, label and offer versions;
    unlabelled; two destinations; restricted (3 kinds); a generic page; another dispensary.
  - 2 Desktop pin tests and 4 V2 pin tests.
- **Measured against the real catalog.**
  - Original release: of 95 offers, 59 are non-Fullscript and 36 are the generic Fullscript sign-up
    page. **No original offer can carry a /2 action.**
  - Expanded: 527 offers are Fullscript product pages under one dispensary, but none is labelled.
- **Status.** Local: pass. **Hosted acceptance: BLOCKED.** There is no AWS route, no durable action or
  admission ledger, and no provider sandbox. Nothing is claimed to work end to end.
- **Residual risks.**
  - V2's /1 client and its callers (`SupplementsProvider`, `programs.tsx`, `SupplementsRecommendations`,
    the tRPC route) are unchanged. An existing V2 test pins /1's exact request body, and the path is
    unreachable in this launch (no route; purchase links withheld). Moving them to /2 issue-then-redeem is
    a **precondition for activation**.
  - The `lab_checkout` kind stays on /1 with its loose host check.
  - The 9 offers that become actionable after approval in the original release are **direct brand
    storefronts**, not Fullscript (Branch Basics, Calroy, NutriSense, Organifi ×3, Super Teeth, Supreme
    Nutrition, Vervita). The /2 contract does not cover them, and V2's direct-link path has **no bound
    action**.

### WP5: full verification

Results are recorded in the section below.

## Suites and gates (exact commands, honest results)

| Check | Result |
| --- | --- |
| V2 `bun run test` at `5939f3f` | **3424 passed, 1 skipped**, exit 0. The skip is the pre-existing `hosted-governed-recommendations.integration.test.ts`, which runs only with hosted access. |
| V2 `bun run test` at `270bb12` (before the host fix) | **1 failed**: `data-boundary/app-readiness` refused the affiliate storefront host as a literal in my first contract mirror. I fixed the contract (`f76a7fd8` / `5939f3f`); the test is unchanged. |
| V2 typecheck, lint | exit 0, exit 0 |
| V2 CI gates (store-readiness and launch-acceptance tests, core-launch-scope check and test, knowledge packages, HIPAA baseline, v2-capabilities, TestFlight readiness, production container and workload, food catalog, billing configuration, store readiness, public pages test, surface disclosure) | all 18 exit 0 |
| V2 iOS inspector test; patient API build, smoke and security qualification; core billing build and smoke | all exit 0 |
| V2 Docker image builds, `expo-doctor` | **not run locally**; left to CI |
| Desktop `npm run test:unit` | **535 files: 8491 passed, 11 skipped** (the same 11 pre-existing skips), exit 0. The run started at `fec66354`, and the host fix changed three test files while it ran. Those files were re-run at `f76a7fd8`: 63 passed. Exact-head CI runs the whole suite again. |
| Desktop typecheck, lint | exit 0, exit 0 |
| Desktop source gates (the 36 commands in the Typecheck job) | **all 36 pass**. The first run stopped at `qualify:security` because a report from an earlier run in this working copy was still in the ignored `dist/` (the CLI writes with `wx` and refuses to overwrite). After removing that build output it passed 29/29, and the last gate passed too. No code or gate was changed. |
| Desktop clinical build (`APP_EDITION=clinical NEXT_PUBLIC_USE_LIVE_API=true npm run build`) | exit 0 |
| Desktop E2E battery | **not run**: no file under a page, route or the live stub changed. |
| Exact-head CI | reported in the final message |

No timeout was increased, no test was skipped or edited to pass, and no refusal was turned into a pass.

## Unresolved findings

1. **V2 /1 action client defect** (WP4). It is unreachable in this launch, but it must move to /2 before
   any purchase activation.
2. **Direct brand storefront offers have no bound action** (WP4). They are the only offers that become
   actionable after approval in the original release.
3. **Catalog classification.** A glucose monitor (NutriSense), a toothpaste (Super Teeth) and a cleaning
   product (Branch Basics) are typed `supplement` and open, so the consumer gate treats them as orderable
   supplements.
4. **V2's Fullscript classification uses `trackingMetadata.supplier`**, which in the source names the
   *brand* (only 5 offers say "Fullscript"). The /2 issuer classifies by verified destination instead.
5. **Hosted label figures (21/16 vs 22/17)** are not reconciled (WP2).
6. **WP3 activation preconditions**, as listed above.
7. **WP1 residuals**: the pending-adoption plan name, and the delegate view.

## Decisions needed from Brandon (silence is not approval)

1. **Purchase admission policy.** Which tier comes first: consumer (jurisdiction only) or
   clinician-connected (jurisdiction and a verified care connection)? Which jurisdictions? Which care
   consent scope, if any, should gate a purchase action (for example `billing_links`)?
2. **Declaration and disclosure wording.** The jurisdiction and practitioner declaration text, and the
   action disclosure. No copy was written; a release must supply reviewed copy.
3. **Direct brand storefronts.** Withhold them until they have a bound action, or give each brand its own
   reviewed destination authority.
4. **Catalog typing** of the non-supplement goods in finding 3.
5. **Expanded catalog.** The 598 offers commercially activated without labels stay non-actionable. Should
   labels be sourced, or should those activations be withdrawn?
6. **Generic Fullscript sign-up links** (36 in the original release). Retire them in favour of product
   pages, or keep them as reference only?

## Codex AWS hand-back, in order

1. **Hosted catalog read (no writes).** Count, per hosted release, current products, products with an
   approved label **in the same import batch**, and consumer-actionable offers under the WP2 rule. Run the
   offer coverage audit against the hosted manifests and reconcile 21/16 against 22/17.
2. **Catalog-label release data.** Labels for the expanded release, or withdrawn activations, as Brandon
   decides. Product-page destinations to replace the generic sign-up links. The type corrections in
   finding 3. Each goes through the reviewed catalog path.
3. **Durable ledgers (BLOCKED candidates for review; none is written here).** These are needed before any
   route:
   - **Action ledger**, keyed by action id. It needs these properties:
     - request id unique across all accounts;
     - request SHA-256, account, session, environment, binding, connection, destination, issued and
       expiry times, and `redeemed_at` set once by compare-and-set;
     - append-only, with the API role able only to execute narrow functions.
   - **Admission store.** Append-only declarations with their digest and server time; current
     declaration per account.
   - **Practitioner authority.** A verified-jurisdiction record per clinic or practitioner, from a
     reviewed licence check.
4. **Route**, behind the empty release list:
   - `POST /clinical-core/consumer/fullscript/actions` (issue);
   - `…/actions/redeem`;
   - an admission declare/status pair.
   The session must come from the verified authenticator: account, session id, auth time and
   revocation. The catalog port is the consumer audience. The patient-link port reads
   `clinical_core.patient_connections` for the account, revoked rows included.
5. **Synthetic test identities and fixtures.** Two fictional consumer accounts with two sessions each; one
   fictional clinic and a verified, a paused and a revoked connection; a fictional dispensary slug; a
   synthetic release naming one fictional jurisdiction. Fictional data only.
6. **Hosted negative tests first**, mirroring the source matrix:
   - changed product, label or offer, and two offers;
   - restricted product;
   - revoked link, before and after issue;
   - expired action, other account, stale session, different session;
   - redirecting destination;
   - replayed request id and replayed redemption;
   - undeclared, unsupported and unverified jurisdiction.
   **Then one positive.** Each records the observed head and source digest.
7. **Fullscript sandbox** (only with Brandon's go-ahead). Confirm the product-page shape and storefront
   host for the reviewed dispensary. No live send, and no purchase.
8. **WP3 inputs.** A worker change so verified markers can leave `needs_human_review` through review, and
   biomarker ids and dates on considerations. Both are source changes Codex would deploy only after
   review.

## Graphify

Graphify is not available in this environment. No graph was generated or consulted.
