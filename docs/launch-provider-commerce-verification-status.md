# Launch providers and commerce: engineering status versus external blockers

September 20, 2026. For the Core-only launch ($19.99/month; peptide +$10 and longevity +$50 stay
disabled). Each row says what is source engineering (done or missing) and what is an external blocker
(a credential, account, agreement or approval only the owner can supply). A missing credential is a
blocker; a missing callback, retry or reconciliation path is engineering. Status words: implemented,
locally verified, hosted verified, device verified, awaiting approval. Nothing below is hosted or
device verified.

| Area | Engineering status | External blocker |
|---|---|---|
| Core purchase, restore, entitlement | implemented, locally verified (V2 `backend/billing/*`, `core-native-purchase.test.ts`, matched configuration gate `check:billing-configuration`, `smoke:core-billing`): Apple transactions never auto-finish, Google selects the monthly base plan, receipts never move between accounts, restore is the recovery for "no purchase found" | App Store Connect and Play Console products, agreements, sandbox testers, `BILLING_ACTIVATION=approved` and `COMMERCIAL_RELEASE_APPROVAL=approved` (awaiting approval) |
| Renewal, refund, revocation, billing failure | implemented, locally verified: store notifications and the six-hourly reconciliation sweep (`reconciliation.ts`) record refund, revocation, expiry and billing failure as `accessLost`; outages leave rows untouched and stop after five failures; the read path decides access from stored state | Store notification endpoints registered in the consoles; the reconciliation schedule is `DISABLED` until activation |
| Add-on tiers | implemented: contract pins `available:false`, responses cannot carry enabled add-ons, the launch scope manifest agrees on both repositories | Owner decision to keep them off at launch (recorded) |
| Transactional email delivery | implemented, locally verified: SES reminder sender with a configuration set, minimum-necessary content, no health information | Domain identity pending three DKIM records; AWS production access denied (case 178794181600116) and to be resubmitted after DNS verification; `RemindersEnabled=false` until then |
| Email bounce and complaint handling | **implemented this commit, locally verified**: an SES configuration-set event destination publishes bounces and complaints to an SNS topic that invokes the telehealth function; permanent bounces and complaints are stored as a hashed suppression list (never the address); a reminder to a suppressed address is skipped with `reason: suppressed`; transient bounces are ignored; notifications from any other topic are refused; reminders cannot be enabled without the topic (`telehealth-requests-extension.json`, `UseReminders`) | SES production access; a hosted bounce simulator test (`bounce@simulator.amazonses.com`, `complaint@simulator.amazonses.com`) once the sender is enabled |
| Calendar availability, holds, conflicts, cancellation, rescheduling | implemented, locally verified (`aws-telehealth-requests.ts`): published slots, atomic holds with expiry, booking only against the caller's live hold, cancellation with the fee policy, reschedule requests and workforce rescheduling under version checks; conflicts are `409` | None for the internal calendar; an external calendar (Google/Outlook) sync is out of the Core scope unless the owner adds it (awaiting decision) |
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
