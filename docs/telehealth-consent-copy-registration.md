# Exact telehealth consent copy registration

The telehealth registrar's transaction engine registers existing approved recording-consent wording on the exact 112-migration fictional qualification target. It never creates the approval or a patient consent grant. The engine is locally verified; it is not an installed AWS operator. A reviewed native target, interruption custody and hosted acceptance remain required before AWS registration.

## Separate release and scope

The input contract is `telehealth-consent-copy/112`, with scope `telehealth_recording`, artifact ID, organization ID, artifact version, exact text and its SHA-256. Text is not trimmed or newline-normalized. Only UUID spelling is normalized. Invalid UTF-8 representation, NUL, empty wording, over 16,000 UTF-8 bytes, additional approval fields and other scopes are refused.

`runTelehealthConsentCopyRegistration` accepts only the complete 112 source artifact, successor ledger `45aec4369ec94bf6339a17e47eadba7b81e7b5195fd5be46c2903e587b709fb4` and assembly `6cc191355442ae2c2349cab50466979eaab0e45961a4e1547f34785294dce4b9`. The actual database must be `clinical_core_qualification` in the fixed synthetic-account configuration, with PHI false and activation blocked. It checks the whole live ledger, not only the count or latest receipt.

Historical 105/106 copy registration and its wire scopes remain unchanged and refuse this successor. No count tolerance, changed parent SQL or broadened care-consent parser is used. Target verification checks the existing Fullscript extension, approved-copy functions and triggers, the exact new telehealth function, immutable-copy blocker, restricted table access and forced row-level security.

## Approval and transaction behavior

Registration requires the current approved artifact for the specified clinic and scope, matching the exact version and content digest. Its reviewer must still be an active production-bound workforce identity, with an active person and authorized membership in an active clinic. A newer approved artifact without registered wording supersedes the older one; the registrar must not fall back to the older copy.

Inventory and inspection are read-only. Writing uses the shared migration and fixture advisory locks, copy and ledger table locks, the existing scope serialization lock, and shared locks on reviewer authority. Rehearsal actually inserts and rolls back, then independently inspects the result. Registration inserts once; an identical existing copy remains immutable and is reported as present, not newly inserted. Conflicting text or linkage is refused.

The receipt states `approvalsCreated:false` and `grantsCreated:false`, and contains identifiers and hashes rather than the wording or clinical data. Registering approved wording must not grant recording consent. Patients must read and acknowledge it through the separate consumer consent endpoint.

An uncertain commit produces a fixed failure, not a success receipt or automatic retry. Read-only inspection can observe the exact registered copy while current approval authority still holds. Loss of authority or supersession is a refusal; it is not evidence that a stored copy was deleted. The native recovery layer must account for this distinction instead of using registration replay to guess a prior outcome.

## Local verification

```powershell
npm run test:telehealth-consent-copy-registration
```

Real embedded PostgreSQL tests exercise exact-text parsing, approval and reviewer authority, clinic and scope binding, stale release refusal, schema and permission changes, shared-lock denial, rollback, idempotent copy presence, failed inserts and uncertain commit replies. A registered copy is read through the actual restricted consumer consent function, with a second consumer denied and no consent grant created. Every identity, approval and record is fictional in memory. These tests do not prove concurrent-session locking or AWS behavior.

## Native and hosted work still required

Before exposing an AWS command, build a separate source-bound operator containing the exact 112 migration bytes. Bind a reviewed canonical target, operator digest, copy-file digest, artifact and clinic to actual STS and foundation observations. Reject substitutions and dirty source before AWS or database construction. Do not reuse the 105/106 command or pretend that a schema-upgrade target review approves consent wording.

Use the existing shared operator namespace and database fence, durable exact-copy admission, rollback rehearsal, bounded file reads, stopped-process recovery and repeated exact-target readbacks. An interrupted writer must retain its original custody; it must not be retired on a guessed copy-insertion result. Do not log the wording or claim a recovered observation proves the original response succeeded.

The qualification database was last observed at migration 107. The reviewed preserving predecessor and successor upgrades remain prerequisites. After registration, qualify the matched published consent API, current and superseded copy, withdrawal and renewal, host/patient Zoom behavior and physical V2 journeys. Consent wording, provider coverage and policy approvals remain separate human gates. PHI and paid mobile builds remain disabled or held.
