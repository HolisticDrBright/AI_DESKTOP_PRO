# Outreach wiring, end to end (marketing wiring, workstream 7) — 2026-10-15

**Branch:** `claude/outreach-integration-20261015`, created from `claude/outreach-status-20261015` (`d9d0f1b8`),
which already carries workstreams 1, 2 and 6. The other three were merged in, each with its own merge commit, in
this order. No history was rewritten, nothing was squashed or rebased.

| Order | Workstream | Branch | Head | Merge commit |
| --- | --- | --- | --- | --- |
| base | 1, program pages | `claude/funnels-finish-20261014` | `3f2b8bbe` | carried by the engine branch |
| base | 2, the campaign engine | `claude/campaign-engine-20261015` | `f08b277a` | carried by the status branch |
| base | 6, Outreach status | `claude/outreach-status-20261015` | `d9d0f1b8` | the branch point |
| 1 | 3, enquirer emails | `claude/consult-enquirer-emails-20261014` | `0c6c23a2` | `47d7a64a` |
| 2 | 4, reminders and notices | `claude/patient-notices-20261014` | `2ed79cde` | `99baf1dd`, then the brace fix `5da3002d` |
| 3 | 5, the leads board | `claude/leads-board-20261015` | `60e026f4` | `8eb3617c` |

`claude/campaign-service-20261014` (`a0046123`, the superseded Dittofeed version of workstream 2) was not merged.

An earlier integration line, `claude/outreach-integrated-20261015` (`6367ae15`), merged the same six heads in a
different order. Its code is identical to this line's at the point before the end-to-end tests (only the order of
the `CLAUDE.md` rows differed), and its end-to-end tests were carried here as one commit. It is superseded by this
branch.

**Merging this line to `main` is Brandon's release decision, and it is not part of this work.**

## The three resolutions and the one seam

1. **The lost closing brace** (`5da3002d`, its own commit). Workstreams 3 and 4 both inserted a new function directly
   after `sendAppointmentReminder` in `src/server/clinical-core/aws-telehealth-requests.ts`. Git stitched the two
   insertions together with no conflict marker and dropped the `}` that closes `sendBookedEmail`; `tsc` reported
   `TS1005: '}' expected` at the end of the file. The merge commit `99baf1dd` records the tree as git produced it,
   and `5da3002d` restores the one line after `} catch { return "failed"; }`. Brace balance was checked:
   `sendBookedEmail`, `mailAppointmentReminder` and `sendAppointmentReminderOnChannels` are each complete.
2. **`CLAUDE.md`, the return-notes table** (`47d7a64a`, `8eb3617c`). Every row is kept, in date order: the
   2026-10-14 notes (program pages, enquirer emails, patient notices), then the 2026-10-15 notes (the campaign
   engine, the leads board, Outreach status, the go-live order), then this note.
3. **`.env.example`** (`47d7a64a`). Every block is kept: the campaign engine's, then the enquirer emails'.

**The switch list, reconciled** (`b5c5b464`). Every setting a Desktop-server row of the Outreach status screen names
was checked against `docs/outreach-go-live.md` and `.env.example`, not assumed:

| Setting | Status screen | Go-live | `.env.example` before | Reconciled |
| --- | --- | --- | --- | --- |
| `NOTIFICATION_PREFERENCES_ENABLED` (Desktop, workstream 4) | rows 6 and 7 | steps 6 and 7 | **missing** | added as `false`, with what it turns on |
| `NEXT_PUBLIC_SITE_ORIGIN`, `APP_RUNTIME_ENV` (existing) | row 1 | step 1 | **missing** | added as commented examples, so the default stays unset |
| `CONSULT_ENQUIRER_*` (workstream 3) | row 4 | step 4 | present | none needed |
| `CAMPAIGN_ENGINE_ENABLED`, `CAMPAIGN_API_ORIGIN`, `FUNNEL_PRACTICE_SLUG` | rows 10, 12 | steps 10, 12 | present | none needed |

