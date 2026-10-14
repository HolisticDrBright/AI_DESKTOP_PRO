# Lab safety, provenance and browser acceptance, 2026-10-13: return

_The same return is committed in V2 as `expo/docs/claude-lab-safety-provenance-return-2026-10-13.md`. It answers
"Next Claude Code handoff — lab safety, provenance, and browser acceptance" (October 13, 2026). Paths without a
repository prefix are Desktop paths when they start with `src/`, `infra/`, `scripts/` or `e2e/`, and V2 `expo/` paths
when they start with `__tests__/`, `app/`, `lib/`, `contracts/`, `components/`, `services/`, `backend/` or `release/`._

**Source work only.** Branches: `claude/lab-safety-provenance-20261013` in both repositories (work packages 1 and 2)
and `claude/browser-acceptance-runner-20261013` in Desktop (work package 3), each cut from the integrated heads the
handoff named (Desktop `ea91196c`, V2 `1ec928da`; both re-checked as the current remote heads before branching).
Nothing was merged to `main`, deployed, force-pushed, opened as a pull request or deleted. No schema was applied, no
AWS write was made, no provider was called, no PHI was enabled, no lab-derived direction or purchase link was
released, and no paid mobile build was started. Every candidate below is **BLOCKED**: unregistered, applied nowhere,
and its activation row is disabled. The $19.99 Core launch stays education-only; `CONSUMER_PURCHASE_RELEASED` is
false; the lab classification, inference and directive tiers are off; peptides and longevity stay unavailable.

Status vocabulary, used separately throughout: **implemented** (source exists), **locally verified** (observed here,
with the command), **CI verified** (green exact-head CI), **hosted verified** and **device verified**. Nothing in
this return is hosted verified or device verified. A skipped, refused or unobserved case is never counted as a pass.

**Base and heads.** Base pair as handed off: Desktop `ea91196c`, V2 `1ec928da`. The late addendum's newer integrated
heads — Desktop `34330b2c` (Codex's runner guards) and V2 `d5bf83c4` (code `b5d012ec`, all 17 general lab-order
destinations held outside the bundle) — were merged in with ordinary merges (Desktop `0771d28c`, V2 `46a43325`), and
so were the heads Codex pushed while this work was in progress — Desktop `8a998736` (the Lens panel confirms the exact
saved result before announcing completion) and V2 `a5daecd7` (its rebind to that source) — as Desktop `83a46bb5` and
V2 `27bb0c6e`. V2's acceptance files were taken as this branch left them in each merge, then rebound (V2 `cf8992a`).
Code pair: Desktop `83a46bb5cd4643ade2a664ba7200d61d4d61fecf`, V2 `27bb0c6e5ac04598ded02138fa23568e25956f93`.
Codex's later Desktop head `f97bb2d8` (browser-runner and e2e files only) is merged into the runner branch, not this
one; the two branches change different files except `CLAUDE.md`'s documentation index, where their rows sit apart (a
three-way merge of that file was checked: no conflict).

