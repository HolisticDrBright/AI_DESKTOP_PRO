# Core purchase and clinical follow-up, 2026-10-13: return

Source work only, on `claude/core-purchase-clinical-followup-20261013` in both repositories, answering V2
`expo/docs/claude-core-purchase-clinical-followup-2026-10-13.md` (Codex's handoff on
`agent/core-overnight-integrated-20261013`). Nothing was merged, deployed, force-pushed or opened as a pull
request, and no branch was deleted. No AWS, Stripe, Fullscript, Zoom, Apple or Google write was made, no
provider credential was handled, no real identity or health record was used, and no paid Expo/EAS/TestFlight
build was started. Nothing was activated: `CONSUMER_PURCHASE_RELEASED` is false, the consumer purchase release
list is empty, the lab-directive gate is OFF, and the consideration trace is off in the worker's result.
**Neither app is commercial-ready or PHI-ready.** Source tests are source evidence only; they fill no hosted,
device, store, provider or human-review cell.

## Start pair (verified before any work)

| | Commit | Branch | Verified |
| --- | --- | --- | --- |
| Desktop | `05bcc7346332cb512195b74dde27760d7b7ad701` | `agent/core-overnight-integrated-20261013` | remote head matched; integrated CI run `38418940665` **success** (so there was no merge failure to classify) |
| V2 | `d4d1e87452bdae68ec62e4f133caf4a648e800d6` | `agent/core-overnight-integrated-20261013` | remote head matched; App verification run `38420725926` **success** |

Since then Codex pushed two Desktop commits to the integrated branch (`caad5ab8`, `687fb46a`: catalog reads
retried through Aurora resume). They touch none of the files this branch changes, and `git merge-tree` merges
them cleanly. They are **not** in this branch; the final code pair below does not include them. V2's
integrated head has not moved.

## Brandon's decisions, recorded as given on 2026-10-13

1. **Consent scopes:** include as many as legally possible. Which scopes are legally permissible is a counsel
   question; nothing here chose them.
2. **Tier:** consumer first; Desktop and practitioners connect later.
3. **National consumer reach:** patients across the country already buy labs and products. All of these
   supplements are over the counter. Labs can be ordered in every state except NY and NJ; a licensed
   physician in each state signs off for Fullscript and Vibrant. Implemented as a release field: an
   over-the-counter consumer release may declare `licensure: not_required_over_the_counter`; the
   clinician-connected tier always needs `buyer_jurisdiction_verified`.
4. **Restricted brands (Ortho Molecular and similar):** recommended in a plan, or Fullscript emails Brandon a
   request he approves. They stay non-orderable in the consumer path.
5. **Labels:** the list of products needing labels went to Claude Cowork (V2 `4dc989f`), with
   destination-per-supplement notes and the retiring generic links.
6. **Destinations:** each supplement gets its own destination, not a brand ("brands cover multiple areas").
   Enforced: an offer whose destination another product also uses is refused everywhere in the environment.
7. **Non-supplements are catalogued too.** Held out of the consumer read by exact stable ID until a reviewed
   type release (see finding 3).
8. **Retire generic links** and link straight to the product on Fullscript (75 generic links listed for Cowork).
9. **NutriSense** is for anyone with blood-sugar issues, including type 1 or type 2 diabetes. Recorded; it
   needs a reviewed type and intended-use release before it is offered (finding 3).
10. "Go ahead on all the rest."

## Commits (full SHAs; each branch descends from its start pair)

