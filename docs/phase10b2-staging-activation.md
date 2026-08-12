# Phase 10B.2 — Controlled Live-Provider Staging Activation

**Status: the controls are built and tested. No external OpenAI request was
made, and none could be.** This environment has no AWS credentials, no AWS
config, and no OpenAI secret reference, so the bounded live verification is
blocked on an external prerequisite. See *Unavailable prerequisites*.

The phase's goal was narrow: prove the governed copilot **can** make
bounded real OpenAI requests using synthetic staging data, while real
patient use and production activation remain **impossible**. The second
half is delivered and enforced. The first half is delivered up to the
point where a credential would be required.

---

## Authority map

Who decides what, and where the decision is written down.

| Concern | Authority | Where |
| --- | --- | --- |
| Provider configuration | Platform admin, via audited RPC | `clinical_copilot_provider_registry`, `register_copilot_provider` |
| Secret ownership | AWS Secrets Manager. The database stores a **reference** only | `provider_secret_ref` (CHECK refuses secret-shaped values); `secrets.aws.ts` |
| Organization activation | Org owner/admin, state machine | `clinical_copilot_org_activations`, `set_copilot_activation_state` |
| Activation **scope** | Org owner/admin, with a reason | `set_copilot_activation_scope` (environment / approved use / exact model / expiry) |
| Legal & data posture | Platform admin, from a reviewed document | `clinical_copilot_provider_posture`, `record_copilot_provider_posture` |
| Synthetic eligibility | Org owner/admin, per subject, with an attestation reference | `clinical_synthetic_eligibility`, `attest_synthetic_subject` |
| Safety core | Deterministic code, identical pre and post | `safety.ts`, asserted by `orchestrator.ts` |
| Retrieval boundary | Governed envelope; citations must be a subset | `retrieval.ts`, `validateCitations` |
| Outbound payload | Whitelist-only minimizer | `data-minimizer.ts` |
| Cost / rate control | Atomic DB reservation under `FOR UPDATE` + CHECK constraints | `reserve_copilot_external_call`, `clinical_copilot_call_budget` |
| Practitioner review | Second-actor approval; drafts and tasks only | `approve_supervised_copilot_run`, `apply_copilot_run_to_*` |
| Emergency shutdown | Org owner/admin kill switch, reason required both ways | `set_copilot_kill_switch` |

Nothing in that table is an environment variable. `deriveApprovalGates`
reads no `process.env` at all, and a unit test sets every plausible
approval-looking variable and asserts not one gate moves.

---

## Data flow and trust boundaries

```
practitioner (browser)
   │  no secret, no ARN, no prompt, no provider response body ever crosses here
   ▼
Next.js server route  ── RLS session ──▶  Supabase staging (urcjiehlxoehievobezf)
   │                                        · governed rows are the authority
   │                                        · evaluate_copilot_staging_gate
   │                                        · reserve_copilot_external_call (atomic)
   │
   ├─ data-minimizer  ── whitelist ──▶ MinimizedEnvelope (no direct identifiers)
   ├─ staging-gate    ── process-side checks the DB cannot make
   ├─ secrets.aws     ── lazy dynamic import ──▶ AWS Secrets Manager (reference → bearer)
   └─ http-transport  ── pinned origin ──▶ https://api.openai.com/v1/responses
```

Three trust boundaries, and what each one refuses:

1. **Browser ↔ server.** The browser never receives a secret, an ARN value,
   an auth header, a prompt, or a provider response body. The governance
   surface reports `hasSecretRef` as a boolean. A browser proof scans the
   rendered page *and* the API response for key, ARN, KMS-URI, SigV4,
   service-role, and system-prompt patterns.
2. **Server ↔ database.** Every write goes through a `SECURITY DEFINER` RPC
   with a pinned empty `search_path`, and every one of them is revoked from
   `PUBLIC` and `anon`. Direct table writes are revoked.
3. **Server ↔ OpenAI.** One pinned origin, redirects refused, hard timeout,
   bounded request and response bytes, content-type validated before
   parsing, strict schema after.

---

## The OpenAI boundary

**Endpoint:** `https://api.openai.com/v1/responses` — pinned as a constant.
No environment variable widens the transport allowlist, and a
caller-supplied base URL is refused by origin *and* path equality.

