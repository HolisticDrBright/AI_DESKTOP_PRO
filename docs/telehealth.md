# Telehealth — virtual visits inside Desktop Pro

The Telehealth tab (sidebar, under Calendar) is where a practitioner runs a
video visit without leaving the chart: the day's virtual visits, the visit
itself with Zoom embedded in the page, and the post-visit note that starts as
Zoom AI Companion's summary and becomes a signed telehealth visit record when
the practitioner signs it. Chart-note integration is still outstanding.

This is the clinical edition. There is no sample data on any of these screens:
every row is an appointment that exists, every consent is a record somebody
made, and a service that cannot answer says so.

## Product decisions carried into code

### October 9 summary-boundary repair

Summary import requires a known visit instance UUID and an exact matching UUID
in the provider response; a meeting number alone is not authority. Legacy visits
without a verified instance remain refused rather than silently importing an
unbound summary. Response bytes are streamed under the 256 KiB decoded limit,
cancelled on overrun, decoded as strict UTF-8, and parsed only after the bound
holds. Malformed declared lengths are refused before reading; identity-encoded
lengths must match received bytes. Fetch-decoded compressed bodies remain bounded
but their compressed wire length is not equated to decoded length.

These are source repairs, not deployed acceptance. The subsequent source repair
also keeps dispatched unknown creations fenced on empty or missing provider reads,
checks complete exact-marker pagination before adoption, and refuses ambiguous
matches. A stale original writer does not delete a meeting already bound by a
reconciler. Note and list reads require current clinical calendar authorization;
missing historical appointments are omitted with an incomplete-list flag rather
than exposed through organization membership alone. A reviewed independent
historical-record authorization path still belongs to chart/lifecycle integration.

Visit subjects cannot silently change with the calendar or request. Patient-app
visits require the current patient connection and calendar to agree. Start checks
binding and consent again after provider creation and SDK work before returning
a session; its final version-conditional write fences concurrent visit withdrawal.
Even an already-ended idempotent response requires current authority. These checks
do not certify atomic provider shutdown, orphan deletion, or actual provider races.
Chart/lifecycle/multi-clinic integration and the authorized positive host-and-patient
Zoom journey remain required. PHI remains disabled.

| Decision | Where it is enforced |
| --- | --- |
| Video is Zoom, embedded (Meeting SDK component view), not a link out | `src/components/telehealth/TelehealthVisit.tsx`, `zoom-sdk.ts` |
| Notes come from Zoom's AI Companion and are imported after the call | `importVisitNote` in `src/server/clinical-core/aws-telehealth-requests.ts` |
| Practitioner notes sit on top of the AI notes; both are saved by one signature | `signVisitNote` (server), `TelehealthNote.tsx` (screen) |
| ONE combined consent (telehealth + recording/AI notes), both parts required | `startVisit` refuses with `consent_required`; the UI check is not the control |
| Nothing the AI drafts is final until the practitioner reviews it | imported notes are `not_reviewed`; action items are `suggested` until decided |
| Entry point is the day view; a patient row opens the chart | `TelehealthDay.tsx` → `patientPath()` |

## Where the data lives

```
Telehealth day view (viewer's time zone)
  ├─ Desktop-owned calendar RPC (get_desktop_calendar) — appointments of type `telehealth`
  └─ AWS telehealth boundary (telehealth-requests Lambda, workforce routes)
       ├─ patient-app requests (already existed) — scheduled requests appear as rows
       ├─ VISIT records (new) — consent receipts, Zoom meeting, provider shutdown, the note
       └─ consent authority (identity extension, read through the clinical API with the caller's JWT)
            ├─ consent_artifacts — the organization's approved `telehealth_recording` artifact (version + hash)
            └─ consent_grants   — the patient's current grant/revocation for that scope (append-only)
```

The two sources are merged per appointment in `src/adapters/telehealth.live.ts`.
If the visit boundary is unreachable, the calendar rows still render and the
screen says consent and meeting state are **unknown** — it never renders
"Consent not signed" for a consent it could not read. If the boundary's list
hit its page bound, the day view says the list is incomplete rather than
presenting a truncated list as whole.

