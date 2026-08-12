# Phase 10B.2 — Operator Bootstrap

**Read this if `npm run preflight:copilot` reported anything as
`missing`, `denied`, `expired`, or `misconfigured`.**

Everything below is provisioning an operator does once. Nothing here asks
you to paste a key into a chat, an issue, a commit, or a terminal
argument, and no tool in this repository accepts one that way.

> **The one rule.** There is no environment-variable activation path and no
> local plaintext fallback. `createProductionSecretResolver` returns `null`
> without a region and never reads a key from the environment; the adapter
> refuses when the resolver is null. If you find yourself wanting to set
> `OPENAI_API_KEY`, the answer is that it would not be read.

---

## 0. Current blocker

`npm run preflight:copilot` on this machine reports:

| Check | Status |
| --- | --- |
| `aws.region` | **missing** |
| `aws.credentialSource` | **missing** |
| `aws.secretReference` | **missing** |
| `aws.callerIdentity` | n/a — needs the two above |
| `aws.secretReadable` | n/a — needs the three above |
| `clinical.backend` | **missing** |
| `clinical.stagingPosture` | n/a — needs a backend |

Nothing about a secret was read, printed, or requested to produce that
table. The checks are presence-and-permission only.

---

## 1. AWS — deploy the template

The template is idempotent. Deploy it repeatedly with the same parameters
and nothing changes.

```powershell
aws cloudformation deploy `
  --template-file infra/aws/copilot-staging-secret.yaml `
  --stack-name clinical-copilot-staging `
  --capabilities CAPABILITY_NAMED_IAM `
  --region <your-region> `
  --parameter-overrides `
      Environment=staging `
      SecretName=clinical/copilot/openai-staging `
      ReaderPrincipalArn=<arn-of-your-server-or-sso-role>
```

`ReaderPrincipalArn` may be left blank on the first pass. The role is then
created with a deny-everything trust policy — it exists and is assumable
by nobody, which is the safe default. Re-deploy with the ARN once you know
which principal the server actually runs as.

Read the outputs:

```powershell
aws cloudformation describe-stacks `
  --stack-name clinical-copilot-staging --region <your-region> `
  --query "Stacks[0].Outputs" --output table
```

You need `SecretArn`, `ReaderRoleArn`, and `KmsKeyArn`. None of the three
is a secret; all three are safe to record in a ticket.

### What the template gives you, and why

| Resource | Why it is shaped this way |
| --- | --- |
| Dedicated CMK, rotation enabled | Lets you revoke by disabling **one key**, and makes the `kms:ViaService` condition meaningful |
| Secret container with **no value** | A generated placeholder passes every presence check and fails only at the provider — the worst place to find out |
| `GetSecretValue` on **one ARN** | No wildcard resource anywhere in the policy |
| `kms:Decrypt` conditioned on `ViaService` | The key cannot be used for anything but this secret |
| **Explicit Deny** on `ListSecrets` / `BatchGetSecretValue` | Denied, not merely unlisted, so a broad managed policy attached later cannot re-grant it. The preflight asserts this denial holds and treats "allowed" as a misconfiguration |
| **Explicit Deny** on every write action | The application never writes a secret |
| Resource policy on the secret | Enforced from both sides: an over-broad identity policy elsewhere in the account still cannot read it |
| `DeletionPolicy: Retain` on key and secret | A stack teardown must not silently destroy credential history |

### Console equivalent

If you must click rather than deploy, the exact sequence:

**KMS → Customer managed keys → Create key**
1. Key type **Symmetric**, usage **Encrypt and decrypt** → Next.
2. Alias `clinical-copilot-staging` → Next.
3. Key administrators: your admin role only → Next.
4. Key users: leave **empty** — Secrets Manager is granted through the key policy, not here → Next → Finish.
5. Open the key → **Key policy** → Switch to policy view → add the
   `AllowSecretsManagerUseOfTheKey` statement from the template verbatim.
6. **Key rotation** tab → Enable automatic rotation.

