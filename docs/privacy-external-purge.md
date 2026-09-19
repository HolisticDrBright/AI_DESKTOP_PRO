# Operator-led external purge and deletion completion

September 19, 2026. Original phase 3 increment, source only. Nothing deployed, no PHI, no paid build.

## The gap it closes

Before this change an assigned privacy operator could inventory an owner's lab and voice jobs
(read-only DynamoDB scans into a ledger) and purge Aurora personal history, but nothing
executed deletion of the inventoried external jobs, nothing recorded the reviewed disposition
of the remaining stores, and nothing completed the request. The unwired orchestrator in
`owned-privacy-fulfillment.ts` predates the inventory and marked voice as not enumerable.
The handoff named "operator-led cross-store deletion fulfillment" as remaining engineering.

## What changed

- Migration `20260919010000_production_external_privacy_purge.sql` adds a per-item purge
  ledger keyed to the inventory items and three functions. `begin_owned_external_purge`
  hands the trusted worker a bounded batch (at most ten) of inventoried items that are not
  yet terminal, together with the owner scope, under the request lock; it refuses held
  requests and inventories still scanning, and never lets the caller choose identifiers.
  `record_owned_external_purge_item` stores what the store reported; terminal outcomes
  (`cleaned`, `not_found`) are immutable, `claimed` and `refused` may be retried, and a
  refusal can be recorded while a hold is active so the ledger explains why, while a
  cleaned claim cannot. `finish_owned_external_purge` records the store's fulfillment only
  when every item is terminal: `purged` for an exhausted inventory with items, because the
  documents, audio and transcripts are gone and only metadata watch tombstones remain under
  retention; `not_applicable` for an exhausted inventory with no items; `pending` for a
  bounded inventory, because a bounded scan cannot prove the store empty. These are the only
  outcomes the existing completion rule accepts, which also means a device-cache disposition
  of `not_enumerable` keeps the request open until a reviewed `not_applicable` or retention
  decision replaces it.
- `privacy-external-purge.ts` executes one inventoried item. Lab jobs are fenced with
  `claimLabDeletion` (unfinished work is cancelled with a Step Functions stop) and purged
  with `reconcileLabDeletion`; cleanup records are reconciled; voice jobs are cancelled and
  advanced through the same guarded worker path the sweep uses, so a provider job still
  processing stays `claimed` for a later batch. Every remote mutation runs under the owner
  hold/identity guard, so a legal hold or closed identity refuses rather than deletes.
  Owner and organization mismatches refuse before any call.
- `privacy-operations.ts` gains `purgeExternal` (multiple short transactions: choose the
  batch, run each guarded mutation, record each outcome as reported, finish when complete),
  `recordDisposition` for clinic records and device caches (never a purged claim),
  `retainByPolicy` for backups and clinic records under a verified retention policy, and
  `completeDeletion`, which calls the existing nine-store completion rule.
- The workforce API gates `purgeExternal` behind inventory activation and its own reviewed
  evidence hash. The Lambda template adds a `PurgeActive` branch with pinned permissions:
  item-level DynamoDB reads and updates on the two tables, versioned deletes under
  `personal-labs/` and `personal-voice/` only, execution stops on the personal lab state
  machine only, and transcription job reads and deletes for `alp-personal-voice-*` only. No
  scans, object reads, puts or wildcard resources. The function timeout rises to 60 seconds
  for a ten-item batch.

## Verification

PGlite runs of the real migration artifact cover batch ordering and bounds, hold refusal and
recorded refusals while held, immutable terminal outcomes, exhausted versus bounded
fulfillment, the multi-transaction operation with an executor double including a crashing
executor, completion refused until all nine stores are terminal, disposition and retention
recording, and refusal of unassigned operators. Executor unit tests use mocked DynamoDB, S3
and voice service doubles. API tests cover activation gating and input validation.
Infrastructure tests assert the permission branch and its condition. Manifest count is 80.

## Not done

No hosted DynamoDB, S3, Step Functions, Transcribe or Aurora run. Consumer identity
deletion remains unimplemented: no operation can record `identity` as purged, so completion
still needs that store to be recorded through a future reviewed step. Retention and hold
policy content, operator assignments and activation evidence are human inputs and are not
seeded. A purged external store still leaves the lab cleanup watch record and the voice cleanup tombstone as metadata, and is not erasure of backups or audit records.
