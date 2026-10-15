# Outreach go-live: the order to switch things on

This is the list of every outreach setting, in the order Brandon should switch them on, and who does each step. The
**Outreach status** screen (Business → Outreach status, `/outreach`) shows the same rows in the same order, each as
**On**, **Off** or **Can't tell**, with what it is waiting for. A test (`src/server/outreach-status.test.ts`) fails
if this table and the screen disagree about the settings or their order.

Everything here ships **off**. With every setting off the app behaves as it did before this work, and switching any
one back off returns that piece to how it was before. Nothing in this document has been applied: no AWS resource, DNS
record, number, sign-up or send exists.

## Before any switch

These are Brandon's, or AWS's, and come first:

1. **Release.** Merge the integration line to `main` and deploy it. This is Brandon's release decision.
2. **SES production access.** The request should describe both uses honestly: clinical transactional email
   (`alp-transactional`), and a separate opt-in marketing identity per practice (`alp-marketing`).
3. **Content and approval.** Brandon supplies the published content for the three programs and approves the exact
   text of the pages and emails. The attorney also approves the weight loss and diabetes text and the text-message
   consent wording.
4. **Campaign sending identity.** Brandon chooses the sending subdomain, the "from" name and the mailing address.
5. **Texts.** Register a sending number for End User Messaging, and confirm the AWS agreement covers it.
6. **Push and marketing texts.** Decide whether push comes first, and whether marketing texts are wanted later.
   Neither is built.

"AWS operator" below means whoever owns the native AWS resources. They apply each change after Brandon says go.

## The order

| Step | Setting | Where | Turns on | Blocked until | Who does it |
| --- | --- | --- | --- | --- | --- |
| 1 | `NEXT_PUBLIC_SITE_ORIGIN` + `APP_RUNTIME_ENV=production-clinical` | Desktop server | Search listing of published program pages, and full public addresses for the consult and sign-up links | Brandon picks the public address | Brandon chooses the address; the AWS operator sets both values on the Desktop service |
| 2 | Funnel `status: published` (per program) | Repository: the program's funnel definition | That program page going live | The program's published content, and approval of the exact text (also the attorney, for weight loss and diabetes) | Brandon supplies the content and approves the text; the attorney reviews weight loss and diabetes; a developer makes the reviewed change |
| 3 | `REMINDERS_ENABLED` (existing; template parameter `RemindersEnabled`) | Telehealth service | Email appointment reminders | SES production access | AWS operator, after Brandon says go |
| 4 | `CONSULT_ENQUIRER_EMAILS_ENABLED` | Desktop server | The "we received your request" email | SES production access, and the sender and the clinic's contact line set | Brandon approves the contact line; the AWS operator sets the values |
| 5 | `CONSULT_ENQUIRER_EMAILS_ENABLED` + `CLINIC_DISPLAY_NAME` (template parameters `ConsultEnquirerEmailsEnabled`, `ClinicDisplayName`) | Telehealth service | The "your consultation is booked" email | SES production access, and the clinic name set | AWS operator, after Brandon says go |
| 6 | `NOTIFICATION_PREFERENCES_ENABLED` | Identity service | The API behind patients' notification choices | The identity service's two settings routes added to its API (not in this change) | AWS operator |
| 7 | `NOTIFICATION_PREFERENCES_ENABLED` | Desktop server | The read-only view of a linked patient's notification choices, beside the patient in the Inbox | The identity service's copy switched on first | AWS operator |
| 8 | `NOTIFICATION_SETTINGS_RELEASED` | Patient app build (a code constant) | The patient app's Notifications screen | A patient-app release with it set, after the identity service's copy is on | Brandon decides; the app release owner ships it |
| 9 | `PATIENT_NOTICES_ENABLED` | Identity service | "Something new" emails | SES production access, and patients able to change their choices first | AWS operator, after Brandon says go |
| 10 | `CAMPAIGN_ENGINE_ENABLED` + `CAMPAIGN_API_ORIGIN` | Desktop server, and the campaign stack | The /join sign-up pages, the Campaigns screen and everything else campaign | The campaign stack (`infra/campaigns/campaign-engine.json`) applied | The AWS operator applies the stack after Brandon says go, then sets the two values |
| 11 | `marketing` entitlement (this practice) | Campaign engine (operator data) | The "Get updates" link, the sign-up page and the Campaigns screen | The Growth or Complete tier, or the marketing add-on | Brandon sells the tier; the operator records the entitlement and its allowance |
| 12 | `FUNNEL_PRACTICE_SLUG` | Desktop server | "Get updates about this program" on this deployment's program pages | That practice's sign-up address set and its marketing entitlement held | AWS operator sets it; the practice sets its sign-up address |
| 13 | Practice sending domain verified | Campaign engine and the practice's DNS | Campaign emails from this practice | DNS records added by the practice | The practice adds the records its Campaigns screen lists |
| 14 | Campaign sending settings | Campaign engine | Campaign emails | SES production access, sending subdomain, from name, mailing address, approved text | The practice fills in its settings and approves its emails; Brandon and the attorney approve the wording; the AWS operator enables the stack's sending schedule (`SendScheduleState`) |
| 15 | `SMS_REMINDERS_ENABLED` | Telehealth service | Appointment reminder texts | A registered sending number, the consent wording approved by the attorney, and the AWS agreement confirmed to cover End User Messaging | Brandon registers the number and confirms the agreement; the attorney approves the wording; the AWS operator sets it |
| 16 | `SMS_NOTICES_ENABLED` | Identity service | "Something new" texts | A registered sending number, the consent wording approved by the attorney, and the AWS agreement confirmed to cover End User Messaging | Brandon registers the number and confirms the agreement; the attorney approves the wording; the AWS operator sets it |
| 17 | Funnel purchase offers (existing withholding) | Desktop server | Buying a program from its page | Brandon lifts the Core-launch withholding | Brandon |

