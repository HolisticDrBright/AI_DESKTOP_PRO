# Phase 9E-B — Product Research Handoff, integrity + sanitized pre-import preview

**Status: draft.** Nothing here is imported, verified, activated, or attached to any
patient. Every clinical judgment stays queued for the signed-in practitioner.

## Source package

The handoff package lives on the operator's local disk. Its path is deliberately
not printed here or in any PR. The package is treated as **private, local, draft
research**: never committed to the repo, never copied into Git, never uploaded to
any external AI provider.

The authoritative files audited:

- `handoff-manifest.json`
- `product-label-enrichment.jsonl`
- `commercial-links.jsonl`
- `evidence-sources.jsonl`
- `unresolved-products.xlsx`
- `README.md`
- `work/qa-report.txt`

The `work/*.results.jsonl` files and the build scripts are reproducibility
artefacts, not authoritative inputs — the QA suite already validated them.

## Part 1 — Package integrity

### SHA-256 verification (all 8 hashes recomputed locally)

| File | Match |
|---|---|
| Source: `Affiliate Links.xlsx` | ✅ |
| Source: `Longevity_Skincare_AI_Product_Database_v2.xlsx` | ✅ |
| Output: `product-label-enrichment.xlsx` | ✅ |
| Output: `product-label-enrichment.jsonl` | ✅ |
| Output: `commercial-links.jsonl` | ✅ |
| Output: `evidence-sources.jsonl` | ✅ |
| Output: `unresolved-products.xlsx` | ✅ |
| Output: `README.md` | ✅ |

### JSONL line counts

- Clinical (`product-label-enrichment.jsonl`): **164**
- Commercial (`commercial-links.jsonl`): **172**
- Evidence (`evidence-sources.jsonl`): **433**

All three match the manifest exactly.

### Schema validation

Every clinical row has `product_research_id` matching `^PRH-\d{4}$`, unique across
all 164 records. Every row carries the required `source_file`, `source_sheet`,
`source_row`, `identity_confidence`, `research_status`. Every clinical row is
`clinically_approved: false` and `imported: false`. **0** clinical, commercial,
or evidence records leak an `affiliate_url`, `commercial_url`, `discount_code`,
`price`, or a private Windows path (grep on the JSON body for `C:\Users\Brand`
returned zero hits).

### PHI / credential scan

The naive credit-card-shaped regex flagged 2 records — both are 13-digit UPC
values inside `identifiers` (`PRH-0033`, `PRH-0154`). UPCs pass the mod-10
check by design; no PHI or credit-card material is present. Every other PHI
and credential pattern returned zero hits (`SSN`, `DOB`, `AWS AKIA`,
`Bearer …`, `sk-live/sk-test`, `MRN`).

### QA report cross-check

`work/qa-report.txt` reports 26 PASS, 1 WARN (5 ambiguous records leaving
variant-dependent fields null — informational), 0 FAILURES.

### Aggregate reconciliation (round 2 — operator's checkpoint prompt)

Distinctions the operator asked to be documented explicitly:

- **`unresolved_records: 131` = 123 researched-clinical rows carrying at
  least one `unresolved_reasons` entry + 8 rows skipped without research.**
  Recomputed locally: 123 + 8 = 131. Exact match to the manifest.
- **Product-level source-authority tiers = 106 / 56 / 2** (per-record
  `source_authority_tier` on the 164 researched rows). Sum: 164.
- **Evidence-row source-authority tiers = 170 / 253 / 10** (per-evidence
  `authority_tier` on the 433 evidence records). Sum: 433.
- These two triples are **different entities** (a product vs an evidence
  row) and are never presented as conflicting counts.

### 52 vs 59 reconciliation (documented, not silently chosen)

- **`supplement_facts_complete: 59`** — per-record boolean flag on the JSONL.
  Directly recomputable: 59 rows carry the flag. This is the value the README
  explicitly names as the data-completeness threshold.
- **`records_with_complete_supplement_facts: 52`** — manifest-level aggregate
  that applies additional filters (not directly derivable from the per-record
  fields exposed in the JSONL — the 7-record gap cannot be reproduced from
  `discontinued_flag`, `identity_confidence`, `research_status`,
  `label_verification_candidate`, or `ingredient_amounts_partial` alone).
- **Choice:** the workspace uses the **per-record `supplement_facts_complete`
  flag** as the completeness threshold. Both aggregates remain in the manifest
  unchanged. Neither is preferred silently.

## Part 2 — Import mapping key

**Name is never used.** Mapping priority:

1. `product_research_id` — always unique in the handoff.
2. `source_file` + `source_sheet` + `source_row` — traces back to the exact row
   in the two original spreadsheets (whose SHA-256 hashes are recorded).
