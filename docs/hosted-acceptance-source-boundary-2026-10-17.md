# Hosted acceptance source boundary (2026-10-17)

**Source only. Nothing hosted was run.** Every test below drives the real acceptance libraries, the real CLIs and the
real manifest observer over a **fictional** transport: fictional account `111122223333`, fictional stacks
`fictional-qualification-*`, commit `a…a`. A local test over a fictional transport is **not hosted evidence**. No AWS,
Fly, Cognito, SES, Stripe or Fullscript call; no SQL; no credentials; no PHI. Branch
`claude/desktop-acceptance-observation-20261017`, base `c327e9ae4a77d68fd705d9de6443443c17157c45`.

This closes the two residuals in `docs/codex-hosted-qualification-packet-2026-10-17.md` §6 for the shared-manifest
Desktop CLIs (recording, export-retention, voice-shutdown):

- no dirty-tree check;
- one stack observation before the run, so a mid-run redeploy was not caught.

It also decides how an unmarked 401/403 counts, and makes the care-messaging inspector's `not_deployed` unusable as an
acceptance precondition.

## 1. What changed

### The source boundary (`qualification-target-boundary.ts`, `qualification-target-observation.ts`)

- **`observeAcceptanceBoundary`** is one observation at a safe boundary:
  1. `git status --porcelain --untracked-files=all` must print nothing. Otherwise `target_source_dirty:checkout`,
     before any AWS call.
  2. Then the existing `observeQualificationTarget`: HEAD equals the manifest's `sourceCommit`, STS is an assumed role
     in the manifest's account, the foundation checks, and every candidate stack the run depends on.
  3. `SOURCE_COMMIT` or `OBSERVED_AWS_ACCOUNT_ID`, when set, must equal what was observed. Otherwise
     `target_source_mismatch:asserted` or `target_account_refused:asserted`.
- **Every stack read is fingerprinted**, the foundation included. The fingerprint is a SHA-256 over the canonical
  StackId, status, CreationTime, LastUpdatedTime, and every output and parameter. Any CloudFormation update moves
  LastUpdatedTime, so a redeploy of the **same** commit (a new `CodeVersion`) is still a change.
- **Two boundaries per run.**
  - *Before*: in the CLI, before the first fixture write or request.
  - *After*: inside the library's `finish()`, after the last request. That is after the voice run's second inventory
    read and the export run's scheduled-removal observation, and also on every early stop.
- **`closeAcceptanceBoundary`** never throws, because the report is always written:
  - `unchanged`: both observations succeeded and agree;
  - `changed`: lists the candidates that differ (or `source`, `account`, `foundation`); refusal `target_changed_mid_run`;
  - `refused`: the closing observation itself refused. Examples: a stack in `UPDATE_IN_PROGRESS`, from another commit
    or gone; a dirty tree; a moved HEAD. The refusal is the category, e.g. `target_stack_refused:owned-voice`;
  - `not_observed`: exploratory mode, or a library call with no boundary.
- **The boundary is part of the report** (`sourceBoundary`), so it is covered by `evidenceSha256`.
- **The recording run's two commands must see one deployment.**
  - `fixture` prints `boundary` (the digest of its observation).
  - The wrapper hands it to `run` as `CLINICAL_RECORDING_FIXTURE_BOUNDARY`.
  - `run` refuses a different deployment with `target_changed_between_steps:fixture`, before its first request.

### The verdict

- **`ok` is false** when any of these holds:
  - a mandatory step was answered only by unmarked denials (§2);
  - the observed boundary is `changed` or `refused`.
- **`qualified`** (new, top-level) is `mode === "acceptance" && ok && sourceBoundary.state === "unchanged"`.
  - Exploratory runs are never qualified.
  - A library call without a boundary is never qualified either.
- **CLI exit status.**
  - Acceptance mode exits 0 **only** when `qualified`.
  - Exploratory mode keeps its old rule (`ok`). It still observes nothing, takes asserted values, and prints
    `qualified:false`, `target.source:"asserted_by_caller"` and `sourceBoundary.state:"not_observed"`.
- **Each CLI line now prints** `qualified`, `unverified` and the boundary summary (state, changed, refusal, both
  digests).

### Wrappers

- `qualification-target-verify.ps1` gains `Assert-QualificationCleanCheckout`. The export, recording and voice wrappers
  call it in acceptance mode only, after the HEAD check and before STS.
- The recording wrapper refuses a fixture that prints no boundary. Otherwise it passes the fixture's boundary to the
  run, and clears it in `finally`.

### The care-messaging inspector

- **Inventory is unchanged.** Without `--acceptance`, a missing stack still prints `status:"not_deployed",
  acceptance:false` and exits 0.
