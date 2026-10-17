# Hosted program evidence: observed, not asserted (2026-10-17)

**This is a hand-back, not authorization.** Nothing here was deployed, applied, registered or switched on:

- no AWS, Cognito, Fly, SES, Stripe or Fullscript call, read or write;
- no SQL applied;
- no PHI, and every identity, commit and digest in the tests is fictional (or a stale value already pinned in source);
- no purchase, real or simulated.

I hold no AWS credentials. **Nothing below was observed on a hosted target.** A fictional transport is not hosted
evidence, and the code enforces that (§3.5).

This is the Desktop half of work package 4. The V2 billing harness is someone else's package.

## 1. What changed

| File | Change |
| --- | --- |
| `scripts/hosted-program-acceptance-observation.mjs` | **New.** A read-only observation adapter: the stack-advertised source, the live `CodeSha256`, the issuers, and every answer's qualification marker. Also the write ledger. |
| `scripts/hosted-program-acceptance.mjs` | **New.** The acceptance evaluator, the session that gates a run, the program assignment journey, and a read-only command. |
| `scripts/hosted-program-acceptance.test.mjs` | **New.** 36 tests with fictional adapters. |
| `scripts/verify-synthetic-program-routes-hosted.mjs`, `scripts/verify-settlement-hosted.mjs`, `scripts/qualify-aws-daily-guidance-hosted.mjs` | **Header comment only.** Each now says SMOKE, says it is not acceptance evidence, and names the acceptance path. The body of each, which is all of its logic and its printed output, is byte-identical to base `c327e9ae` (a test pins the digests). |
| `package.json` | `test:hosted-program-acceptance`. |
| `.github/workflows/ci.yml` | One step in the `checks` job, after `test:synthetic-care-release`. |

## 2. Findings

| # | Label | Finding |
| --- | --- | --- |
| F1 | failing-before → passing-after | **No acceptance path existed for the program and settlement routes on `wxv734oi12`.** Only the smoke scripts existed. Nothing compared the stack-advertised source or the live code digest with the reviewed pair, or checked the marker. Nothing told created, reused and skipped writes apart. The new evaluator refuses each case named in the package; one test per case (§4). |
| F2 | failing-before → passing-after | **The smoke scripts were not labelled as smoke.** The settlement script's header said "Real JWT/Data API synthetic acceptance". The daily-guidance script had no header. The program script said "smoke" but not that its pass is not acceptance evidence. They are labelled now. Their output is unchanged, including the settlement script's `apiAcceptance: true` field. |
| F3 | **hold** | **The API the smoke scripts call never emits the qualification marker.** `wxv734oi12` runs `src/server/clinical-core/aws-identity-api.ts`, through `aws-identity-lambda.ts`. Neither file mentions `x-clinical-execution` or `markQualificationResponse`. The handlers that mark answers are the qualification candidates (`qualification-program-api.ts`, `production-care-messaging-api.ts` and others). So any acceptance run against `wxv734oi12` stops before its first write with `execution_not_qualification`. That refusal is correct. It lifts only in one of two ways, and both are outside this package: a reviewed source change that marks the identity API's answers, or running journey 5 on the qualification program API (`6zt8e9qz04`). That API is undeployed as far as source shows: its preflight requires that no `/programs` route exists yet. I did not observe it. |
| F4 | **hold** (mechanism explained after review) | **The identity bundle digest in the packet is not a valid pin.** At HEAD (`src/` identical to `8bfe2349`), `buildCareIdentityBundle` produced 1,950,986 bytes, SHA-256 `546d962fc542dd504351f965f11301c047f37f60b5e6731804e2d0d93b34ac29`; the packet named 1,980,414 bytes, `24a65189…`. **Mechanism, reproduced on integration review:** the unminified bundle keeps one `// <path>` comment per module, relative to the build root. 564 of the 738 modules sit in a symlinked `node_modules`, so their paths depend on how deep the root is. The same `8bfe2349` source gives `24a65189…` from the packet's deep scratch root (`// ../../../../../../../home/user/AI_DESKTOP_PRO_NOTIFY/node_modules/…`) and `546d962f…` from `/home/user/<dir>` (`// ../AI_DESKTOP_PRO_NOTIFY/node_modules/…`). That accounts for the 29,428-byte gap. Neither value is the digest of a reviewed build. `REVIEWED_SOURCE_PAIR` now leaves the digest unpinned (`null`), and every artifact refuses `reviewed_bundle_unpinned` until a clean `npm ci` build of the reviewed commit records its digest in a reviewed change. Acceptance never compares the live code with an ad-hoc local rebuild. |
| F5 | coverage | **The packet's §6 gaps are still in the smoke bodies,** and a characterization test holds that. In the program script, `deployedSourceCommit` is declared at `:23` and only printed at `:452`; there are 2 occurrences and no comparison. It has no marker check. It prints `fictionalFormCreatedOrReused:true`, one field for two outcomes. It has one unconditional `verdict:'pass'`, and its create-or-reuse branches start at `:112`, `:178`, `:236`, `:253`, `:270` and `:343`. The settlement script reads `dist/settlement-qualification/deployment.json` (`:26`) and copies its `sourceCommit` into the evidence (`:117`). The daily-guidance script has no source, stack or marker check. Its model-path check trusts `provenance.provider` from the answer body (`:123`). |
| F6 | inferred, **unobserved** | **The program smoke may not run against today's deployment at all.** At `:43` it requires `LambdaCodeKey` to be the unversioned `clinical-core/authenticated-api/58f59783….zip`. If the stack carries the versioned key that `DEPLOYED_CARE` pins (`care-release/5b6f8aa4…/644967ee….zip`), the script refuses `deployed_artifact_changed` before any request. I could not observe which key is live. |

