# Patient reminders and notices (marketing wiring, workstream 4) — 2026-10-14

**Branches.**

- Desktop: `claude/patient-notices-20261014`, cut from `22053299`.
- V2: `claude/patient-notices-20261014`, cut from `b2681a4e`.

This is the clinical side. Nothing here touches the campaign engine, a marketing list or a commercial
table, and nothing was deployed, applied, registered or sent.

**What it builds on.** It carries forward the unintegrated 10-13 work from
`claude/patient-notifications-20261013`, ported as `5d500de0` and `1a59c0a1`. That work is described in
`docs/claude-patient-notifications-2026-10-13.md`:

- the contract;
- the rules (quiet hours, STOP/HELP/START, batching, fixed wording);
- the BLOCKED SQL candidate;
- the dispatcher, the SES and End User Messaging senders, and the inbound handler;
- the text-reminder port on the telehealth reminder event;
- the post-commit notice emitter.

**What this workstream adds.**

- the named switches;
- the hook-point proof through the real handler;
- the patient's settings routes;
- the clinic's read-only view;
- the V2 Notifications screen;
- the push report.

## Settings (every one off by default)

Each switch is on only when it reads exactly `true` (trimmed). Unset, `TRUE`, `1` and `yes` are all off. The
names and their reader are in `src/server/notifications/notification-switches.ts`, and the code that turns
them into ports is in `notification-runtime.ts`.

