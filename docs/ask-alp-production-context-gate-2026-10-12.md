# Ask ALP production context gate (2026-10-12)

The deployed Ask ALP extension is synthetic-only. Its request body includes a
caller-supplied `context` object. A valid consumer token and Core entitlement
do not prove that this object came from that consumer's consented health record.
Activating the existing model route for PHI would let a caller submit invented
or another person's health context to the model.

The handler therefore refuses production generation with
`trusted_context_not_configured` before provider invocation, even if
`PHI_ALLOWED=true`. It also refuses any unknown `RUNTIME_MODE` instead of
treating it as synthetic. Synthetic generation remains unchanged. This is a
safety gate, not completion of the production Ask ALP feature.

Before a production candidate may replace this refusal:

1. Resolve the consumer and owner from independently verified identity, not
   body fields. Fetch a bounded, current server-owned snapshot for that owner
   from the production clinical boundary. Enforce the separate active Ask ALP
   consent and record its version and provenance. Never merge caller-supplied
   labs, wearables, cycle, plan, or care-team assertions into that snapshot.
2. Preserve the Core entitlement check, approved prompt hash, model/provider
   policy, red-flag/refusal controls, no tool-use writes, output validation,
   audit/version fields, and explicit unavailable states. Build the provider
   request only from the trusted snapshot and the user's question.
3. Add cross-owner and cross-organization refusal tests, consent withdrawal,
   stale snapshot, oversized response, forged body, concurrent revision, and
   missing-source tests. Run hosted fictional acceptance on the exact candidate.
4. Separately review the production OpenAI project/agreement/retention and
   subprocessors, secrets/IAM, prompt and clinical language, monitoring,
   rollback, and device journey before PHI or real-patient activation.

No production Ask ALP CloudFormation candidate, hosted production-context
acceptance, physical-device evidence, or PHI activation is claimed here.
