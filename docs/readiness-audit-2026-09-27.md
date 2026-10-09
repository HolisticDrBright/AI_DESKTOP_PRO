# September 27 independent repair and readiness audit

## Status

Not commercial-ready or PHI-ready. This is a source repair and synthetic database qualification increment, not a release or activation approval. No real health data, model-provider requests, paid mobile builds, production-account changes or application deployments were performed.

Audited source: Desktop `ad6a14ceec6389ff6fcdadcac69a7a1d8681d0d2` and V2 `d3680e4fa606a4ff52b15d08cfda184c6ffeece1`, both from `claude/gracious-hypatia-jbd3br`. Their pre-repair hosted CI runs were green (`35790777532`, `35791060569`). Repairs are on a separate `agent/sept27-readiness-repairs` branch; do not overwrite concurrent Claude work or assume main contains them.

## Repairs

1. Voice-drain acceptance validates every required inventory count as a nonnegative safe integer. Missing, null, string, negative, fractional, NaN, infinite and overflowing counts fail. Invalid inventories cannot masquerade as empty retained work.
2. Cross-pool workforce 401/403 is distinguished from the consumer Lambda's cleanup-only refusal. An unrelated 503 is not a successful drain test.
3. The acceptance CLI obtains both inventories directly from the reviewed AWS stack and refuses caller-supplied inventory files. It checks configuration stability; neither inventory proves erasure, settled writers, or an atomic snapshot.
4. Scheduled retention no longer passes when the owner already removed the copy. Full acceptance cannot omit the schedule. The CLI correlates a completed scheduled invocation from the deployed function's CloudWatch stream with a read-only, job-specific service-attributed deletion audit. A missing observer, wrong actor, stale/unrelated log, refusal or timeout is not a pass. The runtime binds operational invocation metadata to the configured rule; it never logs export content. This is correlation evidence, not protection against an administrator fabricating evidence.
5. The offline target validator uses the installed bundler API and the current Node executable, so it works on Windows without an `npx` executable. Temporary files are cleaned on success and refusal. Tests run with an otherwise empty PATH.
6. Windows CRLF fixture generation no longer doubles carriage returns. Artifact tests use bounded build setup; the parameter generator builds recording templates in isolated temporary output directories, avoiding corruption of another test's runtime/manifest pair. No checksum or clinical assertions were weakened.
7. Real AWS inspection encountered `DatabaseResumingException`. The transaction adapter now retries only that explicit cancelled-before-execution response before starting the transaction (three delays totaling seven seconds). It never retries a transaction body, commit, timeout, access denial or ambiguous network failure. The qualification inspector reports exhaustion as `database_resuming_retry_later` rather than an opaque statement failure.
8. The previously local qualification foundation builder and boundary tests are intentionally brought into source, with package and CI hooks and CloudFormation lint. This does not recreate the existing stack.

## Verified evidence and limits

- V2: typecheck; 1,862 tests passed, one skipped; lint; TestFlight source gate (309 files); capability contract and production-container gates passed. V2 source was not changed in this increment. This is not physical mobile acceptance.
- Desktop: typecheck, focused repair tests, source lint (zero errors, five existing warnings), 52 hosted-runner binding cases and 32 pre-network qualification-name cases passed. Lint excludes local generated `.artifacts/` and Graphify outputs; an initial unfiltered run reported generated bundle lint errors, not clean source evidence.
- The initial Desktop full run found the CRLF fixture defect. Later full runs exposed build-test timing and shared artifact output races; those failures are preserved as failures, not relabeled passes. After the repairs, the complete Desktop run passed: 265 files, 3,220 tests passed and 11 skipped, with two workers, `TZ=America/Los_Angeles`, and `CLINICAL_SUPABASE_ANON_KEY` unset. Final typecheck and source lint also passed (five existing lint warnings). Hosted CI for these new repairs is a separate, still-unverified boundary.
- Both new foundation and privacy-operations templates passed CloudFormation lint. Foundation boundary tests pass. No credentials or review approvals are synthesized by these tests.
- Live App Runner `ai-desktop-pro-synthetic-staging` is RUNNING at `https://penrnyupn3.us-east-2.awsapprunner.com`, configured image tag `4ffd5f248432f93256ecbc6d2124ba1e798e21f0`. `/api/health` returned `{"ok":true}`. A fresh browser reached the practitioner sign-in screen with the synthetic-only banner; no authenticated chart journey was tested. This is an older release, not the audited branch.
- The isolated qualification API `6zt8e9qz04` still has **zero routes**. No HTTP/provider export, recording, transcription, drafting or scheduled-sweep acceptance has run against it.

