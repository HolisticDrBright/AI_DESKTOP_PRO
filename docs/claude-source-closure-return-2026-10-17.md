# Overnight source closure: the return (2026-10-17)

**What this is.** Source engineering only, with fictional data. It is a safer, more exact candidate and a shorter
remaining list, not a commercial or PHI-ready claim.

**What was not done:**

- no SQL applied or registered;
- no AWS, Fly, Cognito, SES, Stripe, Fullscript, store or provider write or credentialed read;
- no PHI and no real patient data;
- no paid EAS build;
- no blocked switch turned on;
- no force-push and no merge to `main`.

Every PGlite, fictional-transport or intercepted-HTTP test below is source evidence only. None of it stands for Aurora,
a provider sandbox or a phone. The launch observer's nine external cases stay `unobserved`.

The handoff was `expo/docs/claude-overnight-source-closure-2026-10-17.md` on V2
`agent/v2-advisory-drift-gate-20261017` at `4325c047`.

## 1. Heads

### The selected code pair

| Repository | Code commit | Branch | Built on | Exact-head CI |
| --- | --- | --- | --- | --- |
| Desktop | DESKTOP_CODE | `claude/desktop-source-closure-20261017` | `c327e9ae` (Codex's audit successor `88f49ca6` + this session's docs `a38a62be`) | DESKTOP_CI |
| V2 | `54391a47fd3df9c6e1abde173d0998d86b31576b` | `claude/v2-source-closure-20261017` | `4325c047` (Codex's advisory-drift gate, CI [39014144521](https://github.com/HolisticDrBright/AI_LONGEVITY_PRO_V2/actions/runs/39014144521) success) | **None available.** See below. |

**V2 CI is unavailable, and it is not a code failure.** Every V2 run since about 08:16 UTC has ended as `failure` within
26 to 120 seconds, with no runner assigned (`runner_id: 0`), no step executed and no downloadable log (HTTP 404):

- this session's integration heads;
- both V2 package branches;
- a re-run of [39017686303](https://github.com/HolisticDrBright/AI_LONGEVITY_PRO_V2/actions/runs/39017686303)
  (attempt 2, 26 s).

The same workflow passed on `4325c047` at 07:53–08:06 on three branches. V2 is a **private** repository and Desktop is
public, and the Desktop runs kept executing. That is consistent with exhausted private-repository Actions minutes or a
spending limit. The API gave no reason, so this is an inference, not an observation. **Brandon:** check the account's
Actions billing. Until a run on the exact V2 head passes, V2 has no exact-head CI. Every CI gate was run locally on
`54391a47` instead (§3), which is not a substitute for CI.

**The base/merge graph:**

- **Desktop `claude/desktop-source-closure-20261017`:**
  - `c327e9ae`: `88f49ca6` merged with `a38a62be`;
  - WP4 Desktop `78f4c654` and `bd2fbf5f`, merged at `2b790d08`;
  - the packet correction `c0a212c5`;
  - WP2 `5227b644`, merged at `b8fbbdba`;
  - WP5 `4b33f7bd`, merged at `8d06e560`;
  - WP3 `0dd4e608`, merged at `20775244`;
  - the integration fix `aa7e8b9b`;
  - the WP4 follow-up `05400972`, merged at `4c805b80`;
  - WP1 Desktop `48e2545f`, merged at `30095ff6`.
- **V2 `claude/v2-source-closure-20261017`:**
  - `4325c047`;
  - WP4 V2 `a1de19db`, merged at `abaa3737`;
  - WP1 V2 `8be5f7dd`, merged at `54391a47`.
- **Metadata heads, above the code pair:** V2 KIT_HEAD (the kit rebind, `expo/release/` only) and Desktop
  DESKTOP_DOC_HEAD (this document, `docs/` and `CLAUDE.md` only).

All package branches are pushed, with their own heads:

- `claude/v2-export-lineage-20261017` `8be5f7dd`
- `claude/v2-billing-observation-20261017` `a1de19db`
- `claude/desktop-acceptance-observation-20261017` `5227b644`
- `claude/desktop-revocation-reconciler-20261017` `0dd4e608`
- `claude/desktop-program-observation-20261017` `05400972`
- `claude/desktop-continuity-release-map-20261017` `4b33f7bd`
- `claude/desktop-export-oversize-20261017` `48e2545f`

### WP0: reconcile the heads

| Check | Result |
| --- | --- |
| V2 final documentation head `4325c047` | CI [39014144521](https://github.com/HolisticDrBright/AI_LONGEVITY_PRO_V2/actions/runs/39014144521) **success**. The earlier `e07a80a1` run was cancelled when it was superseded. |
| V2 advisory source `109a2cf1` | CI [39013404753](https://github.com/HolisticDrBright/AI_LONGEVITY_PRO_V2/actions/runs/39013404753) **success** |
| Desktop audit successor `88f49ca6` | CI [39011580284](https://github.com/HolisticDrBright/AI_DESKTOP_PRO/actions/runs/39011580284) **success**. It contains `8bfe2349` and Codex's Cognito drift checker; this session's docs head `a38a62be` did not. |
| Source observer on V2 `4325c047` (`node scripts/run-launch-acceptance.mjs`) | 9 `source_test` cases ACCEPTED, 9 WITHHELD (`unobserved`), `RELEASE ACCEPTANCE WITHHELD`, exit 1, as expected. Source digest `3ac7454c764c…`; `observedHeads` = `4325c047`, clean, no code change since the kit's `109a2cf1`. Result file SHA-256 `c0c15070…2b5e` (gitignored, kept in the session scratchpad). |

## 2. Per package

Each finding is labelled **failing-before** (a defect, with a test that failed on unchanged code), **coverage**
(already-correct behaviour now pinned) or **hold** (a policy, owner, counsel or hosted hold). The original six phases
each package advances are the handoff's own numbers.

### WP1: privacy-export lineage (V2 `8be5f7dd`, Desktop `48e2545f`); phases 1, 3, 4

| Finding | Label | Evidence |
| --- | --- | --- |
| The device and personal-storage copies carry every stored plan verbatim, drop none and add no ordering link. A B row under A's key refuses the whole copy. Cancelled or partial copies share nothing. Recovery stays free after Core expiry. Screens show counts only. A self-claimed practitioner approval is still held. | coverage | 11 tests, passing on the unchanged source |
| The copies do not say which plans are held or that none is current. Candidate `privacy-export-lineage/1` (`expo/lib/clinicalData/privacyExportLineage.ts`) lists each held part by JSON pointer. It marks current, historic or pending and `not_a_current_recommendation`, and counts ordering links without presenting them. | hold (Brandon/counsel) | `EXPORT_LINEAGE_DECISION = {envelope:false, notice:null}`, so the shipped copies are byte-identical. 10 contract tests (9 failed before) and a 6-test pin. |
| The 2026-10-16 draft notice ("contains everything stored on this device") contradicts the copy. | hold | Revised draft in `expo/docs/claude-v2-export-lineage-2026-10-17.md` §4 |
| A saved lab analysis over the 24 KiB export page withheld the owner's **whole** personal-storage copy. Production surfaces it as HTTP 400 `request_invalid` on every poll, with the job left `running` at 0 of 3 records until its 48 h deadline. | **failing-before** (Desktop) | `owned-privacy-export-oversize.database.test.ts`: 12 of 17 failed on `c327e9ae`; 17/17 after |
| The fix is the BLOCKED segmented reader (15,360-byte segments, each carrying the record's size and digest; reassembled and digest-checked; V2 `personal-storage-export/1` unchanged). It sits behind `PRIVACY_EXPORT_SEGMENTED_READ_RELEASE = "blocked"`. Live now, not behind the switch: a confirmed oversize refusal ends the job at once as `failed` / `record_exceeds_export_page` instead of 48 hours of silence. | failing-before → fixed in source, BLOCKED | Same file; 26 related files, 408 tests |
| A restored account copy marks a held supplement `status: "suggested"` | hold | not changed |

### WP2: hosted-acceptance source boundary (Desktop `5227b644`); phases 2, 3, 6

| Finding | Label | Evidence |
| --- | --- | --- |
| Acceptance took a dirty or untracked checkout | **failing-before** | `qualification-acceptance-cli.test.ts`, which runs the real CLIs. Fictional git/aws/fetch only. |
| A mid-run redeploy still exited 0 with `ok:true` | **failing-before** | same |
| An asserted `SOURCE_COMMIT` or account that disagreed with the observation was ignored | **failing-before** | `target_source_mismatch:asserted` / `target_account_refused:asserted` |
| Nothing bound the recording fixture to the run | **failing-before** | fixture boundary digest |
| A mandatory step answered only by an unmarked 401/403 counted as a pass | **failing-before** | It is now unverified: never qualification, never production |
| Stale commit, missing stack, skipped mandatory steps, missing marker; exploratory mode stays non-acceptance | coverage | |
| The care inspector's `not_deployed` was usable as a precondition | failing-before (policy gap) | `--acceptance` refuses `candidate_not_deployed`, exit 1 |
| Recording's consumer-token step and voice's cross-identity step can never qualify on a correct deployment, because API Gateway answers them unmarked | hold (policy) | `docs/hosted-acceptance-source-boundary-2026-10-17.md` §5 |

Vitest went from 20 failed / 28 passed before to 90/90 after. Care tests 77/77. PowerShell runner test 83 cases (was 75),
run with a pwsh 7.4.6 downloaded into the scratchpad.

### WP3: the emergency-revocation publication gap (Desktop `0dd4e608`); phases 3, 5, 6

| Finding | Label | Evidence |
| --- | --- | --- |
| A failed signal publication was retried only by an operator | **failing-before** | scratch behaviour test 2/2 failed (`expected 200 to be 403`) |
| The pending item was not renewed, so the gap reopened at its 30-minute deadline | **failing-before** | same |
| Idempotent publication; send authority holds on a revoked login | coverage | |
| The BLOCKED reconciler | fixed in source, BLOCKED | Its own NOLOGIN role and schema, no `clinical_private` USAGE, a fenced 60 s lease, attempt records as the cursor, `attribute_not_exists` publish, at most 2 tries, pending renewal, overdue (5 min) and silence alarms, never a release, never an operator. `WORKFORCE_REVOCATION_SIGNAL_RECONCILER_RELEASE='blocked'`; the template allows only `BLOCKED` / `DISABLED`. |
| **PUBLIC holds EXECUTE on 20 `clinical_private` functions.** 9 are SECURITY DEFINER; 4 are directly callable (`move_entitlement`, `build_sync_payload`, `require_knowledge_admin`, `require_knowledge_editor`). | **finding, unreviewed** | Pinned as current state by a test. Whether it escalates depends on each function's own checks, which nobody has reviewed. Needs its own security review. |
| Race order B, and the commit-instant window | hold | **The three original `it.fails` are unchanged**; run as plain `it`, each still fails with `expected 200 to be 403`. A new `it.fails`: a send due inside the outage window still goes out. |

The reconciler bounds the outage window to about one sweep after the signal table recovers, and pages from 5 minutes.
It cannot make the commit-instant window zero.

Tests: race tests 19 + 1 expected-fail; SQL 15; unit 23; head-start 7; related set 22 files, 234 passed and 4
expected-fail. Mutation checks were caught.

### WP4: billing and program evidence observed, not asserted (V2 `a1de19db`; Desktop `78f4c654`, `bd2fbf5f`, `05400972`); phases 2, 5, 6

**V2 billing:**

| Finding | Label | Evidence |
| --- | --- | --- |
| A hand-written deployment file with matching fake digests, plus real probes, gave 5 `blocked_path_observed` and no refusal | **failing-before** | It is now `deployment_not_observed`. 17/17 new tests failed before. |
| `--api-origin` could be any host | **failing-before** | Probes must hit the observed stack's own origin, between two observations |
| No created/reused/skipped record existed, so a replayed purchase read like a real one | **failing-before** | A reused purchase is now `unobserved`; a replay reporting creation and duplicate creations are refused |
| The old file check expected hex digests, but AWS reports `CodeSha256` in base64 | format finding | covered |
| Billing replies carry no `x-clinical-execution`; the marker is the template's `Metadata.Qualification` | hold (hosted) | |
| The billing template has no `SourceCommit` parameter | hold (hosted) | `source_commit_unobserved` |
| Provider-shaped JSON stays `claimed_unverified` | coverage | |

Harness tests 29/29 (12 old + 17 new).

**Desktop program:**

| Finding | Label | Evidence |
| --- | --- | --- |
| No acceptance path existed for the program routes on `wxv734oi12` | **failing-before** | `hosted-program-acceptance.test.mjs`: 34 of 36 failed before; 37/37 now. Mutation checks were caught. |
| The smoke scripts were not labelled smoke (the settlement header said "acceptance") | **failing-before** | Header only; the bodies are byte-identical, pinned by a test |
| The packet's §6 gaps remain in the smoke bodies | coverage | characterization test |
| `wxv734oi12`'s identity API never emits `x-clinical-execution`, so acceptance there refuses `execution_not_qualification` before the first write | hold (source change or run on the qualification program API) | |
| **The packet's identity-bundle digest `24a65189…` was not a valid pin.** | correction (this session's own error) | Explained in the next paragraph |
| The reviewed Desktop commit was a hard-coded pin (`8bfe2349`). A runtime commit cannot name itself, and the WP2 CLIs need a clean checkout at the exact commit. | fixed at integration | `reviewedCheckoutPair()` uses the clean checkout's HEAD; `source_dirty` / `source_unobserved` are refused before any AWS read |

**The bundle digest correction.** The unminified bundle keeps one path comment per module, relative to the build root.
With a symlinked `node_modules`, the same `8bfe2349` source gave `24a65189…` (1,980,414 bytes) from a deep scratch root
and `546d962f…` (1,950,986 bytes) from `/home/user/<dir>`. The digest is now unpinned and refused as
`reviewed_bundle_unpinned` until a clean `npm ci` build records it. The packet and the earlier return carry the
correction.

### WP5: clinic continuity negatives and the issuer release map (Desktop `4b33f7bd`); phases 1, 3, 6

| Finding | Label | Evidence |
| --- | --- | --- |
| In a suspended or archived clinic, the patient could not read or withdraw their own care-connection consent (`care_connection_actor` requires an active clinic). This contradicts the owner's decision and the route's contract. | **failing-before** → BLOCKED successor | 4/4 failed before; 22/22 after. `care-connections-patient-withdrawal-clinic-status.sql`. |
| Once the window is applied, nobody can withdraw a **recording** consent in a suspended clinic | hold, R1 (`it.fails`) | negatives file: 11 passed + 1 expected-fail |
| D3 recording cleanup refused; D4 legal holds neither placed nor released; D5 a delivered patient copy unreadable while closed (executed); R2 refreshed token reads consent state and withdraws; R4 campaigns ignore ordinary suspension | hold (owner) | 4/4 D5, 4/4 campaign tests |
| Refreshed tokens lose clinical reads; the retention sweep continues; a compromised login is refused inside the window and at campaigns | coverage | |
| `qualification-issuer-release-map/1` refuses the qualification API as pinned today: a mixed issuer, with the program API on the older MFA-optional `us-east-2_ueGlFRbNB` | hold (hosted) | 11/11. Template lines are in `docs/clinic-continuity-release-map-2026-10-17.md` §6. |

### Integration findings (this session)

The full Desktop suite on `20775244` had **3 failures**, fixed in `aa7e8b9b`:

- **Two stale release-map citations.** WP2 moved `qualification-target-manifest.ts:222` to `:225`, and WP4's header moved
  the daily-guidance pool pin from `:14` to `:20`. The test caught exactly the drift it exists for.
- **A duration-parser bug in the ordinary-suspension-window test.** It stripped only `ms`, so a correct `2879s` or
  `48min` became `NaN` (`expected NaN to be greater than 2878999`). The fix parses ms, s, min and h; an unparsed unit
  fails, and the bound is unchanged.

## 3. Verification

**V2 at `54391a47`, run locally because CI is blocked:**

- typecheck exit 0; lint exit 0;
- full suite: 363 files passed, 1 skipped; 4,014 tests passed, 1 skipped;
- `test:launch-acceptance` 27/27; `test:release-preflight` 10/10;
- `test:billing-qualification-harness` 29/29;
- floors and residuals 9/9;
- every early CI step replayed locally, exit 0: the Bun toolchain, floors, the high-advisory drift gate ("4 known high
  advisories remain unapproved; no new high advisory or lockfile drift"), the image-size patch, the iOS parser, store
  readiness, the kit, preflight, the Core scope mirror and the knowledge package checks.

DESKTOP_VERIFICATION

**The browser battery was not run.** No browser path changed: `git diff --name-only c327e9ae <code commit>` touches nothing
under `src/app`, `src/components`, `src/lib`, `src/adapters`, `e2e/` or the stub server. The last battery passed the
same 328 tests in both orders on `8bfe2349`'s tree (see `docs/claude-release-integrity-return-2026-10-17.md`).

No deployable artifact was built here, so no immutable image or ZIP digest is claimed. The only digests are source
files and SQL candidates (§4).

## 4. BLOCKED switches and unregistered SQL (new in this session; all earlier ones unchanged)

| Item | State |
| --- | --- |
| `WORKFORCE_REVOCATION_SIGNAL_RECONCILER_RELEASE` | `'blocked'` (source and Lambda env). Template `ReconcilerRelease` allows only `BLOCKED`; `ScheduleState` allows only `DISABLED`. |
| `PENDING_HEAD_START_DECISION` | `owner_decision_required` (250 ms proposed, not wired) |
| `PRIVACY_EXPORT_SEGMENTED_READ_RELEASE` | `"blocked"` |
| V2 `EXPORT_LINEAGE_DECISION` | `{envelope:false, notice:null}` |
| V2 billing | still BLOCKED. `--acceptance` gives at best `not_qualified`. |
| `REVIEWED_SOURCE_PAIR.identityBundleSha256` | `null` (unpinned until a clean reviewed build) |

| Unregistered SQL / template | SHA-256 |
| --- | --- |
| `source-candidates/care-connections-patient-withdrawal-clinic-status.sql` | `0b5a6fc9cd75a8a4e3fe9e80f341c32db4c6f86b48ae6acb2987b63591540011` |
| `…-rollback.sql` | `28e78b681fd8d53032ce26e6ef6755fcbdddf851ae1677f79390bd155417cb89` |
| `source-candidates/workforce-revocation-signal-reconciler.sql` | `5ef389b41ca3efc230364ef38e878dcd48055f5899bf4aba27e855af3c6a7946` |
| `…-rollback.sql` | `bf272983de34c692eb0ed4fcfcc851f6ff5a5fb24642f05afdfdedf9f8c3c763` |
| `source-candidates/owned-privacy-export-segments.sql` | `06a99fd76881cd2ed194d12f0761fb5264124d4063797ce84afa89622bda8cfa` |
| `…-rollback.sql` | `bff3f1844e272f5a826cf490c992b3ddb11b183752d11749fef56ac27869aecc` |
| `infra/aws-clinical-core/workforce-revocation-signal-reconciler.json` (template, BLOCKED) | `fdd8b8bdd1de65e79f61ab547e01eb7595f70e9f3afcd57e037a5616cf480a8a` |

- No `production-migrations/` file changed.
- The V2 kit's 25 candidate and 6 mirror hashes are carried unchanged.
- The kit lists none of this session's new Desktop candidates. They are named here and in their package docs.

## 5. Still unobserved (never source evidence)

- **Hosted:** `j1-hosted-registration-reset-mfa`, `j2-hosted-lab-analysis-delivery`, `j3-hosted-ask-alp-marker-fidelity`,
  `j5-hosted-program-and-message-round-trip`.
- **Physical device:** `j1-device-two-device-owner-isolation`, `j4-device-health-permissions-and-withdrawal`,
  `j6-device-voice-interruption-and-export-share`, `j7-device-sandbox-purchase-restore-cancel`.
- **Human:** `j7-human-paid-build-and-store-authorization`.
- 51 preflight values unfilled; 8 store-readiness blockers.
- **Package holds:**
  - Fly `release:null` (reported);
  - `wxv734oi12` on old Desktop `5b6f8aa4`;
  - the identity API unmarked;
  - billing unmarked and with no `SourceCommit`;
  - the Data API 64 KiB row limit and the export timings;
  - the mixed workforce issuer;
  - `ueGlFRbNB`'s MFA setting (reported, not observed);
  - two-session lease and race runs on Aurora;
  - the V2 device rendering of the new terminal state.

## 6. Ordered Codex AWS hand-back (nothing here was run)

Stop at any step whose precondition fails. A refusal is the result; never edit a report, a binding or a parameter to
pass.

0. **Restore V2 CI first** (Brandon: Actions billing for the private repository), and get a passing run on the exact V2
   code commit `54391a47`. Then run Desktop CI on the code commit (§1).
1. **Credential-free checks**, each from a clean checkout of the code commit:
   - Desktop: `npm run test:hosted-program-acceptance` gives 37 passed; `pwsh ./scripts/test-qualification-acceptance-runners.ps1`
     gives 83 cases.
   - V2: `bun run test:billing-qualification-harness` gives 29 passed.
2. **Read-only checkpoints. Record them before any write.**
   - **F0:** the Fly release and image digest and the current `/health` body. Today expect `release_missing`.
   - **D0:** `node scripts/hosted-program-acceptance.mjs --observe-read-only`. Record `lambdaCodeKey`, `codeSha256` and
     `revisionId`. Expect `reviewed_artifact_required` and `observed_source_stale`.
   - **Q0:** each qualification candidate's `SourceCommit` and template hash.
   - **B0:** `npm run check:synthetic-core-billing-target -- --profile <p>`, then the harness with `--acceptance`.
     Expect `lambda_code_mismatch` or `source_stale`. A 16 October receipt in source records the live ZIP as built for change set
     `blocked-billing-shape-c3507d8-20261016`; that is recorded, not observed.
3. **Negative checks**, each refusing before any request (WP2 doc §6.3):
   - a dirty checkout gives `source_dirty`;
   - the predecessor checked out gives `sourceCommit_checkout`;
   - `SOURCE_COMMIT=<predecessor>` gives `target_source_mismatch:asserted`;
   - the care inspector with `--acceptance` gives `candidate_not_deployed`.
4. **Pin the identity bundle.** Build it in a clean `npm ci` checkout of the Desktop code commit, with real
   `node_modules`. Record its SHA-256 and size as a reviewed source change of `REVIEWED_SOURCE_PAIR`. Never use
   `24a65189…` or `546d962f…`.
5. **Owner decisions before any write** (§7).
6. **Writes, each with Brandon's approval and its checkpoint as the rollback target:**
   - redeploy Fly from V2 `54391a47` (rollback F0), then
     `npm run verify:live-release -- --origin=… --kind=fly-synthetic --source=54391a47…`;
   - a reviewed care release of the Desktop code commit to `wxv734oi12` (rollback D0; packet §7 step 6);
   - the qualification candidate stacks from the Desktop code commit (rollback Q0);
   - a billing redeploy that names its commit (rollback B0).
7. **SQL on isolated fictional qualification Aurora only.** For each candidate: check the parent prosrc, apply, test,
   rehearse the rollback, then re-apply.
   - The WP5 successor: `docs/clinic-continuity-release-map-2026-10-17.md` §7. Two-session withdrawal-versus-suspension
     in both orders; then deploy care-connections with digest `f1658585…`.
   - The WP3 reconciler: `docs/revocation-signal-reconciler-2026-10-17.md` §10. First add the role-scoped Data API
     adapter. Two-session lease. Apply the template while still BLOCKED. Outage drill and silence-alarm drill.
   - The WP1 segmented export: `docs/privacy-export-oversized-records-2026-10-17.md` §7. Reproduce with the build
     blocked, apply, run the qualification build only, measure the Data API row and response sizes against the
     8 s / 15 s budgets, check owner B isolation, rehearse the rollback.
8. **Hosted runs, with no deploys during a run:**
   - **Export retention:** can qualify.
   - **Recording and voice:** expect exit 1 with `unverified: [...]`; record the refusal.
   - **Program on `wxv734oi12`:** expect `execution_not_qualification`.
   - **Billing:** at best `not_qualified` with `sourceBinding: observed`. That is not a purchase pass.
   - **Issuers:** `assertQualificationIssuerPlan` against the observed authorizers. Read `ueGlFRbNB`'s MFA setting
     yourself.
9. **Record the kit rows.** Record hosted rows in the V2 kit with `observedSource` read from the deployment, never typed.
   The nine external cases stay `unobserved` until each is independently observed.

## 7. Owner and counsel decisions (none taken here)

1. **Export lineage:**
   - option A (the envelope only), B (the envelope and the notice) or C (decline);
   - the notice wording (`expo/docs/claude-v2-export-lineage-2026-10-17.md` §4);
   - the restored-copy `suggested` status.
2. **Oversize packaging wording:** "Packaging stopped because one saved record is larger than this release can include
   in a prepared copy. Nothing was shared and no record was changed. Trying again will stop at the same record."
3. **The head start:** 250 ms, or none. Also the 1-minute schedule, the 5-minute overdue threshold and the batch of 100.
4. **R1:** recording-consent withdrawal in a suspended clinic. **R2:** refreshed-token consent management. **R4:**
   campaigns under ordinary suspension. **D3 to D5:** cleanup, legal holds and patient copies.
5. **One workforce issuer** for the qualification API, and whether the program API moves to `zGOVBoeGT`.
6. **How recording's and voice's unmarked denials can ever be verified.** An authorizer-configuration read plus a token
   anchor is one option.
7. **The identity API's marker:** a source change to mark `wxv734oi12`'s answers, or run journey 5 on the qualification
   program API.
8. **A security review of F5** (PUBLIC EXECUTE in `clinical_private`).
9. **Unchanged from before:** the four V2 high residual advisories stay unapproved.

## 8. Graphify append text (not applied; the shared map was not changed)

```
node: desktop-source-closure-20261017 (Desktop DESKTOP_CODE) -> contains: 88f49ca6, a38a62be, 5227b644, 0dd4e608, 78f4c654, bd2fbf5f, 05400972, 4b33f7bd, 48e2545f, aa7e8b9b
node: v2-source-closure-20261017 (V2 54391a47) -> contains: 4325c047, a1de19db, 8be5f7dd
edge: hosted-acceptance-source-boundary -> refuses: dirty checkout, mid-run redeploy, asserted-source mismatch, unmarked-denial-only steps, not_deployed under --acceptance
edge: hosted-program-acceptance -> binds: clean checkout HEAD, observed LambdaCodeKey commit, observed CodeSha256, marker; holds: identity API unmarked, bundle digest unpinned
edge: billing-deployment-observer -> binds: observed stack, template Metadata.Qualification, CodeSha256 (base64), issuer; holds: no SourceCommit, no marker
edge: revocation-signal-reconciler (BLOCKED) -> bounds: outage window after recovery; cannot: commit-instant window; finding: PUBLIC EXECUTE on 20 clinical_private functions
edge: care-connections-patient-withdrawal (BLOCKED SQL 0b5a6fc9) -> keeps open: patient status and withdrawal in a closed clinic
edge: qualification-issuer-release-map/1 -> refuses: mixed workforce issuer (program API on us-east-2_ueGlFRbNB)
edge: owned-privacy-export-segments (BLOCKED SQL 06a99fd7) -> fixes: one oversized record withholding the whole copy; live: record_exceeds_export_page terminal state
edge: privacy-export-lineage/1 (V2, disabled) -> awaits: Brandon/counsel option A/B/C and wording
hold: V2 CI unavailable since ~08:16 UTC 2026-10-17 (jobs refused before any step; private repo)
```