| Work | Implemented | Locally verified | CI verified | Hosted | Device |
| --- | --- | --- | --- | --- | --- |
| WP1 service lab holds in V2 (contract, plan check, decision, screen) | V2 `5388204` | 9 failing before → pass; full V2 suite 3,567 passed, 1 existing skip | V2 `27bd034` run 38485918794 ✔ | no | no |
| WP1 server lab-aware program review (BLOCKED candidate) | Desktop `1564e7f4` | PGlite 20/20 (9 failing before); Desktop unit suite 8,627 passed, 11 existing skips | Desktop `0771d28c` run 38486172947 ✔ | no (not applied) | n/a |
| WP2 reviewer attestation (BLOCKED candidate + disabled adapter) | Desktop `1564e7f4` | 33/33 on the production artifact; mutation checks | run 38486172947 ✔ | no | n/a |
| WP2 lab-result/2 contract, Desktop refusal, V2 builder (not sent) | Desktop `1564e7f4`, V2 `a9ab1cd`/`17fd94c` | contract, route and builder suites; failing before on both bases | both runs ✔ | no | no |
| WP2 legacy V2 backfill removed | V2 `a9ab1cd` | guard suite failing before → pass | run 38485918794 ✔ | n/a | n/a |
| Acceptance rebind (predecessor preserved) | V2 `27bd034`, then `cf8992a` | `test:launch-acceptance` 22/22, `test:release-preflight` 10/10; `check:launch-acceptance` 8 source cases accepted, 8 hosted/device cases withheld as unobserved | V2 `cf8992a` run 38490838327 ✔ | — | — |
| WP3 runner repair and LensPanel | runner branch `6e4733a4` (code `575e0908`) | full battery at `575e0908`: forward and truly reversed, 318 of 318 each, 0 failed (above); runner tests 27/27, dev-resource tests 23/23, unit suite 8,574 passed (11 existing skips), lint, typecheck and clinical build clean | runner `6e4733a4` run 38523164539 ✔ (including the three live-fixture shards) | n/a | n/a |

Hosted and device columns are empty by design: nothing was deployed, applied or installed.

## Work package 1 — the server evaluates labs before it declares a supplement step available

**The defect.** The V2 device held a program supplement step against saved labs (program-lab-safety/1), but the
server's review (`production_program_review`) was not lab-aware: it declared an iron step available beside a high
ferritin, `complete` accepted it, and only the device stood between the person and the step. The device rule is a
second safeguard; it cannot be the authority (another client, an older build, or a device without the readings
would not apply it).

**Contract first, V2 first** (`contracts/programAssignments.ts`, byte-identical in both repositories). The review gains
an optional, additive `labHolds` list (program-lab-review/1). Each entry names a supplement step the service already
HELD, the nutrient (`iron`, `vitamin_d`, `vitamin_b12`, `folate`, `magnesium`, `zinc`), the reason
(`measured_above_range`, `results_disagree`, `status_not_verified`) and `decision: 'clinician_review'`. It never
carries a value, range, direction or classification. The contract, V2's plan check and the one supplement decision
accept a hold only for a held supplement step, once; a review without the key parses exactly as before. V2 shows the
service's reason, never lets its own readings release a service hold, and counts a service hold once (V2 `5388204`).

**The server rule** (`infra/aws-clinical-core/production-candidates/production-program-assignments.sql`, BLOCKED,
pinned in `src/server/clinical-core/production-program-assignments.ts`):

- *Readings the service reads itself, for the authorized owner only.* The owner's personal lab history (owned
  `lab_observations`, read only under a granted `lab_history` consent, current revision, never verified), and the
  clinic's readings for the enrolled patient record in this organization (`clinical_core.lab_observations`, not
  rejected). A clinic reading is **verified only by a current reviewer attestation** (work package 2); acceptance of
  an import and practitioner review are not verification.
- *Direction against the reading's own printed range only*, never a functional or recalled range. A lower bound alone
  cannot show a result is not high, so the server reads it as unknown (stricter than the device).
- *The rule*, per supplement step whose normalized ingredient keys match a nutrient: any reading above its range holds
  (`results_disagree` when the newest verified reading is not above, `measured_above_range` otherwise); for iron, the
  step is also held unless the newest verified iron-status result is below or within a range with an upper bound
  (`status_not_verified`). Iron-binding capacity (TIBC/UIBC) is not an iron-status result.
- *Only a hold.* A lab hold moves a step into `held` (so `complete` refuses it and its phase cannot advance); it never
  releases anything. The workforce preview has no owner, reads nothing and carries no lab holds.
- *Bound revision.* `planRevision` is the inventory revision plus `:labs:` and a digest of every reading, its revision
  or attestation, and the `lab_history` consent revision. An accept made against an older view of the results is
  refused as `program_review_stale`.
