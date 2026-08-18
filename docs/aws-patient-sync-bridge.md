# AWS patient sync bridge

Synthetic staging now has a deployed signed bridge between AI Desktop Pro and
AI Longevity Pro V2.

## Runtime

- Desktop outbound worker: AWS Lambda, invoked on a bounded EventBridge cycle.
- Desktop verification/callback boundary: API Gateway + Lambda.
- V2 receiver: Fly backend with persistent RLS-protected receiver storage.
- Contract: `patient-sync/1` with raw-body HMAC, key ids, timestamp windows,
  durable nonce replay defense, payload hashes, and bounded request sizes.
- Desktop organization activation: reviewed `alp_patient_sync` connector row.

The bridge remains unusable for a patient until a practitioner creates a
one-time invitation and the patient verifies it in V2. Linking never uses
email, name, phone number, or date of birth. Consent is versioned separately
for each resource scope.

## Wearables

Junction remains the wearable ingestion boundary in V2. V2 may submit only a
minimum-necessary `wearable_summary`: the latest available day plus bounded
seven-day averages and data-quality counts. Raw samples, account credentials,
OAuth tokens, user identifiers, and minute-level timelines do not cross the
bridge.

`record_sync_inbound` maps `wearable_summary` to the independent `wearables`
consent scope. Without a current grant the database refuses the write. With a
grant, the event opens a `sync_review` item for the practitioner; it is never
silently merged into the chart.

## Patient-app lab imports

Historical app labs use the independent `lab_results_import` consent scope;
the existing `lab_summaries` scope remains Desktop-to-app only. The app
projects each numeric marker into a signed `lab_result` event. Notes, uploaded
files, interpretations, recommendations, contact data, and account identity
are excluded. Deterministic provider-event and source-version keys make a
repeated backfill idempotent on both sides.

Every accepted event first creates a `sync_review` task. A practitioner must
accept that exact signed event before Desktop creates an `alp_patient_sync`
lab document, panel, and unreviewed biomarker observation. Source identity,
source version, provider event id, signing key id, and clinician import actor
remain in provenance. Marker-level review is still required in Labs; import
acceptance never labels a result clinically reviewed.

## Deployment and verification

The stack is deployed only to the dedicated synthetic staging AWS account.
`scripts/deploy-aws-sync-bridge.ps1` preserves existing bridge secrets during
CloudFormation updates. `scripts/build-aws-sync-bridge.mjs` produces the two
Lambda bundles without putting secret values in source or client code.

Verification includes exact-route and method checks, content-type and size
limits, signature-before-parse, replay protection, a signed invalid-invitation
request reaching the Desktop RPC, a signed Desktop envelope reaching the V2
connection boundary, a bounded worker cycle, client-bundle secret scans, and
the existing patient-sync database acceptance suites.

The final live synthetic acceptance still requires deliberate practitioner
and patient actions: issue invitation, link V2, grant the `wearables` scope,
send a wearable summary, and review it in Desktop. This document does not
authorize production or real PHI.

Lab-import acceptance additionally requires a synthetic app panel, explicit
`lab_results_import` consent, repeated backfill with zero duplicates, signed
AWS callback delivery, practitioner import acceptance, and confirmation that
the marker appears in Labs as awaiting review. Real lab transfer stays blocked
until that gate and the production PHI-readiness gate both pass.
