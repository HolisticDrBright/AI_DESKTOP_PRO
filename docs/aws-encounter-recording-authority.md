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

## September 17 lifecycle increment (internal repository; not activated)

Overlay `20260917100000` brings the canonical artifact to **67 migrations**.
It adds default-deny immutable command receipts, inventory-bound dispositions,
and lifecycle access/command events. No consent, policy, storage or approval
rows are seeded. The same encounter-before-capture lock order applies; no
external storage/provider work runs under the transaction.

The owning, currently authorized practitioner can read a bounded recovery state
and explicitly pause, resume, renew, finish or discard. Credential-version
compare-and-swap prevents stale-device commands from silently taking control.
A repeated command returns a historical receipt, **never a capture secret**;
the caller must reread current state and explicitly renew after a lost token.
The fresh token is returned once, only its hash is stored, and renewal is bounded
by the original retention deadline and current capture/storage releases.

Recovery rechecks the same roster epoch, recording grants, active encounter,
workforce/patient access and qualified releases. Re-consent cannot revive a
revoked capture. A late participant requires disposition of the existing
capture followed by a new session; old bytes retain their original provenance.
Both finish and discard bind to the exact reviewed inventory digest. Finish
requires at least one verified stored segment and no unresolved reservation.
Discard can close a revoked/pending capture but does not remove pending rows,
silently call a provider or claim deletion. Both return `processingRequested:false`
and `audioDeleted:false`. The immutable disposition is evidence for future
processing/hold-aware cleanup, **not an implemented cleanup worker**.

The typed server repository uses fixed parameterized SQL, bounded strict schemas,
request/response correlation and sanitized database refusals. Recovery state
contains counts and a digest, not private object keys, participant names or
credentials. It does not recover missing local audio bytes or supply a browser
recording UI. A future HTTP route must verify fresh workforce login; a capture
token alone is never login authority. No such route is activated by this change.

Executed verification: **191 focused cases** across lifecycle, real SQL,
database-refusal mapping and canonical artifact tests; **2340 full unit tests
passed, 11 existing skips, 197 files**. Typecheck and lint pass (four existing
unrelated lint warnings); the67-migration/no-seeded-row gate passes. Real SQL
tests cover cross-user/default-deny access, expiry, lost response, stale-version
rejection, withdrawal, late joins, release retirement, inventory changes,
unresolved segments and immutable disposition. PGlite serializes the concurrent
test requests; it proves CAS behavior, not independent Aurora connection locking.
An initial test-adapter TypeScript narrowing error was fixed before final checks.

Still engineering: authenticated binary/lifecycle routes, capture UI and durable
local recovery, storage reconciliation/hold-aware cleanup, provider processing,
transcript/correction provenance and review-only drafts. Still external evidence:
qualified AWS resources, actual Aurora/S3/provider execution, browser microphone,
Safari/physical-device recovery and permission withdrawal. `audioCapture:false`
remains unchanged. No AWS migration/deployment or paid mobile build occurred.

The earlier full-browser harness run Desktopdd3694e/CI35272294502 now **passed**
(295passed/19existing skips, actual memory probe inspected, no dev restart).
V2b206b7e/CI35274202914 passed. These are source/CI results, not PHI activation.
All six ORIGINAL commercial-readiness scopes remain incomplete.

## September 17 authenticated transport candidate (not deployed)

The new separately activated workforce API connects the existing lifecycle and
segment services. All routes are POST under `/clinical-core/workforce/encounter-recording/`:

| Route suffix | Request | Result |
| --- | --- | --- |
| `start` | Encounter/command IDs and allowed audio MIME type | Qualified start receipt; credential returned only once |
| `state` | Recording ID | Current bounded state and inventory digest, no storage key/token |
| `command` | Action, expected credential version, command ID and required disposition digest | Historical retry-safe or new lifecycle receipt |
| `segment` | Raw audio plus bounded `x-alp-*` identity/sequence/hash/token headers | Verified stored-segment receipt only |

The request identity comes exclusively from API Gateway's verified workforce JWT.
Consumer/wrong-organization/unverified/expired/stale-auth identities refuse before
service construction. No identity override, query-string credentials, arbitrary
storage destination, provider selection or token-only login is accepted. Upload
requires canonical Gateway base64, a supported MIME type, at most4MiB of actual
bytes, bounded metadata and a matching digest. Duplicate/combined metadata headers
refuse. The declared MIME type must match the capture before S3 is touched.
Responses are strict, non-cacheable and sanitized. The configured capture release
is server-owned, not chosen by a browser request.

Canonical overlay `20260917110000` adds storage-qualified start: both reviewed
releases must be valid before a capture is created, and the initial token expiry
is capped by those releases and the original retention deadline. The artifact has
**68 migrations, zero seeded rows**. No reviewed destination or consent is invented.

Build: `npm run build:aws-recording-capture`. The same reviewed builder still emits
the independent consent-only candidate by default. Capture creates
`dist/aws-clinical-core/recording-capture/`: **index.js AND recording-capture-runtime.js
must both be packaged**. The artifact manifest binds both files and template.json
with byte counts and SHA-256s. The small handler does not initialize database/S3
SDKs for blocked, unauthenticated or malformed requests. The authorized runtime
reuses clients across warm calls while rechecking database authorization each time.
Sanitized authored errors preserve their bounded categories across the two bundles.