**Model:** `gpt-5.6-sol`, the exact identifier. Verified against OpenAI's
published model documentation on 2026-08-05: Responses endpoint, structured
outputs supported, 128,000 max output tokens, $5/M input and $30/M output
on the standard tier with a long-context tier above 272K input tokens.

Floating aliases are refused **by name** — `gpt-5.6` resolves to Sol today
and may resolve elsewhere tomorrow, and a run row recording an alias
records nothing durable. `resolveGovernedModel` returns a distinct
`model_is_floating_alias` refusal so an operator is not invited to simply
add it to the list.

**Request contract** `10b2.responses.v1`:

- `text: { format: { type: "json_schema", name, strict: true, schema } }` —
  the Responses API shape. An earlier revision sent the Chat Completions
  `response_format`; it survived review by being unreachable, because
  Phase 10B.1 made no external call.
- `store: false`, unconditional.
- `reasoning: { effort: "low" }` for the reasoning family. **`temperature`
  is not sent** — the reasoning models do not accept the classic sampling
  parameters, and an unsupported parameter is a 400 that would abort a
  governed run for a reason this repository could have avoided.
  Determinism is pursued through a pinned prompt, a strict schema, and a
  fixed effort instead.
- **No** `tools`, `tool_choice`, `parallel_tool_calls`, `attachments`,
  `file_ids`, `background`, `web_search_options`, `modalities`, `include`,
  `previous_response_id`, or `truncation`. They are *absent*, not disabled:
  a field that is never written cannot be switched on by configuration.
  `assertNoToolSurface` is run against the real builder output by a unit
  test, so adding one requires deleting an assertion.

**Untrusted data.** Every chart field, transcript, document, lab value, and
message in the user payload is quoted third-party material. The system
instruction says so explicitly — and that is defence in depth, not the
defence. The strict output schema, the citation-subset check, and the
deterministic safety core mean a model that ignores the paragraph still
cannot produce an accepted draft that acts on injected text.

**Response validation.** Exact model match (a substituted model fails the
run with `openai_model_substituted`), then strict structural validation
with unknown fields refused, then the citation subset check. One
hallucinated citation fails the **complete** run with `draft: null` — the
orchestrator does not drop the citation and keep the body.

**Telemetry.** `clinical_copilot_external_calls` records run id, provider
request id, model, request-contract version, output-schema version, input
and output tokens, latency, result category, and estimated cost. There is
deliberately **no column** for a prompt, a response, patient data, or
clinical content — a field that does not exist cannot be filled in by a
careless caller, and a SQL assertion proves no such column was added.

---

## "Not used for training" is four different claims

These are routinely conflated, and conflating them is how an organization
comes to believe it has protections it does not have.

| Claim | What it actually means |
| --- | --- |
| **Not used for training** | OpenAI does not train on API data by default. This is the *weakest* of the four and says nothing about retention. |
| **Default retention** | API inputs and outputs are retained for a limited period for abuse monitoring, then deleted. Retained data is accessible to authorized OpenAI staff for that purpose. |
| **Modified Abuse Monitoring (MAM)** | An approved exception that removes or reduces that human-review path. Requires application and approval; not a setting you toggle. |
| **Zero Data Retention (ZDR)** | Requests and responses are not persisted at all. Also requires approval, and is not available for every endpoint or feature. |

`store: false` is **none of these**. It controls whether the response is
retrievable through OpenAI's own API; it is not a retention agreement.

A BAA is a fifth, independent thing: it is the contract that makes PHI
processing permissible at all, and it is what grants MAM/ZDR eligibility.
Having ZDR without a BAA does not make PHI lawful, and having a BAA
without ZDR does not make retention zero.

This is why the posture table stores `baa_status` and `zdr_mam_status`
**separately**, each as `unknown | verified | expired | not_approved`, each
with its own verification date, and why `verified` requires a reviewer
reference that is not a placeholder. `unknown` is rendered as "Not
verified" in slate — not green, not red — because the absence of a review
is not a statement about the agreement.

---

## BAA / HIPAA activation checklist

Every line requires a recorded artifact. None is satisfiable by
configuration.