3. Exact `identifiers.sku` / `identifiers.upc` / `identifiers.gtin` when
   `identity_confidence='exact'` AND the identifier passes a mod-10 check.

Any probable, ambiguous, unmatched, conflicting, or variant-uncertain record
**never** attaches automatically to a governed product. The `preview` batch
stages every clinical row into `clinical_knowledge_import_items` under
`change_kind='add'` with `status='needs_review'` and the identifier + source
provenance in `payload`. No `applied_ref_type` / `applied_ref_id` is written
until a practitioner reviews and applies the item individually.

### Mapping outcomes (aggregate)

| Outcome | Count |
|---|---|
| Exact identity **with** UPC/GTIN/SKU | 85 |
| Exact identity, no strong identifier | 15 |
| Probable | 40 |
| Ambiguous | 23 |
| Unmatched | 1 |
| **Total** | **164** |

**Rejected / non-applying mappings:**

| Kept unresolved | Count |
|---|---|
| Probable | 40 |
| Ambiguous | 23 |
| Unmatched | 1 |
| Exact-with-no-strong-identifier (pending physical-label + identifier confirmation) | 15 |
| **Total kept unresolved by design** | **79** |

The remaining 85 records land as `exact_identity_with_id` in the preview
but still require practitioner label verification before any product becomes
active, selectable, or attachable.

## Part 3 — Clinical import rules

Every clinical record enters the correct queue. Nothing is calculated, inferred,
normalized, averaged, or filled.

- `clinically_approved: false` — preserved.
- `imported: false` — preserved.
- Null values stay null.
- Printed units and wording are preserved verbatim.
- Identity confidence is preserved.
- Missing fields, conflicting fields, restriction flags, source authority tier,
  retrieval timestamps, label jurisdiction, independent-audit corrections,
  reviewer notes, and unresolved reasons are all preserved.

Not calculated / inferred / filled: dosages, serving sizes, ingredient amounts,
units, percent daily values, warnings, regulatory classifications, SKU or UPC
values, label revisions, clinical eligibility.

### Queues

| Queue | Count |
|---|---|
| Label-verification candidates (exact + complete + conflict-free) | 45 |
| Probable identity | 40 |
| Ambiguous identity | 23 |
| Unmatched | 1 |
| Records with unreconciled conflicts | 51 |
| Records with unresolved reasons | 123 |
| Discontinued (`discontinued_flag=true`) | 18 |

### Restriction categories

| Category | Count |
|---|---|
| `device_or_equipment` | 6 |
| `non_ingestible_household` | 2 |
| `peptide_containing_topical` | 15 |
| `bundle_or_multi_product` | 18 |

### Missing-fact top categories

| Missing | Count |
|---|---|
| `label_revision_date` | 145 |
| `storage` | 135 |
| `allergens` | 120 |
| `regulatory_classification` | 84 |
| `warnings` | 83 |
| `identifiers.gtin` | 81 |
| `identifiers.upc` | 76 |
| `contraindications` | 70 |
| `identifiers.sku` | 61 |
| `package_size` | 55 |

**No record has all four required label facts printed** — the manifest already
reports `records_still_missing_required_label_facts: 164`, i.e. every researched
row is missing at least one required label field.

### Conflict field categories (structured field names only)

51 records carry at least one `conflicting_fields` entry. 23 of those entries
are long-form prose notes describing multi-source conflicts (Marketing copy vs.
printed panel, HTML panel vs. official label image, two label revisions on one
page, etc.) — those are counted here but their text is not printed in this
report. Practitioners will see the full prose in the workspace.

Top structured conflict fields:

- `ingredients` — 10
- `other_ingredients` — 10
- `suggested_use` — 3
- `official_product_name` — 3
- `ingredients.Phosphatidylcholine.amount` — 2
- `servings_per_container` — 2
- `serving_size vs suggested_use` — 2
- `active ingredient naming` — 2

## Part 4 — Evidence limitations

- **433** evidence source records.
- **All 433 are URL-only** with `retrieval_date` metadata.
- **0** have an `archived_sha256`. The `evidence/` folder is empty.
- Manufacturers can change the linked images without changing the URL. These
  URLs are therefore treated as **mutable external sources** — **insufficient
  by themselves for final label verification**.
- No governed label may be approved solely from these URLs.

Authority-tier distribution:

| Tier | Count |
|---|---|
| 1 (official label image/PDF) | 170 |
| 2 (official product page) | 253 |
| 5 (retailer, identity only) | 10 |

