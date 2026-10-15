# Outreach wiring, end to end (marketing wiring, workstream 7) — 2026-10-15

**Branch:** `claude/outreach-integrated-20261015`. It is the integration line for workstreams 1 to 6, built by merge
from these heads. No history was rewritten.

| Workstream | Branch | Head |
| --- | --- | --- |
| 1, program pages | `claude/funnels-finish-20261014` | `3f2b8bbe` (carried by the engine branch) |
| 2, the campaign engine | `claude/campaign-engine-20261015` | `f08b277a` |
| 3, enquirer emails | `claude/consult-enquirer-emails-20261014` | `0c6c23a2` |
| 4, reminders and notices | `claude/patient-notices-20261014` | `2ed79cde` |
| 5, the leads board | `claude/leads-board-20261015` | `60e026f4` |
| 6, Outreach status | `claude/outreach-status-20261015` | `d9d0f1b8` |

**Merging this line to `main` is Brandon's release decision, and it is not part of this work.**

## Merge conflicts and the one seam

**Conflicts.** Three were resolved, all by keeping both sides:

- `.env.example` (the campaign engine's and the enquirer emails' blocks);
- `CLAUDE.md` (each workstream's documentation row);
- `src/server/clinical-core/aws-telehealth-requests.ts`. Workstream 3 adds `bookedEmail` and `sendBookedEmail` after
  the reminder sender, and workstream 4 adds `mailAppointmentReminder` and `sendAppointmentReminderOnChannels` at the
  same place. Both sets are kept, one after the other.

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
