# Provider boundaries: matched configuration and failure reconciliation

September 16, 2026. Source engineering only. No provider credential is installed, no BAA is asserted, nothing is deployed.

## Matched configuration gate

`npm run check:aws-provider-configuration` (`scripts/check-aws-provider-configuration.mjs`, self-tested by `test:aws-provider-configuration`, both in CI) refuses when any of these drift:

- `external-provider-readiness.json` records `phi_allowed=false`, every provider disabled or not production enabled, no installed payment credentials, SMS disabled, Amazon SES as the transactional email provider.
- `telehealth-requests-extension.json`: `ZoomEnabled`, `ZoomBaaVerified`, `RemindersEnabled` and `StripeTestEnabled` default to `false` with boolean allow-lists; secret ARNs and the reminder sender default to empty; Stripe return URLs are https on `ailongevitypro.app`; the Lambda environment sets exactly the variables `aws-telehealth-requests-lambda.ts` reads, no more and no fewer; `PHI_ALLOWED` is never a literal true.
- The handler source keeps the Zoom BAA gate, the stale-reminder refusal, live-mode webhook refusal, the five-minute webhook replay window, test-mode-only Stripe keys and the payment reconciliation action.
- Fullscript defaults to `sandbox_us` with a `NoEcho`, default-less client secret; consumer account activation defaults to `blocked`; no template or snapshot contains credential material.

## Payment failure reconciliation

A workforce charge moves a request to `paymentStatus: processing` and waits for the signed Stripe webhook. If the webhook is delayed or lost, staff can now post `action: "reconcile"` to `POST /clinical-core/workforce/appointments/payments` with the request's `expectedVersion`:

- The handler reads the official payment intent with the test-mode key. The intent must be the stored `paymentIntentId` and its metadata must name this organization and request; anything else is `provider_unavailable` and nothing changes.
- `succeeded` settles the request as `paid` with the received amount, which must be at least one minor unit and no more than the published price or fee due. `canceled`, or `requires_payment_method` with a recorded payment error, settles as `failed`.
- `requires_action`, `requires_confirmation`, `requires_capture` and `processing` leave the request untouched and report `still_processing`. A request that is not processing reports `not_processing`.
- A stale `expectedVersion` is a `409 conflict`. Without the Stripe test boundary the action is `503` and no secret is read.

Reminder and Zoom failure handling are unchanged: reminders refuse to send for cancelled or rescheduled appointments, Zoom stays fail-closed until the BAA gate and secret are registered.

## Still required from owners

Stripe test secret and webhook secret registration, Zoom Server-to-Server OAuth credentials with the BAA gate, SES production access after DNS verification, Fullscript production application and commercial approval, and hosted acceptance runs of callback replay, reminder delivery, booking holds and payment reconciliation against the deployed stack. Unit tests with mocked AWS clients and a stubbed Stripe fetch are the only evidence in this increment.