| Repository | Commit | Package |
| --- | --- | --- |
| V2 | `4dc989fcb7d920984405134f987dd465eb3cecc8` | Cowork catalog packet: labels needed (825), per-product destinations (195), generic links to retire (75) |
| Desktop | `6035f55c689852e0741c6a22b84ba73e5975d470` | WP1: brand-site offers bound per product, OTC licensure field, shared-destination refusal |
| V2 | `723999f50178b3b56630d1d87eb29884cd0fb25b` | WP1: version-1 purchase call replaced by the bound issue-then-redeem flow, off |
| Desktop | `6f59b90db338c28f8e1c25d888181361e50f62e0` | WP2: Takesumi import accounting, three non-supplement goods held from the consumer read |
| V2 | `48eb815fa5cf9ee14bee9fd4c354a6c108e350cb` | WP2: the same three goods held from consumer matching and purchase |
| Desktop | `cfd5ad11d51e45ed175861369516f5e9a5c5b841` | WP3: iron-veto withholding recorded; measurement behind each consideration |
| V2 | `d0ee0d21181abd836c82fd13886b10db6a6b989a` | WP3: lab candidate as the Plan's one composer behind the OFF gate; source gaps closed |
| V2 | `35ce103727b542c24b1f2453a62b6a805e7f2e24` | WP4: pending-adoption name and delegate view held |
| V2 | `1fbcb2fb456a430cd1cad85aaa95199632786cf8` | WP5: predecessor index preserved (metadata) |
| V2 | `3f96de4e4522d489bd00b0b7b03d12517ccf5bd9` | WP5: acceptance index bound to the final code pair (metadata) |
| V2 | this document's commit | WP5: this return, mirrored (documentation) |
| Desktop | this document's commit | WP5: this return (documentation) |

**Final code pair:** Desktop `cfd5ad11d51e45ed175861369516f5e9a5c5b841`, V2
`35ce103727b542c24b1f2453a62b6a805e7f2e24`.

## Evidence per work package

Every "failing before" below was run against the unchanged start code (or, for WP4, the WP3 head) with only
the new test added. Where a new test imports a function that did not exist before, a scratch-only shim
reproduced the old behaviour under the new name; shims were never committed.

### WP1: bound purchase flow, off

- **V2:** every purchase control (Plan card, recommendations, Coaching, program steps) binds the exact product
  version, reviewed label and single offer, issues an expiring action with no address, and redeems it once.
  The version-1 client, `createProductAction` and the unbound `createLabCheckout` are removed, not kept
  reachable. **Failing before: 11 reproductions** on the integrated base (redirect, generic sign-up page,
  `fullscript.io` host, 30-day action, missing label/offer binding, lab-checkout network call, brand pages
  opened unbound); 134 focused tests pass after.
- **Desktop:** `fullscript-consumer-action/2` gains `direct_brand_product` (an exact product page on the
  brand's own public host; never a site root, credential, port, fragment, onward-redirect parameter or
  URL-valued query). Contract digest `6d695267be2819eba4398664d4f893daca4964befa2ead829707507080ffd47d`,
  pinned byte-for-byte in both repos. The consumer reader refuses an offer whose destination another product
  uses anywhere in the environment: **failing before** on the base reader, label gate 11/11 after.
  `consumer-product-action.test.ts` 68 tests, `.database.test.ts` 8 on the real catalog SQL.

### WP2: Takesumi accounting and the non-supplement quarantine

- `catalog-import-reconciliation/1` (`src/server/clinical-core/catalog-import-reconciliation.ts`): read-only
  (a `read only` transaction) classification of each product's label and offer per environment, naming the
  import batch of the current product version and which checked-in releases carry the label and offer.
  `scripts/catalog-import-reconciliation-report.ts` lets Codex run it. 3 database tests on fictional histories.
- **Takesumi Supreme:** every checked-in package carries its label (v1.1.0 conflicted, v1.2.0 resolved) and
  the original release carries its offer, and the importer writes every manifest row in one transaction.
  Hosted staging (current product v5, no label row, no offer row) therefore cannot come from importing any
  checked-in release. The batch ledger names the manifest that did; Codex reads it (hand-back step 1).
