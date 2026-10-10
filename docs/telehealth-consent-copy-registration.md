# Exact telehealth consent copy registration

The telehealth registrar's transaction engine registers existing approved recording-consent wording on the exact 112-migration fictional qualification target. It never creates the approval or a patient consent grant. The engine, retained-copy observation and command orchestration are locally verified; they are not an installed AWS operator. Fixed native ports, interruption custody, an exact executable builder and hosted acceptance remain required before AWS registration.

## Separate release and scope

The input contract is `telehealth-consent-copy/112`, with scope `telehealth_recording`, artifact ID, organization ID, artifact version, exact text and its SHA-256. Text is not trimmed or newline-normalized. Only UUID spelling is normalized. Invalid UTF-8 representation, NUL, empty wording, over 16,000 UTF-8 bytes, additional approval fields and other scopes are refused.

`runTelehealthConsentCopyRegistration` accepts only the complete 112 source artifact, successor ledger `45aec4369ec94bf6339a17e47eadba7b81e7b5195fd5be46c2903e587b709fb4` and assembly `6cc191355442ae2c2349cab50466979eaab0e45961a4e1547f34785294dce4b9`. The actual database must be `clinical_core_qualification` in the fixed synthetic-account configuration, with PHI false and activation blocked. It checks the whole live ledger, not only the count or latest receipt.

Historical 105/106 copy registration and its wire scopes remain unchanged and refuse this successor. No count tolerance, changed parent SQL or broadened care-consent parser is used. Target verification checks the existing Fullscript extension, approved-copy functions and triggers, the exact new telehealth function, immutable-copy blocker, restricted table access and forced row-level security.

## Approval and transaction behavior

Registration requires the current approved artifact for the specified clinic and scope, matching the exact version and content digest. Its reviewer must still be an active production-bound workforce identity, with an active person and authorized membership in an active clinic. A newer approved artifact without registered wording supersedes the older one; the registrar must not fall back to the older copy.

Inventory and inspection are read-only. Writing uses the shared migration and fixture advisory locks, copy and ledger table locks, the existing scope serialization lock, and shared locks on reviewer authority. Rehearsal actually inserts and rolls back, then independently inspects the result. Registration inserts once; an identical existing copy remains immutable and is reported as present, not newly inserted. Conflicting text or linkage is refused.

The receipt states `approvalsCreated:false` and `grantsCreated:false`, and contains identifiers and hashes rather than the wording or clinical data. Registering approved wording must not grant recording consent. Patients must read and acknowledge it through the separate consumer consent endpoint.

An uncertain commit produces a fixed failure, not a success receipt or automatic retry. Normal inspection requires current approval authority. Loss of authority or supersession is a refusal; it is not evidence that a stored copy was deleted.

The separate administrative `inspectRetainedTelehealthConsentCopy` observes the exact immutable copy and artifact linkage on the canonical112 target without certifying current approval. It is read-only and is not a patient-delivery fallback. Its receipt explicitly states that approval authority and deletion are not certified, no mutation occurred and no retry occurred. Missing or changed artifact linkage, text, digest, schema, privileges or release is refused. No wording appears in its receipt.

## Command orchestration

`executeTelehealthCopyCommand` accepts only canonical target and copy files, their supplied SHA-256 values, exact clean operator source and operator digest, actual STS/member-role/foundation observations and matching clinic/artifact/version/scope. The target contract is `telehealth-consent-copy-target/112`; its review scope is `fictional-consent-copy-registration-only`. A schema-only review is refused.

Registration requires current authorized inspection, a real rollback rehearsal and durable write admission before one registration call. Two exact retained-copy readbacks precede settlement. Copy text stays out of command results and custody bindings; bindings contain identifiers and digests. Native custody must privately retain the original exact file bytes before admitting a writer.

Read-only reconciliation uses original custody, baseline and admission, never registration replay. It makes three matching retained-copy observations even if current approval was retired. An unadmitted new copy, disappearance of a baseline copy, changing readbacks or counterfeit evidence refuses settlement. It reports the original write outcome as unknown and cannot certify approval or deletion.