**A review task is queued for every candidate requiring** physical-label
confirmation, archived manufacturer label, FDA/regulatory listing, variant
or strength confirmation, or practitioner reconciliation of conflicting
official sources. **This phase does not fetch or archive evidence
automatically.**

## Part 5 — Commercial isolation

`commercial-links.jsonl` will land as a **separate preview batch** with
`commercial_only: true`. Commercial records are structurally excluded from:

- Clinical search ranking.
- Product eligibility.
- Safety classification.
- Evidence grading.
- Protocol selection.
- Interaction review.
- AI retrieval (Phase 10 copilot).
- Copilot prompts.
- Clinical recommendations.

A commercial link is **not attached to a governed product** until (a) a
verified governed product identity exists, (b) an exact `sku`/`upc`/`gtin`
or another approved identifier matches, (c) a practitioner records the
governed commercial-match decision, and (d) the decision carries a reason and
an audit event. A supplied Fullscript or affiliate URL never serves as
clinical evidence.

## Part 6 — Pre-import preview (sanitized, aggregates only)

The exact sanitized preview payload lives at
`.local/prh/preview-report.json` (produced by `scripts/prh/preview.mjs`;
never committed). Aggregate summary here:

- Package hashes: all 8 match.
- Clinical records: **164** | Commercial: **172** | Evidence: **433**.
- Identity: 100 exact / 40 probable / 23 ambiguous / 1 unmatched.
- Candidates: **45** label-verification candidates (identity gate only).
- Unresolved: **123** records with at least one unresolved reason.
- Restrictions: see table above.
- Conflicts: **51** records with at least one conflict; **23** of those carry a
  long-form conflict note.
- Missing facts: see top-10 table above.
- Evidence authority tiers: 170 tier-1 / 253 tier-2 / 10 tier-5.
- Commercial link records: **172** (kept in the commercial namespace).
- Mapping outcomes: 85 exact-with-id / 15 exact-without-id / 40 probable /
  23 ambiguous / 1 unmatched.

**Practitioner attestation checkpoint.** `preview_knowledge_import` requires
a no-PHI attestation. The exact attestation the operator must repeat verbatim
in their signed-in practitioner session:

> "I attest that the Product Research Handoff package I am about to preview
> contains no patient health information, no patient identifiers, and no data
> that could re-identify a patient. It contains only public product-label
> research and public commercial-link data."

The preview itself must execute **under the practitioner's signed-in JWT**,
not through an administrative or service-role connection.

## Part 7 — Curation workspace

`/settings/imports` now carries a **Research handoff** tab that renders
the Product Research Handoff filter surface. Filter chips (17 of them,
matching the operator brief exactly): source_package, Product Research
ID, identity-exact, identity-probable, identity-ambiguous,
identity-unmatched, strong-identifier-present, strong-identifier-absent,
candidate, supplement-facts-complete, missing-facts, conflicting-fields,
restricted, evidence-not-archived, physical-label-required,
commercial-match-pending, audited-sample. Status legend distinguishes six
practitioner-visible statuses: Previewed / Unresolved / Candidate for
review / Practitioner verified / Clinically approved / Commercially
matched — never conflated. Bulk verification / approval / restriction
clearance / commercial attachment / conflict resolution are structurally
refused on this surface.

The tab renders an honest-empty state until a Product Research Handoff
preview batch exists in the org. The next-step wording points at this
document and at the "Read a file" tab where the signed-in practitioner
uploads the package.

## Preview batch verification round 3 — operator reported three uploads

**Operator statement:** "I created three preview batches through the normal
signed-in P2 practitioner UI: `product-label-enrichment.jsonl`,
`commercial-links.jsonl` marked `commercial_only=true`, and
`evidence-sources.jsonl`."

**Verification result on the connected Supabase project (`urcjiehlxoehievobezf`),
read-only via MCP at head `811123a`:**

| Query | Value | Expected if uploads landed |
|---|---|---|
| Batches with `source_kind='research_handoff'` | **0** | ≥ 3 |
| Batches with source filename containing `product-label-enrichment` | **0** | ≥ 1 |
| Batches with source filename containing `commercial-links` | **0** | ≥ 1 |
| Batches with source filename containing `evidence-sources` | **0** | ≥ 1 |
| Batches whose `source_sha256` matches any handoff-manifest hash | **0** | ≥ 1 |
| Batches carrying a `manifest_sha256` | **0** | ≥ 1 |
| Import items created since 2026-08-04 00:00 UTC | **0** | ≥ 164 + 172 + 433 |
| Batches created since 2026-08-04 00:00 UTC | **0** | 3 |
| Latest batch created on this project | **2026-08-02 22:29:02 UTC** | ≥ 2026-08-04 |
| Total preview batches on this project | **8** (unchanged) | 8 + 3 = 11 |
| Total cancelled batches | **32** (unchanged) | 32 |
| Total committed batches | **0** (unchanged) | 0 |

