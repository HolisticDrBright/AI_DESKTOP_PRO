# Phase 9A — governed nutrition planning

Assessment → versioned diet template → personalised patient plan → safety
review → approve → activate → instructions → adherence → revise, with history
that revision cannot overwrite.

This document states what the system guarantees, where each guarantee is
enforced, and — as plainly as possible — what has **not** been proven.

## What has not run

- **No real Passio API request has ever been executed by this build.** The
  provider boundary is disabled by default and, unconfigured, contacts nothing.
  `hasExecutedLiveRequest()` reports the difference between *configured* and
  *transacted*, and the template library screen shows both facts separately, so
  no screen can imply the integration is proven when nothing has been sent.
- **No governed nutrition reference set is loaded.** Every starter template is
  therefore graded `practitioner_experience`, and none is presented as
  evidence-based. The database agrees: publishing a version graded
  `governed_reference` without an actual reference row is refused.
- **No drug–nutrient interaction reference exists in this build.** The safety
  evaluator therefore raises a review prompt naming the count of recorded
  medications; it never asserts that an interaction exists.
- **The nutrition copilot is disabled by default** and has no model behind it
  when enabled — see *Copilot* below.

## The gate

A plan version cannot be approved unless:

1. safety has actually been **evaluated** for that version, and
2. no flag with severity `blocking` is still `open` **or merely
   `acknowledged`**.

Both checks live in `approve_nutrition_plan_version`, a SECURITY DEFINER
function with a pinned empty `search_path`. A client that never renders the
safety screen still cannot approve. Acknowledging a blocking flag is
deliberately *not* the same as deciding about it — only an override carrying a
reason, or a resolution, clears the way, and an override records the reason,
the person and the time together or not at all.

## Immutability, and what it is for

| Artefact | Frozen when | What may still change |
| --- | --- | --- |
| Template version | `published`, `superseded`, `archived` | status onward only |
| Plan version | `approved`, `active`, `paused`, `completed`, `discontinued`, `superseded` | lifecycle stamps only |
| Content rows (phases, food rules, meal days, meals, items, recipes, grocery) | owner is frozen | nothing — insert, update and delete all refused |
| Assessment constraints | owning version is frozen | nothing |
| Events, amendments, provenance | always | nothing; append-only |

The freeze covers **INSERT** as well as UPDATE and DELETE. Without that, an
approved plan could still *gain* an instruction after approval, which is the
same failure wearing a different hat.

`revise_nutrition_plan_version` copies an approved or active version into a new
draft and touches the original not at all — not its content, not its approver,
not its timestamps. The plan a patient was actually handed stays readable
exactly as it was.

## The template is not the plan

A patient plan **snapshots** the template it came from. It records
`source_template_id`, `source_template_version_id`, a name and version snapshot,
and `detached_at`. Editing that template afterwards never alters a plan the
patient already has. This is why the template library can be maintained freely
without a change quietly propagating into delivered care.

Only a **published** template version may start a patient plan; a draft has not
been through review, and a plan built from one would inherit that.

## One active plan per patient

Enforced by a partial unique index on `nutrition_plans (organization_id,
patient_id) where status = 'active'` — storage, not application logic.
Activating a version supersedes any other live plan for that patient rather
than racing the index, and resuming a paused plan into a patient who has since
been given another live plan is refused in the phase's own words.

## Units are never implied

- Energy targets carry an explicit `kcal` / `kJ` unit; a value without one is
  refused at the route (so the practitioner reads a sentence) and at the
  database (so nothing else can bypass it).
- `nutrition_targets.unit` is `NOT NULL`. An unlabelled nutrition number cannot
  reach storage at all.
- Weights carry `kg` / `lb`.
- Provider nutrient values are stored with `nutrient_source`, so a Passio figure
  is never presented as the practice's own measurement.
- On screen, a target that was never set reads **"Not set"**, not zero.

## Adherence is reported, never inferred

Every check-in carries a required `source` — `patient_reported`,
`practitioner_recorded`, `imported_device` or `imported_app`. There is no path
that records one with no stated origin.

The adherence summary reports days **covered** and days **missing**, and
averages only the days that exist. A day with no check-in is missing, not zero
adherence: turning silence into a clinical finding is the failure mode this
surface is built to avoid. Two sources on one day still count as one day.

## Safety evaluation — what it will and will not say

Derived automatically:

| Flag | Severity | Basis |
| --- | --- | --- |
| `recorded_allergy` | `blocking` if the allergen appears in food the plan tells the patient to eat, otherwise `review` | chart allergies |
| `medication_food_interaction` | `review` | count of active medications — a prompt, never a finding |
| `missing_demographics` | `review` | absent date of birth or sex |
| `pediatric` | `blocking` | age under 18 |
| `missing_safety_information` | `review` | no constraints recorded |
| `extreme_or_inconsistent_targets` | `blocking` outside 800–5000 kcal; `review` when macros and energy disagree by >25%, or macro percentages miss 100 | arithmetic on entered values |