- NutriSense (`prd_aff_nutrisense_cgm_090`, device), Super Teeth (`prd_aff_super_teeth_super_teeth_089`,
  personal care) and Branch Basics (`prd_aff_branch_basics_branch_basics_088`, household) are held out of the
  consumer read and V2 matching/purchase by exact stable ID. Quarantine test **failing before 3 of 4**, 4/4
  after; V2 failing before on the recommendation and purchase case. Coverage evidence
  `docs/evidence/2026-10-13-catalog-offer-coverage-followup.json`: original release consumer-actionable
  offers after approval **9 → 6**; expanded release 0.

### WP3: the lab candidate as the Plan composer, and the source gaps

Desktop (`src/server/clinical-core/aws-lab-analysis-worker.ts`):

- The iron veto now returns a withholding record: rule `iron/2`, reason `iron_panel_above_range`, with both
  the suggesting low marker(s) and the contradicting high marker(s).
- Every consideration maps to the measurement that triggered it. Each measurement records:
  - the analysis's biomarker id;
  - value and unit;
  - draw date (null when unknown, never invented);
  - the bound crossed and its kind;
  - `needs_human_review`.
- The full record is persisted server-side as the `supplement-considerations` artifact, under the job prefix
  that deletion already removes.
- `CONSIDERATION_TRACE_IN_RESULT = false`. V2's lab contract is strict, so a build that predates the
  additive fields would refuse the whole result. The trace reaches the result only after every supported V2
  build parses it (hand-back step 7).
- **Failing before: 7 of 41**; 41/41 after.
- Fixture `src/contracts/fixtures/lab-consideration-trace.json`:
  - generated by the builder from invented values;
  - SHA-256 `b23d0dde40a0e1d16676d4c033112b554327bb7ac5aca22d95738c8906887d86`;
  - pinned here and mirrored in V2.

V2:

- **One composer.** The Plan screen builds `lab-supplement-candidate/1` only while `LAB_DIRECTIVE_SHOWN`.
  The product surface renders a candidate's decision and nothing else. It renders nothing unless the
  candidate's own `released` is true, so a forced route or an old record shows nothing. The old
  needs-then-match path no longer runs on the Plan screen.
- **AWS readings are never verified by the app.**
  - Functional ranges keep their reviewed source and version. The mapping moved to
    `lib/labs/awsBiomarkers.ts`; before, the source was dropped.
  - Every AWS reading is `needs_human_review` and is not used.
  - An AWS panel saved before the mark was stored is not treated as verified. Before, it was used.
  - No app code assigns `independently_verified`. A review transition is a release prerequisite (below), not
    something the client does.
- **Functional targets.**
  - A one-sided reviewed target keeps its direction, bound and source. Before, it was collapsed and lost.
  - For the candidate, an unsourced (house) target is set aside, named `functional_target_unsourced`, and
    never re-read as the laboratory's interval.
  - Other readers (Ask ALP context, display) keep their previous behaviour.
- **High-dose vitamin D** is a clinical-review item like iron. A declared label amount above 4,000 IU,
  100 mcg or 0.1 mg per serving decides it; the name never does.
- **Health history.** One that was never captured pauses matching. Defaults are not read as "none".
- **Additive lab contract.** It accepts the optional `measurement` on a consideration and the optional
  `withheldConsiderations`. Earlier results still parse; self-contradicting or "verified" traces are refused.
- **Marker matrix** (`__tests__/lab-candidate-plan-composer.test.ts`). Markers:
  - hsCRP;
  - assay-aware MPO: its own interval only, never a borrowed or invented one;
  - homocysteine;
  - fasting insulin;
  - HOMA-IR: a blank unit is not used;
  - ferritin/iron;
  - vitamin D.

  Each is run high, low, conflicting across dates, and missing a unit. A low result with no rule is not a
  need. Nothing pads the product count. Reproductive products are withheld for a male, an unknown cycle and
  an unrecorded physiology. The adult-only fence is unchanged.
- **Plans kept.** A new lab save keeps the active plan, earlier plans and earlier panels. This passes before
  and after: coverage, not a repair.