## 3. The acceptance path

### 3.1 Observation (read-only)

`observeProgramTarget(reader)` issues exactly four operations, `READ_OPERATIONS`, and refuses any other
(`read_operation_refused`):

- `sts:GetCallerIdentity`;
- `cloudformation:DescribeStacks`, for `ai-clinical-core-synthetic-staging-authenticated-api` and for its foundation;
- `lambda:GetFunctionConfiguration`, for `wxv734oi12-synthetic-identity`;
- `apigatewayv2:GetAuthorizers`, for `wxv734oi12`.

**Source.** The source comes from the stack. The versioned `LambdaCodeKey` families (`care-release`,
`care-intent-release`, `care-registered-release` and `catalog-runtime-release`) name the Desktop commit in their path.
A `SourceCommit` parameter or output, or a `SOURCE_COMMIT` function variable, is read too. Every signal present must
agree. The old unversioned `<sha>.zip` key advertises no source.

**Code.** The code digest is the function's own `CodeSha256`, decoded from base64. It is compared both with the stack's
key and with the reviewed artifact.

**Provenance.** Each observation is deep-frozen and recorded in a module-private `WeakSet`. A JSON copy, a file, or an
object edited in place is not an observation.

### 3.2 The binding (`evaluateTargetBinding`)

It refuses with these codes:

- `expected_source_invalid`: the expected source is not a 40-character lowercase commit.
- `reviewed_artifact_required`, `reviewed_artifact_invalid`, `reviewed_bundle_unpinned` (no reviewed clean-build digest is recorded yet), `reviewed_bundle_mismatch` (its `index.js` is not the pinned
  bundle), `reviewed_artifact_source_mismatch` (its `release.json` names another commit) and
  `reviewed_artifact_not_canonical` (it is not the canonical care-release ZIP).
- `observation_required`, `observation_not_from_adapter`.
- `account_refused`, `stack_not_complete`, `phi_posture_refused`, `function_not_active`, `function_code_unobserved`.
- `stack_source_unadvertised`, `stack_source_signals_disagree`, `observed_source_stale`.
- `stack_code_pointer_disagrees`: the function runs code other than what its stack points at.
- `observed_code_stale`.
- `issuer_mismatch`, `audience_mismatch`, checked on the function's environment, on each JWT authorizer, and on any
  extra authorizer.