Everything else — pregnancy, kidney or liver impairment, disordered-eating risk,
deficiency risk, conflicting chart information — is available through
`raise_nutrition_safety_flag`, attributed to whoever raised it. Those are
clinical judgements this build cannot derive honestly, so it does not pretend to.

Re-running the evaluation clears only `open` flags. A decision a practitioner
already recorded is never silently discarded.

## Starter library

Eight patterns, written for this product: Low FODMAP, autoimmune elimination
(AIP-style), GAPS-style staged gut protocol, therapeutic ketogenic,
Mediterranean, lower-carbohydrate, structured elimination/reintroduction, and
anti-inflammatory. Nothing is transcribed from a commercial handout or any other
copyrighted source.

Every one installs with `requires_practitioner_review = true`; the install RPC
refuses one that says otherwise. Each states its caution populations, its
prerequisites, and — the field that matters most — what must be established
before it is used for anyone in particular. Sample days deliberately carry no
energy or macro figures: a number on a generic day reads as a target calculated
for somebody, and targets belong on a patient's plan.

Installation goes through the ordinary governed path (template → version →
content → publish) and is idempotent on a content hash, so re-running it
unchanged reports `unchanged` rather than minting a version that differs in
nothing.

## Passio provider boundary

Disabled by default. `PASSIO_ENABLED`, `PASSIO_LICENSE_KEY` and
`PASSIO_CUSTOMER_ID` are server-only; both credentials are on the
forbidden-in-demo environment list.

- **No fixture fallback.** Unconfigured means an honest `not_configured` state
  and no network call. An invented nutrient value is a clinical hazard, not a
  placeholder.
- **Food terms only.** A query shaped like a record id, an email address, a date
  of birth, or a long number is refused *before* any request is made, so a food
  lookup cannot become a quiet PHI disclosure. Barcodes go through a separate
  capability with its own format check.
- **The licence key travels only to the token endpoint**, never with a data
  request and never in a header on one.
- **Provenance is a response hash**, plus the provider's own timestamp where it
  supplies one. Response bodies are not stored.
- **Image recognition always returns `awaiting_review`.** A photographed meal is
  a suggestion until a human confirms it.
- Missing values come back `null`, never `0` — unknown calories and zero
  calories are different claims.

## Copilot

Draft-only, disabled by default, and **deterministic rather than generative**.
It derives suggestions from a published template and the patient's recorded
constraints; there is no model behind it to invent dietary advice. A fluent
invented food rule is indistinguishable from a real one on screen, and this is
the wrong place to discover that.

Structurally — not by policy — it cannot write, approve, activate, set a
clinical number, or claim evidence: no function in the module has those shapes
and it imports no adapter. An allergy conflict is **raised** with the rule left
in place; a silent removal would hide exactly what the practitioner needs to see.

## Permission matrix

| Action | Requirement |
| --- | --- |
| Read templates, plans, check-ins | authentication + active membership (+ patient access for patient-scoped reads) |
| Author a template or plan, run safety review, record/review a check-in | clinical role — owner, admin or practitioner |
| Approve, activate, publish, resolve a safety flag, change lifecycle | clinical role |

Anonymous callers get `28000`; a wrong tenant or insufficient role gets `42501`;
a missing record `P0002`; invalid input `22023`; a state or concurrency clash
`40001`. No error message carries PHI — the adapter genericises server strings
on purpose, which is why the workspace derives a specific approval-refusal
reason from state it already holds rather than echoing the backend.

## No clinical side effects

Nutrition creates no protocol, supplement, product, program, order, charge,
message, appointment or clinical note. `allergies`, `medications` and
`medication_exposures` are **read** as safety inputs and never written.

## Verification

| Check | Result |
| --- | --- |
| Database acceptance suite (`supabase/tests/desktop_nutrition.sql`) | 44/44 on staging, rolled back |
| Browser proofs (`e2e/live-nutrition.spec.ts`) | 24/24 |
| Full browser battery | 180 passed, 11 skipped, 0 failed |
| Unit suite | 226/226 |
| Typecheck, ESLint | clean |
| Clinical build | succeeds |
| Mock-import gate | PASS — 184 entry files, 321 reachable modules |
| Clinical bundle scan | PASS — 205 client chunks |
| Security advisors | no new class; 27 nutrition entries are all `authenticated_security_definer_function_executable`, the architecture itself |
| Performance advisors | 0 unindexed foreign keys, 0 RLS findings on the new tables |

Two scenarios need a signed-in identity and are therefore proven in the browser
suite rather than in SQL: approval refused before evaluation, and approval
refused while a blocking flag is unresolved.

## Deployment requirements

Nothing beyond the standard clinical Supabase configuration. This phase adds no
worker and no required outbound call. `PASSIO_ENABLED` and
`NUTRITION_COPILOT_ENABLED` are opt-in; leaving them unset is a supported,
fully honest configuration in which food lookup and copilot drafting are simply
unavailable.