### Authority, in order

1. **The appointment, inside the AWS boundary.** Every visit route
   (`consent`, `withdraw`, `start`, `end`, `import`, `sign`) resolves its
   appointment itself, with the caller's own JWT, through the reviewed
   desktop-compatibility operation `get_desktop_calendar` on the clinical API
   — so a direct call to the Lambda gets exactly the appointments that
   practitioner can see under the clinical core's role rules. Nonexistent,
   another organization, revoked membership (the calendar refuses), not a
   telehealth appointment: refused before any write, consent read, secret or
   provider call. A cancelled or no-show appointment is refused for
   consent/start/import; ending a visit still resolves the appointment but
   tolerates a closed status so an outstanding meeting can be shut down. The
   visit keeps the calendar's patient record, practitioner and **stored**
   times; caller-supplied times are at most a search hint. The desktop
   server performs the same resolution first (so the UI never offers an
   action the calendar would refuse), but that is convenience, not the
   control. The day and the zone are the viewer's (`date` + IANA `timeZone`
   on every call), computed DST-aware; February 31 is refused.
2. **The request.** A patient-app visit is bound to its request on the
   boundary: the request must exist in the caller's organization, name this
   exact appointment, and not be cancelled; its stored times and meeting are
   authoritative. Cancelling a request closes its visit and deletes a meeting
   the visit itself created.
3. **The consent.** See the consent section below. No authority read, no
   secret lookup and no provider call happens before a refusal.

The compatibility calendar is the same reviewed operation the Calendar screen
reads; nothing new is granted to the Lambda, and no shared secret is minted —
the caller's JWT is the only credential in play.

The appointment-table policy grants only GetItem, PutItem, Query and UpdateItem.
Its transactions use those underlying operations rather than the nonexistent
`dynamodb:TransactWriteItems` IAM action, following
[AWS transaction permissions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html).
CI lints the telehealth template as well as the other clinical templates.

### Consent

The combined telehealth + recording/AI-notes consent is the governed
`telehealth_recording` scope in the identity extension
(`infra/aws-clinical-core/production-candidates/telehealth-recording-consent.sql`):
one approved, versioned, hashed artifact per organization and an append-only
grant/revoke lifecycle per patient connection. The identity API exposes two
workforce reads for it — `GET /clinical-core/workforce/consent-artifact` and
`GET /clinical-core/workforce/consents/current` — and the telehealth Lambda
calls them with the caller's own JWT.

The scope is packaged as a distinct, blocked 108-migration candidate by
`npm run build:telehealth-consent-candidate`. It preserves all 15 consent
scopes, including `lab_specimen_context`, and binds to the exact 107-migration
parent. Existing 106/107 release bytes and the synthetic migration manifest
are unchanged. The candidate adds no artifacts, grants, review rows or
activation. Its forward-apply, rollback and deployed runtime binding still
need qualification; building it does not change any database.

| Path | What is checked |
| --- | --- |
| Patient app, at booking | the consent object must name the organization's **current approved** artifact (id, version, hash); otherwise `consent_version_refused` |
| Desktop, staff-attested | the dialog reads the current artifact first and shows its version, jurisdiction and hash; the receipt must name exactly that artifact; when the patient has an app connection the grant is recorded in the identity authority (`in_person`) and its id is stored on the receipt |
| Withdrawal | `POST …/visits/consent/withdraw` marks receipts withdrawn (append-only) and revokes the governed grant |
| Start, and AI-summary import | a granted, un-withdrawn receipt; its artifact must still be the approved one (a retired/superseded release is no authority); for a patient-app visit a live connection must exist, the receipt's connection must be that connection, and the current grant must be `granted` for that artifact — a revocation or a vanished/replaced connection is lost authority, never a fallback to staff-only consent |