- `deployment_claim_disagrees`, `deployment_claim_unbound`.

A caller-supplied deployment file, such as the settlement `deployment.json` or a smoke script's output, is only ever
compared with the observation. When the two agree it adds nothing. Without an observation, the file is recorded as
`unverifiable` and the binding is refused with `observation_required`.

### 3.3 The session and the run

`beginAcceptanceSession` observes and binds **before the first request**, and throws if the binding fails. Then:

- **Tokens.** `identity(role, token)` decodes the claims and refuses a wrong issuer, audience or token use, a token that
  is not synthetic-attested, or a production-bound token, before the token is ever used. The token itself is kept only
  in a closure; no report contains one.
- **Writes.** `write(step, …)` refuses before sending:
  - when any earlier answer was unmarked and not a 401 or 403 (`execution_not_qualification`);
  - when no marked answer has been seen yet (`execution_unobserved`);
  - for any purchase kind (`purchase_simulation_refused:<step>`). A purchase is never sent.
- **The end of the run.** `finish()` observes the target again. Any change between the two observations is refused as
  `target_changed_during_run`, for example a new `RevisionId` or code digest.

### 3.4 Writes: created, reused, skipped, refused

Every planned step is recorded exactly once, against an answer this run's transport observed. The outcome rules:

- **`created`** needs a marked 2xx answer. When the answer itself reports a replay (`duplicate: true` or
  `replayed: true`), the run is refused with `replay_counted_as_creation:<step>`. `classifyWrite` gives the honest
  outcome.
- **`reused`** needs a marked 2xx answer (`reuse_not_observed`).
- **`refused`** needs a 401, 403, 404, 409 or 422 answer that is not production.
- **`skipped`** carries a reason and no answer.

Each plan requirement then sets which outcomes are acceptable:

| Requirement | Accepts | Otherwise refused as |
| --- | --- | --- |
| `must_create` | `created` | `mandatory_create_not_observed` |
| `create_or_reuse` | `created`, `reused` | `mandatory_step_skipped` |
| `must_replay` | `reused`, with the server's replay flag | `replay_not_observed` |
| `must_refuse` | `refused` | `refusal_not_observed` |
| `optional` | anything | (never refused) |

These are also refused:

- `step_not_recorded`, `step_recorded_twice` and `step_unplanned`;
- `response_not_from_transport`.

`PROGRAM_ASSIGNMENT_PLAN` and `runProgramAssignmentJourney` cover four steps:

| Step | Requirement |
| --- | --- |
| Assignment | must be created in this run |
| Acceptance | must be created in this run |
| A foreign owner reading the assignment | must be refused |
| Completing a held supplement | must be refused |

On a replay, the server reports the assignment as a duplicate, so the journey records it as `reused`, and the acceptance
it then cannot perform as `skipped`. Both are refused under this plan; neither is reported as done.

### 3.5 Purchases, provider JSON and verdicts

**No purchase can be observed here,** and `purchasesObserved` is always `0`.

**Provider JSON.** `providerShaped` recognises:

- Stripe sessions and ids;
- App Store and Google Play transactions;
- Fullscript treatment plans;
- any `provider` field.

Such JSON is refused wherever it appears: as supplied evidence (`evidence_not_observed` and `provider_shaped_evidence`),
or inside an observed answer (`provider_shaped_evidence:<step>`).

**Verdicts:**

- `refused`;
- `fictional_only_not_hosted_evidence`: every check passed, but on an injected reader or transport, or on a pair other
  than one `reviewedCheckoutPair` built in this process;
- `accepted`: only with the AWS CLI reader built with its own runner, the global-fetch transport, and the reviewed pair.

### 3.6 The read-only command