| Setting | Turns on | Where it is read | Default |
| --- | --- | --- | --- |
| `PATIENT_NOTICES_ENABLED` | "Something new" emails: the identity API enqueues notices; the dispatcher's email channel | identity Lambda entry (`identityNotificationPortsFrom`); dispatcher composition (`noticeDispatcherFrom`) | off (unset) |
| `SMS_NOTICES_ENABLED` | "Something new" texts: enqueueing, and the dispatcher's text channel | same two places | off (unset) |
| `SMS_REMINDERS_ENABLED` | Appointment reminder texts beside the reminder email | `reminderTextPortFrom` (the telehealth handler's `textReminders` port) | off (unset) |
| `NOTIFICATION_PREFERENCES_ENABLED` | Two things: the identity API's two settings routes, and on the Desktop the read-only view and its `/api/live/patient-notification-settings` route | identity Lambda entry; `src/app/inbox/page.tsx`; the live route | off (unset) |
| `NOTIFICATION_SETTINGS_RELEASED` (V2 code constant) | The V2 Notifications screen and its profile-menu entry | `expo/lib/notifications/awsNotificationSettings.ts` | `false` |

**With every switch off, nothing is built.** `notification-switches.test.ts` asserts each of these:

- the identity API is constructed with exactly the inputs it had before (`{}`), and the database is not
  touched;
- both settings routes answer 503, as an identity API without this work would;
- the telehealth handler gets no text port, so its email path is unchanged;
- no dispatcher exists.

`notice-hook-points.test.ts` asserts that, without an emitter, every hooked action answers byte for byte
the same.

**On the Desktop, switched off:**

- the Inbox renders the program panel exactly as before;
- the live route answers 404 before reading the session or calling anything.

**Turning a switch on is necessary, not sufficient.** The candidate's own activation row
(`notices_enabled`, `texts_enabled`, both false, each needing evidence, a reviewer and a date) still holds
everything back.

**Misconfiguration fails closed.** A switch that is on without its sender refuses to build
(`sms_reminders_configuration_invalid`, `patient_notices_configuration_invalid`) rather than run a path
that cannot send. With one notice channel on, the other channel's deliveries are recorded as skipped
(`channel_switched_off`), and its sender and the email directory are never called.

**Where the settings live.** The identity API template (`infra/aws-clinical-core/identity-api-extension.json`)
is pinned by the synthetic-care release scripts and was not edited, so neither identity variable is set
anywhere. Adding them is the native AWS owner's step, listed in `docs/outreach-go-live.md`.

## Hook points: where each kind becomes visible

Each kind emits one internal "item released" event. It fires after the action has committed and its reply
has been decided, through `notify` in `src/server/clinical-core/aws-identity-api.ts`. That function calls
the optional `patientNotices` emitter and swallows any failure, so a notice can never change, fail or roll
back the clinical action.

| Kind | Hook point (the one place it becomes visible) | Tests |
| --- | --- | --- |
| `message` | `POST /clinical-core/workforce/messages`, `send` that is not a duplicate (`care_messages`) | `notice-hook-points.test.ts` "message: … send", "a failing emitter changes nothing"; `notification-dispatcher.test.ts` "maps only committed workforce actions…"; the database end-to-end test "a message a clinician sends becomes one email and one text…" |
| `form` | `POST /clinical-core/workforce/intake-packets`, `assign` with the packet `open` (`intake_packets_workforce`) | `notice-hook-points.test.ts` "form: …"; dispatcher mapping test; database "is refused for … a cancelled form" |
| `program_lesson` | `POST /clinical-core/workforce/programs`, `assign` (the first phase opens) and `release` of a phase (`program_assignments`) | `notice-hook-points.test.ts` "program_lesson: … release"; dispatcher mapping test (assign and release); database "… a withdrawn program, an unreleased phase" |
| `lab_result` | `POST /clinical-core/workforce/lab-imports/review`, `accept` that is not a duplicate (`review_lab`) | `notice-hook-points.test.ts` "lab_result: accepting a lab import…"; dispatcher mapping test; database "… a result under review" |
| `protocol` | **None, stopped.** The only point where a protocol becomes visible is the production `activate_protocol_version` in `aws-production-desktop.ts`. The synthetic plane has no table that can prove a protocol was approved for this patient, and the candidate refuses protocol notices (`notice_source_unverifiable`). | `notice-hook-points.test.ts` "protocol has no hook point…"; database "is refused for … a protocol" |

**The candidate checks visibility again at enqueue.** It reads the item's own table and refuses or skips
anything not visible: drafts, items under review, consumer-authored messages, another clinic's items, and
connections that are not verified.

## Preferences

**V2: the patient's own Notifications screen.** It lives at `expo/app/notification-settings.tsx` and
`expo/components/NotificationSettingsCard.tsx`, with the client `expo/lib/notifications/awsNotificationSettings.ts`.

- **What it shows:**
  - appointment reminders by email and text;
  - each of the five kinds by email and text, using Brandon's fixed phrases;
  - push as "not available in this app yet";
  - the time zone, as "Unknown" when none is set, plus a button to use the device's zone.
- **Saving.** Save sends `expectedVersion`. A conflict reloads the current settings and says so.
- **Texts can't be turned on before the patient agrees.** Agreeing needs four things:
  - the full approved wording, shown;
  - a typed number;
  - an unticked box, ticked;
  - the exact wording version and SHA-256, which are sent with the request.
- **No approved wording.** The screen says texts aren't available yet.
- **After STOP,** texts stay off until the patient agrees again.
- **States.** Loading, a failed read and signed-out access each look different. A failed read never shows
  a default set of choices.
- **Closed until released.** While `NOTIFICATION_SETTINGS_RELEASED` is false, the client refuses before
  reading a session or touching the network, the profile menu has no entry, and a direct visit says
  "aren't available yet".

**Desktop: staff see the choices and cannot change them.** The panel is `src/components/notifications/`
(`PatientNotificationChoicesPanel`, `PatientNotificationChoicesView`), served through
`src/app/api/live/patient-notification-settings/route.ts`.

- **Where it appears.** Beside a linked patient in the Inbox's app-program panel. That is where the
  Desktop chooses a patient's app connection; see "Stopped" for why it is not in the chart.
- **Read only.**
  - There is one request (`read` plus `connectionId`), and anything else is refused with 400 before
    anything leaves the process.
  - There is no input, select or switch, only a "Load the patient's choices" button.
  - The screen says "Only the patient can turn on texts, from the app".
- **What it shows.**
  - The number appears only as its last two digits.
  - A text preference that is on but cannot be sent says why: "On, but not sent: no agreement on record",
    or "On, but stopped: the patient replied STOP".
  - The time zone shows "Unknown" when none is set.
- **States.** Loading, unavailable ("This does not mean they chose nothing"), refused and loaded are
  distinct test ids.
- **Wrong patient.** An answer about a different connection is treated as unavailable.

**Server.** `notification-settings-service.ts` adds two identity API routes, both on the synthetic boundary
only:

- `POST /clinical-core/consumer/notifications/settings`: the patient reads the wording, reads, saves,
  consents and withdraws;
- `POST /clinical-core/workforce/notifications/settings`: the clinic reads.

The SQL candidate gains `clinical_core.clinic_patient_notification_settings(uuid)`.

- It is read-only, for active members of the connection's organization, on a verified connection.
- It returns the last two digits of the number.
- Its new candidate digest is `93bd5f677068b0a2d09f8f8013a66722289b8c82ed50ecb156da0a68e8d596a5`.

**The contract is mirrored byte for byte.** It is `src/contracts/patientNotifications.ts` in the Desktop and
`expo/contracts/patientNotifications.ts` in V2, with SHA-256
`0e9a6098757693d5948c10bffdc5f2dcbb07651cb7067def0b08ad00ebe250d6`, pinned in both suites and kept LF
through `.gitattributes` in both repos.

## Push: what V2 supports and what adding it would take

**Confirmed on the V2 base `b2681a4e`.** There is no push:

- no `expo-notifications` dependency;
- no `aps-environment` entitlement or `UIBackgroundModes: remote-notification`;
- no `googleServicesFile` or FCM configuration;
- no code that requests a push token.

The app is Expo `~54.0.37`, with bundle id `com.ailongevitypro.v2` and Android package
`app.rork.ai_longevity_pro_v2`. Email and text are therefore built first, behind the same service.

**Push is designed as a third channel.** The contract already carries `push: false` per kind, and
`pushAvailable: false` on every settings view, so turning push on is a reviewed contract change, never a
silent setting.

**What adding push to V2 would take:**

1. **`expo-notifications`** and its config plugin, plus a permission prompt placed after sign-in, never at
   launch.
2. **Native configuration:**
   - iOS: the APNs key in EAS credentials, and the `aps-environment` entitlement;
   - Android: FCM v1, with a Firebase project and `google-services.json`. That makes Google a new vendor,
     so check the AWS agreement and privacy terms.
3. **A new EAS build for both stores.** A JavaScript update cannot add a native module. This is a paid
   build, so it is not done here.
4. **A token-registration endpoint** (consumer route) and a clinical-side token table: device, platform,
   token hash and last seen, with revocation on sign-out and account switch. This is a schema change for
   the reviewed process.
5. **A push sender behind the existing `TextSender`/`EmailSender` pattern.** Either Expo's push service (a
   new processor of device tokens) or direct APNs/FCM. The payload carries only the fixed kind phrase and
   no data that opens content.
