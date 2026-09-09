# Personal consumer API and V2 integration — September 8, 2026

Status: **implemented candidate, not deployed or commercially activated**. Core
remains $19.99/month, with peptide/longevity add-ons excluded from initial launch.
PHI remains disabled. No paid EAS/TestFlight build, provider call with personal
health data, signed consent release, or human approval was created.

## Implemented

- Independent JWT-authenticated API under `/clinical-core/consumer/personal`:
  GET records, GET record, POST records, GET/POST consent, GET chat-context.
  Identity comes from API Gateway verified claims plus database ownership checks,
  not body fields or an invented clinic membership. Existing clinic sharing is
  a separate route and explicit action.
- Consent history and exact reviewed copy, verified by SHA-256, plus separate
  storage scopes and AI-context consent. No approved releases are seeded.
  Withdrawal/history remain available if a feature is removed from rollout;
  new grants and data access for that disabled feature remain refused.
- Additive migration `20260908100000` provides consent reads, owner-only point
  reads including tombstone revisions, and bounded recent-record reads. RLS,
  restricted function execution and metadata-only audits remain enforced.
- Fixed an actual adapter-to-Aurora failure: parameterized revision/limit values
  arrived as bigint, so integer database functions did not resolve. Explicit SQL
  casts now match the function contracts. Direct literal SQL tests alone had
  not caught this; the API-handler-to-real-adapter acceptance test did.
- V2 production providers use personal storage without a Desktop connection.
  Explicit Desktop intake sharing still requires its own connection/consent.
  Synthetic installed clients retain their existing path. Personal storage has
  an explicit consent/history screen and intake-save action under the profile.
- Saved revisions prevent unseen overwrite. Encrypted pending-command metadata
  preserves an identical retry across restart without storing a second copy of
  the health payload. Changed content during an ambiguous pending command is
  refused for reconciliation; it is not silently applied. Account changes abort
  requests and invalidate the consent review UI.
- Personal Ask ALP context now includes recorded profile/diet/medications,
  separately consented cycle status, measured wearables including steps alone,
  and separately consented recent symptom/adverse-event reports. Exact consent
  revisions are rechecked after assembly. Missing/stale values are not replaced
  with defaults; a cycle day does not prove ovulation. No recovery score is
  invented. Product eligibility/recommendation rules were not changed.

## Verification and release boundary

The rollback acceptance runner exercises the HTTP handler **in process**, through
the real adapter/Data API into Aurora. It is not a hosted API Gateway test.
It applies both proposed migrations only inside a rollback transaction and uses
fictional identities/consent approval metadata. The latest 35 assertions cover
ownership, RLS, no clinic requirement, content-bound retries, consent history,
exact consent content, AI consent and cross-account context refusal. Independent
checks confirm no retained test rows, identities or proposed schema.

Persistent Aurora remains at **46 applied migrations**. The source candidate now
assembles **48**, with zero seeded clinical or approval rows. The last two
migrations are not persistently applied. Migration 48 requires the new consent
release table to be empty; if another operator has populated migration 47 first,
stop and plan an attributable content backfill instead of guessing approved copy.

`node scripts/build-aws-personal-storage.mjs` builds the Lambda and a validated
CloudFormation candidate with JWT routes, **PHI false, activation blocked, no
enabled scopes, no clinical database credentials and logs-only IAM**. It was not
deployed. This template is deliberately not an activation mechanism.

Local suites: Desktop 1,163 passing / 10 skipped; V2 393 passing / one skipped.
Skipped tests are not acceptance evidence. Both type checks and lint passed
(Desktop has four pre-existing warnings). Desktop's explicit clinical build and
268-chunk client-boundary scan passed. The default build correctly refused an
unspecified edition. The V2 patient API build/smoke and built personal Lambda
refusal smoke passed with normal production routes refused. Physical phone UI and native permissions
have not been verified in this increment. Source publication does not install a
phone build or replace hosted Desktop.

## Engineering still required, in dependency order

1. Complete independently owned **production labs/jobs/history**, including
   extraction and reviewed range-release provenance. Personal chat currently
   returns no server-owned lab observations; it must not claim this means the
   account has no labs. The existing client-supplied lab path is not a substitute
   for complete production-owned lab history.
2. Complete context for the full intake/questionnaire, symptoms history and
   active protocols with accurate approval/source labels. Never call an
   AI-generated or client-supplied protocol practitioner-approved by inference.
3. Complete personal cloud hydration and explicit conflict reconciliation UI,
   including ambiguous saves, changed input, two devices and consent regrant.
   Current code safely refuses those conflicts but does not finish that UX.
4. Complete production identity/scope policy, data-plane deployment/IAM,
   production voice/provider configuration and exact-release acceptance. New
   consent releases and scope approvals require accountable human sign-off.
5. Fulfill export/correction/deletion across database versions, objects, jobs,
   identities and reviewed retention/backups. Tombstones are not physical erasure.
6. Finish store/provider acceptance, security/load/abuse/recovery exercises and
   physical iOS/Android five-persona tests, then build authorized release candidates.

Human account, agreement, clinical-content and operational responsibilities remain
in [commercial-launch-handoff.md](commercial-launch-handoff.md). Engineering is
still required in addition to those gates; this document does not certify HIPAA
compliance or public-launch readiness.