- *No purchase action.* The consumer read returns no purchase destination for any program step (the adapter already
  withholds every authored link, Codex `ea91196c`), and a lab-held step is never in `add`.

**Evidence.** `src/server/clinical-core/production-program-assignments.database.test.ts` (the 106-migration production
artifact plus the two lab candidates and this candidate, through the API role, fictional only) — high ferritin with
an iron step; missing, personal-only, accepted-but-unattested and refuted readings; conflicting readings; a normal
verified result; a non-iron nutrient; stale revision and consent withdrawal; cross-owner and cross-patient readings;
the preview. **Failing before: 9 of 20 against the unchanged candidate** (7 new cases, 2 revision-format cases).
Mutation checks: dropping the clinic readings fails 4 cases; dropping the patient filter fails the cross-owner case.
V2: `__tests__/program-service-lab-holds.test.ts` and one mounted case in `__tests__/program-screen-journey.test.tsx`
— **failing before 9 of 53** on `1ec928da`.

**Open, not decided here.** (1) Nothing releases a lab hold: a clinician release bound to the readings it reviewed is
a clinical-policy decision for Brandon, and until it exists a person with any high iron-status reading in history
keeps the iron step held. (2) The Fullscript product action (`fullscript-consumer-action/2`) is product-scoped, not
program-step-scoped: when consumer purchase is released, a request made from a program step should name the
enrollment and step so the server can re-run this review before issuing it. Neither is reachable today
(`CONSUMER_PURCHASE_RELEASED` is false).

## Work package 2 — trustworthy verification and transfer

**Reviewer attestation** (`infra/aws-clinical-core/production-candidates/lab-observation-attestation.sql`, BLOCKED):

- One reviewer's signed-in statement (`lab-reading-attestation/1`) that the **measured value** of one clinic reading
  matches the laboratory report they compared it with. The reviewer restates marker, value, unit and draw time; the
  server compares them with the stored reading exactly (`lab_attestation_mismatch`). The document digest must be one
  the transfer recorded the reading was read from (`lab_attestation_document_mismatch`); a reading with no recorded
  document — every lab-result/1 import, and owner-entered or personally imported readings — is refused
  (`lab_attestation_document_unknown`). That refusal is deliberate, not a gap to work around.
- No client "verified" boolean, no signature field, no range, no status: the request is a closed object and any of
  those is refused (`lab_attestation_invalid`). The reviewer is the authenticated workforce actor with a clinical
  role (owner, admin or practitioner) in that clinic now; the role is recorded. A consumer, staff without a clinical
  role and another clinic are refused. No reviewer signature is invented anywhere.
- Scope is `measured_value` only and `rangeVerified` is always false: no recalled or analyzer range is ever marked
  verified.
- Append-only, with compare-and-set supersession: one root per reading; a later attestation must name the current one
  (`lab_attestation_stale` otherwise); a `refuted` attestation ends verification; history is newest first; updates and
  deletes are refused. A later rejection of the reading also ends verification. Retries are idempotent by request id.
- The measured fields of import events and clinic readings become immutable, so the binding cannot drift.
- The attestation row is the audit record. The file deliberately does not restate `clinical_audit.events`' action list:
  `clinic-record-privacy.sql` and `telehealth-chart-lifecycle.sql` already each restate the whole list, so whichever
  of those two is applied second silently drops the other's additions. **Finding for Codex: reconcile those two
  restatements at registration.**
- `src/server/clinical-core/lab-observation-attestation.ts`: a default-disabled adapter whose activation evidence must
  name both lab candidates' exact digests; nothing routes to it.

**lab-result/2** (`src/contracts/labResultTransfer.ts`, byte-identical in V2; candidate
`infra/aws-clinical-core/production-candidates/lab-result-transfer-v2.sql`, BLOCKED):

- Carries the origin (`uploaded_report_analysis`, `owner_entered`, `personal_import`), the SHA-256 of each uploaded
  report the reading was read from (required for an uploaded report, absent otherwise), and the analysis's own mark as
  `reportedVerification` — a claim. The server records `verification: 'needs_human_review'` for every reading.