6. **Store review.** Update the App Store privacy label and the Play data-safety form.
7. **A contract version** that lifts `push: z.literal(false)`.

Push comes first only if Brandon says so.

## End User Messaging: what was verified

**The SDK is `@aws-sdk/client-pinpoint-sms-voice-v2`.**

- The newest published version, read from the npm registry on 2026-10-14, is `3.1152.0`.
- This branch pins `3.1149.0`, matching the other pinned AWS SDK clients in `package.json`.
- Only `SendTextMessageCommand` is used: `TRANSACTIONAL`, one origination identity, a configuration set,
  and no `Context` map.
- Nothing uses Amazon Pinpoint campaigns or journeys, which end on 2026-10-30.

**Tested without a network.** The request is built exactly as described, and a
`ConflictException`/`DESTINATION_PHONE_NUMBER_OPTED_OUT` reply maps to opted-out.

**Not verified:**

- **No send of any kind.** No origination identity, registration, configuration set, two-way SNS topic or
  self-managed opt-out setting exists.
- **Carrier behaviour.** Segment counting, carrier filtering and keyword behaviour on a real number are
  unproven.
- **The AWS agreement.** Whether Brandon's signed agreement covers End User Messaging is Brandon's to
  confirm. AWS's HIPAA page lists End User Messaging, excluding voice and WhatsApp.

