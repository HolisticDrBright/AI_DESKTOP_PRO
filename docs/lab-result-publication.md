# Durable cloud publication of completed lab results

September 18, 2026. Original phase 2 increment, source only. Nothing deployed, no PHI, no paid build.

## What changed

- A completed lab analysis is now published as one owner-scoped `lab_analyses` record in personal storage (`src/contracts/personalLabAnalysis.ts`, `src/server/clinical-core/owned-lab-publication.ts`). The record carries the whole completed result plus job id, kind, completion time, result hash and `sourceStatus: consumer_lab_analysis_unreviewed`. It is a consumer-education copy, never a reviewed plan or clinic record.
- Record and request identities derive deterministically from the job id and result hash, so a retried publication after a lost response replays the same command and the store returns the same revision. A prior identical copy counts as published; a different copy is a `record_conflict` refusal.
- Consent is bound to the job's captured `lab_history` revision; a withdrawn consent or an account under deletion refuses (`lab_consent_required`, `account_deletion_write_blocked`) and storage outages stay `pending`. Publication never changes the job's result, delivery claim, acknowledgment, transfers or any plan state.
- Migration `20260918010000_production_owned_lab_analyses.sql` admits the collection under the `lab_history` scope, raises the byte budget to 256 KiB for this collection only (every other collection keeps 16 KiB, in both the table constraint and the write function), and validates the envelope with a trigger. Verified against the built migration artifact in PGlite: replay, revision conflict, owner isolation, budget enforcement per collection and malformed envelope refusals.
- The production worker publishes after the terminal pass has durably stored the result and records the receipt on the job; a publication failure is recorded as `pending` and never fails the pass. `POST /clinical-core/consumer/labs/jobs/{jobId}/publication` republishes idempotently for retries and returns the receipt; synthetic mode reports it unavailable. Job status and inventory descriptors expose only the receipt (`status`, `resultSha256`, `at`, `recordId`, `revision`, `reason`), never the stored copy.
- The owned lab API re-verifies the job's consent binding before publishing; the owned worker Lambda does the same.

## Verification

Unit tests cover envelope derivation, deterministic ids, consent binding, refusal and pending paths, conflict handling and receipt projection; a PGlite run of the real migration artifact covers the database rules above; the lab API route table grows to 36 routes with matching template output. These are mocked-store and local-database checks, not hosted DynamoDB, Aurora Data API, JWT or physical-device acceptance.

## Not done

Hosted publication acceptance against the deployed candidate, Aurora rollback-only run of the new migration, privacy-fulfillment integration of the new collection beyond the generic owned-record export/tombstone paths, and the mobile restore path's physical verification. Publication is not clinic delivery and does not adopt or replace any plan.
