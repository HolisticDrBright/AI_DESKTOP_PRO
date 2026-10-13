# Core safety and release preflight, 2026-10-13: return

_The same return is committed in V2 as `expo/docs/claude-core-safety-release-preflight-return-2026-10-13.md`. It answers the handoff "Next Claude Code handoff — Core safety and release preflight" (October 13, 2026). Paths without a repository prefix are V2 `expo/` paths when they start with `__tests__/`, `app/`, `lib/`, `contracts/`, `components/`, `scripts/`, `release/` or `docs/`, and Desktop paths when they start with `src/`._

Source work only, on `claude/core-safety-release-preflight-20261013` in both repositories. Nothing was merged to
`main`, deployed, force-pushed, opened as a pull request or deleted. No AWS, Stripe, Fullscript, Zoom, Apple or
Google write was made; no provider credential was handled; no real identity or health record was used; no paid
Expo/EAS/TestFlight/Play build was started. Nothing was activated: `CONSUMER_PURCHASE_RELEASED` is false, the lab
classification, inference and directive tiers are off, general lab ordering is off, production Ask ALP is held,
and peptides and longevity stay unavailable. **Neither app is commercial-ready or PHI-ready.** Source tests are
source evidence only; they fill no hosted, device, store, provider or human-review cell.

## Start pair (verified before any work)