Refusals are named: `consent_required`, `consent_withdrawn`,
`consent_superseded`, `consent_version_refused`,
`consent_artifact_unavailable` (no approved artifact exists yet). Approving
the artifact itself is a human review in the consent registry; nothing here
invents a hash or substitutes a configuration flag.

### Visit record (`VISIT#<appointmentId>`)

| Field | Meaning |
| --- | --- |
| `requestId`, `consumerPersonId`, `scheduledStart/End`, `timeZone` | the binding (request-derived or desktop-resolved) |
| `consents[]` | append-only receipts: artifact id/version/hash, signer, method, representative authority, governed grant id, `granted`/`withdrawn` |
| `status` | `scheduled` → `in_visit` → `ending` → `ended`; or `cancelled` |
| `meetingLease` | the durable creating-intent: `acquired` (held, no provider call yet) or `dispatched` (a create was sent; `createdMeetingId` is the exact evidence once known). Only an expired `acquired` lease may be taken over; a `dispatched` lease is reconciled, never overwritten |
| `patientRecordId`, `practitionerUserId` | from the calendar (desktop-booked) — the visit's authoritative patient and practitioner |
| `providerMeetingId`, `providerMeetingUuid`, `joinUrl`, `passcode` | the Zoom meeting instance; `passcode` is Zoom's actual meeting password from create/get meeting, never the encrypted `pwd` token of the join URL, and it leaves the Lambda only inside a start-visit session |
| `providerShutdown` | `not_started`/`pending`/`ended`/`failed` with the provider's answer; `ended` only when Zoom confirmed |
| `flags[]`, `quickNotes` | stamped against the visit timer; saved when the visit ends |
| `note`, `noteHistory[]` | the current note and its prior revisions (bounded); `status` `not_reviewed` or `signed` |

Every write replaces the record under its `version` (optimistic concurrency),
so two tabs cannot interleave. Signed notes are frozen: import and sign both
refuse with `conflict`.

### The meeting: one per visit

Creation is admitted under a durable lease on the visit before any provider
call; a racing start loses the conditional write and is refused without a
second meeting. The sequence is: lease `acquired` → a COMPLETE marker
listing of the host's upcoming meetings (`alp-visit:<appointmentId>` in the
agenda; an incomplete listing — pages left, or the page bound — refuses
rather than concluding "nothing exists") → lease `dispatched` written
BEFORE the create is sent → create → the created id written onto the lease
as evidence → bind. A thrown create leaves the lease `dispatched`; the next
start reconciles it first: by exact id when the evidence exists, otherwise
by a complete listing that can adopt exactly one matching meeting. An empty,
missing or incomplete listing cannot prove that an uncertain creation did
not happen; the dispatched lease stays fenced and no new create is permitted.
A lost database receipt is confirmed by a
single reread (a write that landed is success, never undone); a visit that
was cancelled or bound elsewhere underneath the attempt has the meeting this
attempt created deleted. An expired `acquired` lease (the holder never
reached the provider) may be taken over; an expired `dispatched` lease may
not.

### Ending: a shutdown intent, confirmed by the provider

`end` saves the notes and flags, marks the visit `ending`, asks Zoom to end
the meeting for everyone (`PUT /meetings/{id}/status {action: "end"}`) and then
reads the meeting back. The visit becomes `ended` only on a valid provider
observation: a 2xx state for **this** meeting id whose `status` is exactly
Zoom's documented `waiting` (not in progress). A refused end, a 404, an
unreadable or empty body, a state for a different meeting, `started`, or a
provider that is disabled on the deployment while a meeting exists — all
leave the visit `ending` with `providerShutdown.failed` and the detail; the
screens say the meeting may still be running (recording and AI processing
included), and the practitioner retries. Only a visit with no provider
meeting ends without an observation. The browser leaving its own client is
never shown as termination.

### The AI summary

`import` requires the appointment authority and a current consent authority
(summary access is a use of the recording consent), stores Zoom's payload
verbatim, and refuses a payload that does not name this meeting id, that
names another meeting uuid when the visit knows its own, or that exceeds the
size bound (checked on the declared length before the body is read, and on
the bytes received). Zoom's current unified `summary_content` (Markdown) is
kept whole as the unreviewed Summary section and rendered as plain text;
legacy overview/details/next-steps fields are mapped by label. A payload
with no usable text is "not ready", never an empty editable note. Re-import
keeps practitioner notes and action-item decisions and retains the prior
revision.