The identity and telehealth functions' switches (`PATIENT_NOTICES_ENABLED`, `SMS_NOTICES_ENABLED`, the identity copy
of `NOTIFICATION_PREFERENCES_ENABLED`, `SMS_REMINDERS_ENABLED`, `REMINDERS_ENABLED`, `CLINIC_DISPLAY_NAME`) are read
by those Lambdas, not the Desktop, so they belong in neither `.env.example` nor a Desktop setting; the status screen
reads them as Can't tell and the go-live order names the function. `.env.example` now says so in a comment.
`src/integration/outreach-status-agreement.test.ts` holds the three lists together: every setting a Desktop-server
row names must be in `.env.example`, and each Desktop switch must be listed `false`. It failed before `b5c5b464`.
`src/server/outreach-status.test.ts` and the go-live document still pin each other, and pass on this tree.

**The seam.** On its own branch, workstream 6 read the "received" email's companions by name. On this line it asks
workstream 3's own reader (`consultEnquirerEmailConfig`) whether the email would send, so the screen and the route
cannot disagree. `src/integration/outreach-status-agreement.test.ts` holds it to that.

## The end-to-end paths (every external service faked at its boundary)

All of these are in-process. A browser battery cannot reach the campaign engine: the Desktop accepts only an
`execute-api` origin for it, and pointing that at a local stub would mean weakening the check. So each path drives
the real route handlers, pages, Lambda handlers and SQL. Only the SDK or HTTP edge is faked.

### Marketing: `src/integration/outreach-marketing-path.test.ts`

**Fakes:**

- the campaign engine's own HTTP handler (in-memory store, fake SES), behind its API origin, as API Gateway would
  route it;
- the clinical API's public consult intake;
- the SES SDK used by the consult route.

**The program page.** It is a fictional *published* copy of the Longevity definition, built in the test and
validated by the real schema. No repository definition is published.

| Step | Proven through |
| --- | --- |
| 1. A signed-out visitor opens the program page and gets no redirect to sign-in | `middleware` on `/learn/…`, `/join/…` and `/consult/…`; `funnelPageLinks` and `FunnelPage` render the "Get updates" link to `/join/fictional-clinic/longevity-program` |
| 2. They follow "Get updates", sign up and receive the confirmation email | The real `/join` page (server component) with the engine's sealed form token, then `POST /api/public/campaigns/join`. The confirmation lands in the engine's outbox through `alp-marketing` |
| 3. After the click, they receive the first sequence email | `POST /api/public/campaigns/confirm`, then the engine's sending pass sends "Welcome: about the Longevity Program", with the one-click unsubscribe headers |
| 4. That email leads to the program page with `?via=email`, then to the email consult link | The email's own link is `…/learn/longevity-program?via=email`; `funnelChannelFrom` reads email, and the button is `/consult/longevity-program-email` |
| 5. They submit a request, which appears in the queue with the email channel | `POST /api/public/consult` with that slug. The intake records the slug and only the sealed contact. `funnelSourceOf` gives email, and `funnelRequestCounts` gives web 0 and email 1 |
| 6. They receive the "we received your request" email | One SES `SendEmail` to the typed address through `alp-transactional`, naming nothing they chose |

**The two sides never cross.** Two campaign emails went out, both through `alp-marketing`, and one consult email,
through `alp-transactional`.

### Clinical: `src/integration/outreach-clinical-path.test.ts`

