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

- Hosted deployment acceptance of the typed workforce API and Desktop consent
  integration below; capture UI/transport still requires implementation.
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

## September 17 Desktop consent integration (not capture activation)

The actual encounter page now selects the AWS consent workspace by default.
Only an allowed local contract fixture with no recording AWS origin selects the
legacy scribe UI. Every legacy scribe adapter transport also enforces that
restriction, including direct calls to the old binary upload endpoints; a
missing AWS capture implementation cannot fall back to a retired host.

The new same-origin POST proxy uses only the request-scoped workforce cookie,
never the demo session fallback, a browser-supplied identity or an organization
override. Configure the separately deployed authority API's root HTTPS gateway
origin as `RECORDING_AWS_API_ORIGIN`. It is not the compatibility API origin.
The proxy rejects cross-origin writes, malformed/oversized bodies, redirects,
unexpected response fields, wrong encounter/release IDs and modified document
content. Network/body waits and response bytes are bounded; no response body,
token or raw upstream error is logged. Responses are non-cacheable.

The screen requires explicit reviewed locale/jurisdiction, reviewed capacity
selection and presentation of the exact version/hash-bound document before a
scope-specific grant. It displays effective consent separately from historical
grant status and supports withdrawal. Representative evidence cannot be entered
as free text; that workflow remains unavailable. Audio capture/transcription/AI
drafting are explicitly unavailable, not presented as successful setup.

Uncertain participant/grant writes preserve their exact command ID in memory
for retry, prevent another mutation while confirmation is pending and reload
the authoritative workspace after success. No consent, participant data or
credentials are persisted in browser storage. Encounter navigation remounts
the workspace and aborts unfinished requests. A saved change whose read-back
fails is reported as saved with unavailable read-back, not as a failed write.

Evidence: 70 focused proxy/API/SQL/operations tests passed before the additional
three legacy-transport refusal cases. Final full units: **2,171 passed, 11
existing skips, 193 files**. Typecheck and changed-file lint passed. Browser
presentation and real unauthenticated-proxy verification are in
`e2e/aws-recording-consent.spec.ts` and a dedicated CI job. Fictional UI HTTP
responses do not prove a hosted AWS/database round trip; the independent SQL
suite exercises actual production migrations. The initial browser cache-header
assertion expected only no-store, whereas the application adds no-cache and
must-revalidate. The assertion now checks the required no-store directive;
the initial trace is retained. Final browser rerun: **5 passed**, including
the actual browser-to-Desktop unauthenticated-cookie refusal. No security
assertion or timeout was relaxed.

Prior API-source evidence: V2 83236a1 CI35268055386 passed. Desktop 76dcc07
CI35268046775 was still running when checked. Desktop00f5ed8 CI35266197149
completed with a live-browser failure: 292 passed, 19 skipped and 2 unrun;
the EMR autosave test timed out waiting for a POST immediately after Next
reported a memory-threshold server restart. This new evidence needs a separate
harness/runtime investigation; passing focused consent tests does not resolve it.
Fresh AWS ai-synthetic-staging authentication still requires user re-login.
No schema was applied, AWS deployment changed, real approval invented, PHI
enabled or paid mobile build started. All six original phases remain open.

## September 17 durable segment increment (internal service; not activated)

Overlay `20260917090000` adds three private/default-deny tables: separately
reviewed storage releases, durable segment reservations/receipts and immutable
segment events. The artifact now contains **66 migrations**, with no seeded
storage destination, qualification, clinical consent or approval.

The storage release is immutable apart from one-way retirement, linked to the
exact capture release, hash-bound, expiring and restricted to its AWS region,
bucket owner and KMS key. It is not selected by the browser. The storage
qualification must eventually prove versioning, IAM/KMS, retention and provider
configuration; merely filling these fields does not demonstrate those controls.

Upload sequence:

1. Validate actual bytes/digest/size, then reserve under the encounter lock.
   Authorization rechecks workforce, patient scope, token, participant roster,
   recording consent, authority epoch and both reviewed releases. The reservation
   snapshots participant/grant IDs and establishes a bounded acceptance window.
2. Release the database transaction, then conditionally PUT to the exact S3 key
   with SHA-256, expected bucket owner, SSE-KMS and minimal capture metadata.
   No presigned URL, overwrite or delete operation is exposed. Per-request
   network waits and total upload work are bounded; regional SDK clients are reused.
3. HEAD the exact object version (or recover a lost PUT response by inspecting
   the existing object), requiring a full-object checksum, byte count, content
   type, KMS key, non-null version and matching capture/session/epoch/segment
   metadata. A generic success acknowledgment is not a receipt.
4. Reacquire database authority in a separate transaction. Accept only if consent,
   token, epoch, release and reservation still permit it. Return a small receipt,
   never an object key, token or provider response. A stored receipt can be retried
   without another PUT, but still requires current authority.

Ordering is contiguous with one unresolved segment at a time. Conflicting retries
refuse; exact retries keep the same key/reservation. Reserved bytes count toward
the whole-recording limit. Maximum segment size is 4 MiB, further constrained by
the reviewed policy; the sequence ceiling is 4096. Provenance and accepted
receipts cannot be rewritten. Unknown outcomes remain `reserved`, not `stored`.
The indexed reservation inventory is the basis for later reconciliation; it is
not an implemented cleanup scheduler. No automatic deletion is attempted after
uncertain upload, because retention/legal holds must control that operation.

The SDK contract follows AWS's [conditional write rules](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)
and [version/checksum HEAD contract](https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html).
Retrieving KMS-encrypted checksums requires the corresponding KMS permissions;
the future deployment must scope them to the reviewed bucket/key.

Evidence: **160 focused tests passed**, including actual canonical SQL through
the typed repository/uploader, authority withdrawal during simulated storage,
no network call under a database lock, malformed storage policy, provenance,
immutable receipts, byte/order limits, expired leases, conditional retry,
cross-actor denial and mismatched object evidence. The storage provider in these
tests is simulated; the SQL is real PGlite PostgreSQL, not hosted Aurora.
Full suite: **2261 passed, 11 existing skips, 196 files**. Typecheck, changed-file
lint and the 66-migration/no-seeded-row gate pass. An initial test-only SDK
overload typing issue was corrected before the final typecheck/full run.

Still required before activation: HTTP/binary API deployment and IAM/KMS/bucket
qualification; capture UI/start/credential rotation/pause/resume/disposition;
durable reconciliation and hold-aware object/provider deletion with receipts;
provider processing and versioned transcript/correction/review-only drafts;
actual multi-connection Aurora, S3, browser microphone, Safari and recovery tests.
The authority API continues to report `audioCapture:false`; existing deployed
workloads have not changed. This increment does not close original phase 2 or 6.

Prior-source evidence: Desktop dd3694e CI35272294502 remained in progress at
check; older6834e76 CI35270244009 failed after another dev memory restart.
V2 db2f974 CI35272303130 succeeded. Fresh STS again reports expired credentials;
user re-login requested. No AWS schema/deployment, PHI activation or paid build.
