# Patient reminders and notifications — design and source (2026-10-13)

Branch `claude/patient-notifications-20261013`, from the integration head `07a5a9ca`. Design and
source only. Nothing here is deployed, applied, registered, or sent; no AWS resource, number, sender
identity or wording was created; PHI stays off. The lesson-media branch is untouched. No open-source
messaging project was added, and nothing uses Amazon Pinpoint campaigns or journeys (AWS ends Pinpoint
on 2026-10-30): texts use the AWS End User Messaging SMS API (`@aws-sdk/client-pinpoint-sms-voice-v2`,
`SendTextMessage`), which is a separate, continuing service.

These messages are sent from the clinical side about the patient's own care. They share nothing with
the campaign service (`lead-campaigns-handoff.md`): no table, list, identity, sender or code path.

## What existed before

- **Email reminders** (`src/server/clinical-core/aws-telehealth-requests.ts`): EventBridge Scheduler at
  24 h and 1 h before the visit (names `alp-<request>-<generation>-<offset>`), SES with its own
  configuration set, removal on cancel and reschedule, recovery confirmation, and bounce/complaint
  suppression by hashed address. Disabled (`remindersEnabled: false`).
- **No text code**, no notification outbox, no "something new" notice anywhere in the Desktop source.
- **The patient app (V2) has no push support** at `edcb442`: no `expo-notifications`, no push
  entitlement or token code. Push therefore cannot be the first channel without a native change and a
  mobile build, which this handoff does not authorize. **Open for Brandon: whether push comes first.**
  The preference model carries a `push` flag fixed to `false` and the settings view reports
  `pushAvailable: false`, so adding push later is a contract change, not a silent setting.

## The design as built

### Contract — `src/contracts/patientNotifications.ts` (`patient-notifications/1`)

- Five kinds, in fixed order, each with Brandon's fixed phrase: `lab_result` "a new lab result",
  `protocol` "a new protocol", `message` "a new message", `form` "a new form", `program_lesson` "a new
  program lesson".
- Preferences: `appointmentReminders {email, sms}` and, per kind, `{email, sms, push:false}`.
  Defaults: reminders by email **on**, every kind by email **on**, everything by text **off**, push off.
- Text consent names one E.164 number, the consent wording version and its SHA-256, the time and
  `source: patient_app`. Time zone is an IANA zone; without one, no text is sent.
- Reminders stay at **24 h and 1 h** (`REMINDER_OFFSETS`); texts only **08:00–21:00** local (`TEXT_HOURS`).

### Rules — `src/server/notifications/notification-policy.ts` (pure functions)

Quiet hours in the patient's zone (`withinTextHours`, `nextTextWindow`, daylight-saving safe); inbound
keyword classification (STOP family, HELP/INFO, START/UNSTOP; a sentence is never a keyword);
batching; channel choice; and the fixed wording:

- Notice email: subject "Something new is waiting for you"; body "`<Clinic>` has a new lab result and a
  new message waiting for you in AI Longevity Pro. Sign in to see it: `<origin>/sign-in`", plus "This
  email does not contain your health information."
- Notice text: "`<Clinic>`: you have … waiting in AI Longevity Pro. Sign in to see it: … Reply STOP to
  stop texts, HELP for help." (two segments at most, with the longest allowed clinic name).
- Reminder text: "`<Clinic>`: reminder of your appointment on Wed, Oct 14, 10:30 AM PDT. To join or
  reschedule, sign in to AI Longevity Pro: … Reply STOP …" — clinic, local date and time, how to join
  or reschedule; nothing about the reason, practitioner or program.
- Every link is the app's own `https` origin plus `/sign-in`: no path, query, fragment, port, user
  info or token is accepted (`signInLink` throws otherwise). Clinic names are a restricted character
  set; the template refuses anything else instead of sending it.

### Database — BLOCKED candidate `infra/aws-clinical-core/source-candidates/patient-notifications.sql`

SHA-256 `e7c88741f955055585d61428ae7edf02ae180a8ccd56ababb6b6e01f1057b91a`, pinned with its five parent
migrations and the manifest in `src/server/notifications/patient-notification-ledger.ts`. Not in the
manifest; schema and ledger changes are the native-AWS owner's to review and apply.

- **Disabled** by `patient_notification_activation` (`notices_enabled`, `texts_enabled`, both false;
  either needs evidence, reviewer and date). While disabled, an enqueue still runs every check but
  stores nothing, so no backlog forms.