| | Commit | Branch | Exact-head CI |
| --- | --- | --- | --- |
| Desktop | `c4f8e3daca42ee367f033c6290412f549568b386` | `agent/core-purchase-clinical-integrated-20261013` | [run 38437807204](https://github.com/HolisticDrBright/AI_DESKTOP_PRO/actions/runs/38437807204) **success** |
| V2 | `1951672a7c5e3589b2f058c22a7fc19618e2dec0` | `agent/core-purchase-clinical-integrated-20261013` | [run 38437806760](https://github.com/HolisticDrBright/AI_LONGEVITY_PRO_V2/actions/runs/38437806760) **success** |

Both Claude branches were created from that pair after its CI was green. During the work Codex pushed four V2
commits (`fbcb909`, `6f3bd7f`, `91fe3c0`, `afa7ee4`) and one Desktop commit (`fc99d805`) to the integrated
branches. Each was brought in with an ordinary merge commit (no rebase, no force-push); see the overlap map.

## Brandon's decisions in force (recorded in the previous return, unchanged)

Consumer tier first; national over-the-counter reach; labs everywhere except NY and NJ; restricted brands by plan
or a Fullscript request Brandon approves; a destination per supplement; non-supplements catalogued; generic links
retired; NutriSense is for blood-sugar issues including type 1 or 2 diabetes; "go ahead on all the rest".

## Commits (full SHAs; ancestry: each branch descends from its start pair and from Codex's latest integrated head)

| Repository | Commit | Package |
| --- | --- | --- |
| V2 | `deb768b4bd4dd8d7b42e6829221605a2b9ea9fa5` | WP1: program supplement steps held against the owner's saved labs; no purchase in the unreleased build |
| V2 | `c4137ec0a77643906d991b6e9da6d114f5cc0cbe` | WP2: an unreviewed analyzer classification kept out of clinic sharing and Ask ALP context |
| Desktop | `4cad229e6728e0f7b928492b33d7209f5c36db84` | WP2: a patient-app lab status named as an unreviewed app flag, never the laboratory's |
| V2 | `ce62672a6562767214474d57f078321b5437b3b2` | WP4: the previous account's store action and message end on a sign-in change; entitlement transition coverage |
| V2 | `afd78be269230ca06c5adf0c18e9bb5472f21e82` | Cowork return kept as unreviewed reference data, with its intake validation |
| V2 | `3741f6b9c301686b6df35b9322cabdbe04fa02e7` | WP5: single-build preflight manifest and unfilled five-persona device worksheet |
| V2 | `5faa032999e71147d68c34acd656192620239784` | WP3: meal voice logging honestly unavailable; Core disclosure discrepancy draft |
| V2 | `5f99645157b9866fbfec0b016d982d4f04b2d242` | merge of Codex's `91fe3c00` (catalog package integrity, lab catalog ordering hold) |
| V2 | `8d9241caa8b0aa9ddb8b35c949e0c74d517692b8` | WP5: the new `generalLabCatalogOrdering` gate pinned in the preflight manifest |
| Desktop | `1034ce0fe314c6305e917c249e232890bb53852d` | merge of Codex's `fc99d805` (bounded catalog read retry, no-store catalog errors) |
| V2 | `e671657729c5ad4b62e2abaa39988f09133de03a` | merge of Codex's `afa7ee41` (acceptance rebound to the Desktop catalog retry) |
| V2 | `78f4f97ac9f4c1daf3df89e8098afe85dd738cd9` | WP6: predecessor index preserved (metadata) |
| V2 | `7a9699eae1ab0b3fc2e780c315e717cebbbc4c05` | WP6: acceptance index bound to the final code pair (metadata) |
| both | this document's commit | WP6: this return (documentation) |

**Final code pair:** Desktop `1034ce0fe314c6305e917c249e232890bb53852d`, V2
`e671657729c5ad4b62e2abaa39988f09133de03a`.

## Evidence per work package

Every "failing before" ran the new test against the unchanged start code in a scratch worktree. Where a new test
imports a module that did not exist before, a scratch-only shim reproduced the old behaviour under the new name;
shims were never committed.

### WP1: program supplement safety (finding C9), V2

**Reproduced.** The service's program review (`clinical_private.production_program_review` and its synthetic
twin) compares a program step with the adopted plan by ingredient only; it has no lab input. On the device an
iron-containing step beside a saved ferritin of 420 ng/mL (printed range 30–400) was `available`, and the shipped
build showed a purchase button for an available, bound step although `CONSUMER_PURCHASE_RELEASED` is false.

**Repair** (`lib/programs/programLabSafety.ts`, rule `program-lab-safety/1`). A device rule that only **adds**
holds, decided by `clinician_review`:

- a step containing a nutrient whose saved result is above the laboratory's printed range is held, verified or
  not ("unreviewed is never reassuring");
- readings of the same nutrient that disagree across dates hold the step;
- iron is a clinician's decision as everywhere else in the app: an iron step is held unless the newest
  iron-status result is verified and not above range (TIBC/UIBC are not iron-status results);
- no other missing result holds anything, and the rule never infers that a person needs a product, never releases
  what the service held, never changes a dose, and never touches lessons or progress;
- the printed laboratory interval is the only range used; a functional target cannot make a result look normal;
- the message names the nutrient and the review, never whether the result is high or low.

`decideProgramSupplements` applies a lab hold only to a served `available` verdict; `ProgramPlanCard` counts it
as held and shows its notice; `app/programs.tsx` passes `onPurchase` only when `CONSUMER_PURCHASE_RELEASED`.

**Failing before: 9 of 41** (`__tests__/program-lab-safety.test.ts` 6 of 7, `program-screen-journey.test.tsx`
3 new). 41/41 after. Coverage already in place and cited, not new: account change before or during a request
(`program-assignment-service.test.ts`), revoked access and session change (`program-screen-journey.test.tsx`),
paused, finished and offered programs offering no purchase, typed product/label/offer identity with versions
(`program-supplement-decisions.test.ts`). The lab holds read only the signed-in account's `LabsProvider` panels.

**Still open (server):** the server review stays ingredient-only; the device rule is display and purchase
withholding, not a server control. Blocked candidate below.

### WP2: unreviewed lab provenance (finding C8), V2 and Desktop

**Reproduced.** A published analysis is `consumer_lab_analysis_unreviewed` and each reading is
`needs_human_review`, but:

1. V2 clinic transfer `lab-result/1` sent the analyzer's own classification (`marker.status`) as the result's
   `sourceStatus`, so a practice received "critical" as if it were the laboratory's flag;
2. V2 Ask ALP context labelled an unreviewed reading `device_analyzed_<status>`;
3. Desktop's patient-app intake card rendered that status as "Critical source flag".

**Repair.**

- V2 `services/labs/awsDesktopLabSync.ts`: `sourceStatus` is `unknown` (this device never records the printed
  flag); value, unit, draw date and the printed range cross unchanged, a one-sided range exactly as printed.
- V2 `lib/labs/askAlpLabObservations.ts`: a `needs_human_review` reading, an AWS reading saved without its mark
  and a personal import are `device_analyzed_needs_source_review`; an owner-entered verified reading keeps its
  status.
- Desktop `src/components/patient/lab-range.ts`: `importedLabStatus(range, "patient_app_unreviewed")` names an
  app status as "app flag X (unreviewed)", never promotes it to critical, and with no printed range says
  "Range not provided · app flag X (unreviewed, not a laboratory flag)" with status `unknown`.

**Failing before:** V2 **3 of 5** (`__tests__/unreviewed-lab-provenance.test.ts`), Desktop **2 of 6**
(`src/components/patient/lab-range.test.ts`). 5/5 and 6/6 after. Restore attaching only the analysis summary,
never readings or marks, is coverage. Nothing clears `needs_human_review`; no review path was invented.

### WP3: truthful Core disclosures, V2

`docs/core-disclosure-discrepancies-draft-2026-10-13.md` (machine-readable copy
`docs/evidence/2026-10-13-core-disclosure-inventory.json`) lists **30 discrepancies** for the production-channel
Core build, each with evidence paths and proposed copy marked **DRAFT for Brandon and counsel, not approved**:
8 false claims, 5 missing disclosures, 8 needing counsel, 9 internal inconsistencies, plus 23 data flows.

The handoff's `expo/docs/app-store-data-safety.md` does not exist; the file of that name is at the V2 repository
root and contradicts `release/store-readiness.json` (item 26). Hosted /privacy, /terms and /support were not
reachable from this environment (proxy 403) and are not described.

**One code change** (item 7). Meal transcription is withheld in every build, but Voice mode promised "We'll
transcribe and break down the macros", requested the microphone, recorded the person and then said the recording
"could not be understood". It now says "Voice logging is not available in this release. Type what you ate
instead.", requests no microphone and records nothing. **Failing before 2 of 2**
(`__tests__/meal-voice-unavailable.test.tsx`), 2/2 after.

**Deliberately unchanged** (items 1–6). These strings wrongly call a production-channel build synthetic or
TestFlight, but the restriction they carry ("synthetic only; do not enter identifiable health information") is
today's true posture: the production backend is PHI-disabled and no production build is authorized. Removing them
before a reviewed PHI activation would invite real health data into a service that is not ready for it, and items
1–4 are notice/policy text whose change needs a notice-version decision. No notice, consent, policy, age rating,
purpose string or store declaration changed; `store-readiness.json` stays `not_submittable`.

### WP4: Core entitlement and account transitions, V2

**One defect.** On a sign-in change the membership screen rebuilt its store connection but kept the previous
account's in-flight restore ("busy") and the store's last message for it, so a second person on the same phone
saw account A's store verdict and could not act. The account-change effect now clears both, with the purchase
timer. **Failing before 2 of 2** (`__tests__/membership-account-switch.test.tsx`), 2/2 after.

**Coverage, already correct** (`__tests__/core-entitlement-transitions.test.tsx`, 6 tests, through the real
`SubscriptionProvider` with a fictional transport): a verified purchase or restore is active; cancellation keeps
the paid period and expiry ends it; an offline launch grants nothing and says saved records stay available; an
unavailable service grants nothing; a second account never inherits the first's membership and a late reply for
the first is discarded; a stale or future-dated answer is not current and a service-target change drops the
cache; an active Core never opens peptides, longevity, lab directives, purchase or production Ask ALP; an expired
membership still reaches `/personal-storage` and `PersonalMealRecovery`, which ask nothing of membership. Private
views, lab context and progress dropping on account change are covered by the existing `labs-private-view`,
`ask-alp-private-view` and program progress tests.

### WP5: single-build preflight kit, V2

`release/preflight/` with `scripts/release-preflight.mjs`, `scripts/run-release-preflight.mjs` and
`scripts/release-preflight.test.mjs` (10 tests, in CI). It reuses the launch acceptance index for the source pair
and the five fictional personas.

- `manifest.json` states what the source can: source pair, app version, 12 feature gates, source release and
  consent versions, knowledge package digests, store product ids and the owner-approved price, persona labels.
  Every operator and owner value is `null`: API stage, each of the **19** Desktop Lambda functions (published
  version, AWS `CodeSha256` and package SHA-256, or excluded with a reason), deployed catalog/range/prompt/consent
  releases, build numbers, rollback target, synthetic-domain persona accounts, paid-build authorization and the
  Play base plan. **`bun run check:release-preflight` refuses with 51 missing values** by design.
- Refused, not just missing: a source pair other than the acceptance index's, a gate/price/version that differs
  from the source, `production-pilot` while store readiness is `not_submittable`, an iOS build number at or below
  71, `$LATEST`, placeholder digests, an unlisted function, agent-attributed authorization, non-synthetic or shared
  persona accounts, a rollback that is the candidate, PHI, forged readiness fields.
- `device-worksheet.json` and `.md`: 110 **unfilled** rows (11 areas x 5 personas x iOS and Android) with
  platform-specific steps (HealthKit vs Health Connect, StoreKit sandbox vs Play license testers, VoiceOver vs
  TalkBack). A row is accepted only as a person's observation on a named physical device of the manifest's build;
  a source test, runner, simulator or emulator, another build or the other platform's hardware is refused.

### Cowork catalog return (Brandon's mid-assignment upload)

Stored byte-for-byte under `data/catalog-work-packets/2026-10-13-cowork/returned/` with SHA-256s and a read-only
validator and report under `intake/`. Complete (825 labels, 195 destinations, 179 review rows, every id mapped),
but not importable as-is: the label objects are not the governed `labels.json` shape and carry 13 conflicts only
in notes; 17 links are each returned for two products and 25 equal a link live on another product; two labels
were read from a page the same return says is not the exact product. Nothing imported, approved or made
orderable; owner holds stand.

## Suites and gates (exact commands, honest results)

| Check | Result |
| --- | --- |
| V2 `bun run test` at `8d9241c` (tree of the final code head minus Codex's metadata-only `afa7ee4`) | **305 files passed, 1 skipped; 3538 tests passed, 1 skipped**, exit 0 (the skip is the pre-existing hosted-only integration file) |
| V2 `bunx tsc --noEmit`, `bun run lint` | exit 0, exit 0 (warnings on unchanged lines only) |
| V2 `check:testflight`, `check:core-launch-scope`, `test:core-launch-scope`, `test:launch-acceptance`, `test:store-readiness`, `check:store-readiness`, `check:v2-capabilities`, `check:surface-disclosure`, `check:hipaa-baseline`, `check:billing-configuration`, `test:release-preflight`; knowledge package tests and `--require-complete`; governed catalog `validate.mjs` | all exit 0 |
| V2 `test:launch-acceptance` after the rebind | 22/22 |
| V2 `check:launch-acceptance` after the rebind | exit 1 **by design**: 8 source cases accepted, 9 hosted/device/human cases unobserved, "RELEASE ACCEPTANCE WITHHELD"; source digest `e5a8eb5fd6b8e2a4f1d5f84100974c38ebe08902b2fd54378c83d8c01d7e63c0` |
| V2 `check:release-preflight` | exit 1 **by design**: 51 missing values, 0 refusals |
| V2 first full run after WP1 | 2 failures, both fixed without weakening: the lab-candidate writer scan flagged the literal `independently_verified` in the new rule (re-expressed without it), and `launch-entitlement-surfaces.test.ts` needed a `LabsProvider` mock like its other provider mocks |
| V2 `expo-doctor`, Docker image builds | not run locally; left to CI |
| Desktop `TZ=America/Los_Angeles npx vitest run` (identical to `npm run test:unit`) at `1034ce0f` | **538 files passed; 8561 tests passed, 11 skipped** (the same 11 pre-existing skips), exit 0 |
| Desktop `npx tsc --noEmit -p .`, `npx eslint .` at `1034ce0f` | exit 0, exit 0 |
| Desktop source gates (the 36 commands of the CI Typecheck job) at `1034ce0f` | **all 36 pass**, exit 0 (the stale `dist/qualification/security-qualification.json` was removed first; the CLI writes with `wx`) |
| Desktop clinical build `APP_EDITION=clinical NEXT_PUBLIC_USE_LIVE_API=true npm run build` at `1034ce0f` | exit 0, before the push |
| Desktop `npm run check:clinical-bundle` | PASS: 325 client chunks, no synthetic identity, no demo-only copy, none of the 17 server-only markers |
| Desktop at `4cad229e` before the merge | `tsc` and `eslint` exit 0; the full suite was stopped and re-run on the merge head instead |
| Desktop E2E battery | see the final message: no browser spec renders the changed intake card (its mounted component test covers it), and the battery is run on the merged head for regression evidence only |

No timeout was raised, no test was skipped or disabled, and no refusal was turned into a pass.

## CI on pushed heads

| Repository | Head | Run | Result |
| --- | --- | --- | --- |
| V2 | `c4137ec` (with WP1 `deb768b`) | [38443322257](https://github.com/HolisticDrBright/AI_LONGEVITY_PRO_V2/actions/runs/38443322257) | success |
| V2 | `ce62672` | [38444658922](https://github.com/HolisticDrBright/AI_LONGEVITY_PRO_V2/actions/runs/38444658922) | success |
| V2 | `3741f6b` (with the Cowork intake) | [38446048803](https://github.com/HolisticDrBright/AI_LONGEVITY_PRO_V2/actions/runs/38446048803) | success |
| V2 | `5faa032` | [38447010879](https://github.com/HolisticDrBright/AI_LONGEVITY_PRO_V2/actions/runs/38447010879) | success |
| V2 | `8d9241c` | [38447617971](https://github.com/HolisticDrBright/AI_LONGEVITY_PRO_V2/actions/runs/38447617971) | success |
| V2 | `7a9699e` (two metadata commits on the final code head `e671657`) | [38450238296](https://github.com/HolisticDrBright/AI_LONGEVITY_PRO_V2/actions/runs/38450238296) | in progress at writing; final result in the final message |
| Desktop | `1034ce0f` (final code head; first push of this branch, carrying `4cad229e`) | [38450224110](https://github.com/HolisticDrBright/AI_DESKTOP_PRO/actions/runs/38450224110) | queued at writing; final result in the final message |

## Overlap with Codex lanes

| Codex change | Where it meets this branch | Resolution |
| --- | --- | --- |
| V2 `fbcb909` catalog package bytes pinned on Windows | `.gitattributes` (both sides appended lines) | merged; both sides' lines kept |
| V2 `6f3bd7f` general lab catalog ordering withheld (`generalLabCatalogOrdering: false`) | `contracts/consumerSurfaces.ts` is read by the preflight manifest | merged; the gate is now pinned in the manifest (`8d9241c`), so a manifest cannot declare lab ordering on |
| V2 `91fe3c0`, `afa7ee4` acceptance rebinds | `release/launch-acceptance/index.json`, `scripts/launch-acceptance.test.mjs` | merged first, then this branch's rebind preserves Codex's latest index as the predecessor (`index-2026-10-13-core-safety-preflight-predecessor.json`) |
| Desktop `fc99d805` bounded catalog read retry, no-store errors | none of this branch's files | merged cleanly (`1034ce0f`) |
| Synthetic catalog Lambda at Desktop `c4f8e3d` | the Desktop lab-range change is client-only; no Lambda source changed here | unchanged; Codex's rebuild lane |

No AWS template, Lambda handler, migration, identity, provider sandbox or care-connections file was touched.
`release/preflight/manifest.json` mirrors the Desktop Lambda list at `infra/aws-clinical-core/*.json`; a new
function there is added to `AWS_LAMBDA_FUNCTIONS` in the same change.

## Blocked candidates (source not written; each needs Codex integration and review)

1. **Lab-aware server program review.** `clinical_private.production_program_review` (production candidate) and
   the synthetic review take the owner's verified `lab_history` records as input and return an additive held
   reason (`lab_review_required`, with nutrient and reason, never the classification) inside the strict
   `programReview` contract. V2 must accept the additive field first; Desktop's practitioner view then shows the
   holds. Until then the device rule is the only lab-aware hold.
2. **Reviewer-attested verification transition.** A server-recorded, reviewer-authorized change from
   `needs_human_review`, bound to the reading's biomarker id, document and value; never set by a client, never set
   to populate a candidate. Until it exists every AWS reading stays unreviewed.
3. **`lab-result/2`.** The clinic transfer carries the reading's verification state and source provenance
   (document, assay/unit, draw date, analysis version) instead of `sourceStatus: unknown`. Also: V2
   `lib/sync/lab-result-backfill.ts` (`buildGovernedLabResults`) is unreferenced and still uses the legacy range and
   status; remove or rebuild it with `/2`.

## Decisions for Brandon and counsel (silence is not approval)

1. Every proposed correction in `docs/core-disclosure-discrepancies-draft-2026-10-13.md`, in particular the AI
   lab-processing disclosure (items 2, 9, 10), the store data categories and `sharesWithThirdParties: false` (11, 14),
   the 17+ versus adults-only rating (17), the deletion and retention claims (18, 19), and the draft privacy policy
   that would ship (21).
2. When items 1–6 change: with the reviewed PHI activation, and whether that bumps `PRIVACY_NOTICE_VERSION`.
3. The microphone after the item 7 fix: no Core feature uses it, so `NSMicrophoneUsageDescription`,
   `RECORD_AUDIO` and the store audio declarations describe no reachable production flow. Remove at the next
   native build, or keep for a future release.
4. Whether native purpose strings (item 8) are engineering-owned copy.
5. The Cowork return: which record keeps each of the 17 shared and 25 colliding links; the 13 label conflicts;
   the two labels read from a non-exact page; the storefront display name ("The Holistic Approach").
6. Paid-build authorization and the Play base plan id, the only owner values in the preflight manifest.
7. Still open from earlier returns: the first purchase release record, declaration and purchase copy,
   direct-brand authority, catalog type corrections (NutriSense, Super Teeth, Branch Basics), the 598 unlabelled
   activations, intended use of lab-derived OTC suggestions.

## AWS hand-back to Codex, in order (nothing here was done; no evidence hash is supplied)

1. **CI first.** Confirm exact-head CI on Desktop `1034ce0f` and V2 `e671657` (and the return heads) before
   integrating them into `agent/core-purchase-clinical-integrated-20261013`.
2. **Integrate** this branch into the integrated branches with ordinary merges. V2 already contains Codex's
   `afa7ee4`; Desktop already contains `fc99d805`; neither should conflict.
3. **Catalog Lambda (synthetic staging).** Unchanged by this branch; continue the `fc99d805` rebuild and the
   repeated cold-start test in Codex's lane. Confirm the three non-supplement goods are excluded once deployed.
4. **No server rebuild for WP2.** The V2 changes are app code and ship only with the next authorized app build;
   the Desktop intake label ships with the next Desktop web deployment. Confirm that no server path re-derives a
   laboratory status for an app reading. Hosted check once a build exists: a fictional unreviewed reading sent to
   the synthetic practice arrives with `sourceStatus: unknown` and renders as an unreviewed app flag.
5. **Program review candidate** (blocked candidate 1): write it against the qualification database with fictional
   owners, V2-additive field first; hosted negatives (iron step with a high fictional ferritin held; no verified
   iron result held; a normal verified result leaves the step as the service decided).
6. **Verification transition** (blocked candidate 2) and **`lab-result/2`** (3): design with reviewer authority
   before any lab candidate or practice view relies on a verified state.
7. **Preflight values.** When a build is authorized, fill `release/preflight/manifest.json`'s operator values from
   the observed deployment: API stage and deployment id, each Lambda's published version, `CodeSha256` and package
   SHA-256 (or exclusion with a reason), the deployed catalog/range/prompt/consent release ids and digests, the AWS
   rollback reference and five synthetic-domain persona accounts. `node scripts/run-release-preflight.mjs manifest`
   must exit 0 before any build; it refuses placeholders.
8. **Hosted acceptance.** The 9 hosted, device and human cases of the launch acceptance index stay unobserved until
   observed against this pair; the 110 device rows stay unfilled until people run them on physical devices.

## Remaining gates (neither app is commercial-ready or PHI-ready)

- Store: all eight blockers in `release/store-readiness.json` stand (`not_submittable`): Core scope review,
  privacy notice review, store products not created, paid-app agreements unsigned, production HealthKit artifact
  unverified, the physical device matrix not run, production build authorization pending, production backend not
  activated.
- Provider: no Fullscript, Stripe, Zoom, Apple or Google sandbox acceptance; no executed vendor agreement verified
  for the lab AI flow.
- Device: the five-persona iOS/Android worksheet is unfilled; no production artifact has been inspected.
- Human: clinical, privacy, counsel, store and security reviews; the disclosure drafts are unapproved.
- Hosted: the launch acceptance index's hosted, device and human cases are unobserved; release acceptance is
  withheld.

## Graphify

Graphify is unavailable in this environment: there is no `graphify` executable, no `graphify-out/` and no vault.
No graph was generated, consulted or updated.

The last section of Desktop's tracked handoff `docs/graphify-handoff-2026-09-15.md` is "Fixed six-phase completion
ledger". Append-ready text in its form, for whoever runs Graphify next:

> **2026-10-13 Core safety and release preflight (source only).** Desktop
> `1034ce0fe314c6305e917c249e232890bb53852d`, V2 `e671657729c5ad4b62e2abaa39988f09133de03a` on
> `claude/core-safety-release-preflight-20261013`, each merged with Codex's latest integrated head.
>
> - Program supplement steps are held for clinician review against the owner's saved labs
>   (`program-lab-safety/1`, device-only; server review blocked); no purchase in the unreleased build.
> - An unreviewed analyzer classification no longer reaches clinic sharing, Ask ALP context or the Desktop intake
>   card as a laboratory flag.
> - A sign-in change ends the previous account's store action and message; entitlement transitions covered.
> - Meal voice logging is honestly unavailable; 30 disclosure discrepancies drafted for Brandon and counsel.
> - A single-build preflight manifest (51 values to supply) and an unfilled 110-row iOS/Android device worksheet.
> - The Cowork catalog return is stored as unreviewed reference data.
>
> All six phases remain partial. No deployment, activation, PHI or paid build.
