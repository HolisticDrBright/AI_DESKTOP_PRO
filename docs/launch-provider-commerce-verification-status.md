# Launch providers and commerce: engineering status versus external blockers

September 20, 2026. For the Core-only launch ($19.99/month; peptide +$10 and longevity +$50 stay
disabled). Each row says what is source engineering (done or missing) and what is an external blocker
(a credential, account, agreement or approval only the owner can supply). A missing credential is a
blocker; a missing callback, retry or reconciliation path is engineering. Status words: implemented,
locally verified, hosted verified, device verified, awaiting approval. Nothing below is hosted or
device verified.

## September 28 live configuration checkpoint

This checkpoint supersedes stale configuration assumptions below, not their outstanding acceptance
requirements. Read-only AWS inspection is configuration evidence, not a completed provider journey.

- SES in both `588966314750` and `173535830222` now reports successful DKIM and custom MAIL FROM for
  `ailongevitypro.app`; production access remains false in both. No additional DKIM repair is indicated
  by this observation. Production Cognito consumer and workforce pools use the production SES identity
  with sender `AI Longevity Pro <info@AILongevityPro.app>` and configuration set `alp-transactional`.
- The production configuration set publishes bounce/complaint/reject events to
  `alp-ses-deliverability-alerts`, but that topic's subscription listing was empty. Source handling
  below is not proof a deployed subscriber processes those events. Verify the intended handler,
  suppression and monitored notification path before claiming deliverability operations work.
- The production core-billing readiness stack is blocked, Sandbox, EnabledStores=none. Store-console
  products and agreements were not inspected; source blocker names are not evidence they do not exist.
- The synthetic telehealth stack reports ZoomEnabled=false, ZoomBaaVerified=false,
  StripeTestEnabled=false and RemindersEnabled=false. No secret values were read. Live booking,
  provider meeting creation, charges and reminders remain unverified.
- The synthetic Fullscript stack uses `sandbox_us`, its sandbox authorization origin and the hosted
  Desktop callback; lab ordering is disabled. Verify sandbox OAuth using an appropriate sandbox
  account, not an assumption that production credentials must work there.
- **External Google calendar integration was already requested by the owner.** Internal-calendar
  rendering does not complete that request. OAuth configuration, event sync and conflict behavior
  against the actual external calendar remain unverified; do not silently scope this requirement out.
- AWS Artifact queried from production reports an ACTIVE AWS Organizations Business Associate
  Addendum. The supplied OpenAI amendment has both September 17 signatures, but the customer name
  omits the LLC suffix confirmed by the owner. Obtain entity-coverage clarification and verify the
  covered runtime organization/project, eligible endpoints and retention configuration. Agreement
  evidence alone does not approve PHI activation.
- Qualification alarm SNS subscription for `BrandonBright@gmail.com` is confirmed; the owner confirmed
  receipt of test `ALP-QUAL-20260928-EMAIL-01`. SNS message ID:
  `3092fea1-2044-5873-bfe7-9d9431109c9b`. The `info@AILongevityPro.app` subscription remains pending.
  This proves one direct SNS delivery, not the full CloudWatch alarm route or an on-call drill.
  Both addresses reach Brandon Bright; a separate backup responder is still unassigned.

The V2 companion `expo/docs/release-qualification-preparation-2026-09-28.md` records exact-source,
device and public-notice prerequisites. PHI stays disabled; no provider setting changed here.

## September 20 source inventory (configuration observations superseded above)

| Area | Engineering status | External blocker |
|---|---|---|
| Core purchase, restore, entitlement | implemented, locally verified (V2 `backend/billing/*`, `core-native-purchase.test.ts`, matched configuration gate `check:billing-configuration`, `smoke:core-billing`): Apple transactions never auto-finish, Google selects the monthly base plan, receipts never move between accounts, restore is the recovery for "no purchase found" | App Store Connect and Play Console products, agreements, sandbox testers, `BILLING_ACTIVATION=approved` and `COMMERCIAL_RELEASE_APPROVAL=approved` (awaiting approval) |
| Renewal, refund, revocation, billing failure | implemented, locally verified: store notifications and the six-hourly reconciliation sweep (`reconciliation.ts`) record refund, revocation, expiry and billing failure as `accessLost`; outages leave rows untouched and stop after five failures; the read path decides access from stored state | Store notification endpoints registered in the consoles; the reconciliation schedule is `DISABLED` until activation |
| Add-on tiers | implemented: contract pins `available:false`, responses cannot carry enabled add-ons, the launch scope manifest agrees on both repositories | Owner decision to keep them off at launch (recorded) |
| Transactional email delivery | implemented, locally verified: SES reminder sender with a configuration set, minimum-necessary content, no health information | September 28: domain verification succeeds, but SES production access is still false; delivery acceptance and reminder activation remain outstanding |
| Email bounce and complaint handling | **implemented this commit, locally verified**: an SES configuration-set event destination publishes bounces and complaints to an SNS topic that invokes the telehealth function; permanent bounces and complaints are stored as a hashed suppression list (never the address); a reminder to a suppressed address is skipped with `reason: suppressed`; transient bounces are ignored; notifications from any other topic are refused; reminders cannot be enabled without the topic (`telehealth-requests-extension.json`, `UseReminders`) | SES production access; a hosted bounce simulator test (`bounce@simulator.amazonses.com`, `complaint@simulator.amazonses.com`) once the sender is enabled |
| Calendar availability, holds, conflicts, cancellation, rescheduling | implemented, locally verified (`aws-telehealth-requests.ts`): published slots, atomic holds with expiry, booking only against the caller's live hold, cancellation with the fee policy, reschedule requests and workforce rescheduling under version checks; conflicts are `409` | Hosted internal-calendar acceptance remains required. Owner-requested Google calendar sync is not completed by this internal scheduler; actual OAuth/sync acceptance is outstanding |
| Zoom meeting links and reminders | implemented fail-closed: no link is created unless `ZoomEnabled`, `ZoomBaaVerified` and the secret are all set; reminders refuse for cancelled or rescheduled appointments | Zoom Server-to-Server OAuth credentials and the Zoom BAA (awaiting approval) |
| Payments for appointments (Stripe test mode) | implemented, locally verified: signed webhook, live-mode refused, `reconcile` action reads the official intent and settles only when its metadata names the request; stale versions `409`; no secret read without the boundary | Stripe test secret and webhook secret registration; live provider selection, PCI scope and PHI-free processor metadata review (awaiting approval); Stripe Billing terms exclude PHI, so clinical details never reach the processor |
| Fullscript | implemented: sandbox default, `NoEcho` client secret, destination handling by environment | Production application and commercial approval; OAuth credentials |
| Nutrition catalog packaging and runtime availability | implemented, locally verified: in-house USDA/Open Food Facts catalog, `verify-food-catalog.mjs` in CI, runtime availability check, image smoke | None; hosted verification of the deployed catalog artifact hash is part of the release record |
| Provider configuration consistency | implemented: `check:aws-provider-configuration` refuses any provider enabled by default, any credential in a template, or a Lambda variable the template does not set (and the reverse) | none |

## What a hosted run must still show

With credentials the owner supplies, in the synthetic account first: a sandbox purchase, restore,
refund and revocation each reaching the stored state the read path expects; a store notification
replayed twice reaching the same state once; the reconciliation sweep against a stale row; an SES
bounce simulator address suppressing the next reminder; a Stripe test webhook replayed and a lost
webhook reconciled; a held slot expiring and a conflicting hold refused; a Zoom link created only with
the BAA gate on. Each result belongs in the release record beside the artifact hashes.