## Step by step

Each switch reads as on only when it is exactly `true` (trimmed). Unset, `TRUE`, `1` and `yes` are all off.

1. **Public address.** Set `NEXT_PUBLIC_SITE_ORIGIN` to the https origin Brandon picks, and `APP_RUNTIME_ENV` to
   `production-clinical`, on the Desktop service. Nothing staging or synthetic may appear in the deployment's
   signals or host name, or pages stay `noindex`. *Check:* row 1 reads On.
2. **Program pages, one at a time.** When a program's content and its exact text are approved (and, for weight loss
   and diabetes, reviewed by the attorney), a developer changes that definition to `status: published` with the
   approval recorded. The schema refuses a published page without the approval, the attorney review where required,
   and the real program's "what is included". *Check:* that program's row reads On.
3. **Email reminders.** Set the telehealth stack's `RemindersEnabled=true` with its sender. *Check:* row 3 reads
   Can't tell on the screen; the telehealth stack's parameters are the evidence.
4. **"We received your request".** Set `CONSULT_ENQUIRER_EMAILS_ENABLED=true`, `CONSULT_ENQUIRER_SENDER`,
   `CONSULT_ENQUIRER_CONFIGURATION_SET=alp-transactional` and `CONSULT_ENQUIRER_CONTACT_LINE` on the Desktop service.
   *Check:* row 4 reads On. If it reads Off with "Switched on, but nothing is sent", it names what is missing.
5. **"Your consultation is booked".** Set the telehealth stack's `ConsultEnquirerEmailsEnabled=true` and
   `ClinicDisplayName`. *Check:* the stack's parameters (row 5 reads Can't tell).
6. **Notification choices, the service.** Add the identity API's two settings routes and set
   `NOTIFICATION_PREFERENCES_ENABLED=true` on the identity function. *Check:* the function's configuration.
7. **Notification choices, the Desktop view.** Set `NOTIFICATION_PREFERENCES_ENABLED=true` on the Desktop service.
   *Check:* row 7 reads On, and the Inbox shows a linked patient's choices (or says they could not be read).
8. **Notification choices, the patient app.** Ship a patient-app release with `NOTIFICATION_SETTINGS_RELEASED = true`.
9. **"Something new" emails.** Set `PATIENT_NOTICES_ENABLED=true` on the identity function, after patients can change
   their choices. *Check:* the function's configuration.
10. **The campaign engine.** Apply `infra/campaigns/campaign-engine.json` with `CampaignEngineEnabled=true` (keep
    `SendScheduleState=DISABLED` for now), then set `CAMPAIGN_ENGINE_ENABLED=true` and `CAMPAIGN_API_ORIGIN` (the
    stack's API origin) on the Desktop service. *Check:* row 10 reads On ("the campaign engine answered").
11. **A practice's marketing entitlement.** When the practice holds the Growth or Complete tier, or the add-on, the
    operator loads the tier allowances and grants the entitlement with its first marketing admin
    (`src/campaigns/operator.ts`). *Check:* that practice's row 11 reads On.
12. **"Get updates" on the program pages.** Set `FUNNEL_PRACTICE_SLUG` to the practice whose sign-up pages this
    deployment's program pages link to; that practice sets the same sign-up address on its Campaigns screen.
    *Check:* row 12 reads On and names the programs.
13. **The practice's sending domain.** The practice enters its sending subdomain on the Campaigns screen and adds the
    DNS records it lists. *Check:* row 13 reads On (verified for sending).
14. **Campaign sending.** The practice sets its sender name, mailing address and time zone, approves its emails, and
    turns on a sequence. The AWS operator then sets the stack's `SendScheduleState=ENABLED`. *Check:* row 14 reads On.
    The schedule's own state is not visible from the screen; the stack's parameters are the evidence.
15. **Reminder texts.** Set `SMS_REMINDERS_ENABLED=true` with the registered sender on the telehealth function.
16. **"Something new" texts.** Set `SMS_NOTICES_ENABLED=true` on the identity function.
17. **Purchase from program pages.** Brandon lifts the Core-launch withholding. This is a separately reviewed change:
    no offer ledger is configured outside the test fixture today, and no program page is bound to a program yet.

## Why some rows read "Can't tell"

The Desktop server cannot read the telehealth or identity services' settings, or which patient-app build patients
have, and it does not guess from a copy. Those rows read **Can't tell** on purpose; the service's own configuration
is the evidence. A campaign engine that does not answer also leaves its rows at Can't tell, never Off.

A read-only status route on each service would let the screen tell. It needs routes added to the services' API
templates, which the release scripts pin, so it is left for the AWS operator's reviewed change.