The candidate defaults to blocked/PHIfalse and logs-only IAM. Activation separately
requires capture/storage/retention reviews in addition to workforce/database/
activation evidence and an alarm recipient. Four JWT routes and four exact
invocation permissions expose no function URL. Active permissions scope RDS and
secret/KMS access; S3 read/version-read/conditional-write is restricted to the
configured bucket/organization prefix and account, with the specified encryption
key. The write permission additionally requires the `If-None-Match` header, matching
AWS's [conditional-write enforcement](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes-enforce.html).
There is no delete/list/provider permission. Logs are encrypted/retained;
Lambda errors/throttles and API5xx alarms have the reviewed destination. Resource
qualification must still prove bucket versioning/retention/holds, IAM/KMS and
metadata-only gateway logs. Hash fields alone are not that proof.

The envelope follows AWS [HTTP API payload2.0](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-lambda.html)
and [Lambda synchronous payload limits](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html).
The4MiB audio ceiling leaves room for base64 expansion and the request envelope.
Actual hosted limit/timeout/concurrency qualification remains required.

Evidence: **202 focused API/SQL/repository/segment/artifact cases passed**, plus
the4new capture-infrastructure checks and existing consent candidate tests in
the full run. **2384 full tests passed,11existing skips,199files**; typecheck,
lint (4existing unrelated warnings) and68-migration gate pass. The actual bundled
blocked handler executes without SDK/runtime loading or usable AWS credentials.
Actual API→repository→canonical SQL tests exercise start/replay, altered-byte
refusal, versioned storage receipt/retry, state, finish and withdrawal during
upload. Storage is simulated; PGlite is not hosted Aurora and test claims are
fictional, not proof of Cognito configuration. Separate RDS-envelope tests cover
deployed refusal mapping. No actual audio, network storage or PHI is used.
A separate local compiled-handler probe with fictional reviewed parameters and
deliberately missing database configuration also confirmed that the authorized
branch loads the second runtime file and returns only service_unavailable, not
raw configuration details. It makes no database request and is not activation.

Retained failed evidence: eager monolithic SDK import exceeded the new test's
5second default deadline; a diagnostic placed the delay during module import,
not the blocked request. Splitting SDK initialization out of the blocked path
resolved this check without increasing the deadline (child execution is bounded
to4seconds). A reserved-variable lint issue was corrected before final checks.

Still needed: Desktop same-origin authenticated proxy and capture/recovery UI,
durable local audio policy, isolated hosted qualification lane, deployment and
resource evidence, reconciliation/hold-aware cleanup, provider processing,
transcript/review-only draft workflow and physical microphone/device acceptance.
The existing consent UI still reports `audioCapture:false`; no route has been
deployed, PHI enabled or paid mobile build started. All original phase scopes stay
open. Prior Desktopda55e3b/CI35274197975 and V2424cd4f/CI35275991172 now SUCCESS;
Desktop47e1a2e/CI35275985277 was still running at check. New source needs new CI.

## September 17 Desktop capture proxy and explicit recovery (source only)

Desktop now exposes same-origin POST routes at
`/api/live/scribe/capture/{start,state,command,segment}`. These use the real
request cookie, never a browser Authorization header or fixture identity.
Cross-origin/same-site writes, query credentials, unknown metadata and compressed
request framing refuse. The separate server-only
`RECORDING_CAPTURE_AWS_API_ORIGIN` must be a root HTTPS AWS Gateway origin in the
supported US regions; the consent origin is not a fallback. It remains blank in
the example environment. This does not change AWS activation or PHI policy.

JSON bodies are limited to10KB. Binary segments require measured byte length,
canonical sequence, allowed MIME type and a SHA-256 matching actual bytes before
forwarding. Uploads are bounded to4MiB and10seconds input time. AWS transport is
35seconds; decoded response bodies are bounded to16KB/5seconds. No redirects,
cache, raw provider errors, browser-selected storage, automatic retries or
persistent browser tokens. Browser-safe shared contracts now validate the actual
server repositories and Desktop transport: request/receipt IDs, action, CAS
version, inventory, segment hash/size, replay secret rules and unsupported
processing/deletion claims are all checked.

The existing consent workspace already exposes the open capture ID/session.
Its recovery section now explicitly loads owner-authorized server state, can
pause, and can finish or discard after inventory review plus acknowledgment.
Pending uploads block finish. Revoked captures cannot finish/resume through this
screen. Uncertain commands preserve their original ID/version/inventory in page
memory and offer only exact retry; conflict/authorization failure requires fresh
review. No automatic microphone or resume exists. After a command, current state
is fetched again instead of presenting a historical replay receipt as current.
Wrong-session responses are refused. Discard is a disposition, not proof of
deletion; finish does not enqueue transcription. These limitations are visible.