**Fakes:** DynamoDB (the fictional conditional appointment store), SES, EventBridge Scheduler, and End User Messaging
(the notification providers' fictional senders).

**Real:**

- the telehealth handler;
- the BLOCKED `patient-notifications.sql` candidate on the installed migration chain, in embedded Postgres, called as
  the reduced roles;
- the inbound STOP handler;
- the identity API's lab-review hook point;
- the notice dispatcher.

| Step | Proven through |
| --- | --- |
| 1. Staff schedule the request, and the "booked" email goes out | Workforce `schedule`: one SES email through `alp-transactional` |
| 2. Reminders at 24 h and 1 h; cancelling removes them; rescheduling moves them | Two `CreateSchedule`s at exactly start − 24 h and start − 1 h. `reschedule` deletes those two and creates two under a new generation; the old event is `stale` and sends nothing. `cancel` deletes the new two, and a late event is `stale` with no SES call |
| 3. A text goes out only to an opted-in number, and STOP suppresses it | The scheduled event itself sends the email and one text, to the consented number, with fixed wording. An inbound `STOP` from that number makes the next reminder email only (`text_stopped`) |
| 4. Quiet hours are honoured | Fired at the patient's 03:00, the email goes and the text waits (`quiet_hours`, nothing claimed) |
| 5. One lab result makes one notice; three close together make one | `POST /clinical-core/workforce/lab-imports/review` accept, then the emitter and the SQL enqueuer, then the dispatcher: one email; then three accepts give one email |
| 6. A failed notice doesn't roll back the release | With an enqueuer that throws, the review answers 200 with exactly the committed reply |

### Separation: `outreach-separation.test.ts` and `outreach-switches-off.test.ts`

**The campaign code path holds no clinical credential and reads no clinical store.**

- **The import graph.** Every module reached by value import from every marketing entry point is computed: the
  `/join` pages, `/campaigns`, the three public campaign routes, the staff route, the "Get updates" directory and the
  three Lambda entries.
  - None is under `src/server/{clinical-core,notifications,consult,commerce,programs}` or `src/contracts`.
  - The only adapters reached are the session reader (the staff route forwards the signed-in person's own workforce
    token to the campaign API's authorizer), `errors` and `mode`.
  - The only packages are `react`, `next`, `zod`, `node:*` and the four AWS SDKs for SES, DynamoDB and Secrets Manager.
- **The campaign stack.**
  - Every Lambda variable is `CAMPAIGN_*`.
  - Every allowed action is `logs`, `dynamodb`, `kms`, `secretsmanager`, `ses`, `sqs` or `lambda`.
  - Secrets access names only the campaign key, and table access only the campaign table.
- **The clinical templates.** None names a campaign resource.

**One practice's lists, emails and results are invisible to another.** This is proven through the Desktop's staff
route, with the API Gateway authorizer faked to turn each token into its own practice's claims:

- practice B's overview has no subscriber, template or result of A's, and none of A's addresses, slugs or names;
- B's contact page is empty;
- a request naming A's practice is refused before it leaves the Desktop;
- an unknown token never reaches the engine.

The engine's own `src/campaigns/separation.test.ts` covers the store, tokens, suppression and the DynamoDB commands.

**No marketing code imports clinical adapters.** This is the import graph above, plus the engine's own import pattern
test.

**Every switch off means no send of any kind.** With every switch unset, and its companions set so that only the
switch holds each piece off:

- every campaign route answers 404 and no program page links to a sign-up page;
- the engine with its own switch off sends nothing on a pass and refuses sign-ups;
- the consult route records the request and sends no email;
- scheduling a visit sends no email and creates no schedule;
- the identity ports, the reminder text port and the notice dispatcher are never built, and no database call is made;
- the Outreach status screen reads nothing as on.

**The fake must record nothing.**

**All off is unchanged, for the set as a whole.** One more test in `outreach-switches-off.test.ts` unsets every
setting the six workstreams added at once, the switches and their companions alike, and holds what a visitor, a
patient and the clinic's Inbox get to `22053299`'s own formulas and text rather than to this line's readers:

- every program page is draft and answers not-found, as before;
- rendered anyway, each page's consult address is the base's formula, there is no updates link, and the footer is
  the base's sentence word for word;
- the consult form's answer is the clinical API's answer, unchanged, after one call and no email;
- the Inbox's panel renders exactly as it did with no argument, and the clinic's notification route does not exist;
- every campaign route is absent, the identity service gets no new port, and the status screen reads nothing as On.

What does change with everything off, by design, is staff-only: the Outreach and Campaigns screens exist (the
Campaigns screen says the engine is off), the Requests queue has a Board view beside the unchanged list, and the
Funnels screen counts requests per program and channel. One visitor-side difference is not behind a setting:
`?via=email` on a program page points its button at that program's email consult link. Nothing links there while
the campaign engine is off, and all three program pages are draft (not-found) as shipped.

## Gate results

See the table at the end of this document, filled in from the run on this tree.

## Settings, all off by default

The full list, in the order Brandon switches them on, with who does each step, is
[`docs/outreach-go-live.md`](outreach-go-live.md). It is the same list the Outreach status screen shows.

| Setting | Where | Default |
| --- | --- | --- |
| `NEXT_PUBLIC_SITE_ORIGIN`, `APP_RUNTIME_ENV=production-clinical` (existing) | Desktop server | unset |
| Funnel `status` (existing) | Repository | `draft`, all three |
| `CONSULT_ENQUIRER_EMAILS_ENABLED` (+ sender, configuration set, contact line) | Desktop server | `false` |
| `ConsultEnquirerEmailsEnabled`, `ClinicDisplayName` | Telehealth stack | `false`, empty |
| `REMINDERS_ENABLED` / `RemindersEnabled` (existing) | Telehealth stack | `false` |
| `PATIENT_NOTICES_ENABLED`, `SMS_NOTICES_ENABLED`, `NOTIFICATION_PREFERENCES_ENABLED` | Identity function | unset |
| `SMS_REMINDERS_ENABLED` | Telehealth function | unset |
| `NOTIFICATION_PREFERENCES_ENABLED` | Desktop server | unset |
| `NOTIFICATION_SETTINGS_RELEASED` | Patient app (code constant) | `false` |
| `CAMPAIGN_ENGINE_ENABLED`, `CAMPAIGN_API_ORIGIN`, `FUNNEL_PRACTICE_SLUG` | Desktop server | `false`, empty, empty |
| `CampaignEngineEnabled`, `SendScheduleState`, `SiteOrigin`, `FromLocalPart` | Campaign stack | `false`, `DISABLED`, empty, empty |
| `marketing` entitlement and allowances | Campaign engine (operator data) | none granted, none loaded |
| Funnel purchase offers (existing withholding) | Desktop server | withheld |

## What was verified about SES and End User Messaging, and what was not

**SES**, from `@aws-sdk/client-sesv2` 3.1124.0 and AWS's pages; details in
`docs/claude-campaign-engine-2026-10-15.md`.

- **Verified from the SDK and the docs:**
  - tenants (`CreateTenant`, `CreateTenantResourceAssociation`, `SendEmail` with `TenantName`);
  - reputation entities and their statuses;
  - custom headers for one-click unsubscribe;
  - `GetAccount` `ProductionAccessEnabled`.
- **Not verified:**
  - no AWS call was made;
  - the IAM resource ARN `SendEmail` authorizes for a tenant;
  - `aws:RequestTag` and `aws:ResourceTag` on SES identities;
  - the 10,000-tenant quota against the live quotas page;
  - DKIM timing, deliverability and RFC 8058 behaviour at real mailbox providers;
  - this account's production access.

**End User Messaging**, from `@aws-sdk/client-pinpoint-sms-voice-v2` 3.1149.0 (pinned; 3.1152.0 was the newest on
2026-10-14); details in `docs/claude-patient-notices-2026-10-14.md`.

- **Verified without a network:**
  - only `SendTextMessageCommand` is used (`TRANSACTIONAL`, one origination identity, a configuration set);
  - an opted-out destination maps to opted-out;
  - nothing uses Pinpoint campaigns or journeys, which end on 2026-10-30.
- **Not verified:**
  - nothing was sent, and no origination identity, registration, configuration set, two-way SNS topic or opt-out
    setting exists;
  - carrier behaviour (segments, filtering, keywords on a real number);
  - whether Brandon's AWS agreement covers End User Messaging. AWS's HIPAA page lists it, excluding voice and
    WhatsApp.

## Stops, across the line

Every one is recorded in its workstream's note. Together they are:

- **Content and approval** (Brandon, and the attorney for weight loss and diabetes):
  - the three programs' published content;
  - the exact page and email text;
  - the consent line;
  - the text-message consent wording.
- **SES:**
  - production access;
  - the sending subdomain, the from name and the mailing address;
  - the tenant ARN in IAM.
- **Texts:**
  - a registered number;
  - the AWS agreement;
  - the identity and telehealth functions' settings, which are set on the functions because the release scripts pin
    those templates.
- **Routes:**
  - the identity API's two notification-settings routes;
  - a read-only status route on each service, so the Outreach status screen could tell instead of saying Can't tell.
- **Campaigns:**
  - the Complete tier's monthly email allowance (not in the tiers document);
  - image upload;
  - program pages for practices other than Brandon's;
  - the operator command-line wrapper.
- **The leads board:** "contacted" and "scheduled" need a schema change (`docs/claude-leads-board-2026-10-15.md`).
- **Push:** not built. The patient app has no push support, and the report is in workstream 4's note.
- **Release:** applying any template, merging to `main` and deploying.