```bash
node scripts/hosted-program-acceptance.mjs --observe-read-only [--reviewed-artifact=<absolute zip>] [--deployment-claim=<absolute json>]
```

The command observes the target and checks the binding. It never sends an API request and never writes. It prints
`hosted-program-target-binding/1` with `journeyAcceptance: false`, `apiRequestsSent: 0` and
`awsMutationPerformed: false`, and it exits 1 on any refusal. It refuses unknown, relative or repeated arguments before
any AWS call.

## 4. Evidence (run in this worktree; logs in the session scratchpad `agents/wp4d-*.log`)

| Check | Result |
| --- | --- |
| Failing-before: the test file against unchanged code (`wp4d-before.log`) | 36 tests: 2 pass (both coverage), 34 fail. 33 fail because the modules do not exist (`ERR_MODULE_NOT_FOUND`); 1 fails on the missing SMOKE header. |
| Passing-after: `npm run test:hosted-program-acceptance` (`wp4d-after.log`) | 36/36 pass, exit 0 |
| Mutation check (`wp4d-mutation.log`): 9 checks removed one at a time | Each mutation was caught by at least one test. Mutations: replay accepted as creation; any object accepted as an observation; every answer treated as marked; code digest not compared; stack source not compared; authorizer issuer not compared; `must_create` accepting reuse; provider shapes ignored; deployment claim not compared. |
| Neighbouring suites (`wp4d-neighbours.log`) | `test:synthetic-care-release` 89/89; `test:synthetic-aws-principal` 3/3 |
| `node --check` on the 5 changed scripts | ok |
| `npx eslint` on the 6 changed script files (`wp4d-lint.log`) | exit 0 |
| `npm run typecheck` (`wp4d-typecheck.log`) | exit 0 |
| Bundle rebuild at HEAD (`wp4d-bundle-head.log`) | `546d962f…`, 1,950,986 bytes, not the pinned value (F4) |

**The refusal cases, one or more tests each** (test numbers from the run):

| Case | Tests | Refusal codes |
| --- | --- | --- |
| Forged deployment file | 5–9 | `observation_required`, `observation_not_from_adapter` (a copy or a file), `deployment_claim_disagrees` (a file naming the pair over the pinned old deployment), `deployment_claim_unbound`, `reviewed_bundle_mismatch`, `reviewed_artifact_source_mismatch`, `reviewed_artifact_not_canonical` |
| Stale Lambda or source | 10–15 | `observed_source_stale` and `observed_code_stale` for the pinned `5b6f8aa4` release, before any request; `stack_code_pointer_disagrees`; `stack_source_unadvertised`; `target_changed_during_run`; `expected_source_invalid` for `8bfe2349`, `main` and upper case |
| Wrong issuer | 16–17 | Authorizer, function environment, an extra pool and a token, all before any request |
| Missing marker | 18–20, 22 | Stopped before the first write; one unmarked 2xx after the last write (`mixed`); denials alone are `unobserved`; plain `http://` is refused |
| Duplicate replay | 23–28 | Honest reuse and skip refused under `must_create`; a replay recorded as created; a step recorded twice; an unobserved answer; a skipped or unrecorded step; `must_replay` |
| Provider-shaped JSON and purchases | 29–32 | Stripe, App Store, Google Play and Fullscript payloads; a purchase step is never sent; a provider-shaped API answer; both smoke outputs refused in every position |

**Not run:** any hosted or AWS call, the Playwright battery, and the full unit suite.

## 5. What stays smoke

| Script | Why it stays smoke | Use instead |
| --- | --- | --- |
| `verify-synthetic-program-routes-hosted.mjs` | It cannot be made source-bound without a redesign. Its fixtures are fixed names, created or reused; its programs and consent artifact are seeded directly with Data API SQL, not created through the API; its argument contract is strict; and its target emits no marker (F3). | `hosted-program-acceptance.mjs` |
| `verify-settlement-hosted.mjs` | Its source comes from a local file, and it has no marker check | The same binding gate (same function); no settlement journey was built (H3) |
| `qualify-aws-daily-guidance-hosted.mjs` | It has no source, stack or marker check; it creates and deletes Cognito users; its provider evidence is the answer's own claim | No acceptance path was built (H3) |

