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

This protects the personal PostgreSQL stores only. It is **not** a complete
account-wide write stop: lab/voice job admission, object uploads, clinic sharing,
external providers and in-flight jobs still need their own coordinated closure
checks and deployed race testing. Local caches/recovery archives are not wiped.
Offline and other-device reconciliation, retention-approved fulfillment of every
store, hosted Aurora multi-connection contention, backup restoration and exact
release/device qualification remain open. Never treat this fence as proof of
erasure or completion of a privacy request.

Build 70 and its matching synthetic API remain at c5b4d61. This source increment
is not in that mobile binary. No duplicate paid build was started. Hosted Desktop
still requires renewal of the named ai-synthetic-staging AWS login. All PHI,
clinical/source-verification, provider and activation gates remain unchanged.