## AWS work completed

Account `588966314750`, region `us-east-2`, profile `ai-synthetic-staging`; sign-in renewed and STS pinned. Only the existing `clinical_core_qualification` database on the synthetic Aurora cluster was migrated. Applied `20260922010000_production_record_source_regime.sql`: now 102 migrations, 123 application tables, 81 checked contracts, zero clinical rows.

- Migration identity/release hash: `d6b0a8a5d61c465f8e1db1181c52d6bf4d90db0b65068042d8ebf56358dd82b3`.
- Artifact build hash printed by the build tool: `6ec019812068ece7b5cc801d17d6b69dcfefc1b8c760502413fc23a7777375ee`. Do not substitute this for the identity hash above.
- Real Aurora rollback-only acceptance passed all reported invariants: connections, consent, lab and record import, duplicate/replay protection, provenance, cross-tenant refusal, governed catalog/protocol/knowledge flows, and workforce invitation. 52 audit events existed inside the rolled-back transaction. Evidence hash `bcdd4b6dcadaca3bee6ae8fe982f65fb5fa341cbf782acdc1338af1b7447de12`.
- Staging `clinical_core` was inspected at 30 migrations through `20260904090000` and was not modified. Never apply the production artifact to that incompatible ledger.
- The old SNS subscription had disappeared. Under the owner's prior explicit instruction, a new confirmation was sent to `info@AILongevityPro.app` on the qualification alarm topic. Subscription suffix `734c4a10-6b9f-4ca0-81bf-b89f5d869f55` was pending confirmation. No delivered-alarm claim.

## Work still required, in order

1. Review and merge the repair branch; verify its hosted CI. Rebuild every candidate from the resulting exact source commit and lockfile. Existing uploaded `e87fc3a` packages are obsolete; never present them as current. The added retention schedule ARN must ship with the new handler.
2. Fill and genuinely review the qualification target/deployment manifests: distinct designated consumers, workforce identity, non-human `svc-...` retention subject, reviewed export and recording resources, consent/capture/storage/provider releases, and each required review digest. Placeholders or hashes of invented approvals are not acceptable. Do not use the older provisioner that deletes/recreates existing staging users.
3. Deploy all ten qualification candidates in dependency order with PHI false and production activation blocked; bind to the 102-migration identity hash. A stack existing with a disabled handler is not positive qualification.
4. Execute the hosted matrix against real AWS: actual versioned export download/checksums/KMS/IAM isolation, owner/cross-clinic refusals, cancellation and late writes, retention service release plus observed scheduled sweep, alarm delivery, generated-audio recording/transcription/review-only drafting, consent withdrawal, correction and cleanup. Schedule correlation is bounded to a three-hour observation window around the next daily occurrence; no manual invocation substituted for scheduled evidence. Preserve every failed/unconfigured/skipped result and fix what those runs reveal.
5. Build a matched API/Desktop/mobile release set; verify rollback and exact hosted source/image identities. Deploying only Desktop cannot update TestFlight. Physical iOS and Android journeys remain unverified (identity recovery/MFA, consent, labs, plan/Ask ALP, native health, transfers/replay, audio recovery/deletion, privacy, purchases/restore). Obtain explicit paid-build authorization before EAS work.
6. Complete provider/store test-mode acceptance for Core, actual agreement/configuration coverage, privacy/retention decisions, security/incident/on-call review and a recovery drill. The user reports the OpenAI amendment executed; verify the covered organization/project/services and retention against runtime rather than asking for the signature again. Preserve catalog holds, source verification, adult-only launch scope and paid-tier restrictions. Never enable PHI to satisfy a test.

These are outstanding engineering and acceptance tasks as well as human gates. The whole product cannot be declared complete from the passing local tests above.
