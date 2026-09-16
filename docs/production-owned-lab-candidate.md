# Independent production lab/document processing candidate

September 16, 2026. Original phase 2 (production-owned lab/document processing),
not a new or completed phase. Source only: no deployment, persistent migration,
real data, provider call or paid mobile build. Pairs with V2
`expo/docs/production-lab-processing-consent.md` (client preflight).

## Implemented

- The synthetic lab API is now a mode-aware factory (`createLabAnalysisApi`).
  The synthetic handler is the unchanged default: attested tokens, `synthetic_only`
  classification, `synthetic-labs/` namespace, identical routes and tests.
- Production mode is reachable only through `owned-lab-api.ts`, which mirrors the
  owned voice candidate: API Gateway verifies the JWT signature; code requires the
  exact production consumer issuer/audience, `token_use=id`, verified email,
  production binding, refuses synthetic attestation, and revalidates the active
  database identity through the consent adapter before any job row is read.
- Every production job binds the owner's current `ai_context` and `lab_history`
  consent revisions, release versions and content hashes (`owned-lab/1`). The
  stored job identity must agree with the authorization. Requests carry
  `dataClassification: personal_health_record` and `attestsOwnerConsent`;
  synthetic attestation fields and caller-supplied authorization are refused.
- Server paid-Core check at creation only; status, resume, cancellation and
  deletion never require billing.
- Re-authorization on every access: status, recovery descriptor, discovery,
  upload targets, completion, and replayed request identities. Withdrawn or
  re-granted consent returns `lab_consent_required` and hides the job; a
  different owner gets 404; a synthetic handler never serves a production row
  and vice versa (`classifiedJob`).
- The worker takes an authorization policy. It verifies before document
  extraction, before AI synthesis and again before the terminal result is
  stored; withdrawal mid-run fails the job as `consent_withdrawn` with no result
  persisted. A synthetic worker refuses an authorized job and a production
  worker refuses an unauthorized one. Consent-database outages are retryable,
  not revocations.
- Separate object namespace `personal-labs/` (`LAB_OBJECT_PREFIX`) for documents
  and artifacts, enforced by IAM, the cleanup posture gate and the runtime
  entries; the state-machine name pattern accepts the personal machine.
- `scripts/build-aws-owned-lab.mjs` emits Lambdas and a default-blocked
  CloudFormation candidate derived from the synthetic extension: PHI false,
  activation blocked, no scopes, logs-only IAM until the reviewed activation
  condition holds, consumer JWT routes only (14), explicit production pool
  issuer/audience, retained table/bucket, no browser CORS, scoped consent
  database access, reserved concurrency, error alarms with an optional
  recipient, cleanup rules disabled while blocked. Activation additionally
  requires `LabRangeMode=reviewed_release`: personal documents are never
  classified against fixture ranges. CI now builds and cfn-lints it.

## Verification

Desktop typecheck, lint (zero errors, four existing warnings), all lab suites
plus 42 new owned-lab tests (authorization, API, worker policy, infrastructure
including the bundled handlers refusing while blocked), cfn-lint of the emitted
template, and the clinical-core/identity/authenticated-API/deployment-acceptance/
mock-import gates passed. These are mocked and template checks, not hosted,
provider, payment, device or rollback-only database evidence.

## Still required

Hosted synthetic acceptance of the candidate; the V2 client mode for a verified
production runtime; hosted/device qualification of the source claim and durable
acknowledgment protocol (`lab-delivery-acknowledgment.md`), plus cloud publication
and lost-device recovery; reviewed consent releases for `lab_history`/`ai_context`;
provider (Textract/OpenAI) agreements and evidence hashes; retention/lifecycle
policy; alarm owner; billing origin; load/abuse qualification; complete job/read
auditing and account privacy across documents, artifacts, identity and backups;
physical device tests. Global blocking removes permissions; it is not erasure.
No approval, agreement or signature was invented. All six original phases remain
partial/incomplete.
