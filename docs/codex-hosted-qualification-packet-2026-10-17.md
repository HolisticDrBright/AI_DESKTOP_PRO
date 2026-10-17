# Exact-source hosted qualification packet for Codex (2026-10-17)

**This is a hand-back, not authorization.** Nothing in this packet was deployed, applied, registered or switched on:

- no AWS, Fly, Cognito, Fullscript or SES write;
- no SQL applied;
- no PHI;
- no paid EAS build;
- every identity named is fictional.

This session's network policy refuses `*.fly.dev`, so I have not observed the live Fly `release: null` myself; it is
recorded as reported. I hold no AWS credentials, so every deployed AWS value below is either pinned in source or
reported. None is observed. The four hosted, four device and one human cases of the V2 launch kit stay
**unobserved** until they are actually run.

## 1. The selected code pair

| Repository | Code commit | Branch | Exact-head CI |
| --- | --- | --- | --- |
| Desktop | `8bfe2349af869cbc0d93712fe6050300bb4ce4ab` | `claude/desktop-campaign-account-safety-20261017` | [39007672640](https://github.com/HolisticDrBright/AI_DESKTOP_PRO/actions/runs/39007672640). Its tree `7420c88c` is byte-identical to `1c0790cc`, which passed [39005270305](https://github.com/HolisticDrBright/AI_DESKTOP_PRO/actions/runs/39005270305) |
| V2 | `dd704abf820de5556c5e6da9dcb39495c138fa87` | `claude/v2-release-integrity-20261017` | [39007636227](https://github.com/HolisticDrBright/AI_LONGEVITY_PRO_V2/actions/runs/39007636227) |

**What each side contains:**

- **Desktop:**
  - campaign send authority (WP1);
  - `staff-revocation-signal/2` (WP2, BLOCKED);
  - one Desktop account per Fullscript practitioner (WP3, Fullscript off);
  - the callback typing fix that turned the Fullscript head's CI green (`d0933f19`, [39005920946](https://github.com/HolisticDrBright/AI_DESKTOP_PRO/actions/runs/39005920946)).
- **V2:**
  - account-isolated fictional device data (`23de11b9`);
  - release identity and hosted refusals;
  - Codex's Bun 1.4.3 dependency-security base (`3185d3df`);
  - the Core continuity matrix (`16078e2c`);
  - the dependency advisory rework (`de698e14`).

**Build and deploy from these code commits, not from a later docs or kit head.** The kit is rebound in a later commit
that touches only `expo/release/` and `docs/`. The V2 kit refuses results whose head differs in code from `v2Commit`,
and it refuses a release whose `sourceVersion` is not `v2Commit`. So a Fly image built from the later kit commit is
refused as `release_source_mismatch`, even though its code is identical.

**Not integrated:**

- `origin/agent/production-cognito-live-drift-20261017` (`f913e643`). It is Codex's own, review-only, and was still
  moving tonight; it is cited in §5.
- `origin/claude/v2-dependency-advisories-20261017` (`f79ed573`). It was superseded by `de698e14`, which redid the
  work on Codex's Bun 1.4.3 base instead of overwriting it.

## 2. Artifact digests (SHA-256 of the committed bytes at the code pair)

**V2 Fly synthetic image** (`fly-synthetic-release/1`; `verify-live-release.mjs --kind=fly-synthetic` expects
exactly these):

| Field | File | SHA-256 |
| --- | --- | --- |
| `backendSourceSha256` | `expo/backend/server.ts` | `edbf5696a9d1271aa787ee2084c8de60b3c8af5ffe956cf11c8252eebc370147` |
| `dependencyLockSha256` | `expo/bun.lock` | `ec9c5bebfbac49c7136479c9a077d1424b75789de04bd193d1592584d6a87eab` |
| `dockerfileSha256` | `expo/Dockerfile` | `06c2b85369da18c31e943344ecf0e6fbbc3a6274d19d2898078fa5425469a957` |
| (environment, not in the record) | `expo/fly.toml` | `1d7fc6bc25c2457fba92a68aa930074e330349554546ddbb834bb9a835c599ff` |

**V2 patient API image** (`patient-api-release/1`, root `Dockerfile`):

- The catalog digest is `58674c54828196e94df8d4c59ed30d24f580831460b8eb3cba2a2f63a4cc3d3c`.
- Both `Dockerfile` and `Dockerfile.production` hash to `fb8ab8302b52ed9ea9631886c59e67a741b3d4c9d30b05fe6fcdd4a4a5fc502f`.
- The bundle digest (`apiSha256`) is not reproducible without the build. Take it from the CI artifact of
  [39007636227](https://github.com/HolisticDrBright/AI_LONGEVITY_PRO_V2/actions/runs/39007636227) and pass it as
  `--api-sha256`.

**Desktop templates:**

| File | Parent `a269552f` | Code pair `8bfe2349` |
| --- | --- | --- |
| `infra/campaigns/campaign-engine.json` | `f96dc7038e727ca19d2ac3e1acee2d182de4d2d21172add2c19f82666377254f` | `7d1f50c720215564c01a401efa011a705207bf27ded24bd44956cf6f05d855ad` |
| `infra/aws-clinical-core/fullscript-connector-extension.json` | `8f32a81fe212636f8407c633e0f3836a205556a58fcc67f5390c7807edd0e50f` | `3e412c997b7536dd80f15a22d7ec979e1045e3da8abae32c77c8242b325591d3` |
| `infra/aws-clinical-core/fullscript-revocation-reconciler.json` | (new) | `d4b59c21c77966016a12aee23a1da1d4fcf1b2bde61d3d9998f0d9c4f45795f9` |

**Desktop synthetic identity Lambda bundle:**

- `scripts/synthetic-care-release.mjs` `buildCareIdentityBundle`, esbuild, unminified.
- It is built from `8bfe2349`, with the builder at the same commit.
- Result: 1,980,414 bytes, SHA-256 `24a65189e2351e7d0b4911944e271f5c09849689e23ca67be05650375979ff8f`.

No SQL file changed between the kit's previous Desktop commit `666fc96f` and `8bfe2349`.

## 3. Deployed source drift: what the hosted cases would actually exercise today

| Target | What source pins or reports | Status for the pair |
| --- | --- | --- |
| Fly `expo-sunlit-resonance-4543` (the V2 API every hosted and device case reaches) | Reported: `/health` answers `release: null`. The running machine predates the exact-source control (`expo/docs/fly-synthetic-source-provenance-2026-10-16.md`). | **Refused.** `release_missing`. The source half of the defect is fixed on V2 (§6); the deployment half is §7 steps 1 to 4. |
| `wxv734oi12`, stack `ai-clinical-core-synthetic-staging-authenticated-api` (account `588966314750`), the Desktop clinical API the Fly env names (`expo/fly.toml` `CLINICAL_AWS_API_ORIGIN`) | Pinned in source: Desktop `5b6f8aa45347d33757ac9bfb34658e2e09daefd3` and mobile `11197e52…`, ZIP `644967ee…`, key `clinical-core/authenticated-api/care-release/<desktop>/<zip>.zip` (`scripts/verify-deployed-synthetic-care.mjs:13-17`) | **Stale.** `5b6f8aa4` (2026-10-07) is an ancestor of the pair, and the identity bundle its source builds (`93dd1c70d494f41938b0bf772eae4a3cfa1361726d12747b71049b9625e91ec5`, 1,878,599 bytes) differs from the pair's (§2). The stack already advertises its source in `LambdaCodeKey`, so the source contract is present. Only the deployment is stale. |
| The 12 qualification candidate stacks (`src/server/clinical-core/qualification-target-manifest.ts:60-67`) | Each publishes Output and Parameter `SourceCommit`. The manifest's `sourceCommit` must equal HEAD. | Unobserved by me. Reported as advertising older commits. `observeQualificationTarget` refuses each stack whose `SourceCommit` differs from the manifest (`qualification-target-manifest.ts:215,222`; `qualification-target-observation.ts:36-37,59`). |
| Production patient API (root `Dockerfile` image) | `/health` reports `patient-api-release/1`, and CI checks the image against itself. | Not part of the synthetic qualification. Verify it with `--kind=patient-api` before any claim about it. |

**The consequence.** The kit's hosted rows must carry the following, or they are refused:

- `observedSource.desktopStackCommit === sourcePair.desktopCommit`;
- a verified V2 release for `v2Commit`;
- `execution: 'qualification'`.

Until the Fly API is redeployed from `dd704abf…` and `wxv734oi12` from `8bfe2349…`, every hosted case run through the
app exercises older code on both sides. The kit refuses it as stale. That refusal is correct; do not record around
it.

## 4. Blocked candidates (all stay BLOCKED, unregistered, and off)

**Release switches in Desktop source at the pair:**

- `FULLSCRIPT_REVOCATION_RECONCILER_RELEASE` (`src/server/fullscript/revocation-reconciler.ts:26`) and the reconciler
  template's `ReconcilerRelease`, which allows only `BLOCKED`. The token table's `RevocationQueueIndex` is not created.
- `FULLSCRIPT_OWNERSHIP_TRANSFER_RELEASE` (`practitioner-ownership.ts:155`).
- `ORDINARY_SUSPENSION_WINDOW_RELEASE`, `WORKFORCE_IDENTITY_REVOCATION_RELEASE`, `WORKFORCE_IDENTITY_RECOVERY_RELEASE`,
  `WORKFORCE_TOKEN_BINDING_RELEASE`, `WORKFORCE_CLINIC_BOOTSTRAP_RELEASE` / `DESKTOP_CLINIC_BOOTSTRAP_RELEASE`,
  `WORKFORCE_JOIN_REVIEW_API_RELEASE`, `WORKFORCE_CLINIC_PROPOSAL_REVIEW_RELEASE`, `WORKFORCE_APPLICATION_API_RELEASE`,
  `PLATFORM_OPERATOR_CONSOLE_RELEASE` / `DESKTOP_PLATFORM_OPERATOR_CONSOLE_RELEASE`, `PLATFORM_OPERATOR_SIGN_IN_RELEASE`.
- The campaign engine is off. The send-authority holds and the `/2` signal writer are source only.
- Fullscript: `FULLSCRIPT_LAB_ORDERING_ENABLED=false` and `FULLSCRIPT_PRODUCTION_APPROVED=false`.

**SQL source candidates added or changed on 16 and 17 October** (`infra/aws-clinical-core/source-candidates/`;
candidate, then rollback):

| Candidate | Candidate SHA-256 | Rollback SHA-256 |
| --- | --- | --- |
| `workforce-revocation-campaign-signal` | `b8d5e9b1332e8804e0a23223884b1870b87d9fa08078743b2b0922c32caebeb8` | `edfc76fd7d767f2704da087040558f1969b3afa57d82f8a640ded7ff01286add` |
| `workforce-ordinary-suspension-window` | `94b25a4a7557f4256e6b678c8d338160afcf98371787aadd90a88c2154b3f90b` | `efd8665c81b90599913074721818b6cbdc6c45fc47df54318da1c6cb51184466` |
| `workforce-consent-grant-paths-clinic-status` | `b6f4b53a640dd362df28613a2953d58cf81082d04bbcc1e55c1530022ac24346` | `6382c13c6dd1c3d2789cd1ccafd54a1418a45ae61e115b3d77ef6f48d0784a96` |
| `workforce-identity-recovery` | `30cadec0250283229a005176f08175eb0f7bd3fd79979be6b55196ba2bc86fa8` | `5d73c082cc3b11e1ad044bced9434893b983f7505d99fa35035fe794b26571b9` |
| `workforce-identity-emergency-revocation` | `8d059be1483e9ff5337fd7799b28208901088cab4bc940a1de1d03bc50db9d88` | `cf4c40020aeaf746cfa155ad633bf87cbd7b823e360b5bd2cb56fad4d13804a4` |
| `workforce-current-withdrawal-only` | `24847d3a7127cf36660f850c5467a6c8b9e45ae833015f23884b7e0dc00873f8` | `ea558476f2a13f52c4089f09903764b60509dd44bd6bf7db90ee4733872deb52` |
| `workforce-consent-decision-clinic-status` | `e3ac5c117165afffb37c9357ba3fa2240410dd3bd41a73bc206d99a3c69a31fd` | `5a863a36011561c63c5013a9457ba9429a9707f6707ca350dbde5c243f5ee2c5` |
| `synthetic-invitation-clinic-status` | `775474de8959fe1f6e32fee7598129501b0a7235d685528a3dd4e69422260f63` | `ab088d1bfb82800852c79633841e8b78c84f5098332f5fd57c35d7b829eed0b1` |
| `legacy-claims-clinic-status` | `c3788dc20bed9fe6aae40cc939a08a69773d45d56dc297dea21ae99ed6c7cc66` | `4c311c01148367b82d58e2143c2cce6f21f391fa04d50f1f21e27935224b29a0` |
| `care-messaging-qualification-login` | `7936d0c536dd7224fe32a62489266da730f0202aac09dd30e7d5e466a4f19dac` | `1b04682b1d9a26ad828fa4ee580e53893d25930c5e845e1555bf1c3de11940eb` |
| `care-messaging-qualification-current-context` | `eac6bba8b99976fcf6ed5bc56209259975b5eaf7767fb7cfc582d960fea0e4e2` | `bab715073a39e9d110af54cfc2c9c8cbd81b0d328baf6f8c34cd9a24b56255e5` |

The `workforce-consent-decision-clinic-status-rollback` hash in
`docs/codex-aws-review-packet-major-2026-10-16.md` (`a8a40a7b…`) is superseded by the one above.

**The V2 kit's `sourcePair.candidates` and `mirrors`:**

- The 25 candidate hashes and 6 mirror hashes all match the files at this pair (checked by name against the committed
  bytes in both repositories).
- They are carried forward unchanged.
- The program-family qualification candidate, `qualification-program-boundary.sql`, is among them. A journey 5 run on
  the qualification target, rather than on `wxv734oi12`, needs it applied there first.

## 5. Issuer and pool assumptions

| Pool | Id | Where it is pinned | Checked against the deployed stack |
| --- | --- | --- | --- |
| Synthetic consumer | `us-east-2_nYngyyYGE` | `expo/fly.toml:13`; `scripts/synthetic-care-release.mjs` `consumerPool`; `scripts/build-qualification-program-api.mjs:23` | By the care release verifier and the clinic-records runner (authorizer JWT configuration against stack parameters). The daily-guidance script compares only a token's `iss` with a constant. |
| Qualification / synthetic workforce | `us-east-2_ueGlFRbNB` | `expo/fly.toml:15`; `aws-workforce-token-binding.ts:15` | As above |
| Production | `us-east-2_AZMa5gxSZ` | `aws-workforce-token-binding.ts:13`; `aws-production-clinical-api.ts:38` | Not part of this qualification |
| Telehealth and inventory fixtures | `us-east-2_G2Hvf9wzJ`, `us-east-2_zGOVBoeGT` | `scripts/telehealth-qualification-template.mjs:11,13` | `telehealth-qualification-preflight.mjs:58-69` |

**Assumptions to confirm before step 5:**

- Journey 1 runs against the synthetic consumer pool, never production.
- Codex's read-only production check reports email auto-verification **drift on both production pools** (branch
  `agent/production-cognito-live-drift-20261017`, `f913e643`, `docs/production-cognito-email-drift-review-2026-10-17.md`).
  So a registration that succeeds on the synthetic pool (which has `AutoVerifiedAttributes=["email"]`) says nothing
  about production sign-up.
- The shared-manifest TypeScript harnesses do not compare issuer or audience with the stack
  (`qualification-target-manifest.ts:203-239`). For those, the issuer is assumed from the manifest.

## 6. The hosted runners: what refuses, and what is not admissible evidence

**V2, changed tonight (`claude/v2-release-integrity-20261017`):**

- **`/health` now reports the running image's verified record.** It is `readRuntimeRelease`, in
  `expo/backend/patient-release.ts`. Before, the Fly image's record was never read.
- **`scripts/verify-live-release.mjs` (`release-verification/1`)** is credential-free: one `GET /health`, with the
  expected digests taken from `git show`. Its closed refusal codes:
  - `release_missing`
  - `release_stale`
  - `release_source_mismatch`
  - `release_digest_mismatch`
  - `release_kind_mismatch`
  - `release_posture_refused`
  - `health_not_ok`
  - `expected_source_invalid`
- **`scripts/hosted-release-guard.mjs`** runs the verifier before any authenticated request. The guard is called from:
  - `verify-hosted-consumer-flow.mjs`;
  - the hosted recommendations suite;
  - `run-hosted-governed-recommendations.ps1`, which also refuses a run with any skipped, pending, todo or failed test.
- **`scripts/launch-acceptance.mjs`** refuses hosted rows:
  - with no observed source;
  - with `release:null`;
  - with a stale or mismatched V2 or Desktop source;
  - with an unverified release;
  - without `execution: 'qualification'`;
  - whose results come from an unnamed, dirty or code-changed head.

**Desktop, admissible (unchanged; they already refuse).** Each requires a 40-character commit equal to HEAD and the
deployed stacks' `SourceCommit`. Each refuses missing and skipped mandatory steps, and each requires the qualification
marker:

| Runner | Source | Skipped / unobserved | Marker |
| --- | --- | --- | --- |
| `scripts/clinic-records-qualification-runner.mjs` | Candidate Parameters and Lambda env, including `SOURCE_COMMIT` (`clinic-records-qualification-target.mjs:39,46,87,120-125`). A clean checkout is required (`runner:347-348`). The target is re-observed four times. | All 30 cases present, observed and in order (`clinic-records-qualification-report.mjs:142-149`) | Every response, including 401 and 403 (`runner:95`) |
| Recording, export-retention and voice-shutdown acceptance CLIs (`src/server/clinical-core/*-acceptance-cli.ts`) and the load runner | Output and Parameter `SourceCommit` against the manifest (`qualification-target-manifest.ts:215,222`). HEAD must equal the manifest (`qualification-target-observation.ts:36-37`). | In acceptance mode every step is mandatory, so `ok=false` (`recording-acceptance.ts:291-294`) | `expectedExecution: "qualification"`. An unmarked 401 or 403 is counted separately, because API Gateway's authorizer answers it before any function runs (`qualification-execution.ts:90-104`). |
| `scripts/care-messaging-qualification-observer.mjs` | Outputs and Parameters exact; the template's AllowedValues are `[head]`; a dirty tree is refused | (Inspector; runs no cases) | n/a |

Two residuals in these admissible runners:

- **The shared-manifest CLIs:**
  - they have no dirty-tree check (the load runner has one, `load-qualification-target.ts:9-10`);
  - they observe the target once, before the run;
  - so redeploying mid-run is not caught, and a clean checkout is the operator's to keep.
- **The care inspector** reports a missing stack as `status: not_deployed, acceptance: false` and exits 0
  (`observer:171-176`). That is not a pass; record it as unobserved.

**These are not admissible as hosted acceptance evidence.** Each is a narrow synthetic smoke test or a deployment
check, and none binds the run to the pair:

- **`scripts/verify-synthetic-program-routes-hosted.mjs`**:
  - it is pinned to the old artifact `58f59783…`;
  - its `deployedSourceCommit` (`:15`, `b1f597d3`) is printed but never compared;
  - it does not check the marker;
  - its create-or-reuse branches (`:170, :228, :245, :335`) skip their writes on a replay by design, and it still prints
    `verdict: pass` (`:444`), so a pass does not say which steps this run performed.
- **`scripts/verify-settlement-hosted.mjs`**: its `sourceCommit` is copied from a local file (`:19,110`); it does not
  check the marker.
- **`scripts/qualify-aws-daily-guidance-hosted.mjs`**: no source, stack or marker check; it creates and deletes
  Cognito users.
- **No source or marker check at all:**
  - `scripts/verify-hosted-synthetic-shell.mjs`;
  - `scripts/test-aws-lab-recovery-hosted.ps1`;
  - `scripts/verify-fictional-operator-identity-hosted-20261016.mjs`;
  - `scripts/verify-synthetic-care-consumer.mjs`;
  - `scripts/catalog-runtime-control-observer.mjs`.
- **`scripts/verify-deployed-synthetic-care.mjs`** binds by code digest, and that binding is to the **pinned old**
  deployment. It proves what is deployed, not that it is the pair.
- **The shared-manifest CLIs with `ACCEPTANCE_MODE=exploratory`.** That mode skips the stack observation; the report
  labels it `verdict.mode: exploratory` and `target.source: asserted_by_caller`.
- **The V2 billing harness** (`expo/scripts/billing-qualification-harness.mjs`) binds by Lambda code digest, but its
  observed digests come from the operator-supplied `--deployment` file (`:115`). Take them from a live
  `GetFunction` `CodeSha256` read, never by hand.

I did not change these Desktop scripts. They are credentialed, I cannot run them, and their own documents already
call them smoke tests ("not qualification-fleet or commercial-release evidence", `docs/aws-qualification-2026-10-05.md:68`).
The kit refuses their output by shape: none of them yields an observed `desktopStackCommit` for the pair.

## 7. Ordered steps with rollback checkpoints (Codex; nothing here was run)

Stop at any step whose precondition fails. **Each checkpoint names what to record first, so the step can be undone.**

1. **Checkpoint F0: the current Fly release.**
   - Record the current Fly release and image digest for `expo-sunlit-resonance-4543`, and its current `/health` body.
   - Rollback target: redeploy that recorded image digest.
2. **Build V2.**
   - Use a clean checkout of `dd704abf820de5556c5e6da9dcb39495c138fa87` (in `expo/`).
   - Run `node scripts/resolve-fly-source.mjs`; it refuses a dirty tree.
   - Build with that value as `SOURCE_VERSION`.
   - Run `node scripts/verify-fly-synthetic-image.mjs <image> <commit>`. It checks the image at rest **and** its own
     `/health`.
   - The step is not complete until the CI step "Build and verify exact-source Fly synthetic image" is green at
     `dd704abf`.
3. **Deploy that exact image.** Record its digest.
4. **Verify the V2 release.**
   - Run `npm run verify:live-release -- --origin=https://expo-sunlit-resonance-4543.fly.dev --kind=fly-synthetic --source=dd704abf820de5556c5e6da9dcb39495c138fa87`.
   - Anything but `{"verified":true,…}` means roll back to F0.
   - Then run the negative tests in §8, items 1 to 3.
5. **Checkpoint D0: the current Desktop synthetic API.**
   - Run the read-only `scripts/verify-deployed-synthetic-care.mjs`.
   - Record the stack's `LambdaCodeKey`, the function's `CodeSha256` and `S3ObjectVersion`, and the template SHA-256.
   - Rollback target: that object version and key.
6. **A reviewed care release of `8bfe2349` for `wxv734oi12`**, through the existing prepare, upload and verify path
   (`scripts/build-synthetic-care-release.mjs` and its successors).
   - The source pins its constants to the deployed release (`DEPLOYED_CARE`, `CARE_RELEASE.previousZipSha256`), so a new
     release is a reviewed source change of those pins, not a hand edit at deploy time.
   - The template lacks six routes (`CARE_RELEASE.absentRoutes`) that a code-only update cannot add. Decide first
     whether the hosted cases need them.
   - Its identity bundle must be `24a65189…` (§2).
   - **This step needs Brandon's approval; it is an AWS write.**
7. **Checkpoint Q0, if the qualification target is used.**
   - Record each candidate stack's `SourceCommit` and template hash.
   - Redeploy from `8bfe2349`.
   - The manifest's `sourceCommit` is `8bfe2349…`.
   - `observeQualificationTarget` must pass for the candidates a run uses.
8. **Run the hosted cases** (kit journeys 1, 2, 3 and 5, fictional personas only). Record on each row:
   - `observedSource.v2Release`: the `/health` record;
   - `observedSource.v2ReleaseVerification`: the step 4 output;
   - `observedSource.desktopStackCommit`: the Desktop commit read from the deployed stack, that is the `LambdaCodeKey`
     path for `wxv734oi12` or `SourceCommit` for qualification stacks, never typed;
   - `execution`, read from the `x-clinical-execution` header.

   Set `V2_EXPECTED_SOURCE=dd704abf…` for the hosted scripts.
9. **Validate.**
   - Run `node scripts/run-launch-acceptance.mjs` and the kit validator from a clean checkout. They record
     `observedHeads` and refuse a code-changed head.
   - A refusal is the result. Do not edit the row to pass.
10. **Roll back** to F0, D0 and Q0 if any hosted case shows cross-owner data, a lab-derived supplement direction or
    ordering link under education-only Core, or any PHI posture.

## 8. Fictional negative tests (each must refuse; record the refusal)

1. `verify:live-release --source=bb00bc187e4437917bc90b60652fbd5913e1eee1` (the predecessor) against the redeployed
   Fly must give `release_stale`. `--source=main` must give `expected_source_invalid`, and `--kind=patient-api` must give
   `release_kind_mismatch`.
2. Before step 3, against today's Fly: `release_missing`.
3. A plain `http://` origin for the hosted guard must give `origin_https_required`.
4. Kit rows that must be refused:
   - a row with `v2Release: null`;
   - a row with `desktopStackCommit: 5b6f8aa4…`;
   - a row with `execution: "production"`;
   - results from a dirty tree.

   These are already unit-tested (`expo/scripts/launch-acceptance.test.mjs`). Repeat them once on the recorded files.
5. Journey 1, two fictional personas on one phone: persona B never sees persona A's labs, plan or acknowledgement after
   sign-out and sign-in, a background or a cold start.
6. Offline with a live sign-in: the surface says the phone could not connect, never "sign in again", and never shows
   the data as empty.
7. Expired Core: saved labs, plans, meals and courses are readable for free. A new analysis and other paid writes are
   refused as the membership, not as a sign-in.
8. Education-only Core: no held lab-derived supplement direction and no ordering or purchase link appears on Labs, the
   Plan or Programs.
9. A foreign fictional consumer reading another owner's program assignment or dispute: 403 `operation_refused`.
10. Every clinical answer on a qualification target carries `x-clinical-execution: qualification`. An unmarked 2xx
    classifies the run as `production` and refuses it.

## 9. Still unobserved and withheld

- The nine external cases of the V2 kit:
  - hosted: `j1-hosted-registration-reset-mfa`, `j2-hosted-lab-analysis-delivery`, `j3-hosted-ask-alp-marker-fidelity`,
    `j5-hosted-program-and-message-round-trip`;
  - device: `j1-device-two-device-owner-isolation`, `j4-device-health-permissions-and-withdrawal`,
    `j6-device-voice-interruption-and-export-share`, `j7-device-sandbox-purchase-restore-cancel`;
  - human: `j7-human-paid-build-and-store-authorization`.
- The 51 unfilled preflight values (32 manifest values and 19 Lambda values) and the store blockers.
- The four V2 high dependency advisories left on the exact lock (`braces`, `image-size` ×2, `node-forge`). They are
  decisions for Brandon, not approved exceptions: `expo/docs/claude-v2-dependency-advisories-2026-10-17.md`.
- The three OPEN revocation-signal races, reproduced with `it.fails`: `docs/revocation-signal-timing-2026-10-17.md`.
- The held device-export item `held-content-export-pin`: `expo/docs/claude-v2-core-continuity-matrix-2026-10-17.md` §3.

## 10. What not to do

- Do not deploy from a docs or kit head, a branch name or a short hash.
- Do not record `desktopStackCommit` or a release by hand; read them from the deployment.
- Do not count a smoke script in §6 as hosted acceptance.
- Do not apply any candidate in §4, or turn on any switch. Do not enable PHI, Fullscript, campaigns, billing or lab
  ordering.
- Do not restore a staging snapshot into production, and do not use real patient data.
