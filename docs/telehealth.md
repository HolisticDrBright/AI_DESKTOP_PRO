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
Telehealth day view
  ├─ Desktop-owned calendar RPC (get_desktop_calendar) — appointments of type `telehealth`
  └─ AWS telehealth boundary (telehealth-requests Lambda, workforce routes)
       ├─ patient-app requests (already existed) — scheduled requests appear as rows
       └─ VISIT records (new) — consent, Zoom meeting, flags/quick notes, the note
```

The two sources are merged per appointment in `src/adapters/telehealth.live.ts`.
If the visit boundary is unreachable, the calendar rows still render and the
screen says consent and meeting state are **unknown** — it never renders
"Consent not signed" for a consent it could not read.

No new Supabase migration or `clinicalRpc` operation was added: the calendar
read is the existing reviewed operation, and everything visit-specific is a
DynamoDB item on the telehealth table the Lambda already owns.

### Visit record (`VISIT#<appointmentId>`)

| Field | Meaning |
| --- | --- |
| `consents[]` | append-only; `method` is `patient_app` (typed by the patient at booking) or `staff_attested` (recorded on the desktop) |
| `status` | `scheduled` → `in_visit` → `ended` |
| `providerMeetingId`, `joinUrl`, `passcode` | the Zoom meeting; the passcode leaves the Lambda only inside a start-visit session |
| `flags[]`, `quickNotes` | stamped against the visit timer; saved when the visit ends |
| `note` | `status` `not_reviewed` or `signed`; `aiSections` (four chart sections), `aiOriginal` (Zoom's summary verbatim), `practitionerNotes`, `actionItems[]`, `revision` |

Every write replaces the record under its `version` (optimistic concurrency),
so two tabs cannot interleave. Signed notes are frozen: import and sign both
refuse with `conflict`.

## Workforce routes (telehealth Lambda)

| Route | Does |
| --- | --- |
| `GET  …/appointments/visits` | list visit records for the organization |
| `POST …/appointments/visits/consent` | record a staff-attested consent (`agreed: true` required) |
| `POST …/appointments/visits/start` | **consent gate** → create/reuse the Zoom meeting → sign the Meeting SDK JWT → fetch the host ZAK → `{ visit, session }` |
| `POST …/appointments/visits/end` | store flags + quick notes, mark ended |
| `GET  …/appointments/visits/notes?appointmentId=` | the visit record with its note |
| `POST …/appointments/visits/notes/import` | fetch `GET /meetings/{id}/meeting_summary`, store as `not_reviewed` (`summaryReady: false` until Zoom has produced it) |
| `POST …/appointments/visits/notes/sign` | practitioner notes + reviewed sections + action-item decisions, frozen |

All routes sit behind the workforce JWT authorizer
(`infra/aws-clinical-core/telehealth-requests-extension.json`, contract
`telehealth-requests/5`). The consumer `POST …/consumer/appointments/requests`
now accepts an optional `consent` object (`consentVersion`, `signerName`,
`patientLocation`, `agreed: true`) — the last step of "Request a virtual
visit" in the patient app. A consent signed there follows the appointment into
its visit record when the request is scheduled.

The desktop reaches these through `src/app/api/live/telehealth/*` →
`src/adapters/telehealth.live.ts`. In the browser suite the adapter uses the
contract-fixture origin (same gate as every other live adapter), and
`scripts/live-stub-server.mjs` implements the same routes.

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
only after the server has returned a visit session. The npm package pins
React 18 as a peer, which this app does not use, so the self-contained CDN
build is used instead.

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
cannot start" without consent and offers to record it. Start visit asks the
server for a session; the server's refusal (consent, Zoom off, BAA not
verified) is shown as-is. Quick notes and flagged moments are stamped against
the timer and saved when the visit ends; End visit confirms, closes the Zoom
meeting, and opens the note.

**Note** (`…/note`): Import AI Companion notes (available after the visit
ends; "not produced yet" is reported, not faked). Practitioner notes on top,
"Paste my quick notes from the call", four editable AI sections, action items
to approve or dismiss (decisions only — tasks, orders and appointments are
created separately), the recording/flags card, and Sign note with a
confirmation. Signed notes render frozen and survive reload because the record
is the source of truth.

## Verified by

- `src/server/clinical-core/aws-telehealth-requests.test.ts` — route
  registration, consent gate (409 `consent_required`), Zoom-off refusal,
  append-only consent without passcode leakage, verbatim summary import with
  suggested action items, no import over / no second signature on a signed
  note, Meeting SDK JWT shape.
- `e2e/live-telehealth.spec.ts` — the four browser proofs listed at the top of
  that file, run in the one-process battery in any order.

## Open decisions (unchanged from the handoff)

Consent wording and renewal (attorney review; California requires every
party's consent to recording), the Zoom plan's BAA and AI Companion
permission, recording/transcript retention (the note says it stays in Zoom
under the practice's settings), patients who decline recording, out-of-state
patients (the location is recorded, nothing is blocked), and whether to
restructure Zoom's summary with the platform's AI layer (today it is mapped by
section label only, never rewritten).