- **Failing before: 18 of 25** in the new file. The marker-matrix rows fail partly because the base candidate
  did not expose `needs`. The substantive failures are:
  - source dropped;
  - legacy unmarked AWS panel used;
  - one-sided target lost;
  - unsourced target decided;
  - high-dose D not held;
  - default history read as recorded;
  - strict contract refusal;
  - the second engine on the Plan screen.
- Five older tests that pinned the old composer were moved to the candidate (plan layout, directive surface,
  empty states, purchase screen, safety matrix). Each still proves its claim, and none was weakened.

### WP4: historical data and the delegate view (V2)

- **Pending adoption.** The notice named the plan by its own name. An older lab-derived plan is now named
  "Saved lab-derived plan (held in this release)", like a saved copy.
- **Delegate view** (`app/family-records.tsx`). The server sends the practice's active protocol with every
  item: kind, product, dose, manufacturer and instructions. While directions and peptide programs are
  withheld, the screen says how many items are shared and shows none of their contents.
  - Once directions are released, peptide items, the practice's title and summary (when any item is held)
    and any address in the text stay out.
  - Only granted scopes of this relationship are kept.
  - The view is keyed to the signed-in account and asks nothing until the session is restored.
  - It re-reads on focus, so a revoked grant ends it.
  - A reply that lands after the account changed is discarded.
  - Nothing is deleted.
- **Mounted test** (`__tests__/delegate-and-pending-plan-display.test.tsx`, happy-dom, the real screen). It
  uses an older adopted lab plan with a product name, dose, peptide and saved affiliate link, and covers
  account switch, revoked delegation and delayed hydration. **Failing before: 7 of 7**; 7/7 after.
- **This is a display rule, not a privacy control.** The payload still reaches the delegate's device. The
  server change is the blocked candidate `delegated-protocol-records/2` (below).

## Release prerequisites per lab candidate (none is met today)

Every candidate need below requires all of these. "Clinician" marks needs where a clinician review is required
per person, not only per release.

| Need | Verified marker source | Range version | Catalog / label / offer | Intended-use decision | Clinician |
| --- | --- | --- | --- | --- | --- |
| vitamin D | reviewed verification of the AWS reading (none exists) | signed `lab-ranges` release sha + any functional target's source/version | product version, label from the same import batch, exactly one offer, unshared product-page destination, consumer audience | Brandon + clinical: lab-derived OTC suggestion for the consumer tier | high-dose (> 4,000 IU) always |
| b12, folate, magnesium, zinc, omega-3 | same | same | same | same | when a medication, allergy or condition caution applies |
| iron | same | same | same | same | **always** (iron is never auto-selected) |
| cardiometabolic lipid, insulin sensitivity | same | same | same | same, plus copy that is not a treatment claim | when on lipid or glucose medication |
| inflammation / oxidative stress (hsCRP, MPO) | same, with the MPO assay named | assay-specific interval | same | same | yes for persistent elevation |
| homocysteine cofactor | same | same | same | same | kidney, thyroid or medication contributors |
| reproductive-context products | same | same | same | separate reproductive-health consent release | always |

Shared gate preconditions:

- the lab-directive tier released for the account (`surfaceAvailability('labDirective')`);
- adult with a recorded date of birth;
- recorded physiology;
- recorded pregnancy and nursing status;
- a captured health history;
- no kidney or liver flag.

**Tests proving the gate is OFF today:**

- V2 `lab-candidate-plan-composer.test.ts`:
  - "the directive gate is OFF in this build and the candidate reports it";
  - "the Plan screen builds the candidate only behind the gate…".
- V2 `lab-supplement-safety-matrix.test.ts` "stays behind the OFF release gate".
- V2 `protocol-lab-directive-surface.test.ts`.
- Desktop `aws-lab-analysis-worker.test.ts` "the completed result carries the trace only once V2 accepts it".

## Suites and gates (exact commands, honest results)