## Tests (fictional people, addresses and numbers only)

**Desktop:**

- `src/server/notifications/notification-switches.test.ts` (11): the names and exact-`true` semantics;
  every switch off builds nothing (identity ports, routes 503, no text port, no dispatcher, the Lambda
  entry); each switch builds only its piece; the channel gating; refusal without a sender.
- `src/server/notifications/notice-hook-points.test.ts` (9): each hook point through the real handler, emit
  after commit, a failing emitter changes nothing, no emitter answers the same, and the protocol stop.
- `src/server/notifications/notification-settings-routes.test.ts` (5): the settings routes.
- The database test gains the clinic's read-only view (3), and the settings service over SQL.
- `src/app/api/live/patient-notification-settings/route.test.ts` (7): 404 when off; a read only; refusals;
  failures are 503; a mismatched patient; a bad origin.
- `src/components/notifications/PatientNotificationChoicesView.render.test.ts` (6): no control that changes
  a choice; the four states are distinct; the phrases; on-but-not-sent; "Unknown"; mounted only when on.
- `src/contracts/patientNotifications.test.ts` (2): the mirror digest and the decided defaults.

**V2:**

- `__tests__/notification-settings-screen.test.tsx` (11);
- `__tests__/patient-notifications-contract-pin.test.ts` (1).

**Failing before.** On the base `22053299` the notifications feature does not exist: every file above
fails to import (`@/server/notifications/...`), and the Inbox has no choices panel.

## Gate results

| Check | Result |
| --- | --- |
| Desktop `npm run test:unit` | 556 files; 8,792 passed, 11 skipped, and 1 timed out (see below) |
| Desktop `tsc --noEmit` | clean |
| Desktop `eslint` on every changed file | clean |
| `APP_EDITION=clinical NEXT_PUBLIC_USE_LIVE_API=true npm run build` | passes |
| V2 `vitest run` | 315 files (1 skipped); 3,594 passed, 1 skipped |
| V2 `tsc --noEmit` and `expo lint` | clean |

**The timeout.** `clinic-records-qualification-runner.test.ts` › "refuses a different actual database…" hit vitest's 5-second
limit. That test builds an embedded database and applies 116 migrations, and it ran while a second full suite
(workstream 1's) was running on the same machine. Re-run alone, the file passes (4 of 4, 16 s). This work does not
touch it.

The ordered e2e battery runs once, on the integration branch (workstream 7).

## Stopped (content, approval or a confirmed capability)

1. **Protocol notices.** There is no synthetic source that proves a protocol was approved for a patient.
   This needs the production protocol path, or a reviewed source.
2. **Text-consent wording.** None is recorded. The candidate seeds none, and the V2 screen says texts
   aren't available until one is. The attorney approves it.
3. **Sending number and registration.** These are Brandon's, with AWS.
4. **The AWS agreement** must cover End User Messaging. This is Brandon's to confirm.
5. **The consumer email directory** (`PatientEmailDirectory`) is not implemented. A notice email needs the
   patient's verified address from the consumer Cognito pool, looked up by the identity subject the
   candidate hands out. Writing it means choosing between `ListUsers` filtered by `sub` and a stored
   mapping. That is the native AWS owner's call, so the dispatcher and inbound Lambdas, and their
   schedule, are not written.
6. **The telehealth Lambda's database connection** for the reminder text port is not in its template.
   `reminderTextPortFrom` exists, but the Lambda does not call it until the AWS owner adds the RDS Data
   access and the End User Messaging configuration.
7. **API Gateway entries** for the two settings routes are not in the authenticated API template:
   `scripts/check-aws-authenticated-api.mjs` pins its route list.
8. **The Desktop chart (`/patients/[id]`) has no mapping** from a Desktop patient to an AWS app connection
   id. The read-only view therefore sits where the Desktop already chooses a linked app patient, beside the
   program panel in the Inbox. Placing it in the chart needs that mapping, a reviewed read.
9. **Push first?** This is Brandon's decision, and it needs a native build (see above).
