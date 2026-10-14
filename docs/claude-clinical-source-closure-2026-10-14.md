# Clinical source closure and release evidence (2026-10-14)

Core remains the narrower $19.99 education-only launch. Production lab classification and lab-derived
plans/directions, supplement purchase links, production Ask ALP, peptides and longevity are withheld.
`CONSUMER_PURCHASE_RELEASED` and `LAB_RESULT_TRANSFER_V2_ACCEPTED` remain false. Every clinical hold,
source-verification requirement and provider gate is preserved. Everything here is source, with fictional data only:
no PHI, no SQL registered or applied, no AWS change, no product or price, no paid build, nothing merged to `main`.

| Repository | Base (integrated) | Branch |
| --- | --- | --- |
| AI_DESKTOP_PRO | `85bccb09288204f3f3d9b174a532b7457a4c84a4` | `claude/clinical-source-closure-20261014` |
| AI_LONGEVITY_PRO_V2 | `32919c456bcd530a7bfc14ad876152616f381f98` | `claude/clinical-source-closure-20261014` |

The V2 half is `expo/docs/claude-clinical-source-closure-return-2026-10-14.md` in AI_LONGEVITY_PRO_V2.

## WP1 — the reviewer's value attestation, in source and disabled

**What a reviewer sees.** In the lab workspace, a governed reading (one with an import event) gets a *Value
attestation* card that loads only when asked. Two columns:

- *Clinic reading, as stored*: marker, the value as the database renders the stored number (`value_numeric::text`,
  never reformatted), the unit (or "Unknown"), the draw time in the one serialisation the request accepts, the review
  state, "Laboratory flag: Not transferred", and for a lab-result/1 reading its stored status only as "the app's,
  unreviewed — not a laboratory flag".
- *Transferred report*: the contract and origin, and the SHA-256 of each report the transfer recorded. The reviewer
  selects their copy of the report; the browser hashes it locally (WebCrypto) and says whether it is one the transfer
  recorded. The file is never uploaded. A matching image or PDF is shown beside the reading.

The reviewer restates marker, value, unit and draw time (each compared with the record as they type), chooses
whether the report shows the same reading, and confirms they compared the four fields against the shown digest. The
request binds actor and clinic (from the session token, never the body), the patient on screen, the **reading
revision** they saw and the document digest, around the reviewed `lab-reading-attestation/1` statement.

**Nothing says "verified" early.** The receipt is followed by a read-back; the screen says verified only when the read
view names *this receipt's* attestation as current (`verifiedByView`). A lost reply shows "could not be recorded.
Nothing has been verified." and *Try again* re-sends the same request id, answered from its own record (`duplicate`).
A readback failure says the attestation was recorded but not read back. Changing the selected reading or patient
aborts and drops late answers.

**Why a separately named successor.** The reviewed attestation candidate binds the reading, document and reviewer, but
not the patient the reviewer had open, the revision they looked at, or whether a correction has replaced the reading.
Those cannot be added without changing its pinned bytes, so
`infra/aws-clinical-core/production-candidates/lab-attestation-review.sql` (BLOCKED, own disabled activation row) adds:

- `clinical_core.lab_attestation_review(jsonb)` — the bound view, refusing a missing reading, another clinic's or
  another patient's with **one** refusal (`lab_attestation_review_refused`), so the answer leaks nothing;
- a reading revision: a digest over everything the view showed that an attestation depends on;
- supersession: a later-received, accepted reading of the same source marker over the same connection and provider
  (a correction) supersedes the earlier one, which can no longer be attested (`lab_attestation_reading_superseded`);
- `clinical_core.attest_reviewed_lab_observation(jsonb)` — locks the reading, answers a replay from its own record,
  refuses a stale revision (`lab_attestation_stale`) and a superseded reading, then calls the reviewed
  `attest_lab_observation` unchanged for everything else (actor, role, document, restated fields, CAS).

A characterization test proves the gap the successor closes: the reviewed function alone *would* attest the
superseded original.