| Check | Result |
| --- | --- |
| V2 `bun run test` at `35ce103` | **300 files: 3511 passed, 1 skipped**, exit 0 (the skip is the pre-existing hosted-only `hosted-governed-recommendations.integration.test.ts`) |
| V2 `bun run test` at the first WP3 working tree | 6 failed. Five tests pinned the old composer, the legacy matching inputs or the old contract digest; one was Ask ALP context, after my unsourced-target rule leaked into a shared reader. I scoped the rule to the candidate, moved the pins to the candidate and rebound the matrix digest. No safety claim was dropped. |
| V2 `bunx tsc --noEmit`, `bun run lint` | exit 0, exit 0 (lint warnings are on unchanged lines only) |
| V2 `check:testflight`, `check:core-launch-scope`, `test:core-launch-scope`, `test:launch-acceptance`, `test:store-readiness`, `check:v2-capabilities`, `check:surface-disclosure` | all exit 0 |
| V2 `npm run test:launch-acceptance` after the rebind | 22/22 |
| V2 `npm run check:launch-acceptance` after the rebind | exit 1 **by design**: 8 source cases accepted, 9 hosted/device/human cases unobserved, "RELEASE ACCEPTANCE WITHHELD" |
| V2 `expo-doctor`, Docker image builds | not run locally; left to CI |
| Desktop `npm run test:unit` at `cfd5ad11` | **538 files: 8553 passed, 11 skipped** (the same 11 pre-existing skips), exit 0 |
| Desktop `npx tsc --noEmit`, `npm run lint` | exit 0, exit 0 |
| Desktop `TZ=America/Los_Angeles npx vitest run src/server/clinical-core/` | exit 0 |
| Desktop source gates (the 36 commands of the CI Typecheck job) | **all 36 pass**, exit 0 (the stale `dist/qualification/security-qualification.json` was removed first; the CLI writes with `wx`) |
| Desktop clinical build `APP_EDITION=clinical NEXT_PUBLIC_USE_LIVE_API=true npm run build` at `cfd5ad11` | exit 0, before the push |
| Desktop `npm run check:clinical-bundle` | PASS: 325 client chunks, no synthetic identity, no demo-only copy, none of the 17 server-only markers |
| Desktop E2E battery | not run: no page, route or live-stub file changed on Desktop |
| V2 browser journeys | not run: the changed screens are covered by mounted happy-dom tests; there is no hosted or device evidence |

No timeout was raised, no test was skipped or disabled, and no refusal was turned into a pass.

## CI on pushed heads

| Repository | Head | Run | Result |
| --- | --- | --- | --- |
| Desktop | `6035f55c` | `38425856655` | success |
| Desktop | `6f59b90d` | `38427383338`, `38427383189` | success, success |
| Desktop | `cfd5ad11` (final code head) | `38431487739` | in progress at writing; final result in the final message |
| V2 | `4dc989f` | `38422772541` | success |
| V2 | `723999f` | `38425347423` | success |
| V2 | `48eb815` | `38427021974` | success |
| V2 | `d0ee0d2` | `38431287876` | success |
| V2 | `35ce103` (final code head) | `38432326062` | success |

## Overlap with Codex lanes

| File | Lane | What it means for Codex |
| --- | --- | --- |
| `src/server/clinical-core/aws-lab-analysis-worker.ts` | Lambda artifacts | Source change only (requested by the handoff). The lab worker Lambda needs a rebuild to carry it; trace stays off. |
| `src/server/clinical-core/aws-governed-catalog-reader.ts` | hosted catalog | Consumer read adds the quarantine and the environment-wide shared-destination refusal. The catalog Lambda needs a rebuild. Codex's `687fb46a` touched `aws-governed-catalog-lambda.ts` and `rds-data-database.ts`, not this file; merge is clean. |
| `scripts/catalog-import-reconciliation-report.ts` | hosted catalog reconciliation | New read-only operator script for Codex to run; it writes nothing. |
| V2 `backend/clinical-core/fullscript-action-api-client.ts`, `backend/trpc/routes/fullscript.ts` | patient API | Version-1 routes removed; the /2 routes refuse while unreleased. The patient API image needs a rebuild to drop the old route. |