- [ ] Executed OpenAI BAA, countersigned; reference recorded on the posture row.
- [ ] HIPAA-eligible OpenAI project created; organization and project identifiers recorded.
- [ ] MAM or ZDR approved **for that project**, in writing, with an effective date.
- [ ] Endpoint and model confirmed eligible under that approval.
- [ ] Legal sign-off reference on the activation row.
- [ ] Privacy sign-off reference on the activation row.
- [ ] Clinical sign-off reference on the activation row.
- [ ] Security/infra sign-off reference on the activation row.
- [ ] Organization opt-in recorded (`approved_for_phi`).
- [ ] Data-processing / subprocessor disclosure updated.
- [ ] Incident-response contacts confirmed with the provider.
- [ ] A reviewed migration widening `copilot_activation_environment_values`
      and `copilot_activation_approved_use_values`. **Until that migration
      is written and reviewed, production and patient-data activation
      cannot be reached by writing a row.**

---

## AWS IAM least privilege and secret rotation

The task role needs exactly two actions, on exactly one secret:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadTheOneCopilotSecret",
      "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue"],
      "Resource": "arn:aws:secretsmanager:<region>:<account>:secret:clinical/copilot/openai-*"
    },
    {
      "Sid": "DecryptWithTheSecretsKey",
      "Effect": "Allow",
      "Action": ["kms:Decrypt"],
      "Resource": "arn:aws:kms:<region>:<account>:key/<cmk-id>",
      "Condition": {
        "StringEquals": { "kms:ViaService": "secretsmanager.<region>.amazonaws.com" }
      }
    }
  ]
}
```

No `secretsmanager:*`, no `ListSecrets`, no `PutSecretValue`, no wildcard
resource. The application never writes a secret and never needs to
enumerate them.

**Credentials come from the standard provider chain.** `credentials` is
deliberately absent from the SDK client config: passing it would replace
the chain and exclude SSO, IMDS, ECS task roles, and web identity — the
sources a real deployment should prefer over a static env key. The
environment supplies a **region only**.

**Rotation.** The resolver caches a bearer in bounded server memory with a
short TTL (5 minutes, 32 entries max) and drops a stale entry *before*
refetching, so a failed refresh can never fall back to a revoked bearer.
Rotation is therefore: rotate in Secrets Manager, and the fleet picks it up
within one TTL with no deploy. To revoke immediately, engage the kill
switch — it blocks new calls in the same transaction that takes the budget
slot, so it closes the window rather than narrowing it.

---

## Versioning

| Thing | Version | Where recorded |
| --- | --- | --- |
| Request contract | `10b2.responses.v1` | every `clinical_copilot_external_calls` row |
| Output schema | `copilot_output_v1` | every run row and every telemetry row |
| Prompt | carried on the envelope as `promptVersion` | run row |
| Rule set | carried on the envelope as `ruleSetVersion` | run row |
| Model | exact id, e.g. `gpt-5.6-sol` | run row and telemetry row |

Bump the request-contract version whenever the body shape, the system
instruction, or the schema changes. A past run must be reproducible from
its record, not from whatever the source says today.

---

## Incident response

**Suspected prompt injection, data leak, or runaway cost:**

1. **Engage the kill switch** — Settings → Security & Governance → Provider
   activation. A reason is required. New calls stop immediately; historical
   runs are untouched by design.
2. Read `clinical_copilot_external_calls` for the affected window: result
   categories, token counts, latencies, provider request ids. There is no
   prompt or response content there, by design — take the provider request
   ids to OpenAI support if content is needed.
3. Read `clinical_copilot_activation_history` for who changed what, when,
   and why. It is append-only and enforced by trigger.
4. If a credential is suspected compromised, rotate in Secrets Manager
   **and** keep the kill switch engaged until the TTL has passed.
5. Revoke the provider (`revoke_copilot_provider`) if the provider itself
   is implicated — it cascades every organization's activation to `revoked`.

**Rollback.** Set the activation scope back to `environment='unset'`,
`approved_use='none'` with a reason. This is a scope change, recorded in
history; it is not a deletion.

**Provider outage.** The transport fails closed with a PHI-safe category
(`transport_timeout`, `transport_network`, …), the run records
`unavailable`, and nothing is fabricated in its place. **There is no
fallback from a failed live call to the fixture** — that path does not
exist, and a unit test asserts the refusal rather than a degraded answer.

**Cost monitoring.** `used_calls`, `used_input_tokens + used_output_tokens`,
and `used_cost_cents` are on `clinical_copilot_call_budget` and rendered on
the governance surface. Three CHECK constraints make overshoot impossible
even by direct `UPDATE`.

---

## Production prerequisites

Beyond the BAA checklist above:

1. A new, empty production Supabase project — migrations only, no seed
   import, no restore of a staging snapshot. See
   `docs/deployment-verification.md`.
2. A production AWS account with its own secret, its own CMK, and the
   least-privilege role above.
3. A reviewed migration widening the two CHECK constraints. This is the
   deliberate speed bump.
4. Supervised-run policy carried over from 10B.1: the first N runs per
   organization require second-actor approval before any draft action.
5. Alerting on `result_category <> 'completed'` rate and on budget
   consumption.
6. A rehearsed kill-switch drill with a named owner and an out-of-band
   contact path.

---

## What was actually exercised versus only implemented

**Exercised, end to end:**

- Explicit synthetic attestation, including the refusal to infer synthetic
  status from a name, an MRN, or an id shape (SQL B2.7 — a patient literally
  named "Synthetic Subject" with MRN `B2-SYN` is **not** eligible without an
  attestation row).
- Activation scope, including the structural refusal of `production` and
  `patient_data` both through the RPC and through a direct `UPDATE`.
- The kill switch, in both directions, with a reason required both ways,
  through the RPC and through the real UI.
- Atomic budget reservation, the call cap, double-settle refusal, and the
  CHECK constraints that hold even against a direct `UPDATE`.
- Honest legal posture: `unknown` by default, `verified` refused without a
  dated reviewer reference, a secret pasted into the OpenAI organization
  field refused.
- Append-only activation history.
- Cross-tenant refusal on gate evaluation, governance read, and kill switch.
- The request builder's Responses-API shape, `store: false`, absent tool
  surface, floating-alias refusal, and exact-model response validation —
  against injected deterministic transports.
- The governance surface and the patient-facing phase statement, in a real
  browser.

**Implemented but NOT exercised against the real provider:**

- A real OpenAI HTTPS request. **Zero were made.**
- A real AWS Secrets Manager lookup. **Zero were made.**
- The ten synthetic clinical scenarios (normal drafting, insufficient
  evidence, urgent red flags, pediatric/pregnancy, allergy/contraindication,
  duplicate ingredients, missing interaction review, prompt injection,
  hallucinated citations, provider failure). The **deterministic** halves of
  these are covered by `adversarial-matrix.test.ts` and the citation and
  schema tests; what remains unexercised is specifically *how the real
  model behaves* on them, which cannot be known without a credential.

---

## Unavailable prerequisites

Checked by **presence only** — no secret value was requested, printed, or
logged:

| Prerequisite | State |
| --- | --- |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` | absent |
| `AWS_PROFILE`, `AWS_ROLE_ARN`, `AWS_WEB_IDENTITY_TOKEN_FILE` | absent |
| `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` | absent |
| `AWS_REGION` / `CLINICAL_COPILOT_AWS_REGION` | absent |
| `~/.aws/config`, `~/.aws/credentials`, `aws` CLI | absent |
| `CLINICAL_COPILOT_OPENAI_SECRET_ARN` | absent |

