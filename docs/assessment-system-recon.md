# Assessment system recon — verified findings and dispositions

Scope: `HolisticDrBright/rork-ai-longevity-coach` (mobile + tRPC backend) and
`HolisticDrBright/AI_DESKTOP_PRO` (practitioner platform, clinical database).
Each finding below was verified directly in code before any change was made;
"Fixed by" states where the remediation lives.

## 1. Symptom counts presented as disease risk percentages — VERIFIED

`insights.tsx` rendered "XX% risk" per condition and the webhook sent
`moldRisk`, `lymeRisk`, etc., all computed purely from symptom self-ratings.
A questionnaire cannot measure disease risk, only symptom patterns.

**Fixed by:** "symptom-pattern screening score" language end-to-end
(registry `clinicalLanguage`, insights bands Elevated / Moderate / Below
threshold / Needs more answers, webhook v2 `categoryScores[].band`), with the
disclaimer that no diagnosis is made. Legacy field names survive only inside
the webhook's `legacyV1` compatibility block.

## 2. Unanswered questions scored as zero — VERIFIED

The legacy formula divided the raw sum by the full category maximum
(10 questions × 4), so skipped questions silently deflated scores: answering
6 of 10 questions "severe" produced 60%, not 100%, and an almost-empty
category looked "low risk" instead of "unknown".

**Fixed by:** scoring.v2 — denominator is 4 × ANSWERED questions;
`not_applicable` / `unsure` / `prefer_not_to_answer` are excluded from BOTH
numerator and denominator; below a 0.5 completeness floor the category
reports `insufficient_data` with a **null** score. The legacy formula is
retained only as `legacyScoreV1` to reproduce historical results.

## 3. Webhook conflated categories with labs — VERIFIED

`assessment_complete` v1 sent CATEGORY ids (e.g. `mold`, `thyroid`) under the
key `recommendedLabs`; downstream consumers could not distinguish "elevated
category" from "recommended lab panel", and no versions travelled with the
event.

**Fixed by:** payloadVersion 2 — `elevatedCategoryIds`,
`moderateOrHigherCategoryIds`, and `recommendedLabIds` (registry LAB ids) are
separate, correctly named fields; `questionnaireVersion`, `scoringVersion`,
`ruleVersion`, `registryVersion`, `contentHash`, and
`reviewState: 'pending_practitioner_review'` travel with every event. The v1
shape (including its bug) is preserved verbatim in `legacyV1` for existing
consumers during migration.

## 4. Hardcoded lab mappings with patient-tappable order links — VERIFIED

`insights.tsx` carried a hardcoded category→panel map with storefront links a
patient could open directly (`Linking.openURL`), presenting draft ideas as
orderable actions.

**Fixed by:** deterministic, versioned category→lab rules in the registry
(`rules.v1`, with `legacyAliasId` preserving the old panel aliases); lab
cards are static draft candidates labeled for practitioner review; order
links live in the registry with `reviewStatus: 'unreviewed'` and are never
rendered as patient-executable actions.

## 5. Hardcoded supplement lists in AI prompts, no output validation — VERIFIED

`LabsProvider.tsx` embedded product lists in two prompt strings and attached
affiliate links to WHATEVER the model returned (`findAffiliateLink` falls
back to a default store for any unrecognized name) — an invented product
would have rendered as purchasable.

**Fixed by:** prompt catalog blocks generated from the registry
(`buildSupplementCatalogPromptBlock`); AI output post-validated
(`validateSupplementSuggestions`) — validated items keep canonical registry
identity; unverified items are labeled, carry no product identity and no
purchase link; herbs (no registry coverage) are advisory-only text.

## 6. Two divergent supplement sources — VERIFIED

The structured catalog (`curatedProducts.ts`, 8 products) and the AI prompt
list (15 products; the multi-image variant had only 14) disagreed on
membership and on one product's name. Details and the owner decision list are
in `docs/supplement-reconciliation.md`.

**Fixed by:** single registry (`supp.v1`, 15 products, provenance recorded
per product); both prompts generated from it; authoritative list NOT found,
so ALL products are `pending_verification` and blocked from approved
protocols by the database.

## 7. Desktop /assessments was a placeholder — VERIFIED

The desktop route existed but showed placeholder content; results arriving
via webhook had no practitioner workspace (no per-lab decisions, no protocol
drafting, no review history).

**Fixed by:** the assessments workspace in `AI_DESKTOP_PRO` (library /
assignments / results with completeness + provenance, per-lab
why/approve/modify/dismiss/request-data actions, protocol drafts with full
fields and version history), backed by migration
`20260720000027_assessments_clinical_registry.sql`.

## 8. No content governance — VERIFIED

Questionnaire, scoring, lab rules, and supplement lists had no versions, no
hashes, no author/reviewer trail, and submissions were mutable client state;
nothing prevented content drift between mobile and any future consumer.

**Fixed by:** versioned registry (`q.v1`, `scoring.v2`, `rules.v1`,
`supp.v1`, `registry.v1`) with a pinned sha256 asserted by tests in BOTH
repos over byte-identical copies; `assessment_definitions` row in the
clinical database pins the same hash and `submit_assessment` verifies it;
submissions are immutable (database trigger — only the review triple may
change, no deletes); all writes go through SECURITY DEFINER RPCs with
org/patient authorization, idempotency keys, and append-only audit events.

## Cross-cutting invariants now enforced

- Question IDs: all 150 legacy ids preserved verbatim (test-asserted).
- 25 / 50 banding boundaries use UNROUNDED percentages (golden fixtures at
  22.5 / 25 / 27.5 / 47.5 / 50 in both repos).
- No unapproved product can enter an APPROVED protocol (DB trigger + RPC +
  registry helpers; zero products are approved today).
- Patients cannot approve, decide, or mutate submitted evaluations (RLS +
  RPC role checks; SQL tests cover the refusals).