- **`--acceptance` is new.** It must be given once and needs `--binding=`; otherwise `argument_refused`, before AWS.
  `careInspectionOutcome` then decides the result:
  - `not_deployed` exits 1 with `candidate_not_deployed`;
  - any report other than `deployment_bindings_verified` exits 1 with `deployment_not_verified`. That covers another
    head, one claiming a mutation, PHI or acceptance, and a missing report;
  - a verified deployment prints `acceptancePrecondition:"deployment_bindings_verified"`, still with
    `acceptance:false, humanReviewsVerified:false`. It is a precondition, never acceptance.
- There was no care-messaging acceptance wrapper to change. `--acceptance` is the only way one may consume the
  inspector.

## 2. The decision on unmarked 401/403

**Why an unmarked denial proves nothing.** API Gateway's JWT authorizer answers 401/403 before any function runs. It
answers an expired, malformed or foreign-pool token the same way it answers the identity under test.

So an unmarked denial cannot say:

- which code refused;
- why it refused;
- whether the token was even valid.

**The rule.** An unmarked 401/403 is **unverified evidence**, never qualification evidence and never production
evidence. It still never classifies a run's execution, as before.

- **Per step.** Each step now records `evidence`:
  - `qualification`: at least one answer carried the marker;
  - `production`: unmarked answers that are not denials;
  - `mixed`;
  - `unmarked_denial`: every answer was an unmarked 401/403;
  - `none`: no answer at all.
- **The verdict.** A mandatory step that passed with `evidence:"unmarked_denial"` is listed in `unverified`, and `ok` is
  false while any remain.
  - The step's own outcome and detail are kept as recorded: the refusal happened, but the evidence for it is unverified.
  - `unmet` is unchanged.

**Consequences, stated plainly:**

| Runner | Step | Hosted reality | Result |
| --- | --- | --- | --- |
| Export | cross-owner read refused | The workforce token is refused at the consumer authorizer (unmarked). The second consumer is admitted, then refused by the owner check (**marked**). | Verified by the marked owner-check answers. An expired second-consumer token (all unmarked) is now `unverified` instead of a pass. |
| Export | stale sign-in download refused | The candidate answers `401 reauth_required` (marked). | An unmarked 401 (an expired token at the authorizer) is now `unverified`. |
| Recording | consumer token refused on workforce recording routes | The workforce JWT authorizer refuses the consumer token: three unmarked 401s. | **Always `unverified`. Recording acceptance cannot qualify** until the policy hold in §5 is decided. |
| Voice | drain refuses another identity the same way | The consumer authorizer refuses the workforce token, unmarked. | **Always `unverified`. Voice acceptance cannot qualify** until the same hold is decided (unless the drain function itself answers the workforce token). |

**What a step-level rule leaves.** A step with any marked answer is attributed to the candidate. Export's step 3 is
verified by the second consumer's marked refusals, while its workforce half is still gateway evidence. That is stated
here, not hidden.

**One existing assertion changed.** In `voice-shutdown-acceptance.test.ts`, "consumer authorizer denial of a workforce
token is distinct from the consumer drain refusal" asserted `ok` `toBe(true)` for a run whose cross-identity step had
only an unmarked 401/403.

- That assertion pinned the gap this package closes. It now asserts `ok:false` and
  `unverified:["drain refuses another identity the same way"]`.
- It keeps the step's `outcome:"passed"` and `detail:"workforce_denied_by_consumer_authorizer"`. The refusal is not
  recategorized.
- No other existing assertion changed. No timeout was lengthened.

## 3. Findings

