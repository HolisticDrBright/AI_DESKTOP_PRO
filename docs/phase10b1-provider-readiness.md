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

A second pass then reversed two decisions this document had previously
argued for. Both had been flagged in the PR body as needing review, and
both were overruled:

1. **The governed synthetic capability is removed from every deployed
   runtime.** `approved_for_synthetic` no longer activates a fixture or
   synthetic provider when `isDeployedRuntime()` is true, under any
   circumstances. See *Where a synthetic provider is allowed to exist*.
2. **Hand-written SigV4 is replaced by
   `@aws-sdk/client-secrets-manager`** and the standard AWS credential
   provider chain. Security and maintainability take priority over
   minimizing transitive dependencies. See *Production `SecretResolver`*.

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

**The official AWS SDK, not hand-rolled SigV4.** The first revision signed
requests by hand with `node:crypto` to avoid roughly fifty transitive
packages. That trade was reviewed and reversed: security and
maintainability outrank dependency count here. Request signing has a long
tail of details — credential refresh, session tokens, SSO and IMDS
sourcing, clock skew, regional endpoint resolution, retry classification —
and none of it is this repository's job to maintain.
`@aws-sdk/client-secrets-manager` is now a runtime dependency and
credentials come from the **standard AWS credential provider chain**;
`credentials` is deliberately absent from the client config, because
passing it would replace the chain and exclude SSO, IMDS, ECS task roles,
and web identity — the sources a real deployment should prefer over a
static env key. `npm audit --omit=dev` attributes **zero** findings to the
SDK or any of its transitive packages.

**The SDK is loaded behind a dynamic `import()`, never statically.** There
is no `@aws-sdk` import at module scope anywhere in first-party source; a
test asserts that structurally, and asserts exactly one dynamic edge
exists. Three things depend on it:

- disabled mode does not merely skip *constructing* an AWS client, it does
  not pull the SDK into the process at all;
- nothing under `@aws-sdk` can reach a client bundle —
  `scripts/check-clinical-bundle.mjs` now fails hard (never advisory) on
  nine server-only markers including `@aws-sdk/client-secrets-manager`,
  `GetSecretValueCommand`, the secret-resolver categories, and the copilot
  system prompt;
- a static import put the SDK's whole module graph in front of every
  Vitest worker that transitively imports the resolver. It was not a
  theoretical cost: the unit suite went from ~4s to a 2,649s run that
  failed with worker start-up timeouts. Lazily loaded, it is 4.9s again.

The injection seam is `AwsSecretsSend`, typed against the plain request
shape `{ SecretId }` rather than an SDK `Command` class, so the seam
itself does not reintroduce the static dependency. A second seam,
`sdkLoader`, lets tests exercise the real construction path — bounded
timeouts, `maxAttempts`, no `credentials` key — without the real SDK
entering the test's module graph.

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

## Where a synthetic provider is allowed to exist: nowhere deployed

An earlier revision of this reconciliation treated `approved_for_synthetic`
as authority enough to run a fixture inside a deployed runtime, reasoning
that an audited database row outranks an environment flag. That was
reviewed and rejected, and rightly. A row in a table is not a reason for
synthetic clinical content to exist in a deployed process at all; the
blast radius of one mis-set activation row is a patient chart showing
invented content that looks real.

So the Phase 10A deployed refusal is **categorical and comes first**. A
governed record is now NECESSARY but not SUFFICIENT. All six conditions
must hold together:

1. process mode is `live` (never `disabled`);
2. `isDeployedRuntime()` is **false** — no governed record overrides this;
3. the isolated local contract-fixture boundary allows it;
4. registry kind is literally `synthetic_fixture`;
5. organization activation is `approved_for_synthetic`;
6. the snapshot carries **no PHI**.

`approved_for_phi` does **not** select the fixture — a failed live call
never degrades to fabricated output.

The posture surface follows the same rule. `computeProviderPosture` takes
a required `syntheticPermitted` flag (required, not defaulting to true, so
a caller that forgets it cannot make the false claim). Where synthetic is
refused, an `approved_for_synthetic` organization reads `live_unavailable`
with "Synthetic evaluation is not available in this runtime… no example
content is shown" — never "Fixture test mode", which would promise
deterministic content the run path is about to refuse.

### The local contract-fixture boundary (`src/server/runtime/contractFixture.ts`)