**Secrets Manager → Store a new secret**
1. Secret type **Other type of secret**.
2. **Plaintext** tab. Enter the OpenAI project key — see §2 first.
   (Prefer §3's script over this box: the console puts the value in your
   browser's memory and history.)
3. Encryption key: `alias/clinical-copilot-staging` → Next.
4. Name `clinical/copilot/openai-staging` → Next.
5. Automatic rotation **off** for now; tag `RotationWindowDays=90` and
   `RotationOwner=platform-security` → Next → Store.
6. Copy the **Secret ARN**. This is what you record on the registry row.

**IAM → Roles → Create role**
1. Trusted entity: the principal your server runs as.
2. Skip the permission-policy picker → Next → name
   `clinical-copilot-staging-secret-reader` → Create.
3. Open the role → **Add permissions → Create inline policy → JSON** →
   paste the four statements from the template's
   `read-one-copilot-secret` policy verbatim, substituting your ARNs.
4. Confirm there is **no** `secretsmanager:*` and **no** `Resource: "*"` on
   any Allow statement.

---

## 2. OpenAI — the setup checklist

Every line is required before the gate will run. Record each answer
honestly; `record_copilot_provider_posture` refuses `verified` without a
dated, non-placeholder reviewer reference.

### Project

- [ ] **A dedicated project** for AI Desktop Pro staging. Not the default
      project, not one shared with anything else. Platform → Settings →
      Projects → Create project → `ai-desktop-pro-staging`.
- [ ] **API input/output sharing DISABLED** for that project.
      Project → Settings → Data controls → confirm the project does not
      share API inputs and outputs for model improvement.
      *This is the weakest of the four data claims — see below.*
- [ ] **A project-scoped API key.** Project → API keys → Create → scope it
      to this project only. Not a user key, not an organization-wide key.
      A user key survives the person leaving; a project key does not.
- [ ] **Spending limit** set on the project. Settings → Limits → hard cap.
      The phase caps at $5, so a $10 project cap gives headroom without
      giving room for a runaway.
- [ ] **Rate limit** set on the project, low enough that a loop is
      throttled rather than expensive.
- [ ] **Model allowlisting.** Restrict the project to `gpt-5.6-sol`. The
      application also refuses anything else three separate ways — build
      allowlist, registry row, activation scope — but the provider-side
      restriction is the one that holds if all three are wrong.

### Legal and data posture — record honestly

- [ ] **BAA**: executed and countersigned? → `verified` with the date and a
      document reference. Not executed? → `not_approved`. Nobody has
      checked? → `unknown`. **Leave it `unknown` rather than guessing.**
- [ ] **ZDR or Modified Abuse Monitoring**: approved *for this project*, in
      writing, with an effective date? → `verified`. Otherwise `unknown` or
      `not_approved`.
- [ ] Record the approved organization and project identifiers (these are
      identifiers, not credentials — the schema refuses a key pasted here).

```sql
select public.record_copilot_provider_posture(
  '<provider_id>'::uuid,
  'unknown', null,        -- baa_status, baa_verified_at
  'unknown', null,        -- zdr_mam_status, zdr_mam_verified_at
  '<org-id>', '<project-id>',
  'https://api.openai.com/v1/responses', 'gpt-5.6-sol',
  null);                  -- reviewer_reference
```

> **Do not claim the project is HIPAA-ready.** `store: false` is not a
> retention agreement, "not used for training" is not ZDR, and ZDR without
> a BAA does not make PHI lawful. The four are distinct — the table in
> `docs/phase10b2-staging-activation.md` spells out how — and the UI
> renders `unknown` as "Not verified" in slate precisely so the absence of
> a review never reads as a green light.

---

## 3. Write the key

```powershell
./scripts/bootstrap-copilot-secret.ps1 `
  -SecretId arn:aws:secretsmanager:<region>:<account>:secret:clinical/copilot/openai-staging-XXXXXX `
  -Region <region>
```

It prompts. Input is hidden, not echoed, not logged, not written to disk,
and not placed in PowerShell history. It refuses a key passed as an
argument, and refuses to proceed if the value is too short or contains
whitespace.

Verify without writing:

```powershell
./scripts/bootstrap-copilot-secret.ps1 -SecretId <arn> -Region <region> -Check
```

It reports `present` / `missing` / `denied` / `expired` / `misconfigured`
and the value's shape and length. It never prints the value or any
substring of it.

**Why not `aws secretsmanager put-secret-value --secret-string`:** that
puts the key in `argv`, visible to every other process on the host and to
shell history. The `file://` alternative writes plaintext to disk. The
script uses `AWS.Tools.SecretsManager` so the value is passed in-process
only.

---

## 4. Point the server at staging

```powershell
$env:CLINICAL_COPILOT_AWS_REGION = "<region>"                       # not a secret
$env:CLINICAL_COPILOT_OPENAI_SECRET_ARN = "<the ARN, not the value>" # not a secret
$env:CLINICAL_SUPABASE_URL = "https://urcjiehlxoehievobezf.supabase.co"
$env:CLINICAL_ORG_ID = "<your staging org uuid>"
```

Then:

```powershell
npm run preflight:copilot
```

Every required row must read `present`. `aws.listSecretsDenied` must read
`present`, which means the denial is working — if it reads
`misconfigured`, your policy is too broad; fix it before continuing.

---

## 5. Governed records

Order matters; each step is refused until the previous one holds.

```sql
-- 1. Register the provider. The ARN, never the value.
select public.register_copilot_provider(
  'openai', 'openai_hipaa', '["gpt-5.6-sol"]'::jsonb,
  '<approval-reference>', 'zero', 'platform_governed',
  'us', '<secret-arn>', '<baa-reference-or-null>', null, '<expiry-or-null>');

-- 2. Walk the activation state machine. It refuses skips.
select public.set_copilot_activation_state('<org>'::uuid, '<provider>'::uuid,
  'readiness_review', 'beginning staging readiness');
select public.set_copilot_activation_state('<org>'::uuid, '<provider>'::uuid,
  'approved_for_synthetic', 'approved for synthetic evaluation only');

-- 3. Scope it. `production` and `patient_data` are refused — they are not
--    in the CHECK constraint's value list, by design.
select public.set_copilot_activation_scope('<org>'::uuid, '<provider>'::uuid,
  'staging', 'synthetic_staging_verification', 'gpt-5.6-sol',
  now() + interval '7 days', 'phase 10B.2 verification window');

-- 4. Budget. The phase caps.
select public.set_copilot_call_budget('<org>'::uuid, '<provider>'::uuid,
  'phase10b2', 10, 50000, 500);

-- 5. Attest each subject. A fixture-looking name is NOT sufficient; only
--    this row makes a subject eligible.
select public.attest_synthetic_subject('<org>'::uuid, 'patient',
  '<patient-id>'::uuid, '<attestation-reference>');

-- 6. Drill the kill switch. The gate refuses if it has not been exercised
--    within 30 minutes — a control nobody has pulled is a control nobody
--    knows works.
select public.set_copilot_kill_switch('<org>'::uuid, '<provider>'::uuid, true,  'pre-run drill');
select public.set_copilot_kill_switch('<org>'::uuid, '<provider>'::uuid, false, 'drill complete');

-- 7. Confirm.
select public.evaluate_copilot_staging_gate('<org>'::uuid, '<provider>'::uuid,
  '<patient-id>'::uuid, 'gpt-5.6-sol', 'phase10b2');
```

Step 7 must return `"allowed": true`. If not, `refusal` names the first
failing gate.

---

## 6. Run the gate

```powershell
npm run gate:copilot-synthetic
```

Caps: **10 requests, 50,000 tokens, $5.00**, enforced by the database
under `FOR UPDATE` and by three CHECK constraints that hold even against a
direct `UPDATE`. Retries are disabled for the gate — a retry would consume
a slot a scenario needs.

Ten scenarios, one request each: ordinary draft, insufficient governed
evidence, urgent red flag, pediatric/pregnancy restriction,
allergy/contraindication, duplicate ingredient, incomplete interaction
review, prompt injection embedded in patient content, system-prompt
extraction attempt, hallucinated-citation probe.

Four more are proven **offline** without spending a request — malformed
provider output, model substitution, timeout/refusal, and kill-switch
refusal — because they are decided by our own code before or after the
wire, and injected deterministic transports exercise them far more
thoroughly than one live request could.

Output is counts, categories, token totals, latency ranges, and cost. No
prompt, response, clinical content, patient identifier, secret, or ARN.

---

## 7. Rollback

```powershell
./scripts/copilot-rollback.ps1 -Reason "incident 42 — suspected prompt injection"
```

Kill switch → narrow scope → suspend or revoke → optionally disable the
CMK → rotate the key → collect evidence → release only after review.

**Nothing in it deletes a run, a telemetry row, or a history entry.** An
incident is exactly when that record matters most. The history table
refuses `UPDATE` and `DELETE` by trigger, so the script could not remove
it even if it tried.

---

## What is still not true after all of this

Completing this bootstrap gets you a **bounded synthetic staging
verification**. It does not get you:

- production activation — blocked by a CHECK constraint that omits
  `production`, deliberately requiring a reviewed migration;
- real-patient use — blocked the same way, `patient_data` is absent;
- a HIPAA-ready system — that needs the BAA, the ZDR/MAM approval, and
  every sign-off in the checklist in
  `docs/phase10b2-staging-activation.md`, none of which is a code change.