- **Visibility is re-proven from the item's own table** at enqueue: a message a clinic member sent on
  the connection; an open form packet; a lab observation whose import was accepted; a program offered
  or active, or a phase with a practitioner release. Drafts, items under review, consumer-authored
  messages, another clinic's items and non-verified connections are refused or skipped. **Protocols
  are refused** (`notice_source_unverifiable`): the only protocol activation is on the production
  path, with no synthetic table to prove approval for this patient.
- **Nothing about the item is stored**: kind, `sha256("kind:item id")` for idempotency, who and when.
  No table has a body, title, value or address column (asserted); a text number appears only as a
  SHA-256 lookup key on deliveries, inbound replies and stops, and in plain form only on the consent
  the patient gave.
- **Batching**: `form_patient_notices(window, limit)` forms one notice per patient once the first
  waiting item has been visible for the window (default 10 minutes), carrying every waiting kind once.
  Each channel gets one delivery row (kinds, state, attempts, reason, provider reference as a hash).
- **Hand-out re-checks everything** (`due_patient_notice_deliveries`): connection still verified,
  clinic contact recorded, the current per-kind preference, texts enabled, no STOP, consent still at
  the same number, a time zone, and the local hour. What no longer holds is skipped with its reason; a
  text outside the hours stays queued. Leases are two minutes; three hand-outs without an outcome fail.
- **Consent and STOP**: consent needs a recorded, approved wording (none is seeded) and its exact
  digest; a new number withdraws the old consent; withdrawal turns every text preference off; consent
  rows are append-only except the one withdrawal stamp. STOP suppresses the number before anything
  else and skips queued texts; it is idempotent on the provider's inbound message id. START lifts a STOP
  only where consent is on record at that number (proving control of the number); otherwise the reply
  says to turn texts on in the app first. HELP answers with the clinic of the number's active consent
  (a person has at most one live connection), or the platform line.
- **Reminder texts**: `patient_reminder_channels` tells the reminder sender whether email is wanted and
  whether a text is allowed (and why not); `claim_patient_reminder_text` claims each
  `(request, generation, offset)` once so a retried schedule never texts twice.
- **Authority**: two NOLOGIN, NOINHERIT, non-bypass roles. `patient_notification_authority` owns every
  function and reads only through policies added for it; `clinical_core_api` may run the patient,
  clinic and enqueue functions, `patient_notification_worker` the delivery and inbound functions;
  neither has any table privilege.

### Server — `src/server/notifications/`

- `patient-notification-ledger.ts`: worker ledger, the enqueuer and the patient's own settings over
  the candidate, every reply parsed to its exact shape. Refusal names are classified in
  `rds-data-database.ts` so a refusal is never reported as an outage.
- `notification-dispatcher.ts`:
  - **Dispatcher** — form, hand out, render, send, record. The email address comes from a
    `PatientEmailDirectory` port (the consumer identity), never from a notification table; a bounced or
    complained address is skipped. A text outside the hours is deferred to the next 08:00 local.
  - **Inbound handler** — accepts one SNS topic and our own sending numbers only, classifies the body
    and passes on only the keyword class; replies once (STOP confirmation, HELP line, START outcome).
  - **Reminder text port** (`createAppointmentTextReminders`) and the **post-commit emitter**
    (`noticeSubjectsFor` + `createNoticeEmitter`, which never throws).
- `notification-providers.ts`: SES v2 and End User Messaging senders behind ports (no client is built
  without a complete configuration; nothing in the repository supplies one) and fictional senders.

### Where it is hooked in

- **Identity API** (`aws-identity-api.ts`, synthetic handler only): an optional `patientNotices`
  emitter is called **after** the action's reply is decided for workforce message send, intake packet
  assign, program assign and phase release, and lab import accept. Unset, nothing changes; a failing
  emitter cannot change, fail or roll back the reply.
- **Telehealth reminders** (`aws-telehealth-requests.ts`): `createTelehealthHandler(config, ports)`
  takes an optional `textReminders` port, refused unless reminders are enabled. With it, the same
  scheduled event runs the same refusal and staleness checks first, then sends the email unless the
  patient turned reminder emails off or the address bounced, and a text when the ledger allows one.
  Without it, the existing email path runs unchanged (the existing reminder tests are untouched and
  pass; one asserts the unchanged path explicitly).