Evidence: full suite **2422passed/11existing skips/200files**, typecheck and lint
(4existing unrelated warnings) pass. The final206focused transport/repository/API
and compiled-artifact checks passed. The capture candidate still builds with the shared contracts.
Actual local Next/browser suite **8passed/29.0seconds**, retries0, fictional
consent/capture responses: review/withdrawal, uncertain retry, representative and
missing-release refusal, unavailable/stale auth, recovery/pause/finish with exact
inventory/CAS, pending-segment exclusion, wrong-session refusal, and real
cookie-less consent/capture proxy401s. Screenshot reviewed for recovery controls;
agent-browser confirmed the local app renders without a framework overlay.

Retained failed evidence: the first browser run passed7/failed1 because the
Playwright enabled-state matcher treated a native disabled option as enabled
despite the trace's disabled attribute. The corrected test verifies the actual
DOM disabled property and selectable discard value. The full8-case run then
passed without timeout/retry increases. Two test-only union-inference typing
errors were corrected before the passing typecheck.

Not complete: browser capture/start/credential rotation, durable local audio
recovery policy, storage reconciliation and hold-aware erasure, processing/
transcript/review-only drafting, resource qualification, isolated hosted tests
and physical microphone/device acceptance. No real AWS request, PHI activation,
deployment or paid mobile build occurred. All six original phase scopes remain
open. Prior Desktop47e1a2e/CI35275985277 and V24224455/CI35278360309 now SUCCESS;
Desktop11658c0/CI35278357086 remains in progress at this checkpoint.

## September 17 pending-object reconciliation (source only)

The fifth capture route, `POST /clinical-core/workforce/encounter-recording/reconcile`,
and its same-origin Desktop proxy accept only a recording ID. The server selects
the pending segment from the original immutable reservation. Recovery needs fresh
owner/workforce authorization, current participant grants and authority epoch,
reviewed capture/storage releases and unexpired retention; it does not need or
issue the old capture credential. Paused captures can reconcile without resuming.

Canonical migration 69 adds a private immutable reconciliation audit and two
narrow database operations. Preparation locks encounter/capture/segment in the
existing order, refreshes a bounded receipt lease, then commits. The service
performs only a bounded object HEAD outside the transaction: exact version,
full-object checksum, size, MIME type, encryption/key and reservation metadata
must match. Completion rechecks authority after that network operation. Replayed
versions are idempotent; different versions conflict. Missing or unverifiable
objects remain pending. Withdrawal, changed roster, expired retention, retired
releases, closed encounter/capture or unauthorized actor refuse. No PUT, LIST,
body download, deletion or provider permission was added.

The recovery screen now offers **Reconcile pending upload**. A lost reply keeps
the exact request for explicit retry; a no-pending reply reloads current state
rather than fabricating a stored receipt. Finish remains unavailable until all
pending segments resolve. Discard still does not prove erasure.

Evidence: **234 focused tests passed**, including API/proxy, original upload
regressions, canonical SQL and candidate infrastructure; **2467 full unit tests
passed, 11 existing skips, 201 files**. **Nine local browser cases passed in
52.3 seconds**, retries zero, including loss after a simulated server commit,
exact retry, refreshed inventory, finish availability and no audio/credential
transmission. Browser responses and storage HEAD are fictional. SQL runs in
PGlite, not hosted Aurora. The complete build now contains 69 registered
migrations, zero seeds, and five exact JWT routes/invocation permissions.

Retained failed evidence: the first SQL attempt correctly refused an unregistered
overlay; registering it resolved that failure. The first full-unit invocation
bypassed the package timezone setting and exposed an outdated 68-migration
assertion. The assertion now checks 69 plus the exact last migration; the normal
`test:unit` command passes without changing timezone semantics or skipping tests.
An initial local legacy-scribe probe used the AWS-panel server configuration and
could not find the legacy panel; this is not evidence about microphone behavior.

Release qualification remains incomplete: Desktop CI35278357086 failed one
legacy microphone-loss setup before recording (292 passed, 19 skipped, two did
not run). Its trace shows the recording POST aborted at the existing eight-second
authorization bound and the UI stopped capture as unconfirmed. That trace alone
does not prove the cause of the delayed acknowledgment. No timeout/safety check
was relaxed. V2 CI35280326725 passed and independently verified the shipped USDA
catalog in both final container variants. Neither CI result is hosted activation.

Remaining original phase-2 work includes capture/rotation/durable local recovery,
missing-object disposition and hold-aware erasure, processing/transcript/drafts,
hosted concurrency/storage/identity qualification and physical devices. This
increment does not complete any of the original six scopes. No PHI flag, database
deployment, provider activation or paid mobile build changed.

### Source-scan isolation and legacy browser investigation

