# Ask ALP production context gate (2026-10-12)

The deployed Ask ALP extension is synthetic-only. Its request body includes a
caller-supplied `context` object. A valid consumer token and Core entitlement
do not prove that this object came from that consumer's consented health record.
Activating the existing model route for PHI would let a caller submit invented
or another person's health context to the model.

The handler refuses production generation without both an owner-scoped context
loader and a trusted backend-caller verifier, even if `PHI_ALLOWED=true`. It
also refuses any unknown `RUNTIME_MODE` instead of treating it as synthetic.
Synthetic generation remains unchanged. This is a safety gate, not completion
of the production Ask ALP feature.

The source now includes an owned-record context loader. It uses the same
database adapter as personal storage, requires the separate `ai_context`
consent, ignores every caller-supplied context field, caps context bytes, and
rebuilds the snapshot after generation so withdrawal or record changes withhold
the response. The API also checks current owner claims, Core entitlement, the
prompt hash, activation-evidence field, and output guard before delivery.
The production handler now accepts only
`POST /clinical-core/internal/ask-alp/generate`, not the public consumer JWT
route. Its caller verifier pins the API and account, requires an API Gateway
IAM-authenticated invocation from the specified ECS role, and independently
verifies a Cognito ID token carried in a separate header before deriving the
owner. Core entitlement receives that verified token; SigV4 Authorization is
not misread as a consumer bearer token. The synthetic route is unchanged.
These are local/source tests only. V2 now has a source-only SigV4 backend
signer for the private route and sends no device context on that path. The
personal-context response carries a digest of its exact owner snapshot;
V2 validates it and signs it into the private request. The Lambda reloads
owner data and refuses a digest mismatch before calling OpenAI. V2 emits
context chips only after an accepted answer has been saved. This binds the
source read across the two servers, but does not make the V2 budgeted snapshot
identical to the raw Lambda/model snapshot. No production `AWS_IAM` route,
restrictive Lambda permission, exact context/chip contract or hosted proof
exists yet. A public JWT route must not
bypass the V2 server's
deterministic red-flag/refusal and inbox workflow. The existing synthetic
CloudFormation template fixes `RUNTIME_MODE=synthetic` and `PHI_ALLOWED=false`.

Before a production candidate may replace this refusal:

1. Deploy a separately reviewed `AWS_IAM` route and IAM-scoped ECS task role,
   with a restrictive API Gateway-only Lambda resource permission. The V2
   source signer must be bound to the deployed ECS task role; prove a consumer
   cannot mint or replay the call and verify the actual gateway IAM event
   shape, including its account field, under hosted qualification. Also prove
   that the route is reached only after deterministic red-flag/refusal handling,
   including practitioner-inbox alerts. Do not
   satisfy this with an unverified request header or a browser-held secret.
2. Produce one exact context/chip contract across V2 and the model boundary;
   the V2 builder currently budgets the snapshot while the new AWS loader
   returns the owned raw snapshot. Refuse if a marker or safety input is
   omitted without disclosure. Preserve the Core entitlement, approved prompt
   hash, model/provider policy, no tool-use writes, output validation, and
   audit/version fields.
3. Add hosted cross-owner and cross-organization refusals, consent withdrawal,
   stale snapshot, oversized response, forged body, concurrent revision, and
   missing-source tests on an isolated candidate. Source tests are not hosted
   acceptance.
4. Separately review the production OpenAI project/agreement/retention and
   subprocessors, secrets/IAM, prompt and clinical language, monitoring,
   rollback, and device journey before PHI or real-patient activation.

No production Ask ALP CloudFormation candidate, hosted production-context
acceptance, physical-device evidence, or PHI activation is claimed here.
