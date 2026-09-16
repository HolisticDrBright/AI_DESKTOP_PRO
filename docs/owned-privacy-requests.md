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
- Workforce-only operations (revalidated workforce identity, never a consumer):
  place/release legal hold, record a store's fulfillment outcome, complete a
  request only when every store has a terminal outcome and no hold exists, and
  physically purge retained personal history only with an approved, unretired
  retention policy version and a non-held in-progress request.
- `owned-privacy-fulfillment.ts`: an attributable, bounded orchestrator for the
  non-database stores. Lab jobs are enumerated from the owner inventory and
  driven through the existing cancellation/deletion outbox (receipt:
  late_upload_watch, not erased). Voice jobs are reported `not_enumerable` (no
  per-owner index). Identity deletion (disable, global sign-out, delete) runs
  last, only with explicit confirmation and no pending store. Device caches and
  recovery archives are `not_enumerable`; backups and audit are
  `retained_by_policy`. Receipts carry counts and identifier fingerprints only.
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