## Zoom

Zoom is **disabled by default** and stays disabled until the stack is deployed
with `ZoomEnabled=true`, `ZoomBaaVerified=true` and a `ZoomSecretArn`. Starting
a visit with Zoom off is refused as `provider_unavailable`, which the screen
shows as "Video is not enabled for this practice yet".

The Secrets Manager secret is one JSON object:

| Key | Used for |
| --- | --- |
| `accountId`, `clientId`, `clientSecret` | Server-to-Server OAuth app (create/update/delete meetings, read the AI Companion summary, host ZAK) |
| `userId` | the Zoom user (email or id) that hosts practice meetings |
| `sdkKey`, `sdkSecret` | the Meeting SDK app; the secret signs the short-lived (2 h) SDK JWT and never leaves the Lambda |

Server-to-Server OAuth scopes the Lambda calls need: `meeting:write:admin`
(create/update/delete), `meeting:read:admin`, `user:read:admin` (ZAK via
`GET /users/{userId}/token?type=zak`), and the meeting-summary read scope
(`meeting_summary:read:admin`). Meetings are created with the waiting room on,
`join_before_host` off and `meeting_authentication` on. AI Companion meeting
summary must be turned on for the host account in Zoom; the Lambda imports it,
it does not start it.

### In the browser

`src/components/telehealth/zoom-sdk.ts` loads the Meeting SDK (component
view) from `source.zoom.us` at a pinned version, only on the visit screen and
only after the server has returned a visit session. Zoom's embedded CDN build
is not self-contained: it binds to the `React`, `ReactDOM`, `Redux`,
`ReduxThunk` and `_` globals Zoom documents loading alongside it, at the
React 18 line it was built against. The loader loads those vendor scripts in
order and then the SDK. This application is a React 19 bundle whose React is
module-scoped and never on `window`, so the two never meet: Zoom's UI renders
with Zoom's React inside the mount element. (The first version loaded only
the SDK script and died with "React is not defined".) Any failed bootstrap —
a network failure or a script that loaded without registering — removes the
elements it added and clears the loader's cache, so Retry fetches and
evaluates every script again instead of rediscovering the same missing
namespace. The session's `passcode` is Zoom's meeting password, which is what
the SDK's `JoinOptions.password` expects.

Verification: `e2e/zoom-sdk-bootstrap.spec.ts` loads the real pinned build
with network access, asserts `ZoomMtgEmbedded` registered and a client
initialized under the visit route, and that the inevitable join failure
(the fixture meeting does not exist) is reported as a join failure, not a load
failure. CI runs it as its own step (`E2E_ZOOM_SDK=1`). The negative suite
(`live-telehealth.spec.ts`) aborts the download and proves the honest
failure state. `src/lib/telehealth-headers.test.ts` pins the production CSP
and isolation headers. A two-participant run — host join, patient join,
media permissions, reconnect, end-for-all — needs an authorized Zoom account
and real devices; it is a manual acceptance step before any PHI, not a
simulation here.

`next.config.ts` gives `/telehealth/visit/*` a Content-Security-Policy that
allows exactly the Zoom origins the SDK needs and nothing else, camera +
microphone + display capture for this origin, and cross-origin isolation
(`Cross-Origin-Embedder-Policy: credentialless`) so the SDK can use
SharedArrayBuffer. `/api/live/telehealth/*` responses are never cached.

Mute, camera, screen share, chat, participants and the waiting-room "Admit"
use Zoom's own toolbar inside the embedded view. "Show patient" is screen
sharing one chart window through Zoom — the side panel opens chart tabs in
their own window for that reason.

## What the screens do