No synthetic identity, provider sandbox, care-connections 112 or Ask ALP transport file was touched.

## Holds that stay in place

- Education-only $19.99 Core. Lab-derived supplement directions, purchase links, production Ask ALP,
  peptides and longevity protocols are withheld.
- `CONSUMER_PURCHASE_RELEASED = false`; `CONSUMER_PURCHASE_RELEASES = []`.
- Lab-directive gate OFF; `CONSIDERATION_TRACE_IN_RESULT = false`.
- 598 unlabelled activations stay non-actionable. The three non-supplement goods are held.
- No paid mobile build. No PHI activation.

## Source versus hosted status

Everything above is source. Hosted catalog state, the hosted lab worker, the purchase routes and ledgers,
the delegate server payload, device behaviour and store review are **unobserved**. Of the acceptance index's
17 mandatory cases, 8 source cases pass and 9 hosted, device or human cases are unobserved, so release
acceptance is withheld.

## Unresolved findings

1. **The lab catalog's "Open to order"** (V2 `app/lab-catalog.tsx`):
   - It opens a saved `panel.orderLink`.
   - It is reachable in Core as a non-personalized catalog.
   - It is not the /1 purchase action.
   - The NY/NJ exclusion is not enforced in the app.

   Brandon decides whether the lab catalog's order links are in the Core release; if they are, a
   jurisdiction check is needed before the link opens.
2. **Takesumi's hosted rows** came from a manifest that no checked-in release produces. Only the batch ledger
   can say which.
3. **Catalog type corrections** for NutriSense, Super Teeth and Branch Basics. NutriSense's intended use
   ("blood-sugar issues including type 1 or 2 diabetes") makes it a device with a clinical indication. It
   needs a reviewed type and intended-use release; the lab candidate never auto-selects it.
4. **The delegate payload** carries held directions to the delegate's device (WP4).
5. **No review path takes an AWS reading out of `needs_human_review`.** Until one exists the lab candidate,
   once released, would use no AWS reading.
6. **One-sided functional targets** cannot be expressed on either side of the AWS path today: Desktop
   `lab-ranges/2` requires `min < max`, and V2's `functionalRangeSchema` requires both bounds. V2 now
   preserves one if one arrives.

## Decisions still Brandon's (silence is not approval)

1. **Purchase tier and jurisdiction.** Consumer first and national OTC are recorded. Still open:
   - the exact first release record (which storefront, which offers);
   - whether brand-site offers are admitted (`directProducts`).
2. **Declaration and purchase copy.** No copy was written.
3. **Direct-brand commercial authority:** each brand product's own reviewed offer page, or withheld.
4. **Catalog type corrections** (finding 3).
5. **The 598 unlabelled activations:** relabel from real reviewed source (Cowork is gathering labels), or
   withdraw.
6. **Lab catalog order links in Core** (finding 1).
7. **Intended use of lab-derived OTC suggestions** for the consumer tier: the "intended-use decision" column
   above.

Counsel, clinical, security, privacy and store reviewers remain separate. Executed agreement coverage also
remains separate.

## Codex AWS hand-back, in order

1. **Read-only reconciliation (synthetic staging).**
   - Run `scripts/catalog-import-reconciliation-report.ts` with purpose `reviewed_reference_catalog_import`
     for Takesumi and the original-release products.
   - Record each product's current version, batch, manifest digest and label/offer findings.
   - Report the batch whose manifest produced Takesumi v5.
   - Reconcile the hosted label figures (21/16 vs 22/17) against the coverage evidence.
2. **Rebuild and deploy, synthetic staging only, in this order. Code pair: Desktop `cfd5ad11`, V2 `35ce103`.**
   1. The catalog Lambda from Desktop `cfd5ad11` merged with Codex's `687fb46a` (merges cleanly).
   2. Confirm the consumer read excludes the three stable IDs.
   3. Confirm it refuses a shared destination. The expected original-release consumer-actionable count is 6,
      down from 9.