| # | Finding | Label | Evidence |
| --- | --- | --- | --- |
| F1 | The acceptance CLIs and wrappers accepted a dirty or untracked working tree at the right HEAD. | **Failing-before defect** | `qualification-acceptance-cli.test.ts` "a dirty checkout is refused…": before, the recording run proceeded to the API. PowerShell probe: "export acceptance from a dirty checkout did not refuse … got none". |
| F2 | One observation before the run, so a redeploy, a stack left updating, or a checkout edited mid-run still produced a passing verdict. | **Failing-before defect** | CLI "a redeploy in the middle of the run…": before, exit 0 with `ok:true`. "a stack left updating…": before, exit 0. |
| F3 | An asserted `SOURCE_COMMIT` or `OBSERVED_AWS_ACCOUNT_ID` that disagreed with the observation was silently ignored in acceptance mode. The export CLI's own comment says it is refused. | **Failing-before defect** | CLI "an asserted SOURCE_COMMIT or account…": before, both runs reached the API. |
| F4 | The recording fixture and run observed separately, with nothing binding them. A stack changed between them went unnoticed. | **Failing-before defect** | CLI "a stack that changed between the recording fixture and the run…": before, the fixture printed no boundary and the run reached the API. |
| F5 | A mandatory step answered only by unmarked 401/403 counted as a pass in acceptance mode. | **Failing-before defect** | Probe of the unchanged libraries (`wp2-failing-before-probe.log`): recording consumer-token step, export second-consumer step and export stale-sign-in step each `ok:true`. Voice CLI "the hosted shape of the cross-identity drain step…": before, exit 0. |
| F6 | Stale commit and missing stack are refused before any request. | **Coverage of already-correct behaviour** | CLI "a stale checkout…" and "a missing candidate stack…" passed before and after. |
| F7 | Skipped mandatory cases and a missing execution marker fail the run. | **Coverage of already-correct behaviour** (the exit status); the new `qualified:false` field | CLI "skipped mandatory cases and a missing execution marker…". Before, exit 1 and `ok:false` already matched; it failed only on the new `qualified` and `sourceBoundary` fields. |
| F8 | Exploratory mode stays non-acceptance and observes nothing. | **Coverage**, plus the new explicit `qualified:false` | CLI "exploratory mode keeps…". Before, exit 0, `ok:true` and `asserted_by_caller` already matched; only the new fields were missing. After, no git or AWS call at all, even on a dirty tree. |
| F9 | Care inspector: `not_deployed` exits 0, and nothing an acceptance wrapper could call refused it. | **Policy gap closed in source** (no wrapper consumed it yet) | `care-messaging-qualification-observer.test.mjs`: before, the suite failed at import (`careInspectionOutcome` absent) and `--acceptance` was `argument_refused`. |

## 4. Failing-before and passing-after

All logs are in `/tmp/claude-0/-home-user/66320678-ef33-50b0-bb92-9936dae56d06/scratchpad/agents/`. The tests were
written first and run on the unchanged implementation at base `c327e9ae` (tests-only working tree).

| Suite | Before (unchanged implementation) | After |
| --- | --- | --- |
| Vitest: execution, observation, recording, export, voice, CLI | `wp2-failing-before-vitest.log`: **20 failed, 28 passed (48)** in five loadable files. `qualification-target-observation.test.ts` failed to load (the boundary module was absent), so its 8 new tests did not run. The 2 CLI tests that passed are F6 (coverage). | `wp2-after-vitest.log`, with the load, manifest, operator and target suites added: **10 files, 90 passed, 0 failed** |
| Care observer (`node --test`, both files) | `wp2-failing-before-care.log`: the messaging file failed at import. Baseline before the new tests: 75 passed. | `wp2-after-care.log`: **77 passed, 0 failed** |
| PowerShell runner test (pwsh 7.4.6, credential-free) | `wp2-failing-before-ps.log`: stopped at "recording runner did not hand the fixture boundary to the run". `wp2-failing-before-ps-dirty.log` (a temporary copy without that check, then deleted): "export acceptance from a dirty checkout did not refuse". Baseline: 75 cases. | `wp2-after-ps.log`: **83 cases passed** |
| Behavioural probe of the unchanged libraries | `wp2-failing-before-probe.log`: three `ok:true` lines (F5). These were temporary test files, deleted after the run. | Covered by the passing tests above |

**New tests:**

- `qualification-execution.test.ts`: +1;
- `qualification-target-observation.test.ts`: +8;
- `recording-acceptance.test.ts`: +5;
- `export-retention-acceptance.test.ts`: +3;
- `voice-shutdown-acceptance.test.ts`: +1, and 1 assertion changed (§2);
- `qualification-acceptance-cli.test.ts`: +11. This file is new. It imports the three real CLI entry modules and
  replaces only the process boundary: `execFileSync` (git and aws, answered by the fictional deployment), the report
  write, the RDS Data client, the fixture provisioner, the voice inventory reader and `fetch`;
- care: +2;
- PowerShell: +8 cases.

**Shared fixture.** `testing/qualification-target-fictional.ts` (fictional manifest and deployment) is imported only by
tests, and is absent from the built bundle.

**Checks, all under the shared lock:**

- `npm run typecheck`: exit 0;
- `eslint` on every changed file: exit 0;
- `npm run build:aws-deployment-tools`: exit 0. The three bundles contain the boundary.

## 5. Holds (not closed here)