**Day view** (`/telehealth?date=YYYY-MM-DD`): stat tiles are counts of the
rows shown. Each row has the appointment status, the visit phase
(`Consent not signed` / `Consent signed` / `In visit` / `Visit ended · note
pending` / `Note awaiting signature` / `Note signed`) and one action: Record
consent, Start visit, Rejoin visit, Open note, View note.

**Visit** (`/telehealth/visit/[appointmentId]`): the stage says "This visit
cannot start" without consent and offers to record it, and "cancelled" for a
cancelled appointment. Start visit asks the server for a session; the
server's refusal (consent missing, withdrawn, superseded; appointment
cancelled; Zoom off; BAA not verified) is shown as-is. Quick notes and
flagged moments are stamped against the timer and saved when the visit ends.
End visit asks the server to end the meeting for everyone; the note opens
only once Zoom confirms, otherwise the screen says the meeting may still be
running and offers Retry shutdown.

**Note** (`…/note`): labelled as the telehealth visit record. Import AI
Companion notes (available once Zoom confirmed the end; "not produced yet" is
reported, not faked). Practitioner notes on top, "Paste my quick notes from
the call", four editable AI sections (Zoom's unified summary shown whole
under Summary), action items to approve or dismiss (decisions only — tasks,
orders and appointments are created separately), the recording/flags card,
prior revisions, and Sign note with a confirmation. Signed notes render
frozen and survive reload because the record is the source of truth.

## Verified by

- `src/server/clinical-core/aws-telehealth-requests.test.ts` — route
  registration and the API-origin wiring; a direct AWS call for an
  appointment the caller's calendar does not return is refused with no
  write, secret or provider call; a desktop-booked consent binds to the
  calendar's patient and stored times, not the caller's; cancelled (calendar
  or request), revoked membership, non-telehealth, mismatched and missing
  bindings refused; no consent → appointment verified then nothing else;
  superseded artifact, withdrawn grant and a vanished connection refused;
  staff consent only against the current artifact, append-only, passcode
  never listed; governed grant recorded through the identity API;
  withdrawal; one meeting under the lease, bound with Zoom's actual password
  (never the URL token), racing start refused without a second create; a
  thrown create leaves a `dispatched` lease — incomplete listing refuses,
  complete unique listing adopts, complete empty listing stays fenced;
  evidenced create adopted by exact id; lost database receipt confirmed by
  reread without deleting; meeting deleted when the visit was cancelled
  underneath; shutdown never certified on a disabled provider, empty state,
  wrong meeting, 404, refused end or `started` — certified only on
  `waiting` for this meeting; duplicate end idempotent; unified-summary
  import, wrong-id/missing-id/wrong-uuid/oversized refusals, empty → not
  ready; re-import keeps notes/decisions and history; frozen signed notes;
  paginated lists without note bodies; cancelled booking closes the visit
  and deletes its meeting; SDK JWT shape.
- `src/adapters/telehealth.live.test.ts` — zoned day bounds (zone, DST,
  impossible dates), the merge, unavailable and incomplete boundary states,
  appointment resolution before any boundary call, stored times only,
  cancelled-appointment refusal, refusal message mapping.
- `src/lib/telehealth-headers.test.ts` — the visit route's production CSP and
  isolation headers.
- `src/server/clinical-core/aws-identity-api.test.ts`,
  `authenticated-api-infrastructure.test.ts` — the workforce consent reads
  and the 57-route pin. `telehealth-consent-candidate.database.test.ts` applies
  the distinct 108-migration artifact in PGlite and exercises the API role's
  real row policies: all prior scopes remain supported, foreign-clinic and
  consumer-pool reads refuse, retired artifacts confer no authority, and
  withdrawal supersedes the grant. This is in-memory qualification, not AWS
  evidence. `scripts/migration-sql-bytes.test.mjs` verifies that CRLF/CR input
  builds the same canonical LF migration bytes without changing SQL content.