A separate module from `deployedRuntime.ts` and a separate concept from
`resolveCopilotMode()`. Those answer "is this deployed?" and "what did the
operator ask for?". This answers a narrower question with a higher bar:
*is this unambiguously a local test harness, talking to a loopback backend
that is definitely not the clinical project?* Five ordered rules, each
refusing on its own and naming which one failed:

1. `CLINICAL_CONTRACT_FIXTURE=1` set explicitly — there is no default-on path;
2. `isDeployedRuntime()` is false — the same categorical Phase 10A detector,
   reused rather than reimplemented, including its `NODE_ENV=production`
   last-resort signal;
3. a clinical backend URL is configured at all;
4. it is not the clinical project `urcjiehlxoehievobezf` and not any hosted
   Supabase project — checked **by identity**, so a tunnel or hosts-file
   entry that makes the project look local is still refused;
5. the host is loopback.

No `NEXT_PUBLIC_*` value is consulted, so nothing client-shipped can open it.

### The consequence for browser coverage

`next start` forces `NODE_ENV=production`, which rule 2 refuses. Rather
than weaken the refusal, the live state-machine job runs against
`next dev` (`E2E_DEV_SERVER=1`), where the fixture is legitimately
permitted, and a fourth CI job proves the other half: identical governed
records plus deployment markers produce **nothing**.

A governed *adversarial* synthetic identity
(`synthetic_fixture_adversarial`) exists so the hallucinated-citation
branch is provable through the real UI rather than only in a unit test.
It is bounded exactly as the ordinary synthetic provider is — never in a
deployed runtime — and is labelled distinctly on every run row.

## Hallucinated citations fail closed

The orchestrator previously dropped the offending citation, kept the
draft, and returned `completed` with a quiet footnote — so a practitioner
saw a clean draft partly sourced from something the governed envelope
never contained. It now returns `failed` with `draft: null` and category
`citation_validation`, matching what the OpenAI adapter already did.

## Browser coverage

`e2e/live-copilot-provider-readiness.spec.ts` runs in **four CI jobs**, one
per runtime posture, because the copilot's mode *and* the runtime's
deployment posture are both fixed when the server boots and one server
cannot show all of them. Each job declares its block with
`E2E_COPILOT_POSTURE`; a value outside the four throws rather than
silently running nothing. The guards select a posture; they do not avoid
running.

| Job | `E2E_COPILOT_POSTURE` | Server | Env | Proofs |
| --- | --- | --- | --- | --- |
| `e2e-live-fixture` | `default` | `next start` | mode unset | 1, 1b, 2, 9, 19, 20 |
| `e2e-copilot-readiness` | `live_local` | `next dev` | `live` + `CLINICAL_CONTRACT_FIXTURE=1` | 3, 6–17, 19, 20 |
| `e2e-copilot-fixture-refusal` | `deployed_fixture` | `next start` | `fixture` + fixture flag + 3 deployed markers | 4, 5 |
| `e2e-copilot-deployed-live` | `deployed_live` | `next start` | `live` + fixture flag + 2 deployed markers | 4b, 4c, 19 |
| `e2e-clinical-down` | n/a | `next start`, backend down | — | 18 |

Why the readiness job uses a dev server is explained above: `next start`
is a deployed runtime by rule, and the alternative was to weaken that rule
for the sake of coverage. The dev server's only accommodations are a
route warm-up in `beforeAll` and longer *webServer/test* timeouts for
on-demand compilation. `retries` stays 0 and no assertion is relaxed.

**Proof 19 is split by artifact, not by strictness.** Its RUNTIME half —
the rendered DOM and the copilot API response bodies — runs in every
posture. Its SHIPPED half — every loaded script body — runs wherever the
server is a production build (three of the four jobs), plus the static
`check:clinical-bundle` scan in `checks`. The split exists because
`next dev` serves unminified modules with source *comments* intact: a
comment in `src/adapters/index.ts` mentioning "the `service_role` worker
boundary" appears in a dev chunk and in no production chunk. Scanning dev
chunks measures the wrong artifact — it fails on prose that is never
shipped while proving nothing about what is.

Every test runs under `assertNoExternalTraffic`, which fails if the page
requests any host other than the local app and the local fixture backend.

## Activation gate for Phase 10B.2

The next phase supervises the first N production runs per organization.
Phase 10B.1 leaves the registry empty by default; each organization starts
in state `disabled` and cannot leave that state without every approval
reference recorded on the activation row. `platform_admins` is empty in
the staging project, so no provider can even be registered without a
service-role migration.