1. **Policy hold: cross-pool authorizer refusals.** In a correct deployment two mandatory steps can only ever be
   `unverified`: recording's consumer-token step and voice's cross-identity step. So those two runners cannot produce a
   qualified verdict, and they will exit 1 with that step listed. Unblocking them is a reviewed decision for Brandon
   and Codex. One option is to observe the route's authorizer configuration (`apigatewayv2 get-routes` and
   `get-authorizer`, the issuer and audience, as the care inspector does) **and** anchor the token: the same token
   answered with the marker on its own pool's route in the same run. **Neither is implemented.** I cannot see API
   Gateway's real answer here, and modelling it would be a fake contract.
2. **Hosted hold: changes outside CloudFormation.** Stack fingerprints do not show the following:
   - function code replaced directly (`update-function-code`);
   - an environment edited in place;
   - routes or authorizers edited outside the stack;
   - a change made and fully reverted outside CloudFormation between the two reads.

   Reading Lambda `CodeSha256`/`RevisionId` needs the operator role's permissions reviewed first. Two reads are not an
   atomic snapshot.
3. **Operational.** The assumed-role session must outlast the run, including an export run's scheduled wait of up to
   180 minutes. An expired session makes the closing observation refuse, so the run fails closed and does not qualify.
4. **Not changed:**
   - **The load runner** (`load-qualification-target.ts`) still observes once. Its evidence is refusal-only
     (`positiveClinicalAcceptance:false`).
   - **The stale-sign-in step** accepts any **marked** 401; it does not check the body for `reauth_required`.
   - **The older docs** `docs/hosted-recording-acceptance.md` and `docs/aws-qualification-target.md` are outside this
     package's files. This doc supersedes them on the boundary and the unmarked-denial rule.
5. **Nothing here is hosted evidence.** The PowerShell test ran locally under a downloaded pwsh. CI's two pwsh steps
   have not yet run it at this head.

## 6. Codex steps (in order; nothing here was run against AWS)

Run these only from a machine that can inspect the target: STS as an assumed role in the synthetic account, read access
to the stacks, and a clean checkout. **Do not run credentialed hosted tests from a container that cannot inspect the
target.**

1. **Clean checkout.**
   - Check out the exact commit of the selected Desktop code pair, once it includes this branch.
   - `git status --porcelain --untracked-files=all` must print nothing.
   - Keep the filled qualification manifest **outside** the checkout. An untracked manifest inside it is refused as dirty.
2. **Run `pwsh ./scripts/test-qualification-acceptance-runners.ps1`.** It is credential-free. Expect `83 cases passed`.
3. **Negative checks, each refusing before any request.** Record each refusal.
   - **Dirty checkout.** Touch any untracked file, then run
     `./scripts/run-aws-export-retention-acceptance.ps1 -QualificationTargetPath <filled> -DeploymentManifestPath <reviewed> -ConfirmSyntheticOnly`.
     - Expect `qualification_target_refused:source_dirty`, with no AWS call.
     - Remove the file.
   - **Stale checkout.** Check out the predecessor commit and run the same command. Expect
     `qualification_target_refused:sourceCommit_checkout`.
   - **Asserted commit disagrees.** Run the CLI directly with `SOURCE_COMMIT=<predecessor>`
     (`node dist/aws-clinical-core/deployment-tools/exportRetentionAcceptance.js`). Expect
     `{"ok":false,"error":"target_source_mismatch:asserted"}`.
   - **Care inventory versus acceptance.**
     - Run `npm run inspect:aws-care-messaging-qualification -- --acceptance --binding=<reviewed binding>`. With the
       candidate absent, expect stderr `candidate_not_deployed` and exit 1.
     - Without `--acceptance`, `not_deployed` with exit 0 is inventory. Record it as **unobserved**, never as a pass.
4. **Hosted runs.** Only after checkpoint Q0 (packet §7, step 7): candidates redeployed from that commit, and
   `observeQualificationTarget` passing.
   - Do not deploy anything while a run is in progress.
   - Run each wrapper in acceptance mode:
     - **Export.** Can qualify only if all 12 steps pass on attributable evidence and `sourceBoundary.state` is
       `unchanged`. This includes the scheduled sweep and a stale token that is genuinely stale.
     - **Recording.** Expect exit 1 with `unverified:["consumer token refused on workforce recording routes"]` (hold 1).
       Record the refusal.
     - **Voice.** Expect exit 1 with `unverified:["drain refuses another identity the same way"]` (hold 1). Record the
       refusal.
5. **Read the report under `dist/qualification`.**
   - Any `sourceBoundary.state` other than `unchanged` is a refusal: `changed`, `refused` or `not_observed`.
   - Any `qualified:false` is not acceptance.
   - Do not edit a report to pass, and do not rerun until the deployment is quiet.
   - Record `sourceBoundary.before.sha256` and `after.sha256` with the row.