The local legacy probe initially used the wrong AWS-screen configuration, then
timed out while dev compilation repeatedly invalidated the page. The app's
Tailwind import implicitly scanned the whole checkout, including generated graph
and downloaded evidence files. It now uses `source("../")` relative to
`src/app/globals.css`, restricting candidates to the complete `src` tree, following
[Tailwind's explicit source-base documentation](https://tailwindcss.com/docs/detecting-classes-in-source-files#setting-your-base-path).
An isolated test compiles the real stylesheet/theme with the installed engine:
application utilities must exist; distinct utility classes in Graphify and trace
fixtures must not. It passes. The rendered Today screen retains its styles and
has no framework error overlay. The unchanged legacy microphone-loss browser test
then passed (one case, 35.5 seconds, no retries or deadline changes). This is a
local verification result, not proof that the remote CI delay has the same cause
or that the complete browser battery passes. The downloaded failure trace is
retained outside the checkout in the workspace evidence directory.
Final source checkpoint after this repair: **2468 unit tests passed, 11 existing
skips, 202 files**; typecheck passes; lint has no errors (four existing unrelated
warnings); the five-route capture candidate builds. Synthetic AWS STS was checked
again and reports an expired session; hosted qualification cannot proceed until
the operator renews that named profile. Local/source engineering remains possible.

### September 17 — consent-bound capture readiness

The sixth capture-service operation, POST readiness, qualifies the encounter
before a browser may offer capture. It accepts only encounterId, uses fresh
workforce identity and the server-configured capture release, and checks current
patient/practitioner roster, every recording grant, encounter status, capture
and storage releases, and absence of an unresolved capture. Short SQL transactions
do not call storage or providers. No capture/token/approval is created; a readiness
reply is advisory, not a grant. Start and uploads still recheck current authority.

The strict result contains only encounter/epoch, checked/expiry timestamps,
measured configuration limits, supported MIME types, and explicit false values
for captureStarted/processingRequested. Validity is at most 30 seconds and bounded
by both release expirations. Browser validation rejects expired/future observations,
wrong encounters, duplicated MIME types, invalid limits and secret-bearing replies.
The Desktop cookie proxy, shared contracts and six exact JWT invocation scopes are
wired; the AWS UI microphone controller remains the next engineering step.

238 focused tests pass, including actual canonical PostgreSQL, API-to-database
readiness followed by capture, retirement/withdrawal/roster/access failures,
response correlation and final-candidate infrastructure. Typecheck, 70-migration
zero-seed gate and capture candidate build pass. This is isolated fictional
evidence, not hosted AWS or physical-microphone acceptance.
The full six original commercial scopes remain incomplete. AWS synthetic
credentials are still expired. No deployment, approval signature, PHI/provider
activation or paid mobile build occurred.
Final local verification: 2497 full unit tests passed, 11 existing skips, 203 test
files. Lint has zero errors and four existing unrelated warnings. No new browser
UI is exposed in this increment, and no new browser/device acceptance is claimed.

### September 17 — page-owned microphone and transport controllers

Source controllers now connect the readiness/start/lifecycle/segment contracts
to browser microphone ownership. They are not yet mounted in the encounter
screen. Start requires fresh readiness, an allowed supported MIME type, microphone
permission, and an acknowledged server start before MediaRecorder is constructed.
The same recorder/output stream survives pause and explicit microphone replacement;
no new media header is appended to an existing server capture after a page reload.

One transport writer serializes uploads and credential changes. Encoded chunks
are split by the reviewed byte bound, hashed, uploaded in sequence and acknowledged
once. The queue is limited to eight MiB, the reviewed total recording bytes and
4096 segments. Overflow/encoder failure marks the capture incomplete instead of
presenting a silently truncated finishable recording. Lost acknowledgments retain
the original request/bytes for explicit retry only. A secret-free command replay
does not reactivate input; explicit resume first validates fresh state, unchanged
session/epoch/inventory/CAS, then requests a new credential.

Successful upload receipts revalidate authority. Idle capture renews through the
actual grant-checking command, not a recovery-state read. A monotonic 20-second
local freshness bound plus token/retention expiry stops input even while requests
are stuck; moving the device wall clock backward cannot extend this local lease.
Start has an eight-second authorization bound; other transport operations are
bounded at fifteen seconds. Hidden page, offline/pagehide, device loss, expired
authority and disposal stop microphone tracks. Late permission/results cannot
restart them. Finish waits for the original recorder's final dataavailable/stop
events and all upload receipts before requesting the exact server inventory
disposition. No transcription/deletion is implied.

Verification uses fictional service responses/media objects, not actual devices.
The focused microphone/transport/bridge/preparation suite covers microphone
ownership, bounded uploads, clock changes, exact retry and cross-device control.
Initial negative runs caught a contradictory size-limit fixture and an aliased
mock cleanup counter; those fixtures were corrected without relaxing validation.
Type checking also caught two state-narrowing/test-response typing errors; these
were repaired. No runtime timeout extension, test skip or PHI activation was used.

Remaining source work includes mounting controls with consent-mutation/account/
navigation cleanup, explicit memory-only recovery disclosure, rendered browser
acceptance, durable encrypted local recovery, pending-object disposition and
hold-aware erasure, transcription/review-only drafts, plus hosted/physical
qualification. Current buffers are memory-only; closing this page loses unsent
bytes and does not prove remote rollback or deletion. All original six scopes
remain incomplete. Nothing was deployed or enabled for PHI.

Retained full-suite evidence: one run during concurrent Graphify extraction
timed out in the existing default-blocked service smoke test (2526 passed,
one failed, 11 skips). After extraction finished, the unchanged smoke test and
full suite passed (2527 passed, 11 skips, 205 files;79.75seconds), without changing
its five-second test bound or ten-second child-process bound. Resource contention
is a hypothesis, not a proven cause. A subsequent cross-device finish-version
regression also passes in the 42-case focused controller suite.

A second full run then exposed the same five-second wrapper timeout in the
privacy artifact smoke test (2527 passed, one failed, 11 skips). Removing inherited
test-runner environment and using a four-second child bound did not fix those
two smoke tests under Vitest; standalone probes of the identical blocked
recording artifact returned 503 in 226/245ms with minimal/inherited environments.
The environment or Graphify hypotheses are not established causes.
Both affected artifact tests now use a clean deployment-like child environment
and asynchronous child execution, retain their original ten-second child limit,
and give the enclosing harness fifteen seconds to reap/assert the result, matching
the existing owned-storage/voice artifact tests. Assertions remain intact,
including 503/PHI-disabled responses without database credentials. No production
timeout or performance SLO was changed or declared verified. The seven focused
artifact cases pass; native-startup/hosted latency qualification remains separate.
The read-only diagnostic is retained outside application source under workspace
evidence/recording-controller-20260917/child-startup.mjs.
Final full unit verification: **2528 passed, 11 existing skips, 205 files** in
84.76seconds. This covers the final controller/CAS code and bounded artifact
harness repair. It is not physical browser/microphone or hosted-service proof.

### September 17 — encounter capture screen integration

The AWS encounter screen now mounts the page-owned browser controller. Recording
requires an explicit readiness check, acknowledgment of memory-only buffering,
microphone permission and fresh server authorization. Controls expose pause,
resume, immediate local microphone stop, exact uncertain-request retry, finish
and discard. No action claims transcription, note creation or physical erasure.
The consent workspace's legacy `audioCapture:false` describes that consent API;
it is not changed or treated as authorization. The separate capture API still
defaults to blocked and needs its own approved deployment configuration.

The capture owner remains mounted while consent workspace reads/mutations run.
Those actions stop input synchronously before network work, retaining any unsent
tail and original retry. Completing/cancelling/marking an encounter erroneous
also stops input before the status request. Page hiding/offline and navigation
stop tracks; unmount disposes the owner. Before-unload warns for unresolved
captures. Login, MFA submission, logout and organization switching broadcast
non-sensitive same-origin invalidation before changing cookies; capture screens
stop, clear local audio and require a fresh document. No identity/token/audio is
stored in that marker. Storage-denied cross-tab delivery is not guaranteed;
server authority checks and the existing bounded lease remain mandatory.

Browser evidence: initial combined consent/capture run **14/14 PASS**. Expanded
capture suite **7/7 PASS**, including actual Chromium-generated WebM bytes,
hash/sequence-matched receipts, pause/resume in one encoded container, final
chunk flush, consent withdrawal before its request, real cross-tab invalidation,
an uncertain binary retry retaining exact bytes and headers, cancellation of
pending authorization, offline stopping and encounter navigation. The earlier
9 consent/recovery cases include actual cookie-less proxy401s. Generated audio
and fictional HTTP authority/object receipts are not hosted AWS authorization,
physical microphone/Safari qualification or provider-processing evidence.
Screenshot inspected; no page errors in the complete recording flow. CI now
explicitly selects both browser suites.44 focused controller/session tests and
typecheck pass. No runtime deadline, clinical gate or PHI flag was relaxed.
The local server also logged absent fictional lens evaluations (404), calendar
date-range refusals and aborted navigation requests. These tests do not prove
clean unrelated server logs or full-app hosted functionality.

Still open in original phase2: durable encrypted local audio recovery, review of
missing/unresolved object disposition and hold-aware erasure, actual transcription
and review-only draft processing, authenticated hosted and physical acceptance.
Buffers remain memory-only, and a refresh can lose unsent bytes. The capture
screen must not be described as a finished voice/scribe service. All other
original phase scopes remain open; no deployment or paid mobile build occurred.

Final source check:2530 full unit tests PASS/11existing skips/206files (86.85s).
Typecheck and changed-file lint pass. Full lint retains the four existing
unrelated warnings; no new errors. All seven new browser cases passed without
retries or timeout changes. Synthetic test servers and browser were closed.

## September 17 — retained fixture failure and bounded timing evidence

Desktop CI35286696055 at2ade8bc failed the legacy fixture refresh-recovery
case: start/chunk/discovery returned200, then the fresh-authority PATCH was
aborted and the UI correctly remained unconfirmed. The saved trace does not
establish whether the request reached the route, token resolution or upstream.
This is separate from the new AWS recording browser suite. It is not resolved
by claiming that the newer suite passed.

Opt-in E2E_RECORDING_DIAGNOSTICS now marks recording POST/PATCH route entry,
body/session completion, token resolution, upstream headers/decoding and route
settlement/abort. It requires the existing local contract-fixture gate as well
as the diagnostic flag; deployment cannot enable it. Entries contain only a
random correlation value, allowlisted method/stage and elapsed time. URLs,
headers, bodies, tokens, patient/session identifiers, errors and audio are not
logged. Observer failures cannot change service outcomes. No retry, authorization
rule, deployed provider or application deadline changes. CI opts in only for
the local-fixture browser job.

The unchanged refresh-recovery browser case passed locally (1.4minutes, no
retry). An initial invocation without E2E_LIVE was skipped and is not evidence;
the subsequent correctly configured invocation executed and passed.14focused
diagnostic/deadline tests and typecheck passed before the POST timing extension.
That local pass does not establish the cause of the older CI failure. Await
new exact-head CI timing evidence before declaring the intermittent issue fixed.

Final diagnostics source:2539unit tests PASS/11existing skips/207files;
typecheck PASS;lint0errors/4existing unrelated warnings. Graphify AST9055nodes/
18274edges/718communities (30known omitted sources;5000-node HTML limit).
Owned browser and local servers closed after testing. Prior Desktop02d2fd5
CI35288355796 passed units/build and AWS recording browsers; its legacy browser
job was still running at this checkpoint. V2fdfdb62 CI35288362105 SUCCESS.

All six original phases remain incomplete, including durable local audio,
processing/drafts, hold-aware cleanup, hosted and physical acceptance. No
deployment, PHI activation, signed-content changes or paid mobile build.

## September 17 — enforce recording storage deadlines independently of cancellation

Inspection found that PUT/HEAD passed AbortSignal.timeout to the storage client
but still awaited its promise without an independent bound. A transport ignoring
abort could hang upload/reconciliation beyond the reservation deadline. Three
new service tests reproduced this before the fix (80existing cases passed).

The live capture uploader and reconciler now share a bounded storage budget.
Each remote operation remains limited to10seconds, the PUT-plus-HEAD sequence
to20seconds, and reconciliation to10seconds, all capped by the original database
reservation deadline. An independent timer settles the caller and requests SDK
cancellation. Monotonic elapsed time prevents backward wall-clock extension;
checks around completion reject late results even if timer delivery is delayed.
Timers are cleared on success/error, and detached late failures are consumed.

An uncertain PUT may still complete remotely: timeout never means absence or
deletion. The uploader can use the remaining budget for read-only HEAD and accepts
only the existing exact version/checksum/size/encryption/provenance checks plus
fresh database authority. It never issues a second PUT. Timed-out HEAD responses
cannot reach receipt completion, and unresolved reservations remain durable for
later explicit reconciliation. No storage delete/list, retention override,
clinical consent bypass or new provider permission was introduced.

The initial214targeted SQL/API/storage cases passed after integration; tests also
cover ignored cancellation, late success/rejection, timer cleanup, short leases,
backwards clocks, synchronous failure and individual-versus-total deadlines.
Typecheck and the capture candidate build passed. These are synthetic local
tests, not S3/Aurora or physical-device qualification. All six original scopes
remain incomplete. Complete cleanup/hold handling, durable local audio,
transcription/drafts and hosted/device evidence remain required.

Final source verification:2552unit tests PASS/11existing skips/208files;
typecheck PASS;lint0errors/4existing warnings;capture candidate build PASS.
Graphify9060nodes/18290edges/714communities (30known omitted source files).
Prior Desktop02d2fd5/CI35288355796 SUCCESS and V2354f1c6/35289756845 SUCCESS.
The newer diagnostic Desktop00583ef/35289750713 remained in progress at inspection.
Fresh ai-synthetic-staging STS check reports expired credentials; no hosted
storage/identity/deployment evidence or environment switching is claimed.

## September 17 — durable cleanup intent handoff (not deletion execution)

Canonical migration71 registers `recording_cleanup_intents` and its immutable
event history. Capture insertion atomically creates a work item at that capture's
original retention deadline, so abandoned/no-disposition captures are not omitted.
Discard advances the due time; capture revocation and withdrawal of a recorded
recording grant do likewise, including withdrawal after a successful finish.
Finish alone does not shorten the original deadline or start processing.

This is a handoff for a reviewed cleanup worker, NOT authority to delete. A due
item must still pass fresh retention/legal-hold, in-flight writer, full version
inventory and storage-disposition checks. No worker, delete permission, hold
release, deletion receipt or `audioDeleted:true` is added here. The worker and
operator workflow remain required engineering. In particular, an empty HEAD or
aborted PUT cannot discharge this work item.

The schema pins recording/organization/patient/release identity. Ordinary API
roles have no table access or execute permission on the enqueue helper. Intent
updates cannot postpone cleanup, replace identity or erase the original request;
each due-reason revision appends an immutable event. Existing retry-safe lifecycle
commands create no duplicate intent events. Original reserved/stored segment
inventory is unchanged. Recording-grant lookup uses a GIN index, not a scan of
every capture for each withdrawal. Existing captures are backfilled through the
same private helper, without approval seeds, storage changes or erasure claims.

Tests execute canonical SQL in isolated PGlite: the preceding70-migration schema
creates unfinished/discarded/finished-then-withdrawn fixtures before migration71
is applied, proving the actual backfill. Cases cover deadline identity, pending
segments, exact replay, finish/withdrawal, unauthorized writes, immutable events,
failed inventory comparison, atomic rollback and preservation of a legal-hold
record. This does not prove that a future deletion worker honors holds or that
multi-connection Aurora concurrency is qualified. Initial93SQL/artifact cases,
typecheck and the71-migration/zero-seed gate passed.

All six original scopes remain incomplete. No deployment, PHI/provider activation,
clinical signature changes, legal-hold release or paid mobile build occurred.

Final local verification:2561unit tests PASS/11existing skips/208files;
typecheck PASS;lint0errors/4existing warnings;recording capture candidate build
PASS;canonical71-migration/zero-seed gate PASS. Graphify9076nodes/18311edges/
712communities (30known omitted sources). Prior Desktop00583ef/35289750713 and
b46d554/35290363870 were still running at inspection, not failed or passed.

## September 17 — separately reviewed cleanup admission and legal holds

Migration72 adds an internal cleanup authorization boundary, not a deployed
deletion service. A capture token, patient grant, due queue item or ordinary
practitioner membership alone is insufficient. Admission requires fresh active,
production-bound workforce identity in the same active organization, purpose
`consent_management`, a separately reviewed/unexpired operator assignment, and
a reviewed cleanup release binding the exact capture release, storage release,
retention-policy hash, worker artifact hash and qualification evidence. No such
approvals or assignments are seeded. Review scope is immutable; revocation and
retirement cannot be undone by the ordinary API role.

Chart-level recording holds have explicit, attributable placement/release and
immutable audit events. Admission checks these and personal legal holds for all
recorded consumer associations, including revoked connections. Association
history is append-only: later unlinking/deleting a connection cannot discard a
known subject and silently remove their hold from consideration. Migration
backfill can only recover connections still present in the database; it cannot
reconstruct previously deleted historical links from absent evidence. Review of
legacy attribution remains required before activating cleanup on legacy data.

Encounter/capture locks serialize against lifecycle writers; patient locks
serialize chart holds and connection changes; sorted owner locks match personal
hold operations. Identity, membership, assignment, policy and release rows stay
locked during the bounded callback. Admission rejects stale queue versions, not-
yet-due items, live segment acceptance windows and mismatched storage. Archived
charts and retired capture/storage releases can still reach reviewed cleanup;
this never revives recording or processing rights. Storage identity remains the
original immutable binding. Pending segments are included, not declared absent.

The typed internal guard validates receipt scope and every exact object key,
storage binding, size, sequence and receipt state. Its single operation is capped
at five seconds (or earlier review expiry), independently of SDK cancellation.
Late results cannot create a receipt or commit the admission transaction. This
is NOT a distributed transaction: an already-issued remote operation could still
finish after timeout. A future deletion worker must retain durable uncertain
attempts, enumerate/reconcile versions and late writes, honor storage-side holds,
and never turn timeout/empty HEAD into proof of erasure. The guard does not grant
S3 IAM, delete anything, complete an intent, or return `audioDeleted:true`.

Verification: full Desktop suite2609PASS/11existing skips/209files; typecheck
PASS;72-migration/zero-seed gate PASS. Tests use actual canonical SQL in PGlite
and fictional records, including separate privilege, assignment expiry/future/
revocation, reviewed-policy failures, holds through unlinking, archived charts,
pending uploads, stale versions, immutable evidence, typed callback transaction
rollback and ignored-cancellation timeouts. Initial test authoring errors (missing
brace and inferred UUID parameter type) were corrected before final verification.
PGlite is not multi-connection Aurora concurrency qualification. No hosted storage
deletion, deployed migration, operator UI/worker authentication, physical device
or production acceptance is claimed. All SIX ORIGINAL phases remain incomplete.

Final lint:0errors/4existing unrelated warnings. Recording capture candidate build
PASS (local artifact only). Prior V2 2aec44c CI passed. Prior Desktop5b67acd/
CI35291079313 still had its legacy browser job running when inspected; no result
is inferred for that run. The new cleanup candidate needs its own CI.

## September 17 — exact-version cleanup worker and durable uncertain attempts

Migration73 adds immutable version-specific attempts and append-only outcome
events. The attempt must commit in a separate transaction BEFORE storage mutation.
Its recording, segment, queue version, inventory hash, cleanup release, object
version/kind, observed-evidence hash and operator cannot be substituted on replay.
The later mutation transaction re-runs cleanup admission and verifies that exact
prepared attempt. A changed hold, assignment, release or queue version refuses
the mutation. Outcome logging grants no mutation rights and remains possible
after a newly placed hold; no event means unresolved, never successful erasure.

`recording-cleanup-worker.ts` and `aws-recording-cleanup-store.ts` implement the
internal worker and AWS version adapter. Every invocation starts with a fresh
first page, validates all observed keys against authoritative segment inventory,
and processes at most25 versions. Subsequent invocations start over rather than
reusing a pagination cursor altered by deletes. Null versions, foreign keys,
duplicate/malformed listings, bad checksum/size/KMS/segment/recording/session/
authority metadata, missing lock evidence and mismatched receipts are refused.
Object provenance and holds are re-read immediately before each mutation.
Delete markers use re-listed exact versions, not HEAD-derived absence.

Storage qualification requires enabled bucket versioning and Object Lock; no
runtime configuration is changed to create them. Bucket owner/region/endpoint,
recording prefix and exact version are pinned. Explicit GetObjectLegalHold and
GetObjectRetention must succeed (HEAD can omit lock state when permissions are
missing). No unversioned delete, bulk/bucket erase, hold mutation or governance
bypass is requested. AWS reference behavior:
[version deletion](https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObject.html),
[Object Lock visibility](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock-managing.html),
[legal-hold reads](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObjectLegalHold.html).

Every network step checks cancellation before another SDK call. The existing
independent five-second admission timer bounds each callback. A lost delete
response or failed outcome write leaves the committed attempt for reconciliation.
`delete_acknowledged` means only an exact-version provider acknowledgment. Even
a later empty listing returns `audioDeleted:false`, `requiresRecheck:true`; the
cleanup intent and pending segment history remain. There is no automatic whole-
recording completion, false erasure statement or guessed late-write horizon.

This is internal source engineering, NOT an activated scheduler/operator service.
Deployment/IAM, fresh worker identity binding, operator inventory/review, durable
recheck scheduling, terminal absence/late-write evidence and storage-side hold
coordination still require engineering and actual AWS qualification. A database
transaction cannot undo a remote operation that finishes after timeout; these
requirements must be satisfied before activating real-data deletion. No current
capture IAM or public API is expanded by these files.

Initial source verification:141 canonical SQL/artifact/guard tests and25 worker/
adapter tests PASS; typecheck PASS. Full2639tests PASS/11existing skips/211files,
lint0errors/4existing warnings. Added one further guard-receipt test; its26-case
guard suite PASS. Final full suite2640PASS/11existing skips/211files; final
typecheck PASS;73-migration/zero-seed gate and capture candidate build PASS.
Graphify9154nodes/18499edges/717communities (30known omitted sources).
Actual SQL+worker test proves
committed attempt survives a simulated lost-delete response and a later empty
scan. Another SQL test proves exact replay, version/record substitution refusal,
immutable attempts and a hold added after preparation. All storage is fictional;
no Aurora concurrency, hosted S3 or physical deletion proof is claimed.

Fresh ai-synthetic-staging STS check:session expired. No account/environment
switch, deployed migration, PHI/provider activation or paid mobile build. All
SIX ORIGINAL phase scopes remain incomplete. Prior V2a720614/CI35292487117 SUCCESS;
Desktop e069b86/CI35292465614 legacy browser job still running at inspection.
Prior Desktop5b67acd/CI35291079313 subsequently completed SUCCESS. New source
requires its own CI; local capture build is not a cleanup deployment artifact.

## September 17 — durable cleanup run leases and recheck queue

Migration74 adds immutable run claims/results and a private mutable schedule
derived from cleanup intents (including preceding-schema backfill). Claims commit
before storage work. Exact replay acknowledges the claim without executing again;
live leases exclude another executor. A new intent version immediately clears
the old lease, and storage admission requires the exact current run and version.
Every operation retains the existing hold/release/operator checks and five-second
bound, shortened when the run lease expires. Expired/superseded workers cannot
obtain another storage admission. This is not cancellation of an already-issued
remote request or distributed-transaction proof.

Results commit separately. Lost result writes leave the claim visible until lease
expiry; late results are retained but cannot postpone newer work. Unknown partial
progress uses a NULL deletion count, not an invented zero. Empty observations
schedule another check in one hour, held work in one hour, remaining work in
30seconds, and failures with exponential backoff capped at one hour. These are
operational retry cadences, NOT retention policies or an approved late-write
horizon. No completion state, intent removal or audioDeleted:true is introduced.

The internal typed queue lists organization-scoped metadata using keyset paging
and an organization/recording index. It reports unresolved attempts, current lease,
outcome and next check; it does not return audio, object keys or credentials.
Ordinary API roles cannot alter tables or forge results. Queue transactions have
two-second lock and ten-second statement limits and contain no storage calls.
The existing narrowly bounded hold-locked storage callback is unchanged.

Verification: typecheck PASS; initial162focused tests PASS; full2662unit tests
PASS/11existing skips/212files; lint0errors/4existing unrelated warnings;
74-migration/zero-seed gate PASS; existing capture candidate build PASS. Canonical
SQL tests exercise leases, replay, stale completion, intent revision, holds,
backoff, unknown counts, scoped listing and direct-table refusal. Guard tests
exercise missing/wrong run receipts and earlier lease deadlines. Tests use PGlite
and fictional storage, NOT Aurora multi-connection or actual S3 deletion evidence.

Still required engineering: authenticated operator service/UI and dispatch,
cleanup deployment/IAM and reviewed worker binding, storage-side hold coordination,
late-write/uncertain-version reconciliation and terminal evidence, encrypted local
recording recovery, transcription/review-only drafts, and hosted/device acceptance.
AWS ai-synthetic-staging credentials remain expired; no account switch, deployment,
PHI activation or paid build. All SIX ORIGINAL phases remain incomplete.

Final scoped pagination/other-organization SQL checks:121cases PASS. Graphify AST
updated9188nodes/18571edges/732communities;30known omitted sources and5000-node
HTML limit remain disclosed. PostgreSQL review informed the short queue
transactions, timeout bounds and organization-first pagination index.