### What an operator must supply

Names and settings only. **Do not paste any secret value into a chat, a
terminal, a commit, or an issue.**

1. **AWS region** — set `CLINICAL_COPILOT_AWS_REGION` (or `AWS_REGION`) on
   the server runtime. This is not a secret.
2. **An IAM role** for the server runtime with exactly the two-statement
   policy above, delivered through the provider chain (task role, IRSA, or
   SSO for local work). Not a static key.
3. **A Secrets Manager secret** whose value is either an opaque OpenAI
   bearer or a JSON object with only `apiKey`, `organization`, `project`.
   Any other field is refused.
4. **The secret's ARN**, recorded on the registry row via
   `register_copilot_provider` — the ARN, never the value. A CHECK
   constraint refuses a secret-shaped string in that column.
5. **Posture review**, recorded via `record_copilot_provider_posture` with a
   real reviewer reference and dates.
6. **Activation scope**, set via `set_copilot_activation_scope` to
   `environment='staging'`, `approved_use='synthetic_staging_verification'`,
   `approved_model='gpt-5.6-sol'`, with an expiry.
7. **A budget**, set via `set_copilot_call_budget` — the phase caps are 10
   calls, 50,000 tokens, 500 cents.
8. **A synthetic attestation** for each subject, via
   `attest_synthetic_subject` with a real attestation reference.
9. **A kill-switch drill** within 30 minutes of the run, because
   `evaluateStagingGate` refuses a control nobody has pulled.

With those in place the bounded verification can run. Until then it is
recorded as **NOT RUN**, which is the honest state.