**Refusals covered** (PGlite through the API role, route and browser): missing document and every lab-result/1
reading (`document_unknown`); a changed document (`document_mismatch`); a stale view after another reviewer or a moved
review state; a superseded reading; withdrawn authority after the view loaded (`clinical_role_required`, or the
platform's `request_context_refused` for a disabled identity); another clinic; a staff member without a clinical role;
a consumer; a client "verified" boolean, signature, range or flag; another patient than the one open.

**Disabled twice.** The Desktop routes (`/api/live/lab-attestations` and `/review`, same-origin, bounded bodies,
strict contract, `no-store`) refuse with `lab_attestation_disabled` and no network call unless
`CLINICAL_LAB_ATTESTATION_ACTIVATION` holds `lab-attestation-review-activation/1` evidence naming all three lab
candidates exactly. The service refuses again on its own activation rows. Under the local contract fixture the
routes reach only the loopback fixture backend, whose attestation switch is off at every reset. The AWS handler
(`labAttestationReviewHttp`) is written and tested but **not mounted**; the identity API answers `route_not_found`.

**Hosted error mapping fixed.** `classifyDatabaseRejection` had no `lab_attestation_*` tokens, so on RDS every stale or
superseded refusal would have reached the reviewer as "service unavailable". It now classifies them by token only.

**Tests.** `lab-attestation-review.database.test.ts` (16), `api/live/lab-attestations/route.test.ts` (19),
`e2e/live-lab-attestation.spec.ts` (6: disabled default; stored reading beside the recorded report, wrong file and
wrong field blocked, verified only after a held readback; another reviewer between view and submit → stale; lost
reply retried as the same request, history length 1; legacy /1; no cross-reading leak). Failing before: with the final test files on the base head `85bccb09`, both attestation suites fail to load
(`lab-attestation-review.database.test.ts`: no `./lab-attestation-review`; `route.test.ts`: no route). The browser
spec was not run on the base.

## WP2 — lab-result/2 receipts (Desktop half)

`importLabResultV2` now returns `lab-import-receipt/2`: the /1 binding plus the documents recorded and
`verification: needs_human_review`. Its `payloadSha256` is computed over the transfer's content in the V2 sender's key
order (`labResultV2Content`), so it equals the sender's `resourceVersion`; one golden vector
(`858f1f3b8ed29cd5a23014c92fdd13a7621a0c1280263352f1d8e89085f2d6e2`) is pinned in both repositories. Before this, the
/2 path returned no receipt at all, so the V2 journal could never have settled a /2 entry. The identity API still
answers `409 lab_result_v2_not_accepted` before any database work. The mirrored `labResultTransfer.ts` is unchanged.
The receipt tests are in `lab-verification-candidates.database.test.ts` (35). Failing before: with the final file on `85bccb09`, the two receipt tests fail and the other 33 pass. The
helper they compute the expected digest with does not exist there, and the base `importLabResultV2` is typed
`Omit<LabImportResult, "receipt">` and returns only `{eventId, state, duplicate}`.

## WP3 — program-step purchase actions bound to the current review

`program-step-purchase/1` (`src/contracts/programStepPurchase.ts`, mirrored byte-for-byte to V2 and pinned in both)
carries the existing `fullscript-consumer-action/2` request **unchanged** beside the step's binding: owner (session),
enrollment, exact step, enrollment revision, the review's plan revision, content digest, care connection, and the
step's catalog stable id, version and target. The action's product must be the step's own catalog product and
version.

`infra/aws-clinical-core/production-candidates/program-step-purchase.sql` (BLOCKED, own disabled activation row, reads
the unchanged program candidate's private review functions) adds:

- `clinical_core.program_step_purchase_check(jsonb)` — re-runs the program's lab-aware review now and refuses unless
  the exact step is available: `program_step_lab_held`, `_held`, `_conflict`, `_duplicate`, `_not_current`, `_stale`,
  `program_review_stale`, `_superseded`, `_not_active`, `_withdrawn`, `_catalog_changed`, and `_refused` (another
  owner, clinic or care link — one refusal);
- `clinical_core.program_held_catalog_products()` — the catalog ids a person's current programs hold (any supplement
  step the review does not list as available or as a plan duplicate). It answers `[]` while the program service itself
  is disabled, and without the supplement-plan consent treats every enrolled supplement step as held.

The disabled consumer-action candidate keeps every non-program behaviour: its 68 unit and 8 database tests pass with
their assertions unchanged (each suite's ports gained one line, a `programHolds` port that holds nothing). Additively:
a step-bound action records its binding and is redeemable only on the program path, which re-reads the review before
the spend; on the plain path such an action does not exist (`action_not_found`), and a product a current program holds
is `product_unavailable` at issue and at redemption, so an older client or a crafted plain request cannot buy a held
step around its hold.

**Key regression** (`program-step-purchase.database.test.ts`, 10): an iron step is available (complete inventory, an
attested ferritin of 80); an action is issued; then a high ferritin (420, accepted, unattested) or a conflicting
personal result arrives. Redemption is refused (`program_review_stale`), a fresh binding is `program_step_lab_held`, the
copied action id is `action_not_found` on the plain path, an old-client plain issue is `product_unavailable`, and no
response carries a destination. With the step still available the bound action redeems once; a product outside the
program behaves exactly as before. `src/contracts/programStepPurchase.test.ts` (2) pins the contract; `aws-identity-api.test.ts`
(52, +6) holds that no attestation or purchase path is mounted. Failing before: on `85bccb09`, `program-step-purchase.database.test.ts` and
`programStepPurchase.test.ts` fail to load (no module). `aws-identity-api.test.ts` passes 52/52 there as well, as it
should: its new cases hold the existing behaviour (nothing mounted).

**Core exposes nothing.** With `CONSUMER_PURCHASE_RELEASES` empty, crafted program and plain issue/redeem requests all
end at `commerce_disabled` before any port is read; without this adapter's evidence it is
`program_step_purchase_disabled` before anything. The identity API mounts none of the purchase paths
(`route_not_found`, no adapter call, no address). Requests naming a destination, a price, a purchase link or another
product are `request_invalid`.

## Found and left for decision (not fixed here)

- **The program candidate's SQL `read` returns `phases` as stored, including `purchaseUrl`.** Only the TS adapter
  replaces it with null. Defence in depth would redact at the source; that needs a successor to the pinned program
  candidate. No path returns it today (the production program family is disabled and unrouted).
- **`complete` checks the step is in `review.add` but not the plan revision**; a completion made against an older view
  is decided against the current review, which is safe (holds only tighten), but it is not compare-and-set like
  `accept`. Noted for review; not a purchase path.
- **The V2 program screen still prepares purchases through the plain path** (behind the off release). The server-side
  guard makes that safe for held steps; switching the screen to the step-bound request is an activation prerequisite.

## Candidates and digests

| Candidate | LF SHA-256 | Status |
| --- | --- | --- |
| `production-candidates/lab-result-transfer-v2.sql` | `fa6ee162a03a85ab23543371d9d1dbaf8ee6dd486b4a8cc64b5545fc16be3b94` | unchanged |
| `production-candidates/lab-observation-attestation.sql` | `d0423bcec5067a668f3522bbba65d096f642f083c1ef95448da190b38494bb83` | unchanged |
| `production-candidates/production-program-assignments.sql` | `78bd5b3805d96443829f6e7380deba0d66ad2f03073374bd6681f4f6bc25b4f3` | unchanged |
| `production-candidates/lab-attestation-review.sql` | `765b5b963824772d049b79030b439a54cda5ca715dbe371b4eb4258fe1aedbf3` | **new**, BLOCKED (`LAB_ATTESTATION_REVIEW_CANDIDATE_SHA256`) |
| `production-candidates/program-step-purchase.sql` | `ad66f389221ca77681bc94a0f75b9d6ab45d9656e3431cce22e5cd026de042de` | **new**, BLOCKED (`PROGRAM_STEP_PURCHASE_CANDIDATE_SHA256`) |
| `src/contracts/labResultTransfer.ts` (mirror) | `fc4ec19fc5b8bb06db6b11206906a5b4fa96b7041b591fd654f23f3a20f8cbcb` | unchanged |
| `src/contracts/programAssignments.ts` (mirror) | `96c2adb19703d3dcb3ca78c63f444d1eb936f8975839b5723ccc033b6336e62d` | unchanged |
| `src/contracts/fullscriptConsumerAction.ts` (mirror) | `6d695267be2819eba4398664d4f893daca4964befa2ead829707507080ffd47d` | unchanged |
| `src/contracts/programStepPurchase.ts` (mirror) | `417d0573c241262b4356a625627e2bf83e3db94468cdd0547f4e0891597d92a1` | **new** |
| `src/contracts/labAttestationReview.ts` (Desktop only) | `460d4469dae55ce4b95e37fa7e5ff3b8b390ec8857cd1073cadd10ca33b80187` | **new**, not mirrored |

Registration order, after the 106-migration artifact: `lab-result-transfer-v2.sql`, `lab-observation-attestation.sql`,
`production-program-assignments.sql`, then — independent of each other — `lab-attestation-review.sql` and
`program-step-purchase.sql`.

## Verification at the exact heads

Code heads: Desktop `e45b60cf0ae8ceeffccd839a43e5955e0cea8d46`, V2 `6525fc51225a6dd91ab67e3a3b577675bdf71f88`. The commits
after them on each branch change documentation and V2 release metadata only (this file, the V2 return, the
`CLAUDE.md` index row, the launch-acceptance index and the preflight manifest's source pair).

| Check | Desktop | V2 |
| --- | --- | --- |
| Full unit suite, base head | 543 files, 8,648 tests: 8,637 passed, 11 skipped, 0 failed | not run at the base (the new suites' failing-before is below) |
| Full unit suite, code head | 547 files, 8,703 tests: 8,692 passed, 11 skipped, 0 failed | 313 files, 3,583 tests: 3,582 passed, 1 skipped (the existing hosted skip), 0 failed |
| Typecheck | clean | clean |
| Lint | clean, 0 warnings | clean, 0 warnings (`expo lint`) |
| Clinical build (`APP_EDITION=clinical NEXT_PUBLIC_USE_LIVE_API=true npm run build`) | passed; both `/api/live/lab-attestations` routes in the output | n/a |
| `check:clinical-bundle` | PASS, 327 client chunks | n/a |
| Gates | `check:stub-reset` (142 bindings), `check:mock-imports`, `check:aws-clinical-core`, `check:aws-identity-consent`, `check:aws-authenticated-api`, `check:aws-desktop-compatibility-contract` (223 RPCs), `check:aws-desktop-operation-inventory` (228 operations, 0 enabled), `check:aws-production-clinical-core` (106 migrations, zero seeded rows), `check:aws-production-clinical-api`, `check:aws-core-launch-scope`, `test:migration-sql-bytes`, `test:e2e-order-config`: all pass | `test:launch-acceptance` 22/22, `test:release-preflight` 10/10; `check:release-preflight` refuses as designed (51 missing values, 0 refusals: the source pair agrees with the index) |
| One-process browser battery, forward and reverse | **PASS** on `e45b60cf`: the same 324 tests passed in each order, 0 failed or did not run; 0 worker restarts; max heap used 2,343 MiB of 9,216; `check:stub-reset` PASS afterwards. 99 tests in each order (the same 99) skipped by declaration and were not counted: 80 in the 10 separately configured specs and 19 in `live-copilot-provider-readiness.spec.ts`, each naming the CI job that runs it. The 6 `live-lab-attestation` tests passed in both orders | n/a |
| Launch-acceptance source cases | n/a | 8/8 source cases passed (source digest `697062fe4c00f4e1a6eeef8503d2714b3ba438758589125ca6b41902de80a9bb`); 9 hosted, device and human cases unobserved; acceptance withheld (exit 1, by design) |
| CI on the pushed head | [run 38610052133](https://github.com/HolisticDrBright/AI_DESKTOP_PRO/actions/runs/38610052133) on `e45b60cf`: success, 11 jobs. The deployed-backend job skips its suite without secrets, so it is not hosted evidence | [run 38610040093](https://github.com/HolisticDrBright/AI_LONGEVITY_PRO_V2/actions/runs/38610040093) on `59d762c` (code `6525fc5` plus the kit rebind): success, including typecheck, lint, the full test suite and the kit regressions |

The battery ran on `e45b60cf`, with this file as the only uncommitted change. Its evidence (server log with memory
samples, latency canary, each order's report and timeline, `summary.json`) stayed in the session's scratch directory,
and nothing from it is committed. The server log holds 35 `ECONNRESET` aborted-socket events (each printed as an
`uncaughtException`). That is the existing development-server noise from navigations that cancel requests, and no
test failed with it.

## Status

| | WP1 attestation | WP2 lab-result/2 | WP3 program-step purchase |
| --- | --- | --- | --- |
| Source implemented | yes (disabled) | yes (prepared, not sent) | yes (disabled) |
| Locally verified | yes | yes | yes |
| CI verified | yes, at the code heads | yes, at the code heads | yes, at the code heads |
| Hosted verified | **no**: not registered, not applied, not mounted | **no**: the identity API refuses /2 | **no**: not registered, not routed |
| Device verified | **no** | **no** | **no** |
| Approved for PHI | **no** | **no** | **no** |

Not run or not observed:

- every hosted, device, provider, store and human launch-acceptance case;
- the 99 browser tests that skip by declaration in the battery, which run in their own CI jobs;
- 11 Desktop unit tests that skip without an external environment:
  - 9 in `sync/bridge-roundtrip.test.mjs`, which needs a running patient-side receiver;
  - 2 in `aws-governed-catalog-seed-adapter.test.ts`, which needs the externally handed-off catalog package;
- the 1 V2 test that needs the deployed service (`hosted-governed-recommendations.integration.test.ts`);
- the attestation browser spec on the base head.

Nothing was run against AWS, a provider, a store, a device or a real person's data.

## The Windows child-process hang (separate; not a source finding)

Codex's Windows full-suite run hung. That is neither a pass nor an application failure, and no test was changed here.

- **Bounded reproduction on Linux, not reproduced.** The five vitest files that spawn child processes from the
  runtime tree (64 tests) finished in 6.4 s, and `scripts/e2e-child-process.test.mjs` passed 3/3.
- **Likely mechanism, unproven.** 153 test files call `execFileSync`, `spawnSync` or `execSync`; for example the four
  calls in `src/server/runtime/e2e-dev-resources.test.ts` (lines 48, 54, 73 and 123) pass no `timeout`, and
  `vitest.config.ts` sets none either. A synchronous child blocks the worker's event loop, so vitest's own test
  timeout cannot fire: on a host where such a child does not exit (a Windows path, shell or antivirus difference),
  the suite waits silently instead of failing.
- **Proposed, not applied.** On the Windows host, run the suite with `--reporter=verbose --reporter=hanging-process`
  to name the file. Then give that file's synchronous calls a `timeout` (with `killSignal`) so a stuck child fails
  the test instead of the run. Making that change without the Windows evidence would be guessing.

## Codex — AWS-only packet

Nothing here asks for an AWS change during Core. Every item below stays unregistered, unapplied and disabled until a
separate reviewed activation.

1. **Candidate identities and order** (LF SHA-256), after the 106-migration production artifact
   (`fb63e0db3d9a6ff3c8020312452591b92660c5d6fc2940eae717345d85c41107`, as `check:aws-production-clinical-core`
   builds it at `e45b60cf`):
   1. `lab-result-transfer-v2.sql`: `fa6ee162a03a85ab23543371d9d1dbaf8ee6dd486b4a8cc64b5545fc16be3b94` (unchanged)
   2. `lab-observation-attestation.sql`: `d0423bcec5067a668f3522bbba65d096f642f083c1ef95448da190b38494bb83` (unchanged)
   3. `production-program-assignments.sql`: `78bd5b3805d96443829f6e7380deba0d66ad2f03073374bd6681f4f6bc25b4f3` (unchanged)
   4. `lab-attestation-review.sql`: `765b5b963824772d049b79030b439a54cda5ca715dbe371b4eb4258fe1aedbf3` (**new**; needs 1–2)
   5. `program-step-purchase.sql`: `ad66f389221ca77681bc94a0f75b9d6ab45d9656e3431cce22e5cd026de042de` (**new**; needs 3; independent of 4)
2. **Activation, when someone decides it.** Each new candidate has its own disabled singleton activation row
   (`lab_attestation_review_activation`, `program_step_purchase_activation`) beside the reviewed ones. The Desktop
   attestation routes also need `CLINICAL_LAB_ATTESTATION_ACTIVATION` = `lab-attestation-review-activation/1`
   evidence naming candidates 1, 2 and 4 exactly; without it they answer `409 lab_attestation_disabled` and make no
   network call. The program-step adapter needs `program-step-purchase-activation/1` naming 3 and 5, and it still
   ends at `commerce_disabled` while `CONSUMER_PURCHASE_RELEASES` is empty, as it is under Core.
3. **Routes.** `labAttestationReviewHttp` (`POST /clinical-core/workforce/lab-attestations/review` and
   `/clinical-core/workforce/lab-attestations`) is written and tested but **not mounted**; the identity API answers
   `route_not_found` for both and for every purchase path. Mounting is part of activation, not of this hand-back.
4. **Negative cases to observe on the synthetic stack** before anything is enabled:
   - **/2 refusal.** A `lab-result/2` POST to the identity API answers `409 lab_result_v2_not_accepted` before any
     database work: no lab row, no receipt. The V2 journal records that entry `refused`, stops the batch, and never
     resends it or downgrades it to /1.
   - **Lab-held iron step.** Use a fictional owner whose iron step is available (complete inventory, attested ferritin
     80). Issue an action. Then add an accepted, unattested ferritin of 420, or a conflicting personal result:
     - redemption is `program_review_stale`;
     - a fresh check is `program_step_lab_held`;
     - the copied action id on the plain path is `action_not_found`;
     - an old client's plain issue for the iron product is `product_unavailable`;
     - no response carries a destination.
   - **Stale revision.**
     - Attestation: a second reviewer attests between view and submit, so the first submit is
       `409 lab_attestation_stale`. A correction (a later accepted reading of the same marker) makes the original
       `409 lab_attestation_reading_superseded`.
     - Program step: an older enrollment revision is `program_step_stale`; an older plan revision is
       `program_review_stale`.
5. **New refusal tokens.**
   - `lab_attestation_review_refused` covers a missing reading, another clinic's or another patient's: one refusal,
     answered 404.
   - `lab_attestation_reading_superseded` answers 409.
   - `program_step_refused` (another owner, clinic or care link) is classified `identity_refused`.
   - `program_step_purchase_disabled` is `operation_refused`.
   - `program_step_lab_held`, `_held`, `_conflict`, `_duplicate`, `_not_current`, `_stale`, `_superseded`,
     `_not_active`, `_withdrawn`, `_catalog_changed`, `program_review_stale` and `program_step_unavailable` are
     `conflict`.
6. **RDS classification changed.** `classifyDatabaseRejection` (`rds-data-database.ts`) now maps the
   `lab_attestation_*` and `program_step_*` tokens to a category and a closed-vocabulary reason. Before this, every one
   would have reached a hosted caller as `service_unavailable`.

## Graphify (append-ready; the vault was not edited)

```
2026-10-14 · Claude · clinical source closure (source only, disabled, fictional data)
- Desktop claude/clinical-source-closure-20261014 (base 85bccb09, code head e45b60cf); V2 same branch (base 32919c4, code head 6525fc5).
- WP1: reviewer value attestation. Desktop card shows the clinic reading as stored beside the transferred report's recorded SHA-256; the reviewer restates and confirms; "verified" only after the receipt is read back. BLOCKED successor lab-attestation-review.sql (765b5b96…dbf3) binds patient, reading revision and supersession. Routes /api/live/lab-attestations[/review] refuse without CLINICAL_LAB_ATTESTATION_ACTIVATION. AWS handler written, not mounted.
- WP2: lab-result/2 prepared, not sent. V2 takes document digests only from the upload job's recorded checksums (lab-document-trace/1). Gate off → /1 only, no trace read or written. Desktop answers /2 with lab-import-receipt/2 (golden vector 858f1f3b…d6e2). The identity API still refuses /2 with 409.
- WP3: program-step purchase binding (program-step-purchase/1, mirror 417d0573…92a1). BLOCKED successor program-step-purchase.sql (ad66f389…42de) re-reads the current program review at issue and redemption. A program-held product is product_unavailable on the plain path; a step-bound action is action_not_found there. Core exposes no destination.
- Unchanged pins: lab-result-transfer-v2.sql, lab-observation-attestation.sql, production-program-assignments.sql, labResultTransfer.ts, programAssignments.ts, fullscriptConsumerAction.ts.
- Kit: V2 launch-acceptance index rebound to e45b60cf / 6525fc5; predecessor preserved (LF 11069a7f…156e); j2 → /8, j3 → /11; hosted, device and human cases unobserved.
- Status: source implemented, locally verified; hosted, device and PHI: no. CONSUMER_PURCHASE_RELEASED and LAB_RESULT_TRANSFER_V2_ACCEPTED false.
- Left for decision: the program candidate's SQL read returns purchaseUrl (only TS redacts it); complete is not compare-and-set on the plan revision; the V2 program screen still prepares purchases on the plain path (behind the off release).
```