3. **Patient API (V2) rebuild**, so the version-1 Fullscript routes are gone from the hosted surface.
   - Hosted negative: `createProductAction` is absent.
   - Hosted negative: `issueProductAction` and `redeemProductAction` refuse with `PRECONDITION_FAILED` and make
     no outbound call.
4. **Durable ledgers (BLOCKED candidates; none written here).** All are needed before any purchase route
   goes live:
   - **Action ledger:** a request id unique across accounts, the request digest, the binding and the
     destination, and `redeemed_at` set once by compare-and-set; append-only.
   - **Admission store:** append-only declarations plus the current declaration per account.
   - **Practitioner and storefront authority:** for the clinician-connected tier.
5. **Purchase routes** behind the empty release list.
   - Issue and redeem for `product_patient_action` and `direct_brand_product`.
   - An admission declare/status pair.
   - The session comes from the verified authenticator.
   - The catalog port is the consumer audience.
   - Hosted negatives first (the source matrix: changed product/label/offer, two offers, a shared
     destination, restricted, expired, other account, stale session, replay, redirecting destination, site
     root), then one positive.
6. **Fixtures.**
   - Two fictional consumer accounts, two sessions each.
   - One fictional dispensary slug and one fictional brand product page.
   - A synthetic release that declares `not_required_over_the_counter`.
   - A fictional delegate relationship with a granted and an ungranted scope, plus a revoked one.
   - Fictional data only.
7. **Lab worker.**
   1. Rebuild from `cfd5ad11`.
   2. Confirm the `supplement-considerations` artifact is written under the job prefix and removed by deletion.
   3. Only after every supported V2 build parses the additive lab contract (V2 `d0ee0d2` or later), flip
      `CONSIDERATION_TRACE_IN_RESULT` in a reviewed change.
8. **Review transition for AWS readings (BLOCKED source candidate).**
   - A reviewer-attested, server-recorded verification that moves a reading from `needs_human_review` to
     `independently_verified`.
   - Bound to the reading's biomarker id, document and value.
   - Never set by a client and never set to populate a candidate.
9. **`delegated-protocol-records/2` (BLOCKED server candidate).** `clinical_core.get_delegated_patient_records`
   would withhold, at the source:
   - protocol items, titles and summaries that the release does not show to a delegate;
   - peptide items until the add-on is released.

   It would carry an additive `{kind: "held_protocol_items", count}` item. V2's records envelope is strict, so
   no new top-level key is used. Until then the V2 screen's holding is display-only.
10. **Fullscript sandbox** (only with Brandon's go-ahead): confirm the product-page shape for the reviewed
    dispensary. No live send, no purchase.

## Graphify

Graphify is unavailable in this environment: there is no `graphify` executable, no `graphify-out/` and no
vault. No graph was generated, consulted or updated.

The last section of the tracked handoff `docs/graphify-handoff-2026-09-15.md` is "Fixed six-phase completion
ledger". The append-ready text below follows its form, for whoever runs Graphify next:

> **2026-10-13 Core purchase and clinical follow-up (source only).** Desktop
> `cfd5ad11d51e45ed175861369516f5e9a5c5b841`, V2 `35ce103727b542c24b1f2453a62b6a805e7f2e24` on
> `claude/core-purchase-clinical-followup-20261013`.
>
> - `fullscript-consumer-action/2` adds bound brand-site product pages.
> - The OTC consumer release may skip buyer-state licensure.
> - Shared destinations are refused environment-wide.
> - Three non-supplement goods are held by stable ID.
> - Takesumi accounting is read-only.
> - The lab candidate is the Plan's sole composer behind the OFF directive gate.
> - The iron veto is recorded with both measurements.
> - The consideration trace is additive and off in results.
> - The pending-adoption name and delegate view are held (display only; server candidate blocked).
>
> All six phases remain partial. No deployment, activation, PHI or paid build.
