# Phase 10A — Governed Clinical Reasoning + Protocol Copilot foundation

**Base:** post-merge `main` at Phase 9E-A.2 merge SHA `996e996`.
**Branch:** `claude/clinical-runtime-phase10a-governed-copilot`.
**Supabase project:** `urcjiehlxoehievobezf` (staging, synthetic).

## Scope boundary (do NOT cross)

Phase 10A builds governed copilot **infrastructure and deterministic test
implementation only**. It must not:

- Activate production AI, or send staging patient data to any external AI provider.
- Use unverified imported content, commit Phase 9 preview batches, verify
  labels, approve references, or resolve real practitioner conflicts.
- Recommend products from affiliate data.
- Auto-sign notes, auto-order labs, auto-create prescriptions, auto-activate
  protocols, or send patient messages / publish patient-facing content.
- Touch AI Longevity Pro, rork, the demo repository, mobile repositories,
  or another Supabase project.

All Phase 9 staging aggregates preserved:
`8 preview / 32 cancelled / 0 committed / 979 items / 38 conflicts /
506 restricted / 310 warnings / 0 active products / 0 governed_knowledge_references /
0 commercial links / 0 product_label_versions`.

## Ownership map — separation of concerns

Every governed copilot run passes through the same layered pipeline. The
boundary between each layer is enforced by module, by DB privilege, and by
tests.

| Layer | Owns | Never depends on |
|---|---|---|
| **Deterministic invariant safety logic** | Emergency detection, allergy conflict, duplicate ingredients, contraindication check, missing-input flags, restriction gating, staleness detection. Runs pre + post model step. Lens-agnostic. | Selected paradigm/lens, model output, commercial data, affiliate URLs, unverified imports. |
| **Governed knowledge retrieval** | Reads only approved knowledge references (`governed_knowledge_references` where `reviewer_state='approved'`), verified label versions (`product_label_versions` where `status='verified'`), approved protocol templates, approved diet templates, current patient-scoped clinical data. | Commercial data, prices, commissions, suppliers, discount codes, affiliate URLs, marketing descriptions, unverified imports, model priors. |
| **Model-assisted drafting** | Vendor-neutral provider adapter; JSON-schema-validated draft output; version-pinned; server-side only. Bounded IO. | Client bundle, secrets in logs, PHI in logs, prompt/output in logs. Cannot bypass safety core. Cannot override missing-info blockers. |
| **Practitioner review** | Every drafted item is `draft` or `inference`; practitioner accepts / dismisses / requests-info / adds-to-note-draft / adds-to-protocol-draft / creates-task / supersedes. | Auto-insertion into signed notes, auto-activation, auto-ordering, auto-prescribing, auto-billing, auto-publishing. |
| **Protocol persistence** | Draft protocol versions land in the existing `clinical_pathway_versions` chain with the copilot run id as provenance. Activation is a separate governed action. | Automatic activation of a copilot-drafted protocol. |
| **Commercial fulfillment** | Only after a practitioner accepts a drafted product using an exact governed identity, and only via the Phase 9E-A commercial-matching workspace. | Any clinical read path. Prompt/retrieval/ranking layers cannot see commercial data. |
| **Future patient-app delivery** | Nothing lands on the patient app in 10A. Publish is a Phase 10C+ concern. | Copilot drafts, until practitioner signs off through the existing publish workflow. |

## Provider mode (default: disabled)

Three modes on `CLINICAL_COPILOT_MODE`:

- `disabled` (default) — no provider request; every run returns a
  determinstic "unavailable" state that the workspace surfaces honestly.
- `fixture` — deterministic, test-only fixtures. **Refused** in any
  deployed environment (`NEXT_PUBLIC_APP_ENV=production|preview` or
  Vercel `VERCEL_ENV=production|preview`).
- `live` — reserved for Phase 10B; refused in Phase 10A even if set.

The mode is server-side; no API key or provider ever reaches the client
bundle. There is **no fallback** between modes.

## Run model (additive migration)

Recorded in `clinical_copilot_runs` (+ input / output / citation tables).
See the migration for the full field list. Every completed run is
immutable; corrections open a new version. A source change stales the
run automatically — the workspace tells the practitioner rather than
silently recomputing.

## Adversarial acceptance — 25 required cases

See `supabase/tests/desktop_phase10a_copilot_safety.sql` and
`e2e/live-phase10a-copilot.spec.ts`. Every case is deterministic and
must not weaken any existing Phase 9 safeguard.

## Remaining Phase 10B activation requirements

- Legal, privacy, clinical-safety, and infrastructure sign-off on the
  actual provider.
- Bring-your-own-key or governed-key flow, still server-side only.
- Human-in-the-loop review for the first N production runs.
- Explicit `CLINICAL_COPILOT_MODE=live` opt-in per organization with
  audit event; never a global flag.
- Real copilot output evaluated against the same 25 adversarial cases
  plus a separate red-team pass.

Phase 10A does not activate any of the above. The provider is disabled
by default and this PR does not change that default.