- **No status of any kind.** Every object is strict; `sourceStatus`, `status`, `flag`, `interpretation` and a
  `verified` boolean are refused by the contract and by the SQL. `source_status` is always null for a /2 row. An app
  or analyzer "critical" therefore cannot become a laboratory-issued flag through /2.
- **Not accepted.** `LAB_RESULT_TRANSFER_V2_ACCEPTED` is false: the identity API answers `409
  lab_result_v2_not_accepted` before any database work, and V2's journal keeps sending /1 (its schema refuses a /2
  payload). `importLabResultV2` and `record_lab_import_v2` exist for review and are tested against the candidate.
- **Legacy /1 stays readable and unverified.** `lab_import_provenance` (and `legacyLabTransferProvenance` in the
  contract) report a /1 row as `origin: not_recorded`, no documents, `needs_human_review`, and name its stored status
  `appAssessment`, never `laboratoryFlag`.
- **The legacy V2 backfill is removed** (V2 `a9ab1cd`): `lib/sync/lab-result-backfill.ts` sent the app's own marker
  status as the laboratory's `sourceStatus` and nothing called it; its only sender, `importAwsLabResult`, went with it.
  A guard test keeps lab transfers to the journal and the shared contract.

**Evidence.** `src/server/clinical-core/lab-verification-candidates.database.test.ts` (33 cases on the production
artifact), `src/contracts/labResultTransfer.test.ts`, the identity API case in
`src/server/clinical-core/aws-identity-api.test.ts`. Mutation checks: removing the value comparison, admitting a
`sourceStatus` key or skipping the stale check each fails its cases. V2: `__tests__/lab-result-transfer-v2.test.ts`
and `__tests__/legacy-lab-backfill-removed.test.ts` — **failing before** on `1ec928da` (no contract; both legacy files
present).

**Open.** Turning /2 on needs the uploaded documents' recorded checksums at send time (the job's document list carries
them; V2's builder takes them as input and refuses without them) and a reviewer surface that shows the reading and
computes the digest of the document the reviewer holds. A reading the clinic holds on paper, with no transferred
document, has no attestation path in this design; that is a decision, not an omission.

## Work package 3 — Desktop browser acceptance runner

Separate branch `claude/browser-acceptance-runner-20261013`; details in that branch's
`docs/claude-browser-acceptance-runner-2026-10-13.md` and its `CLAUDE.md`.

**Four defects, each measured before it was repaired** (evidence, experiments and the reproduction table are in the
runner document):

1. `next start` is a deployed runtime and refuses the loopback fixture — correctly; 45 live specs failed in both
   orders at `ea91196c`. The battery runs on `next dev`; the refusal in `src/server/runtime/contractFixture.ts` is
   unchanged.
2. The runner froze its own server: a synchronous Playwright child stopped it draining `next dev`'s blocking stdout,
   so the server stopped mid-write (reproduced: a synchronous child stalls at request 172; an asynchronous one answers
   4,000 of 4,000). Codex found the same defect independently; Playwright now runs as an asynchronous, bounded child.
