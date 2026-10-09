# Personal account deletion: prevent later cloud writes

September 17, 2026. Original phases 1/3 increment, not a completed phase.
Source only. No live migration, deletion, account closure or activation occurred.

## Behavior

Migration 77 adds database guards for new personal record versions, new consent
grants and active-plan insertion/update. A deletion request in submitted, held,
in-progress or completed state fences these writes for that owner. Refused
deletion requests and correction requests do not. A single-record tombstone
does not close an account. Completed requests remain fenced; signing in again
does not reopen storage. There is no new consumer bypass or reactivation API.

The guards use the existing owner transaction lock, which privacy submission,
fulfillment and normal writes already acquire. They read the ledger under that
lock rather than trusting a client flag or cached request state. A partial index
supports the check. Guard helpers have no public/API execute privilege. Existing
consent, identity, revision, idempotency and legal-hold checks remain in place.
PostgreSQL safety guidance informed the short transaction and minimum privileges.

Retained reads, export, privacy-request review, consent withdrawal, permitted
tombstones and plan release still work. An exact historical idempotent retry
may return its old receipt without inserting new data; it is not a new save or
evidence that the current record is live. No record content is erased by this
overlay. Holds remain authoritative for destructive operations.

The authored SQL refusal is sanitized to `account_deletion_write_blocked`,
returned with HTTP 403/no-store and preserved by the V2 adapter instead of being
mistaken for an expired login. V2 explains the pause, discloses it before deletion
confirmation and no longer promises instant removal of local copies on every
phone. Client copy/error support must ship with the backend change before this
feature is activated. Existing requests must be reviewed before migration: this
is intentionally effective for already submitted/completed deletions too.

## Verification and limits

Local results: Desktop 2,856 unit tests passed / 11 existing skips (221 files);
V2 1,623 passed / one existing hosted skip (139 passing files). Both typechecks
and lint passed; Desktop retains four pre-existing warnings. The 77-migration
zero-seed gate, V2 capability/TestFlight-source gates and actual personal-storage
Lambda build passed. These are not deployment or device evidence.

Eight new PGlite tests execute the canonical production migration artifact with
fictional identities and approvals. They test every fenced state, update/new
record refusal, owner isolation, old-receipt replay, read/export/withdrawal,
tombstones, resurrection refusal, plan insert/update, plan release, holds,
refused/correction exclusions and privilege/direct-SQL bypass resistance.
The existing 44-case privacy suite remains intact. Its shared fictional owners
are reset between tests; intentional historical-backup corruption fixtures
temporarily disable only the new triggers, then restore them, to keep testing
the independent inventory/receipt defenses. This is not a runtime escape hatch.
API and Aurora-driver tests verify the sanitized refusal. V2 exercises the actual
adapter over a mocked transport and checks disclosure text; no native rendering
or physical-device acceptance is claimed.

Migration 78 (next source increment) extends checkpoints into lab/voice processing;
see below. This is still **not** a complete account-wide write stop: object uploads,
clinic sharing, external providers and in-flight jobs need coordinated closure
and deployed race testing. Local caches/recovery archives are not wiped.
Offline and other-device reconciliation, retention-approved fulfillment of every
store, hosted Aurora multi-connection contention, backup restoration and exact
release/device qualification remain open. Never treat this fence as proof of
erasure or completion of a privacy request.

Build 70 and its matching synthetic API remain at c5b4d61. This source increment
is not in that mobile binary. No duplicate paid build was started. Hosted Desktop
still requires renewal of the named ai-synthetic-staging AWS login. All PHI,
clinical/source-verification, provider and activation gates remain unchanged.

## Processing-checkpoint increment: migration 78

The owner-scoped processing-consent function reads AI plus lab/voice consent
under the same short owner lock as the deletion ledger check. The adapter checks
the snapshot version, owner, operation, both scopes, revisions and signed-copy
hashes. No owner supplied by the caller or unsigned approval is accepted.
Privacy-only consent reads remain separate so withdrawal/export/cancellation are
not prevented by closure. API permissions expose only the scoped function.

Lab/voice admission and their existing authorization checkpoints now distinguish
account closure from expired credentials, consent withdrawal and temporary service
failure. Lab extraction checks each document and checks again before each result
artifact write. Voice queued work stops before provider dispatch when closed;
transcripts are withheld if closure is detected after the transcript read. V2
stops voice polling on the explicit refusal, attempts cancellation and directs the
user to their privacy request instead of asking them to log in or grant consent
again. Cancellation failure is not represented as cleanup success. Lab generation
also preserves the specific refusal. React review retained existing hook/session
boundaries; no automatic retry or regrant effect was added.

Local full verification: Desktop 2,875 passed / 11 skips (221 files), V2 1,625
passed / one hosted skip (139 passing files); both typechecks/lint passed, with
four unchanged Desktop warnings. The 78-migration zero-seed gate and V2 capability
and TestFlight-source gates passed. Ten deletion-fence SQL tests now include the
actual adapter and lab/voice authorization policies over canonical migrations,
owner isolation and preserved privacy reads. Targeted tests cover provider-return
closure, suppressed artifact/publication, malformed snapshots, error sanitization,
queued voice cancellation and transcript withholding.

Lab, voice and personal-storage Lambda candidates built. Actual built lab/voice
APIs returned 503/no-store/phiAllowed:false with fictional blocked configuration;
the built lab worker refused production_not_activated. No real provider was called.

Deployment order: apply the reviewed migration artifact before the dependent
backend, ship V2's refusal handling, then synthetically qualify the exact release.
These checkpoints are NOT a lease across provider/S3/DynamoDB operations. A deletion
can race between a successful check and an external action; already-issued upload
URLs, late uploads, pending provider work and Step Functions retries remain separate
coordination work. No atomic multi-store closure, completed erasure, deployed Aurora
race proof or physical-device acceptance is claimed. This is an original phases
1/2/3 increment, not a newly completed phase. Build 70 remains unchanged.
