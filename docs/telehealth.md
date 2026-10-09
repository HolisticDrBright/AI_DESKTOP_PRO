# Telehealth — virtual visits inside Desktop Pro

The Telehealth tab (sidebar, under Calendar) is where a practitioner runs a
video visit without leaving the chart: the day's virtual visits, the visit
itself with Zoom embedded in the page, and the post-visit note that starts as
Zoom AI Companion's summary and becomes a chart note only when the
practitioner signs it.

This is the clinical edition. There is no sample data on any of these screens:
every row is an appointment that exists, every consent is a record somebody
made, and a service that cannot answer says so.

## Product decisions carried into code

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

1. **The appointment.** Every visit action (`consent`, `withdraw`, `start`,
   `end`, `import`, `sign`) first resolves its appointment through the
   practitioner's own calendar access (`get_desktop_calendar`, RLS). An
   appointment the calendar does not return — nonexistent, another
   organization, no access — is `not_found` before the boundary is called. A
   cancelled or no-show appointment is refused. The appointment's **stored**
   times go to the boundary; nothing from the browser does. The day and the
   zone are the viewer's (`date` + IANA `timeZone` on every call), computed
   DST-aware; February 31 is refused, not normalised.
2. **The request.** A patient-app visit is bound to its request on the
   boundary: the request must exist in the caller's organization, name this
   exact appointment, and not be cancelled; its stored times and meeting are
   authoritative. Cancelling a request closes its visit and deletes a meeting
   the visit itself created.
3. **The consent.** See the consent section below. No authority read, no
   secret lookup and no provider call happens before a refusal.

The Lambda cannot see the clinical calendar. For a desktop-booked visit (no
request) it relies on the desktop server having resolved the appointment under
the practitioner's session, which is why the desktop never forwards a browser
value. That split is a known limit, documented here rather than hidden.

### Consent

The combined telehealth + recording/AI-notes consent is the governed
`telehealth_recording` scope in the identity extension
(`infra/aws-clinical-core/migrations/20261009100000_telehealth_recording_consent.sql`):
one approved, versioned, hashed artifact per organization and an append-only
grant/revoke lifecycle per patient connection. The identity API exposes two
workforce reads for it — `GET /clinical-core/workforce/consent-artifact` and
`GET /clinical-core/workforce/consents/current` — and the telehealth Lambda
calls them with the caller's own JWT.

| Path | What is checked |
| --- | --- |
| Patient app, at booking | the consent object must name the organization's **current approved** artifact (id, version, hash); otherwise `consent_version_refused` |
| Desktop, staff-attested | the dialog reads the current artifact first and shows its version, jurisdiction and hash; the receipt must name exactly that artifact; when the patient has an app connection the grant is recorded in the identity authority (`in_person`) and its id is stored on the receipt |
| Withdrawal | `POST …/visits/consent/withdraw` marks receipts withdrawn (append-only) and revokes the governed grant |
| Start, and AI-summary import | a granted, un-withdrawn receipt; its artifact must still be the approved one (a retired/superseded release is no authority); when a connection exists the current grant must be `granted` for that artifact — a revocation in the authority revokes the visit |

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
| `meetingLease` | the durable creating-intent held while a provider meeting is being created (2-minute TTL) |
| `providerMeetingId`, `joinUrl`, `passcode` | the Zoom meeting; the passcode leaves the Lambda only inside a start-visit session |
| `providerShutdown` | `not_started`/`pending`/`ended`/`failed` with the provider's answer; `ended` only when Zoom confirmed |
| `flags[]`, `quickNotes` | stamped against the visit timer; saved when the visit ends |
| `note`, `noteHistory[]` | the current note and its prior revisions (bounded); `status` `not_reviewed` or `signed` |

Every write replaces the record under its `version` (optimistic concurrency),
so two tabs cannot interleave. Signed notes are frozen: import and sign both
refuse with `conflict`.

### The meeting: one per visit

Two simultaneous starts used to create two Zoom meetings. Now creation is
admitted under a durable lease written to the visit before any provider call;
a racing start loses the conditional write and is refused without a second
meeting. Before creating, the Lambda looks for an existing upcoming meeting
carrying the visit's marker (`alp-visit:<appointmentId>` in the agenda) so a
lost create response is reconciled, not repeated. If the created meeting
cannot be bound to the visit, it is deleted and the lease released.

### Ending: a shutdown intent, confirmed by the provider

`end` saves the notes and flags, marks the visit `ending`, asks Zoom to end
the meeting for everyone (`PUT /meetings/{id}/status {action: "end"}`) and then
reads the meeting state. Only a confirmed stop makes the visit `ended`;
otherwise it stays `ending` with `providerShutdown.failed` and the detail, the
screens say the meeting may still be running (recording and AI processing
included), and the practitioner retries. The browser leaving its own client
is never shown as termination.

### The AI summary

`import` requires a current consent authority (summary access is a use of the
recording consent), stores Zoom's payload verbatim, and refuses a payload that
names another meeting or exceeds the size bound. Zoom's current unified
`summary_content` (Markdown) is kept whole as the unreviewed Summary section
and rendered as plain text; legacy overview/details/next-steps fields are
mapped by label. A payload with no usable text is "not ready", never an empty
editable note. Re-import keeps practitioner notes and action-item decisions
and retains the prior revision.

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
the SDK script and died with "React is not defined".) A failed load clears
the loader's cache so Retry really retries.

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
  registration and the API-origin wiring; refusals with no authority read,
  secret or provider call (no consent, superseded artifact, withdrawn grant,
  cancelled/mismatched/missing request); request times used over caller
  times; staff consent only against the current artifact, append-only,
  passcode never returned; governed grant recorded through the identity API;
  withdrawal; one meeting under the lease with the racing start refused and
  no second create; adoption by marker and cleanup on a failed receipt;
  provider shutdown refused → `ending`/`failed`, confirmed → `ended`,
  duplicate end idempotent; unified-summary import, wrong-meeting refusal,
  empty → not ready; re-import keeps notes/decisions and history; frozen
  signed notes; paginated complete/incomplete lists without note bodies;
  cancelled booking closes the visit and deletes its meeting; SDK JWT shape.
- `src/adapters/telehealth.live.test.ts` — zoned day bounds (zone, DST,
  impossible dates), the merge, unavailable and incomplete boundary states,
  appointment resolution before any boundary call, stored times only,
  cancelled-appointment refusal, refusal message mapping.
- `src/lib/telehealth-headers.test.ts` — the visit route's production CSP and
  isolation headers.
- `src/server/clinical-core/aws-identity-api.test.ts`,
  `migrations.test.ts`, `authenticated-api-infrastructure.test.ts` — the
  `telehealth_recording` scope, the workforce consent reads and route pins.
- `e2e/live-telehealth.spec.ts` — the four browser proofs at the top of that
  file (now including the artifact shown before attesting, the 404 for an
  appointment the calendar does not return, and the 409 for a stale artifact),
  in the one-process battery in any order.
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

## Open decisions (unchanged from the handoff)

Consent wording and renewal (attorney review; California requires every
party's consent to recording), the Zoom plan's BAA and AI Companion
permission, recording/transcript retention (the note says it stays in Zoom
under the practice's settings), patients who decline recording, out-of-state
patients (the location is recorded, nothing is blocked), and whether to
restructure Zoom's summary with the platform's AI layer (today it is mapped by
section label only, never rewritten).