3. The server ran itself out of memory: recompile churn plus React 19.2's development async-debug hook (bundled in
   Next 15.5) grew the worker heap 1.5 → 7.6 GiB in 26 minutes until Next restarted its own worker mid-test. Repair:
   the whole app (293 entries plus Next's not-found and error pages) is compiled once per server in about 13 batched
   compilations and kept compiled (`E2E_DEV_SERVER=1` only), and that one hook is left off in the harness's server
   only. Measured: retained heap flat at about 2–2.5 GiB, no restart; a worker restart now fails the battery.
4. The "reverse order" was not reversed — Playwright sorts collected files (found by Codex, `a24ecc28`). Numbered
   aliases now force each order, proven with `--list` before any browser starts, and each order gets a fresh server.

**Result.** Locally verified at runner `575e0908` (the runner branch merged with Codex's `f97bb2d8`): forward
(`aws-recording-capture` → `zoom-sdk-bootstrap`) and truly reversed order, each proven with `--list` and each on a
fresh server that compiled the app first — **318 passed in both, the same 318 by identity, 0 failed or did not run, 99
declared skips not counted**, Playwright exit 0 both times, no worker restart, retained heap at most 2,289 MiB, the
longest in-test event-loop delay 321 ms, canary worst 1.16 s (29.9 s before the repair), `check:stub-reset` PASS; 43
minutes, build included. No genuine application failure was found: every observed failure traced to the runner, the
development server or the unreversed order. Earlier runs in this work package that reported a "reverse order" ran the
same order twice (defect 4) and are not order evidence.

**LensPanel honest state** (separate fix, merged with Codex's parallel repair): completion is announced only after
the run's own readback confirms the exact saved evaluation; loads are sequenced; a lost POST reply ends "Running…".
`e2e/live-lens.spec.ts`: failing before 1 of 6; 8 of 8 after merging Codex's `8a998736` (focused run, debugging
only); its nine tests after `f97bb2d8` are counted in the full battery's result above, not separately.

Statuses: implemented and locally verified as above; CI verified for the runner branch head (run below); the full
battery is not a CI job (Codex's call); not hosted, device or PHI qualification.

## Candidates and digests

| Candidate | LF SHA-256 | Pinned by |
| --- | --- | --- |
| `production-candidates/lab-result-transfer-v2.sql` | `fa6ee162a03a85ab23543371d9d1dbaf8ee6dd486b4a8cc64b5545fc16be3b94` | `LAB_RESULT_TRANSFER_V2_CANDIDATE_SHA256` |
| `production-candidates/lab-observation-attestation.sql` | `d0423bcec5067a668f3522bbba65d096f642f083c1ef95448da190b38494bb83` | `LAB_OBSERVATION_ATTESTATION_CANDIDATE_SHA256` |
| `production-candidates/production-program-assignments.sql` | `78bd5b3805d96443829f6e7380deba0d66ad2f03073374bd6681f4f6bc25b4f3` | `PRODUCTION_PROGRAM_SCHEMA_CANDIDATE_SHA256` |
| `src/contracts/labResultTransfer.ts` (mirror) | `fc4ec19fc5b8bb06db6b11206906a5b4fa96b7041b591fd654f23f3a20f8cbcb` | both suites |
| `src/contracts/programAssignments.ts` (mirror) | `96c2adb19703d3dcb3ca78c63f444d1eb936f8975839b5723ccc033b6336e62d` | byte-identical copies |

## Ordered hand-back to Codex (AWS execution is Codex's)

Nothing here may be run against production, and nothing activates by being applied: every activation row stays
disabled until a separately reviewed change enables it.

1. **Verify the bytes.** For each candidate, `sha256sum` (LF) must equal the table above and the constant that pins it.
   A mismatch means the reviewed file is not the file in hand.
2. **Reconcile the audit restatements first** (independent of this work): `clinic-record-privacy.sql` and
   `telehealth-chart-lifecycle.sql` each restate `clinical_audit.events_action_check` in full; register them so the
   second keeps the first's additions. The lab candidates do not touch that constraint.
3. **Register in this order**, after the 106-migration production artifact: `lab-result-transfer-v2.sql`, then
   `lab-observation-attestation.sql`, then the revised `production-program-assignments.sql` (it calls
   `clinical_private.lab_observation_verified`). Re-run against the registered artifact:
   `npx vitest run src/server/clinical-core/lab-verification-candidates.database.test.ts src/server/clinical-core/production-program-assignments.database.test.ts`
   (expect 33 and 20 passing; PGlite, fictional only).
4. **Synthetic qualification only.** On the synthetic/staging target, with fictional personas: an iron step beside a
   high ferritin is held with `measured_above_range`; a personal-only or unattested normal reading still holds
   (`status_not_verified`); an attested normal reading leaves the step as the plan decides; an accept against an older
   plan revision is refused `program_review_stale`; another person's readings never change the review. Record each as
   hosted evidence with the exact commit; none of it is production acceptance.
5. **Identity API.** The next identity-API artifact built from `1564e7f47190eb388c8c3ada81235521be054b54` or later refuses
   `POST /clinical-core/consumer/labs/import` with a `lab-result/2` body as `409 lab_result_v2_not_accepted` before any
   database work; `/1` is unchanged. V2 never sends `/2` while its gate is off, so this is inert in practice; verify both
   on the synthetic stage.
6. **Activation, later and separately**, each with evidence naming the pinned digests and Brandon's decisions:
   the clinician release path for lab holds; a reviewer surface that shows the reading and digests the document the
   reviewer holds; the V2 sender reading a job's recorded upload checksums for `/2`; binding a future purchase action
   to the program step so the server re-runs this review. Until then the production program family, the attestation
   and `/2` stay disabled.
7. **Browser battery.** Merge `claude/browser-acceptance-runner-20261013` (it already contains `f97bb2d8`). The command
   is `PW_CHROMIUM_PATH=… npm run test:e2e:order` (set `E2E_DEV_HEAP_MB` on a smaller runner; 10,240 MiB is the
   default because 12,288 plus the 4 GiB reserve exceeds a 16 GiB runner — reconsider Codex's 12,288 there). Whether to
   add it as a scheduled or pre-release CI job is Codex's call: one run is two fresh servers, each compiling the app
   (~3.5 min) and running every spec (~17 min). CI's sharded live-fixture job stays the per-push gate.

## Graphify (vault unavailable; append-ready text, the map was not updated)

```
## 2026-10-13 · Lab safety, provenance and browser acceptance (Claude)
- [[Program assignments (production family)]] —reads→ [[Owned lab history]] (lab_history consent; never verified)
- [[Program assignments (production family)]] —reads→ [[Clinic lab observations]] (enrolled patient record; verified only by attestation)
- [[Program assignments (production family)]] —emits→ [[program-lab-review/1]] (labHolds: itemId, nutrient, reason, clinician_review; holds only)
- [[program-lab-review/1]] —accepted by→ [[V2 My Programs]] (service hold is the authority; device rule program-lab-safety/1 is a second safeguard that never releases)
- [[Program planRevision]] —binds→ digest of readings + attestations + lab_history consent (stale accept refused)
- [[Lab observation attestation]] (BLOCKED, lab-reading-attestation/1) —binds→ marker, value, unit, draw time, document digest, reviewer role; measured value only; rangeVerified=false; append-only CAS supersession
- [[lab-result/2]] (BLOCKED; gate LAB_RESULT_TRANSFER_V2_ACCEPTED=false) —carries→ origin, document digests, app mark as claim; never a status or laboratory flag
- [[lab-result/1]] —stays→ readable, unverified; stored status named appAssessment
- [[Legacy lab backfill]] —removed in→ V2 a9ab1cd (sent app status as the lab's sourceStatus)
- [[Order battery]] —runs on→ next dev + contract fixture (next start refuses the fixture by design); accounting by test identity; declared skips not counted
- [[Order battery]] —was frozen by→ [[Synchronous Playwright child]] (blocking Next stdout undrained; repaired: async bounded child)
- [[Order battery]] —was restarted mid-test by→ [[next dev memory threshold]] (recompile churn + React 19.2 dev async-debug hook; repaired: whole app compiled once per server and kept, hook off in the harness only)
- [[Order battery]] —reversal enforced by→ [[Ordered spec aliases]] (Playwright sorts collected files; --list proves order; Codex a24ecc28)
- Open decisions: clinician release of lab holds; reviewer surface; /2 sender document checksums; purchase action bound to program step; audit constraint restatement conflict (clinic-record-privacy vs telehealth-chart-lifecycle)
```
