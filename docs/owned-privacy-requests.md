# Personal privacy requests, legal holds, retention gate and fulfillment

September 16, 2026. Original phase 3 (privacy and access). Source only: no
persistent migration, deployment, real data, operator run or paid build.

## What exists now

- Migration `20260916040000_production_owned_privacy_requests.sql`: an
  owner-scoped ledger of deletion/correction requests (idempotent by request
  identity, one open deletion at a time), per-store fulfillment records with
  evidence digests and operator attribution, workforce-placed legal holds that
  hold every open deletion, and a reviewed retention policy table with no rows.
- Consumer self-service (`POST .../personal/privacy-request`, `GET`, and
  `POST .../privacy-request/tombstone` with explicit confirmation): submission
  and listing need no feature scope and survive consent withdrawal; the
  tombstone call writes a tombstone revision for every live personal record
  under the owner lock, which also clears the active-plan pointer through the
  existing trigger. Tombstones keep history and are not physical erasure. The
  response carries a machine-readable coverage statement
  (`completeAccountDeletion:false`).
- Workforce-only operations (revalidated workforce identity plus an explicit,
  unexpired owner-scoped privacy-operator assignment, never a consumer):
  place/release legal hold, record a store's fulfillment outcome, complete a
  deletion request only when every store has an evidenced, reconciled final
  outcome and no hold exists, and
  physically purge retained personal history only with an approved, unretired
  retention policy version and a non-held in-progress request.
- `owned-privacy-fulfillment.ts`: an unconnected candidate orchestrator for the
  non-database stores. Lab jobs are enumerated from the owner inventory and
  driven through the existing cancellation/deletion outbox (receipt:
  late_upload_watch, not erased). Voice jobs are reported `not_enumerable` (no
  per-owner index). Identity deletion (disable, global sign-out, delete) runs
  last, only with explicit confirmation and no pending store. Device caches and
  recovery archives are `not_enumerable`; backups and audit are
  `pending`, not automatically retained by policy. Receipts carry counts and
  identifier fingerprints only. Do not connect this candidate to execution:
  it still needs request/hold authorization, complete inventory reconciliation,
  and verified store receipts. The newer operator-only retained-lab discovery
  reports non-snapshot limitations and does not authorize deletion.
- Migration `20260916050000_production_guardian_authority.sql`: workforce-
  reviewed guardian authority attestations (basis, evidence kind and digest,
  reviewer, expiry, revocation) readable by guardian or ward. It grants no
  access and seeds no rows.

## What it does not do

No request is fulfilled automatically; no store is reported erased without its
own receipt; backups and audit records are not erased; voice objects are not
enumerated; clinic records are a separate clinic-tier request. Acting as a ward
is deliberately unimplemented: every consumer operation still derives its owner
from the caller's own verified identity. Retention and legal-hold policy text,
the operational owner, response SLAs and the fulfillment runbook remain human
decisions. The rollback-only acceptance gains a `privacy_requests` stage; it has
not been executed against Aurora in this increment.

## September 17 fulfillment-safety repair

The additive `20260917010000_production_privacy_fulfillment_safety.sql` overlay
does not rewrite earlier migrations, approve policy, create operators or modify
any existing hold. Its protections are:

- A reviewed owner/operator assignment with evidence, expiry and revocation is
  required. Direct assignment-table access is denied to the API role. Assignment
  and identity rows are locked during an operation so revocation/disable cannot
  race an already-authorized database action.
- All workforce mutations acquire the same owner transaction lock as consumer
  writes and legal holds. Request status and actual holds are re-read under that
  lock. The earlier implementations are private helpers with API/public execution
  revoked, not alternate bypass routes.
- Deletion completion requires the latest receipt for **each of nine stores** to
  be `purged`, `not_applicable`, or `retained_by_policy`, with evidence and a v2
  fulfillment marker. `tombstoned`, `not_enumerable`, `refused`, `pending`, absent
  stores and legacy receipts keep the request incomplete. Earlier receipts are
  preserved and require explicit reconciliation rather than automatic upgrade.
- Retention requires a separate policy-bound receipt. Policy content must match
  its digest, approval must not be future-dated, and the policy must not be
  retired. Completion rechecks the receipt's exact policy digest. Policy rows
  are read-locked during the transaction. Retained data are not represented as
  erased; completion is fulfillment of the documented request, not total erasure.
- A deletion receipt cannot complete a correction request. Correction completion
  now refuses with `privacy_correction_resolution_required` until a separate
  target/revision-bound resolution workflow is implemented and verified. That
  workflow is remaining engineering, not a human-only blocker.

`owned-privacy-safety.database.test.ts` builds and executes all 58 production
migrations in an isolated PGlite PostgreSQL instance with fictional fixtures.
It tests actual role permissions, scoped assignments, hold checks, incomplete and
legacy receipts, policy integrity, correction refusal, owner-only views and a
nonempty personal-history purge that preserves the other owner's data and audit.
This is not hosted Aurora execution or multi-connection concurrency proof.
Local verification: all 21 new database tests pass; the complete Desktop suite
passes 1,875 tests with 11 existing skips. Typecheck, changed-file lint and the
58-migration production artifact gate pass. No persistent database was changed.

Before activation, the privacy operations owner must approve assignment and
retention procedures and review any pre-existing completed requests for missing
or weak evidence. Do not relabel old requests automatically. Store evidence is
an accountable operator attestation: a syntactically valid digest alone does not
prove an external system actually erased data. Hosted fulfillment, external-store
verification, correction resolution and cross-store execution remain open.