I made no `--acceptance` flag for these scripts. It could only refuse on this target (F3), and adding one would change
their argument contract and their internals without a way to run them here.

The other scripts §6 of the packet names were not touched:

- `verify-hosted-synthetic-shell.mjs`;
- `test-aws-lab-recovery-hosted.ps1`;
- `verify-fictional-operator-identity-hosted-20261016.mjs`;
- `verify-synthetic-care-consumer.mjs`;
- `catalog-runtime-control-observer.mjs`.

## 6. Codex: commands and expected results (nothing here was run against AWS)

1. **The fictional battery.**
   - Run `npm run test:hosted-program-acceptance`.
   - Expect 37 pass.
2. **Checkpoint D0, read-only, with the `ai-synthetic-member` profile.**
   - Run `node scripts/hosted-program-acceptance.mjs --observe-read-only` from a clean checkout of the reviewed Desktop
     code commit, the one the V2 kit's `sourcePair.desktopCommit` names. The reviewed commit is that checkout's `HEAD`.
     A dirty or untracked tree refuses `source_dirty` before any AWS read. Nothing pins a commit in this file, because a
     runtime commit cannot name itself.
   - Expect exit 1 and `verdict: "refused"` with `reviewed_artifact_required`. If the pinned release is still live, also
     expect `observed_source_stale`.
   - Record `observed.lambdaCodeKey`, `desktopCommit`, `codeSha256` and `revisionId` as D0.
   - No API request is sent.
3. **The deployment claim, compared rather than trusted.**
   - Add `--deployment-claim=<absolute path>/dist/settlement-qualification/deployment.json`.
   - Expect `deploymentClaim: "agrees"`, which adds nothing, or `"disagrees"`, which is refused.
4. **Before the reviewed care release (packet §7 step 6).**
   - Rebuild the identity bundle in a clean `npm ci` checkout of the reviewed Desktop commit, with real (not symlinked)
     `node_modules`, and record its SHA-256 and byte count.
   - Pin them in `REVIEWED_SOURCE_PAIR` as a reviewed source change. Until then every artifact refuses
     `reviewed_bundle_unpinned`, by design.
   - Do not use the packet's `24a65189…` or this document's `546d962f…`: both came from a symlinked `node_modules` and
     depend on the build root (F4).
5. **After that release** (Brandon's approval; an AWS write):
   - Run step 2 with `--reviewed-artifact=<absolute path>/candidate.zip`.
   - Expect `binding_observed` only if the stack key names the checkout's `HEAD` (the reviewed code commit) and
     `CodeSha256` equals `sha256(candidate.zip)`.
   - Anything else is a refusal, and it is the result. Do not edit around it.
6. **Journey acceptance on `wxv734oi12`.**
   - Expect `execution_not_qualification` before the first write (F3). Do not record a smoke pass in its place.

## 7. Holds

- **H1: the marker (F3).** No acceptance on `wxv734oi12` until its answers are marked, or until the journey runs on the
  qualification program API.
- **H2: bundle reproducibility (F4).** The cause of the remaining 29,428-byte gap is unexplained.
- **H3: credentialed drivers.** No credentialed journey command exists: no token acquisition and no Windows credential
  handling. No settlement or daily-guidance acceptance journey was built either. Only the binding gate covers their
  function.
- **H4: the reviewed artifact.** There is no reviewed artifact for the selected code commit yet, so the binding refuses with
  `reviewed_artifact_required`.
- **H5: token signatures.** Signatures are not verified locally; API Gateway verifies them. Only issuer, audience, use and
  attestation are compared.
- **H6: in-process provenance.** The `WeakSet` provenance defends against files, copies and in-place edits. It does not
  defend against edited source; source review covers that.