- `e2e/live-telehealth.spec.ts` — six local browser cases: the artifact shown
  before attesting, absent-appointment and stale-artifact refusals, consent
  through confirmed fixture shutdown, clearing opened text after a refused
  signature, an imported note's confirmed signature and persisted revision,
  and an admitted start delivered after navigation without loading an SDK.
  The suite runs serially with a reset at its entry; the delayed-start case
  resets its own fixture. These are contract-fixture observations, not actual
  Zoom meetings or hosted acceptance.
- `e2e/zoom-sdk-bootstrap.spec.ts` — the positive SDK bootstrap (CI step with
  network access).

## Not integrated yet — blocking for PHI

These are stated so they are not mistaken for done:

- **Chart integration.** The signed telehealth note lives on the visit
  record with its revisions; it is not posted through the chart's
  clinical-note/timeline/amendment path and does not appear in the patient
  timeline. The screens and the sign confirmation say so.
- **Record lifecycle.** Consent receipts, quick notes, AI originals and signed
  visit text are new clinical data on the telehealth table. Export,
  correction/amendment, retention, legal hold, erasure and provider-copy
  reconciliation (Zoom's recording/summary copies) are not wired for them.
- **Host binding.** The Lambda uses one configured Zoom host per deployment.
  A multi-practitioner, multi-clinic binding of organization → authorized
  host/practitioner is not proven by a workforce JWT and organization string.
- **Patient-app consent screen.** The consumer booking route validates the
  consent object; the released V2 screen and end-to-end receipt are the
  platform repository's to prove.
- **Zoom agreement.** `ZoomBaaVerified=true` is an operator attestation that
  the executed agreement covers the account, the Meeting SDK app, AI Companion
  and recording/AI policies; it is not the review itself.
- **Positive visit acceptance.** The CI bootstrap step proves the SDK
  registers and initializes under the dev server and that the fixture's join
  fails as a join. A real two-participant meeting under production headers —
  host join with the actual password, patient join, media, reconnect,
  end-for-all, note import for the exact meeting instance — and the
  direct-AWS authority negatives and creation/cancellation/withdrawal/
  receipt-loss races against the deployed synthetic boundary are not run by
  this repository and remain required before activation.

## Appointment change outcome recovery

The consumer `POST /clinical-core/consumer/appointments/change-outcome` route is a read-only observation under the consumer JWT authorizer. The caller submits the original `appointment-change/1` operation ID and exact action input, wrapped as `consumer_action` or `authorize`. Current request ownership is checked before the strong operation read; organization, role, person, subject, request, version, kind and input digest must all match. The reply contains only a historical disposition and minimal receipt, never private fences, actor subjects, input hashes or provider credentials. This route does not read a secret, write data or contact Zoom, Stripe or the scheduler.

A committed disposition identifies the original successor version, even if later changes altered the current appointment. A refused disposition requires a new durable `appointment-disposition/1` no-effects marker. Refusal settlement conditionally requires the operation to remain admitted with no reserved-slot evidence, and atomically removes the request and visit fences. A legacy refused row, pending dispatch or contradictory receipt remains unresolved. No row means unobserved, not non-admission. No status result allows a new writer to take over uncertain provider work.

The matched V2 journal preserves its original intent until an explicit outcome check saves and verifies the exact completion or no-effects refusal receipt. New actions require refresh. The endpoint and client are source candidates, not deployed acceptance. Provider reconciliation, safe resolution of pre-admission refusals, cross-device discovery, complete pagination and slot lineage, cloud record lifecycle, chart integration, consent release, per-clinic hosts and hosted/device qualification remain required. PHI stays disabled.

## Recovery on another consumer device

The consumer JWT route `POST /clinical-core/consumer/appointments/pending-change` observes the operation named by the current request fence. It verifies current owner and clinic before the operation read, then binds its organization, request, consumer identity, version and exact input digest. New explicit consumer operations privately retain only structured scheduling choices needed to recover the original action. Workforce and legacy implicit operations do not capture recovery input. Unsupported or invalid choices are not converted into a recoverable action.

The response exposes only the original consumer action identity and its admission time. Another actor's input is withheld. An absent fence means none observed, not that a device's unconfirmed change failed; a settled read race means changed, not a substitute receipt. Older pending records without the original input remain unrecoverable and fenced. Discovery performs only reads, with no secrets, provider calls, reservations, cancellation or billing writes.

The matched V2 screen first displays the original action for review. Explicit adoption rechecks the exact observation and saves and verifies it in the existing sealed journal without redispatch, generating a UUID, overwriting a local intent or changing payment authorization. The owner can then check the original outcome. A changed observation or lost access refuses adoption. Backgrounding removes the preview, and owner erasure drains late writers.

This implements discovery of newly captured pending consumer actions, not a history browser, legacy reconstruction, provider reconciliation or a two-device hosted acceptance result. The new private operation input also requires the still-open cloud lifecycle integration. Deploy the matched authorizer, handler and V2 candidate together; keep PHI disabled until the broader activation requirements are met.

## Explicit consumer appointment recovery

The consumer-authorized `POST /clinical-core/consumer/appointments/recover-change`
continues the original saved `appointment-change/1` cancel, reschedule request,
or payment-authorization choice. It requires `appointment-recovery/1`, the
original operation ID and exact input. It never creates a replacement operation,
hold or charge. Ordinary action replay remains read-only while the original
action is pending.

Recovery requires an observed private `appointment-writer/1` closure, not an
elapsed lease or an old admission time. The request, owner, clinic, subject,
kind, digest and version must match. One transaction claims a new private writer
token while checking the original request and visit fences. Concurrent recovery,
an active visit, a missing closure or legacy input remains refused. A lost
admission response closes only the matching unstarted writer. Historical
committed operations return their exact receipt without another mutation.

A reserved reschedule continues only its original replacement slot, holder,
hold ID and operation fence, even after that hold's deadline. An unreserved
replacement must still be held and unexpired before any provider cleanup. The
original admission time determines the cancellation fee. Final request,
calendar, slot, visit and receipt changes settle atomically, preserving the
fresh visit's consent withdrawals and note history.

Zoom cleanup reads the exact stored meeting ID, never an upcoming-meeting list.
Before deletion it requires a matching marker, host, time, available instance
UUID and a waiting non-recurring meeting. Only a subsequent exact GET returning
HTTP 404 with numeric code 3001 confirms absence. The restriction to
non-recurring meetings matters because deleting a recurring meeting without an
occurrence ID deletes its series. See [Zoom meeting APIs](https://developers.zoom.us/docs/api/meetings/).

Scheduler cleanup reads the exact group and generation-specific name and
verifies its target, role and request payload. Only the SDK's
`ResourceNotFoundException` proves absence; a successful deletion requires
another read. Permission errors and throttling remain unresolved. See
[GetSchedule](https://docs.aws.amazon.com/scheduler/latest/APIReference/API_GetSchedule.html)
and [DeleteSchedule](https://docs.aws.amazon.com/scheduler/latest/APIReference/API_DeleteSchedule.html).

Provider work has a 20-second aggregate wait budget with five-second child
deadlines. Aborting local waiting is not proof that a remote write stopped.
Unknown outcomes stay fenced for explicit reconciliation; the original
operation is never converted into a no-effects refusal after recorded dispatch
or reservation. These bounds and recovery journeys are locally tested with
fictional stores and providers, not hosted acceptance.

Deploy the matched consumer route, handler and V2 recovery client together.
Staff creation recovery, legacy operations, unobserved pre-admission outcomes,
provider invocation settlement, orphan inventory, full slot lineage, cloud
record lifecycle, chart integration, patient consent release, per-clinic hosts
and physical host/patient and two-device acceptance remain open. PHI stays off.

## Patient consent copy source extension

The distinct 112-migration source candidate adds an exact-copy patient consent
port without changing any 106, 107, 108 or 111 release bytes. Build it with
`npm run build:telehealth-consent-copy-candidate`; verify it with
`npm run test:telehealth-consent-copy` and
`npm run test:telehealth-consent-copy-candidate`. It is not an applied migration,
approved consent release or deployed handler.

`production_telehealth_consent_request` supports consumer connection discovery,
review, grant and withdrawal for `telehealth_recording` only. Review returns the
exact UTF-8 wording from `care_consent_texts`, its artifact/version/hash and the
current grant position. Missing copy, a newer release without copy, future
approval or an inactive reviewer prevents new grants; there is no older-copy
fallback. The grant and withdrawal compare the patient's expected version and
append consent and audit rows. Revoking a link or retiring wording does not
remove status or withdrawal. Withdrawal is not a deletion receipt.

The proposed `POST /clinical-core/consumer/telehealth-consent` API uses only
verified consumer claims and the configured clinic, requires fresh sign-in for
a grant, and admits only designated fictional subjects in qualification. Its
independent connection, consent, database and MFA reviews are not generated by
the builder. New grants default to disabled in the intended deployment. The
database binding checks the existing immutable-copy safeguards plus the new
function's exact bytes, restricted execution and search path before reading
content. Direct table reads, changed functions and overloads are refused.

Remaining integration is explicit: build and register the artifact-bound Lambda
and its default-blocked template, implement the preserving 111-to-112 operator
with rollback evidence, and extend the copy registrar through a separate exact
112 target mapping. The historical 105/106 registrar must not be widened by
count alone. V2 still needs the reviewed-copy signing screen, fresh review
before acknowledgment, booking receipt linkage, withdrawal and uncertain-outcome
recovery. Do not route this through the legacy metadata-only artifact/grant API.
Hosted concurrent-owner/version tests and physical phone acceptance follow the
matched deployment. No production consent text, review, copy, grant, provider
approval or PHI activation is created by this source extension.

## Reminder revision isolation

Each new scheduling operation gives its reminders a private generation equal to
the original admitted operation UUID. The schedule name combines the request
UUID, the generation encoded as 22 base64url characters, and the reminder offset.
The longest name is 63 characters and retains the existing `alp-` resource
prefix. The generation is persisted even when only part of schedule creation
succeeds, but it is removed from public appointment replies. Creation uses a
deterministic client token bound to the exact name, target and schedule input.
The format fits the [AWS CreateSchedule name and token constraints](https://docs.aws.amazon.com/scheduler/latest/APIReference/API_CreateSchedule.html).

Rescheduling deletes only the previous generation's names, never the names of
its replacement. Cleanup of an older row uses its original legacy names; malformed
generation metadata never selects that legacy fallback. Cancellation and a
consumer reschedule request disable reminder delivery. A scheduling operation
with reminders disabled also saves its new generation and disabled status; it
does not claim that old schedules were physically deleted.

New targets carry `appointment-reminder/2`, the exact generation and scheduled
start. A reminder can send only for the current matching generation, a scheduled
reminder status and a scheduled or awaiting-provider appointment. A mutation
fence refuses delivery. Legacy events can send only for legacy rows; they cannot
send for a new generation at the same appointment time. After the suppression
lookup, a second strongly consistent request read checks the generation, time,
status, fence, version, owner, address and join link before mailing.

These checks are locally tested through the actual scheduling and delivery
handler with fictional DynamoDB, Scheduler and SES transports. They are not
hosted acceptance, exactly-once email delivery or an atomic database-and-SES
transaction. A change or suppression can still occur after the final read. A
delayed old create can leave an orphan schedule, although its event cannot mail
the current request. Provider and invocation settlement, compensating cleanup,
orphan inventory, pagination, cloud lifecycle and hosted race tests remain
required before activation. Unknown cancellation deletions remain fenced rather
than becoming certified no-effects refusals. PHI remains disabled.

## Open decisions (unchanged from the handoff)

Consent wording and renewal (attorney review; California requires every
party's consent to recording), the Zoom plan's BAA and AI Companion
permission, recording/transcript retention (the note says it stays in Zoom
under the practice's settings), patients who decline recording, out-of-state
patients (the location is recorded, nothing is blocked), and whether to
restructure Zoom's summary with the platform's AI layer (today it is mapped by
section label only, never rewritten).