**Every check returns zero.** The most recent batch on the connected staging
project was created on 2026-08-02 22:29 UTC — over 46 hours before the
operator's stated upload. Staging aggregates match the pilot baseline
exactly.

**No batch identifiers can be recorded** because none exist on this project.
Fabricating identifiers would violate the operator's rule against changing
source data and the Phase 9 governance principle that "an empty state and a
failure are different claims" — an empty result on staging is the honest
answer.

### Possible explanations for the operator

The upload was reported but did not reach `urcjiehlxoehievobezf`. Possible
reasons, none actionable from this side:

1. The upload was made to a **different Supabase project**. This session
   is bound to `urcjiehlxoehievobezf` (the AI Desktop Pro clinical staging
   project per CLAUDE.md, the only clinical project).
2. The `preview_knowledge_import` RPC was **refused** (permission-denied,
   RLS, no-PHI attestation flow interrupted, or an error the UI surfaced)
   and no batch was persisted.
3. The `Read a file` tab **parsed the JSONL client-side** but the operator
   did not click through to the persistence step — nothing left the
   browser.
4. The upload path used a different file format than the three
   authoritative JSONL files.
5. The session had no active knowledge-editor membership in the target
   organization, so every write was refused before it touched the batch
   table.

### What the operator can do next to unblock verification

Sign in again, open a fresh preview attempt on the `product-label-enrichment.jsonl`
file only, and — before uploading — capture the exact HTTP request URL and
response status the browser network panel shows for the preview call. If
the request succeeded (HTTP 2xx), the batch id from the response should
match a `clinical_knowledge_import_batches.id` on this project. If the
request failed or was never sent, the browser will show the exact failure
category. Neither piece of evidence needs to include any package content
or session material.

Until at least one Product Research Handoff preview batch is persisted on
this project, the `Research handoff` tab renders its honest-empty state
and the aggregate reconciliation below is limited to the local package
integrity check.

## How to create the preview batch (operator action)

**Only the signed-in practitioner can create the preview batch.** No
administrative, service-role, or forged-JWT path is used. Exact steps:

1. Start the app locally: `APP_EDITION=clinical NEXT_PUBLIC_USE_LIVE_API=true npm run dev`.
2. Open `http://127.0.0.1:3000` and sign in as the P2 knowledge-editor
   practitioner.
3. Navigate to `Settings → Import review → Read a file`.
4. When prompted for the no-PHI attestation, repeat verbatim:

   > *"I attest that the Product Research Handoff package I am about to
   > preview contains no patient health information, no patient
   > identifiers, and no data that could re-identify a patient. It
   > contains only public product-label research and public
   > commercial-link data."*

5. Upload the three authoritative JSONL files from the package
   (`product-label-enrichment.jsonl`, `commercial-links.jsonl`,
   `evidence-sources.jsonl`) as separate previews. The `commercial-links`
   preview is marked `commercial_only=true` at upload.
6. Do **not** run `commit_knowledge_import` or any equivalent commit /
   apply / publish / approve operation.

After the preview is created, the `Research handoff` tab will list the
batches with counts. The operator then narrows to the first bounded
review batch (the 10-record audited sample) via the filter chips.

## Recommended first bounded practitioner-review batch

Prioritized as instructed:

1. The **10-record independent-audit sample** whose 20 corrections have
   already been applied.
2. **Exact-identity + `supplement_facts_complete=true` + no conflicts** —
   the deepest data-completeness subset.
3. **Exact-identity records missing exactly one bounded fact** (e.g. `sku`
   or `upc`) — smallest additional evidence surface.

Explicitly **not** in the first batch: probable / ambiguous / unmatched /
restricted / conflicting-official-source records. Those queue behind the
first batch for a separate practitioner sitting.

## What did not happen

- Nothing was imported.
- No preview batch was committed on staging.
- Nothing became active, selectable, attachable, or recommendable.
- No product-label draft was created, verified, or superseded.
- No knowledge reference was drafted or approved.
- No restriction was cleared, no jurisdictional review recorded.
- No warning was resolved or superseded.
- No commercial link was attached or revoked.
- No protocol, order, charge, message, note, or patient-app event was created.
- The 38 pre-existing conflicts in staging remain unresolved.

## Staging aggregates — unchanged

`8 preview / 32 cancelled / 0 committed / 979 items / 38 conflicts /
506 restricted / 310 warnings / 0 active products / 0 approved refs /
0 commercial links / 0 verified labels / 0 supplement products active /
0 copilot runs`.
