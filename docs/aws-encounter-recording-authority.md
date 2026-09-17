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

## September 17 consent workspace and deployable API increment

Overlay `20260917080000` adds retry-safe participant commands and immutable
consent-workspace access audit events. The API role can no longer call the old
non-idempotent participant function. Exact replay returns the same participant
without changing the roster, consent or epoch; a changed actor/payload conflicts.

Workspace reads return at most 20 participants, their latest three consent
scopes, one open capture, and the newest reviewed document per scope matching
the **explicit** locale and jurisdiction. They do not fall back to another
jurisdiction. Exact document content is retrieved separately by release ID.
Expired/revoked representative evidence makes consent ineffective. No capture
secret, token hash, acknowledgment or representative evidence is in the read
response. Successful reads append minimal immutable access events.

`POST /clinical-core/workforce/encounter-recording/authority` now has a typed
request/response boundary and fixed SQL operations for `workspace`,
`readConsentRelease`, `addParticipant`, `grantConsent`, and `withdrawConsent`.
Unknown fields/actions, identity overrides, free-text representative authority,
oversized bodies, malformed UTF-8/base64 and unverified header identity refuse.
API Gateway JWT verification is mandatory; the handler additionally validates
the exact workforce pool/client, configured organization, production binding,
verified email, expiration and fresh authentication. Workforce-pool MFA review
is a separate deployment requirement, not inferred from a token.

The lazy Lambda and `npm run build:aws-recording-authority` generate a bundled
handler and deployment template. Default is PHI false/activation blocked with
logs-only IAM. Database access requires separate activation, database and MFA
evidence plus an alarm destination. IAM is resource-scoped, code object version
is pinned, logs are encrypted/retained, concurrency is bounded and only the
workforce JWT route exists. There are no S3/audio/transcription permissions.
The API always reports `audioCapture:false` in this increment.

The focused suite passes 114 tests across actual SQL, API, typed operations,
RDS refusal mapping and deployment packaging. The local integrated flow executes
the real API handler and SQL to create a participant, replay safely, read the
document, grant consent and withdraw it. It also denies cross-account reads.
The actual compiled blocked handler runs without database/AWS credentials and
returns 503. These are local release-candidate tests, not deployed acceptance.
Final verification for this increment: full Desktop unit suite **2,142 passed,
11 existing skips, 192 files** with two workers; typecheck, changed-file lint
and canonical 65-migration gate pass. An initial test-only TypeScript narrowing
error was corrected. Prior-source Desktop9258110 CI35263941810 is SUCCESS;
Desktop00f5ed8 CI35266197149 was still running when checked. Neither is proof
of this newer source's CI, deployment, live database concurrency or microphone
acceptance. Original commercial-release scopes and clinical holds are unchanged.

## Remaining implementation (do not activate this layer alone)

- Desktop proxy/UI integration with the new typed workforce API, plus hosted
  deployment acceptance. Desktop currently still calls transitional scribe routes.
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
