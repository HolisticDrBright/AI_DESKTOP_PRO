# Consult enquirer emails (marketing wiring, workstream 3) — 2026-10-14

- **Branch:** `claude/consult-enquirer-emails-20261014`.
- **Base:** `agent/qualification-range-release-store-20261014` at `22053299`.

**Scope.** Clinical side only:

- both emails go through the clinic's existing `alp-transactional` SES configuration, never the campaign
  service;
- neither adds anyone to any list;
- both are off by default;
- nothing was sent, deployed or applied.

## What the code actually allows, and how the two emails map onto it

The handoff pictures staff scheduling a visit for a consult request. The code does not work that way, and
the Requests page says so in its own words: an enquirer "cannot be scheduled from here at all — they are
accepted or declined first" (`src/app/telehealth-requests/page.tsx`).

- **Consult requests** (`clinical_core.consult_requests`) move only through `received → accepted →
  declined | withdrawn | converted`. They carry a sealed contact and no appointment.
- **A visit** is an appointment in the telehealth service (`aws-telehealth-requests.ts`), created by a
  patient who is signed in. Staff schedule it with the workforce `schedule` (or `reschedule`) action, and
  that is where the 24-hour and 1-hour reminders are created.

So the two emails sit at the two points that exist:

1. **"We received your request"** is sent when a consult request is accepted into the queue.
2. **"Your consultation is booked"** is sent when staff schedule or reschedule a visit. That is the moment
   the reminders already start from, and the handoff's "once a visit exists, the 24-hour and 1-hour
   reminders take over" describes exactly this path.

There is no link from a consult request to a later appointment. The booked email therefore goes to every
patient whose visit staff schedule, not only to people who began with the consult form. That is a fact of
the data model, not something guessed around.

## 1. "We received your request"

**Where.** `src/server/consult/consultEnquirerEmail.ts`, called by `src/app/api/public/consult/route.ts`.

**When.**

- Only after the clinical API answers `submit` with `outcome: "received"`.
- A throttled or refused submission sends nothing. The database's own limits therefore bound how often anyone
  can make the clinic write to an address: 20 per link per hour, 3 per address per day.

**To whom.**

- The address the visitor just typed, at the one place it legitimately exists in plaintext, before the
  route discards it.
- **Nothing is unsealed for it.** That is stricter than opening the sealed contact, which happens only when
  a practitioner asks for it, as before.

**What it says.** The clinic's name (from the link's own `describe` answer), that someone will reply about a
time, and the clinic's contact line.

**What it never says.** Nothing the visitor chose: no reason, visit type, program, preferred time, name or
reference.

**Never affects the answer.**

- The response to the visitor is decided first and is byte-identical with the email off, on or failing.
- A failure, a slow send (5-second bound) or an unreadable clinic is an outcome, never an error.
- Nothing about it is logged.

## 2. "Your consultation is booked"

**Where.** `bookedEmail` and `sendBookedEmail` in `src/server/clinical-core/aws-telehealth-requests.ts`, called
from `scheduleRequest`.

**When.** After `commitRequestMutation` succeeds, for both `schedule` and `reschedule`.

- It cannot fail, delay or roll back the schedule, and it never throws.
- A stale or refused schedule sends nothing.

**To whom.** The address the appointment already carries, the same one the reminders use. A bounced or
complained address (the existing hashed suppression) is skipped.

**What it says.** It follows the reminders' rules:

- the clinic (`CLINIC_DISPLAY_NAME`);
- the date and time in the visit's own time zone (`Thu, Sep 3, 2026, 10:00 AM PDT`);
- how to join (the visit link when one exists, as the reminder gives it, otherwise "open AI Longevity
  Pro");
- how to reschedule.

It never names the reason, the visit type, the practitioner or any program. A time zone or clinic name that
cannot be read refuses the template rather than guessing.

**Sender.** The reminders' sender and configuration set. It cannot be switched on unless the set is exactly
`alp-transactional` and a clinic name is given (`validateConfiguration`).

## Settings added (all off or empty by default)

| Setting | Where | Default | Notes |
| --- | --- | --- | --- |
| `CONSULT_ENQUIRER_EMAILS_ENABLED` | Desktop server (public consult route) | `false` | Turns on "we received your request" |
| `CONSULT_ENQUIRER_SENDER` | Desktop server | empty | The transactional sender |
| `CONSULT_ENQUIRER_CONFIGURATION_SET` | Desktop server | `alp-transactional` in `.env.example` | Anything else is refused |
| `CONSULT_ENQUIRER_CONTACT_LINE` | Desktop server | empty | The clinic's contact line in the email |
| `CONSULT_ENQUIRER_EMAILS_ENABLED` (template parameter `ConsultEnquirerEmailsEnabled`) | Telehealth Lambda | `false` | Turns on "your consultation is booked" |
| `CLINIC_DISPLAY_NAME` (template parameter `ClinicDisplayName`) | Telehealth Lambda | empty | Required when on |

**Supporting changes.**

- The template (`infra/aws-clinical-core/telehealth-requests-extension.json`) gains the two parameters and
  variables.
- The provider-configuration gate (`scripts/check-aws-provider-configuration.mjs`) now also requires
  `ConsultEnquirerEmailsEnabled` to default to `false` and `ClinicDisplayName` to default to empty.
- The Lambda's existing `ses:SendEmail` permission (transactional identity and configuration set) already
  covers the send; no IAM change.

## Tests (fictional people and addresses only)

- **`src/server/consult/consultEnquirerEmail.test.ts`** (5):
  - off unless exactly `true`;
  - incomplete settings, and any set but `alp-transactional`, refused;
  - the exact text, which repeats nothing chosen;
  - one SES send to the typed address through `alp-transactional`;
  - every failure is an outcome;
  - it imports only the SES client and knows nothing of lists.
- **`src/app/api/public/consult/consult-route-enquirer.test.ts`** (4), on the route itself:
  - off sends nothing and answers as before;
  - on sends one email and the answer is unchanged;
  - a throttled submission sends nothing;
  - a failing email or an unreadable clinic leaves the answer unchanged.
- **`src/server/clinical-core/telehealth-booked-email.test.ts`** (8), through the real handler and the
  fictional appointment store:
  - off by default;
  - one email after the committed schedule, with the exact text;
  - a reschedule;
  - a send failure leaves the schedule intact;
  - a suppressed address is skipped;
  - a stale schedule sends nothing;
  - configuration refusals;
  - template refusals, and the join link.
- **Existing suites unchanged and passing:** the reminder lifecycle, the telehealth handler and the provider
  gate tests.

**Failing before.** On the unchanged base `22053299`:

- 5 of the new tests fail: the route sends nothing, and there is no booked email or setting;
- `consultEnquirerEmail.test.ts` cannot load;
- the "off" and "nothing on failure" tests pass on base, as they should.

## Gate results on this branch

| Check | Result |
| --- | --- |
| `npm run test:unit` | 550 files; 8,709 passed, 11 skipped, 0 failed |
| `tsc --noEmit` | clean |
| `eslint` on every changed file | clean |
| `APP_EDITION=clinical NEXT_PUBLIC_USE_LIVE_API=true npm run build` | passes |
| `node scripts/check-aws-provider-configuration.mjs` and its `node --test` | pass (the new boolean and empty-default checks included) |
| `cfn-lint` 1.57.2 and CI's 1.55.0 on `telehealth-requests-extension.json` | clean |

The ordered e2e battery runs once, on the integration branch (workstream 7). This branch adds no page and no
stub binding.

## Not verified

- **No email was sent.** SES production access is still pending, and no sender, contact line or clinic name
  is set anywhere.
- **The Desktop server's credentials.** The public consult route runs in the Desktop server. Its AWS
  credentials must allow `ses:SendEmail` on the transactional identity and set. That runtime's IAM is not
  in this repository and was not checked.
- **Multiple clinics.** The contact line is one per Desktop deployment and the clinic display name one per
  Lambda. A deployment serving several clinics would need them per organization.
- **The visit link is passed through as given.** The booked email carries the visit link exactly as the
  reminder does. Whether a Zoom link belongs in email at all is a wording question for counsel, along with
  the rest of the text.

## Stopped for approval

**The wording of both emails is a draft.** It needs Brandon's approval, and counsel's for anything that
reaches a patient.
