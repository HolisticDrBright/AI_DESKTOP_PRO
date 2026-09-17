# AWS encounter recording authority — source candidate

September 17, 2026. Original commercial-readiness phase 2; not an enabled
recording service, deployed migration, or completed release phase.

## Implemented boundary

The production overlay `20260917070000` adds nine private, default-deny tables
for encounter controls, participants, reviewed consent documents, representative
authority, immutable grants/withdrawals, reviewed capture configuration, capture
sessions and immutable authority events. No rows or approvals are seeded.
The canonical migration manifest and zero-seed verifier include the new tables.

Five narrowly granted database commands add a participant, record consent,
withdraw consent, begin capture and verify capture authority. Each rechecks the
AWS workforce identity, organization membership, clinical role, active patient
and encounter scope. The encounter row serializes roster/consent/capture changes;
no network work happens while that transaction is held.

Every participant needs a current recording grant before capture starts.
Transcription and AI drafting each require their own grants. Consent content is
bound to a reviewed release hash. Non-self-consenting participants need separate,
reviewed, participant-specific representative evidence, not free-text authority
supplied by the consent command. Evidence may be revoked once, not rewritten or
un-revoked. This is not a completed guardian eligibility/jurisdiction workflow.

Capture configuration is separately reviewed, hash-bound, expiring and
retirable. Missing/null/unsupported fields refuse use. There is no automatic
approval based on the existence of a BAA. The current configuration shape is
only the first authority contract; storage/KMS routing and actual provider
qualification still need implementation before activation.

Capture tokens are random, short-lived, stored only as hashes, and bound to
the actor, recording, session and authority epoch. A replayed start returns a
receipt without the secret and cannot silently resume. A late participant
pauses capture. Withdrawal of any scope revokes capture; later re-consent cannot
revive the old token. Every authorization rechecks releases, representative
authority, membership and consent. Audit rows omit names, consent text and tokens.

## Evidence and limits

The database test executes all 64 canonical production migrations in PGlite
with pgcrypto, checks empty new tables before fixture insertion, then runs only
fictional records through the real SQL as the API role. Eighteen cases cover
permissions, cross-account denial, unsigned/invalid releases, idempotency,
separate consent scopes, late joins, withdrawal, expiration, token/session/actor
binding, null/missing policy fields, atomic failed starts, immutable evidence,
representative revocation and loss of workforce membership.

This is executable PostgreSQL evidence, not hosted Aurora, multi-connection
locking or physical microphone acceptance. It does not demonstrate uploaded
audio, a transcript, a clinical draft or a deletion receipt.

Typecheck, changed-file lint and the canonical 64-migration production gate
pass. Full unit verification with two workers: **2,095 passed, 11 existing
skips, 189 files**. The first unrestricted-worker run failed three existing
lab/voice/privacy subprocess timeouts (2,092 passed); the subsequent two-worker
run passed without raising timeouts or weakening assertions. The new SQL suite
passed in both runs. AWS synthetic credentials remain expired on a fresh STS
check, so no hosted verification or schema application is claimed.

## Remaining implementation (do not activate this layer alone)

- Typed workforce API/adapter and UI read/write integration; no browser direct
  database access. Desktop currently still calls the transitional scribe routes.
- Participant/capacity/guardian verification and reviewed jurisdiction-specific
  consent release workflow; no invented signatures or approvals.
- Durable per-segment consent provenance; explicit pause/resume, short-lived
  credential rotation, lost-token recovery and revoked-session disposition.
- S3/KMS upload transport, bounded memory/deadlines, chunk identity/deduplication,
  receipt reconciliation and independently verified byte/type/size limits.
- Provider processing reauthorization, transcript versions/corrections,
  provenance and review-only proposed notes without overwriting signed notes.
- Hold-aware retention/deletion across audio, transcripts, provider artifacts
  and backups, with actual receipts rather than a status-only claim.
- Deployment/configuration/rollback, concurrent request testing and physical
  microphone/Safari/provider/restore acceptance. No paid mobile build or PHI
  activation has been performed.