## Tests (all fictional patients, addresses and numbers)

| Requirement | Where |
| --- | --- |
| Scheduling (same event, both channels, offsets, one text per reminder) | `aws-telehealth-requests.test.ts` "text appointment reminders beside the email"; `notification-dispatcher.test.ts` "text appointment reminders"; database "text appointment reminders" |
| Cancel and reschedule removal | Existing reminder lifecycle tests (unchanged); new: a cancelled or rescheduled visit sends nothing on either channel before preferences are read, and a change between the two reads sends nothing |
| STOP handling | `notification-policy.test.ts` keywords; database "STOP suppresses the number at once…", "START lifts a STOP only where consent is on record"; dispatcher "inbound replies"; end-to-end STOP through the SQL adapters |
| Quiet hours | Policy (zone boundaries, DST, half-hour zones); database hand-out only inside 08:00–21:00; dispatcher deferral; reminder text skipped in quiet hours without claiming |
| Batching | Policy `batchVisibleItems`; database "items close together make one notice per patient, each kind once, only after the window closes" |
| Preference rules | Policy channels; database defaults, exact shape, push fixed off, per-kind turn-off honoured at hand-out, text needs consent, withdrawal turns texts off; telehealth email-off preference |
| Visibility and content | Database refusals for drafts/under-review/consumer/foreign/protocol; no content columns; dispatcher bodies name kinds only; links carry no token |

The candidate tests were checked against three deliberate defects (dropping the sender check, the
quiet-hours check, and the STOP insert): each turned two or three tests red.

## What was not verified

- **No real send of any kind.** SES production access, the sending phone number and its carrier
  registration, End User Messaging configuration sets, two-way SMS and its SNS topic, and the number's
  keyword settings do not exist and were not touched. Delivery, segment counting on handsets, carrier
  filtering and opt-out behaviour are unproven.
- **The candidate ran on an embedded engine only**; hosted isolation, concurrent hand-out under load,
  lock behaviour and the RDS Data API path are hosted questions.
- **Not wired in any deployed host.** The identity API emitter, the dispatcher schedule, the inbound
  Lambda, the email directory (Cognito consumer email) and the telehealth Lambda's database connection
  for the reminder port are source seams; no Lambda entry, IAM, schedule or template was changed.
- **AWS agreement coverage** was not checked. AWS's HIPAA page lists End User Messaging (excluding
  voice and WhatsApp); `docs/external-provider-activation.md` still reasons from SNS. Brandon must
  confirm against the signed agreement.
- **Consent and message wording** are drafts for counsel; no consent wording is recorded.

## What Codex supplies (native AWS owner), in order, qualification account only

1. Review and apply the candidate (it is BLOCKED); register a worker login holding
   `patient_notification_worker`.
2. A dedicated SES configuration set for patient notices, its bounce/complaint destination, and the
   consumer-email directory over Cognito.
3. An End User Messaging origination identity with **self-managed opt-outs** (so this code is the STOP
   authority and confirms exactly once), a configuration set, and two-way SMS to one SNS topic.
4. Scheduled dispatcher and inbound Lambdas; the identity API `patientNotices` emitter; the telehealth
   Lambda's `textReminders` port with its database connection.
5. Hosted tests: one fictional notice end to end, STOP from a test handset, quiet-hours deferral.
   Activation stays off until the evidence is reviewed.

## Remaining defects and decisions

- **Push first?** Brandon's decision; needs a native module and a mobile build.
- **No patient settings route or screen yet.** The settings functions and adapter exist; the consumer
  route, its API Gateway entry and the V2 screen are not built, because the push decision changes the
  screen. Clinic name and help line also need a Desktop setting (the SQL function exists).
- **The number is not proven to belong to the patient** before the first text; a one-time confirm
  text is recommended before activation.
- **The existing email reminder** shows the time as a UTC ISO string and does not name the clinic; its
  wording is unchanged here because its tests pin it. Bringing it in line with the content rules is a
  small, separate change once counsel approves the wording.
- **A 1-hour reminder before 09:00** falls in quiet hours and its text is skipped (the email is not).
- **Email is at-least-once**: if SES accepts and the outcome cannot be recorded, a lease expiry may
  resend. Texts for notices have the same property; reminder texts are claimed once.
- **Protocol notices** stay refused until the production protocol path can prove approval.