The separate native executable embeds the exact112 migration artifact and clean source identity. Relative paths, overrides, dirty or falsely truthy build metadata, altered/duplicate JSON, changed AWS target, copy substitution, schema-only approval and future review time refuse before the affected operation. Its fixed ports use only the synthetic member account and qualification foundation, with the existing bounded single-attempt Data API transport and shared database fence. Neither the historical105/106 registrar nor the preserving schema-upgrade executable is broadened.

Native custody archives the original operator and canonical exact-copy file before publishing a complete hard-linked shared `operator.lock`. The header and hash-chained journal contain only identifiers and digests, not consent wording. Stable bounded descriptor reads reject changed files and symlinked ancestors. Each stage rechecks the fence and archive integrity; unexpected write outcomes retain custody without an automatic retry.

Reconciliation requires the original build, target, copy bytes and journal, the original process to be stopped on the same host, and a settlement interval of at least60 seconds. A torn final event stays archived and cannot admit a writer. A live, foreign or altered recovery guard is never cleared. Three matching database observations precede command settlement. A baseline or subsequently recorded copy cannot disappear, and a new unadmitted copy cannot settle. Recovery receipts explicitly do not certify the original response, renewed approval or deletion. These controls address process interruption; they do not prove power-loss durability, Windows file confidentiality, concurrent AWS behavior or hosted acceptance.

Build and inspect only after a separate exact-copy review:

```powershell
npm run build:telehealth-consent-copy-operator
node dist/aws-clinical-core/telehealth-consent-copy-operator/index.cjs inspect --target C:/absolute/reviewed-target.json --target-sha256 <target-sha256> --copy C:/absolute/reviewed-copy.json --copy-sha256 <copy-sha256>
```

The other operations use the same arguments. `rehearse` and `register` require `--confirm-fictional-telehealth-copy`; `reconcile` requires `--reconcile-fictional-telehealth-copy`. Do not issue `register` again after an uncertain reply, clear a custody lock by hand, or substitute a newer build for the original recovery operator. The shared directory must already exist; no environment or command-line override selects another custody root. The builder's optional absolute `--out-dir` changes build output only, not runtime custody or AWS configuration.

## Local verification

```powershell
npm run test:telehealth-consent-copy-registration
npm run test:telehealth-consent-copy-operator-artifact
```

Real embedded PostgreSQL tests exercise exact-text parsing, approval and reviewer authority, clinic and scope binding, stale release refusal, schema and permission changes, shared-lock denial, rollback, idempotent copy presence, failed inserts and uncertain commit replies. A registered copy is read through the actual restricted consumer consent function, with a second consumer denied and no consent grant created. Every identity, approval and record is fictional in memory. These tests do not prove concurrent-session locking or AWS behavior.

The current four-suite command/native-custody/registration/historical-registration run passed183 tests. It composes actual SQL and the Data API parameter encoder with actual local file custody, including idempotent presence and an inserted copy with a lost reply and retired approval. Child-process liveness and the local archive/journal checks are physically exercised. AWS observations and the outer database fence in these composition tests remain fictional. Five actual compiled-artifact tests cover release/source binding, invalid CLI requests, unsafe or schema-only targets, build overrides and refusal to publish on source drift. Positive AWS execution is not represented by these tests.

## Hosted work still required

Before any AWS run, build from a clean recorded commit and separately review the canonical target, operator digest, copy-file digest, artifact and clinic. A schema-upgrade target review does not approve consent wording. Review the archive directory's access and retention separately; a file mode is not evidence of Windows ACL protection.

Qualify the fixed native ports, shared database fence, exact-copy admission, rollback rehearsal and interruption/recovery against the real synthetic target. An interrupted writer must retain its original custody; it must not be retired on a guessed copy-insertion result. Do not log the wording or claim a recovered observation proves the original response succeeded.

The qualification database was last observed at migration 107. The reviewed preserving predecessor and successor upgrades remain prerequisites. After registration, qualify the matched published consent API, current and superseded copy, withdrawal and renewal, host/patient Zoom behavior and physical V2 journeys. Consent wording, provider coverage and policy approvals remain separate human gates. PHI and paid mobile builds remain disabled or held.
