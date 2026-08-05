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

## Added in the reconciliation pass

The first checkpoint of this phase left three gaps. All are now closed.

### Bounded HTTPS transport (`http-transport.ts`)

`createHttpsTransport` is a real transport, not a placeholder:

- origins compared by `URL.origin` **equality**, never prefix or substring
  — `https://api.openai.com.evil.example` is refused;
- `redirect: "manual"` — a 3xx is refused, never followed, so the
  `Authorization` header cannot be carried to an unapproved host;
- hard `AbortSignal` timeout composed with any caller signal;
- bounded request bytes before sending, and bounded response bytes
  enforced against bytes **actually received** rather than the peer's
  `content-length` claim;
- HTTP status and content type validated before anything parses the body;
- `TransportError.message` **is** the category — no URL, header, or body.

`refusalTransport` remains the default, so an adapter that was handed no
transport still cannot reach a socket.

### Production `SecretResolver` (`secrets.ts`, `secrets.aws.ts`)

Five distinct server-side categories — missing / denied / malformed /
unavailable / expired. `publicSecretCategory()` collapses *missing* and
*denied* for anything caller-visible, because distinguishing them tells an
attacker which ARNs are real. A JSON payload must carry only `apiKey`,
`organization`, `project`; an unexpected field is refused rather than
ignored. The cache is bounded with a short TTL, and a stale entry is
dropped **before** the refetch so a failed refresh can never fall back to
a revoked bearer.

**No AWS SDK dependency was added.** This repository ships five runtime
dependencies and no vendor SDKs — the OpenAI request is likewise
hand-built against the published wire contract. `@aws-sdk/client-secrets-manager`
would pull roughly fifty transitive packages into a clinical application
to make one signed POST. Signing is HMAC-SHA256 via `node:crypto` against
the documented SigV4 canonical string. If a later phase adopts the SDK it
implements the same `SecretsManagerClient` interface and nothing above it
changes. `package.json` is unchanged from the base commit.

### Disabled mode constructs nothing (`provider.runtime.ts`)

`resolveProviderRuntime` returns on the disabled branch **before** either
factory is invoked. "No AWS client is built when the copilot is off" is
therefore a property of control flow that a test observes by counting
construction, not a comment asking the reader to trust it.

## The seven states

`provider-posture.ts` is the single source of truth for what the
application may claim. The vocabulary is exactly: `disabled`,
`configured_unapproved`, `approved_never_transacted`, `fixture_test_mode`,
`live_unavailable`, `live_failed`, `live_transacted`. There is no
"connected" and no "HIPAA-ready", and a test asserts neither phrase can
appear in any posture.

**Configured and transacted are separate facts**, rendered separately.
Having a key and having sent something are different claims, and
collapsing them is how an organization comes to believe it is live when
nothing has ever been sent.

Nine approval gates are derived from governed records only.
`deriveApprovalGates` reads no `process.env` at all; a test sets
`OPENAI_API_KEY` and `CLINICAL_COPILOT_APPROVED` and asserts not one gate
moves. Placeholder references (`TBD`, `pending`, `n/a`, `none`, `test`)
are refused rather than trusted.

## Why the synthetic provider is governed, not env-driven

The e2e server runs `next start`, so `NODE_ENV=production` and the
deployed-runtime detector correctly refuses `CLINICAL_COPILOT_MODE=fixture`.
Weakening that refusal to obtain browser coverage was not acceptable, so
`selectGovernedProvider` reaches the deterministic provider through the
governed record the schema already models. All four conditions must hold
together: process mode `live`, registry kind `synthetic_fixture`,
organization activation `approved_for_synthetic`, and **no PHI** in the
snapshot. `approved_for_phi` does **not** select the fixture — a failed
live call never degrades to fabricated output.

A governed *adversarial* synthetic identity
(`synthetic_fixture_adversarial`) exists so the hallucinated-citation
branch is provable through the real UI rather than only in a unit test.
It is reachable only under `approved_for_synthetic` and is labelled
distinctly on every run row.

## Hallucinated citations fail closed

The orchestrator previously dropped the offending citation, kept the
draft, and returned `completed` with a quiet footnote — so a practitioner
saw a clean draft partly sourced from something the governed envelope
never contained. It now returns `failed` with `draft: null` and category
`citation_validation`, matching what the OpenAI adapter already did.

## Browser coverage

`e2e/live-copilot-provider-readiness.spec.ts` runs in **three CI jobs**,
one per runtime posture, because the copilot's mode is fixed when the
server boots and one server cannot show all three. The guards select a
posture; they do not avoid running.

| Job | `CLINICAL_COPILOT_MODE` | Proofs |
| --- | --- | --- |
| `e2e-live-fixture` | unset (disabled) | 1, 1b, 2, 9, 19, 20 |
| `e2e-copilot-readiness` | `live` | 3, 6–17, 19, 20 |
| `e2e-copilot-fixture-refusal` | `fixture` + 3 deployed markers | 4, 5 |
| `e2e-clinical-down` | n/a, backend down | 18 |

Every test runs under `assertNoExternalTraffic`, which fails if the page
requests any host other than the local app and the local fixture backend.

## Activation gate for Phase 10B.2

The next phase supervises the first N production runs per organization.
Phase 10B.1 leaves the registry empty by default; each organization starts
in state `disabled` and cannot leave that state without every approval
reference recorded on the activation row. `platform_admins` is empty in
the staging project, so no provider can even be registered without a
service-role migration.
