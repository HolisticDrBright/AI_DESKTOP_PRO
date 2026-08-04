# Phase 10B.1 — Governed Copilot Provider Readiness

**Base:** `main` at Phase 10A merge `ab61be1`.
**Branch:** `claude/clinical-runtime-phase10b1-provider-readiness`.

## Purpose

Build the infrastructure that would let a governed clinical copilot call an
approved external AI provider, without actually calling one. Every path
below is verifiable end-to-end on the fixture provider and on the disabled
provider. **Live mode is intentionally unreachable** in this PR because the
approval and BAA gates evaluate to `false`.

## Provider decision

Target: **OpenAI API with Modified Retention** as the first supervised
provider adapter, once every gate below is `true`.

- Executed OpenAI BAA (recorded outside the code).
- Approved HIPAA-eligible OpenAI project (recorded outside the code).
- Legal + privacy + clinical + infrastructure sign-off (recorded outside
  the code, referenced from the registry row's `approval_references`).
- Documented Modified Retention setting on the OpenAI project (Modified
  Retention = zero data retention for HIPAA-eligible calls).

**Consumer ChatGPT is never a clinical provider.** The adapter refuses on
sight if `providerName='chatgpt'` or if the resolved endpoint is
`chat.openai.com`.

## Non-negotiables kept from Phase 10A

- Unknown stays unknown; never invent a dose.
- Empty state and failure are distinguishable.
- Commercial data cannot touch clinical data.
- Nothing synthetic in the clinical project.
- Declared value carries authority; text signal does not.
- No safety test may be weakened.

## New in Phase 10B.1

- Governed provider registry.
- Per-organization activation state machine.
- Data-minimization envelope with structural exclusion checks.
- OpenAI adapter behind the vendor-neutral interface (refuses; no external
  call is made in this PR).
- Practitioner actions extended: dismiss with reason, flag unsafe, request
  regeneration, report citation failure.
- Adversarial 25-case matrix as executable unit tests.
- Grant-level defense-in-depth on every new RPC (P10A precedent).

## What this PR **does not** do

- No external AI request is made.
- No key is transmitted anywhere.
- No production activation.
- No BAA is asserted in code.
- No PHI-shaped fixture data appears in staging.

## Activation gate for Phase 10B.2

The next phase supervises the first N production runs per organization.
Phase 10B.1 leaves the registry empty by default; each organization starts
in state `disabled` and cannot leave that state without every approval
reference recorded on the activation row.
