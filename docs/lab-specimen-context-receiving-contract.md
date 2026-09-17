# Clinic lab specimen context — receiving contract

September 16, 2026. Source increment within original phases 2/3/4/6.
This is NOT a deployed or complete V2-to-Desktop workflow.

## What is implemented

The separate `lab-specimen-context/1` command associates supplemental context
with an already imported lab event, its exact content SHA-256 and collection
date. It does not expand the existing `lab-result/1` payload or consent.

- Recorded completed age at draw (days/months/years), sex, assay identifier and
  optional reproductive dimensions. Unknown values stay null. No DOB, names,
  free-text history, clinical approval or guessed current-profile context.
- Provenance is always patient_reported / unverified. Neither receipt nor
  practitioner lab-result acceptance verifies the assay or activates held ranges.
- Current lab-import consent plus an exact version of the independently approved
  lab_specimen_context consent is required. Its artifact version is
  lab-specimen-context-consent/1. Reproductive dimensions additionally require
  the exact current reproductive_health grant. Self-authorized patient-app grants
  are supported; this does not implement guardian verification.
- Existing provider approval is insufficient: sync_providers needs its independent
  lab-specimen-context/1 capability, reviewer and review timestamp.
- Connection/owner/organization, event ownership, original result hash, collection
  date and active provider are checked in the receiving transaction.
- The connection lock is acquired before consent reads, matching grant/revoke
  ordering; the lab event is locked before allocating the next revision.
  No external network request is performed while locks are held.
- Immutable revisions, request IDs and content hashes protect against replay with
  changed content. An exact duplicate returns the original receipt; stale revision
  or request reuse with different content conflicts. Withdrawal/re-grant cannot
  authorize replay of the old command.
- Minimal database grants: API SELECT through RLS; inserts only through the
  security-definer function with an empty search path. No API update/delete.
  The function writes an audit event without embedding clinical context.
- Bounded error categories distinguish consent/conflict from temporary service
  failure. SQL, secrets and provider error text never become client messages.

## Routes and contracts

All routes use the corresponding Cognito JWT authorizer:
- POST /clinical-core/consumer/labs/specimen-context
- GET /clinical-core/consumer/labs/specimen-context?eventId=<uuid>
- GET /clinical-core/workforce/labs/specimen-context?eventId=<uuid>

POST returns lab-specimen-receipt/1 with context/event/request IDs, revision,
content SHA and received timestamp. GET returns null or a strict
lab-specimen-record/1 with the latest revision, original lab SHA and context.
Consumer reads are limited to their linked chart; workforce reads require a
clinical role in the same organization. Previously disclosed clinic records are
not erased by consent withdrawal; approved retention/deletion rules remain work.

The synthetic migration 20260916080000 and equivalent production overlay are
registered but NOT applied to AWS. Neither seeds an approved artifact/provider.
Both existing production pilot policies still refuse these routes and the new
consent scope. A reviewed policy expansion is a separate activation requirement.

## Verification and limitations

Local checkpoint: V2 1,427 tests passed / one existing hosted skip; Desktop
1,758 passed / 11 existing skips. Both typechecks passed; V2 lint is clean,
Desktop lint has zero errors / four pre-existing warnings. V2 capability gate,
Desktop authenticated API gate/build and production migration/API gates/build
passed. This is source/in-memory execution evidence, not cloud or device evidence.

Tests execute the actual new SQL against in-memory PostgreSQL using PGlite and
pgcrypto, with the API role, request context and RLS enabled. They cover real
inserts/revisions/duplicates, different users/organizations, direct-write denial,
content/date binding, reproductive grants, provider suspension, withdrawal and
re-grant, and an application-adapter-to-SQL round trip. Tests also check the HTTP
identity/shape boundary, sanitized errors and production-policy refusal.
The PGlite dependency is test-only. Its execution is not Aurora acceptance,
multi-session concurrency testing or a full production migration-chain test.

V2 has the matching versioned contract. Its ordinary lab import now omits legacy
UI-only range bounds when reportedReferenceRange is absent. Changing from an old
fallback to real reported bounds changes the content fingerprint and can require
review; it does not authorize automatic chart replacement. A test clock race in
the inventory fixture is fixed without weakening runtime drift checks.

## Required next steps (not completed)

1. Explicit V2 context preview/selection, approved consent presentation, independent
   grants/withdrawal, immutable consent-bound send/retry journal and export mapping.
   Bind selection to the exact successful lab receipt, not name-based matching.
2. Desktop per-result context/provenance display with honest missing/withdrawn/
   unverified states; no automatic clinical range activation.
3. Integrate context history into full privacy export, approved retention,
   correction/deletion/legal-hold handling and cross-device receipt discovery.
4. In synthetic AWS: reviewed migration application, approved synthetic consent
   artifact/provider configuration, exact API deployment, two-account HTTP tests,
   concurrent revoke/write/revision tests and rollback verification.
5. Only after receiving API acceptance, authorize a mobile candidate and perform
   physical V2-to-Desktop tests. No paid mobile build is authorized by this work.
6. Production policy/signatures, source verification, relevant agreements and
   original commercial/provider/device gates remain separate. PHI stays disabled.

All six original commercial phases remain partial/incomplete.
