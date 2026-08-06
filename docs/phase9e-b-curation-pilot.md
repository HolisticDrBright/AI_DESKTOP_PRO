# Phase 9E-B — Curation pilot (bounded)

**Base:** post-merge `main` at Phase 9E-A.2 merge SHA `996e996`.

**Branch:** `claude/clinical-runtime-phase9e-b-curation-pilot`.

**Supabase project:** `urcjiehlxoehievobezf` (staging, synthetic).

## Immutable baseline (before any curation)

Aggregates confirmed via authenticated minimum-necessary reads.

| Metric | Value |
|---|---|
| Preview batches | **8** |
| Cancelled batches | **32** |
| Committed batches | **0** |
| Preview items | **979** |
| Conflicts | **38** |
| Restricted items | **506** |
| Warnings | **310** |
| Active supplement products | **0** |
| Governed knowledge references | **0** |
| Restricted-review decisions | **0** |
| Commercial links | **0** |
| Warning resolutions | **0** |
| Product-label versions | **0** |

Every value matches the expected baseline exactly. No governed data has
been mutated.

## Sanitized batch inventory

Source-file names are practitioner-facing labels the practitioner
declared; item counts + conflict counts + restricted counts come from
authenticated aggregates. No raw source text, no per-item content, no
private paths recorded here.

| # | Safe source label | Kind | Items | Conflicts | Restricted | Notes |
|---|---|---|---:|---:|---:|---|
| 1 | Longevity Skincare AI Product Database v2 | product_spreadsheet | 81 | 0 | 20 | catalog-only skincare products; 61 unrestricted |
| 2 | Affiliate Links | product_spreadsheet | 91 | 0 | 6 | commercial-only affiliate mappings |
| 3 | Organic Acid Interpretation with Recommendations | product_spreadsheet | 103 | 0 | 0 | organic acid interpretation references |
| 4 | Oxidative Stress SNPs and Interventions | product_spreadsheet | 40 | 0 | 0 | oxidative-stress genotype/intervention references |
| 5 | The Mold Recovery Manual | protocol_document | 128 | 4 | 6 | mold-recovery protocol content |
| 6 | Supplement Protocols | protocol_document | 68 | 28 | 6 | general supplement protocol content; most conflicts here |
| 7 | Longevity and Peptide Program | protocol_document | 103 | 5 | 103 | ALL restricted (peptide + suspected_restricted) |
| 8 | MRNA Vax Injury Therapies (Mechanism/Phenotype) | product_spreadsheet | 365 | 1 | 365 | ALL restricted (vaccine_related, 82 also suspected_restricted) |

Total: 979 items, 38 conflicts, 506 restricted — matches the ledger
exactly.

### Restricted-flag categories (per batch)

| Batch | Flag | Items |
|---|---|---:|
| Longevity and Peptide Program | peptide | 103 |
| Longevity and Peptide Program | suspected_restricted | 103 |
| Longevity Skincare AI Product Database v2 | suspected_restricted | 20 |
| MRNA Vax Injury Therapies | vaccine_related | 365 |
| MRNA Vax Injury Therapies | suspected_restricted | 82 |
| Affiliate Links | suspected_restricted | 6 |
| Supplement Protocols | suspected_restricted | 6 |
| The Mold Recovery Manual | suspected_restricted | 6 |

### Conflict categories (per batch)

| Batch | Conflict rows | Unique identity collisions |
|---|---:|---:|
| Supplement Protocols | 28 | 2 |
| Longevity and Peptide Program | 5 | 4 |
| The Mold Recovery Manual | 4 | 4 |
| MRNA Vax Injury Therapies | 1 | 1 |

### Missing-fact categories (unrestricted skincare batch)

All 61 unrestricted skincare items are missing all four label-verification
facts:

- ingredient amounts and units
- dose form
- serving size
- regulatory classification

None can be verified without practitioner-supplied facts from a
physical label. All 61 are legitimately in the practitioner decision
queue.

### Candidate-match categories

No item across the 8 preview batches carries `candidate_matches` — the
parser did not surface any governed products that resemble a preview row
without sharing its identity. The ambiguous path is empty, which means
no rows are blocked on identity confirmation from a governed product.

## Proposed review order (with reasons)

The recommended order aligns with the brief's default when the actual
data does not prove a safer order.

1. **Longevity Skincare AI Product Database v2** (61 unrestricted
   product-label candidates). Lowest risk; each is a distinct product
   identity requiring practitioner-supplied label facts. **Start here.**
2. **Affiliate Links** (91 items, 6 restricted). Commercial-only. Must
   never become clinical evidence. Only attach after Longevity Skincare
   labels are verified with a governed identity, then match via the
   commercial matching workspace with an exact SKU/UPC/manufacturer.
3. **Organic Acid Interpretation with Recommendations** (103 items, 0
   restricted). Knowledge-reference domain; graded interpretations
   require citations before approval.
4. **Oxidative Stress SNPs and Interventions** (40 items, 0 restricted).
   Same knowledge-reference domain.
5. **The Mold Recovery Manual** (128 items, 4 conflicts, 6 restricted).
   General supplement-protocol content; conflicts are only 4 across 4
   distinct identities so each is a discrete practitioner decision.
6. **Supplement Protocols** (68 items, 28 conflicts, 6 restricted). 28
   conflicts across only 2 distinct identities — a small number of
   competing protocol rows the practitioner has to reconcile.
7. **Longevity and Peptide Program** (103 items, ALL restricted as
   peptide). Entirely under the 5-outcome restricted review.
8. **MRNA Vax Injury Therapies** (365 items, ALL restricted as
   vaccine_related). Entirely under the 5-outcome restricted review.

**Commercial files must never become clinical evidence sources.** The
Affiliate Links batch is treated as commercial-only throughout.

## Bounded pilot — Longevity Skincare, 10 unrestricted candidates

Selection criteria (all satisfied by the 10 chosen):

- **Unrestricted** (`cardinality(restricted_flags) = 0`)
- No **conflict** (`change_kind != 'conflict'`)
- No **ambiguity** (`change_kind != 'ambiguous'`)
- No **warnings** (`jsonb_array_length(warnings) = 0`)
- `entity_type = 'catalog_product'`
- Not among the categories the brief explicitly excludes (no prescription,
  no peptide, no vaccine injury, no disease-treatment claims, no dosage
  recommendations, no drug interactions, no pregnancy/pediatrics, no
  devices)

The 10 pilot items were queried by opaque UUID only. Their identifiers
were **not** committed to Git. Each has 4 missing label-verification
facts (all four of: ingredient amounts+units, dose form, serving size,
regulatory classification), which is exactly the practitioner-required
input.

### Pilot actions performed

- Enumerated the 10 candidates by opaque id via authenticated reads.
- Confirmed each is a `catalog_product` `add` in `needs_review` state.
- Confirmed each has `restricted_flags = []`, no conflict, no
  ambiguity, no warnings.
- Confirmed each is missing the four required label-verification facts.
- Recorded the missing-fact category set in this document
  (`ingredient amounts and units`, `dose form`, `serving size`,
  `regulatory classification`).

### Pilot actions deliberately NOT performed

- No preview item was resolved, applied, or committed.
- No product-label draft was created, verified, or superseded.
- No knowledge reference was drafted or approved.
- No restriction was cleared, reviewed under 5-outcome workflow, or
  jurisdictionally cleared.
- No warning was resolved, superseded, accepted-risk-marked, or marked
  not-applicable.
- No commercial link was attached or revoked.
- No batch was committed. No bulk operation ran on real preview items.
- No content was published, activated, recommended, or attached to a
  patient.
- No affiliate copy was used as label evidence.
- No fact was inferred from a product name or description.
- No 38 real conflicts were auto-resolved.

## Practitioner decision packet

Every judgment below requires the operator's signed-in session — no
administrative access, no service-role, no MCP write path may make
these calls.

### Pilot batch — Longevity Skincare (10 candidates)

- **Missing label facts by category**: each of the 10 items is missing
  all four of: ingredient amounts and units, dose form, serving size,
  regulatory classification. Complete each label from a physical bottle
  through the Product Label editor at `/settings/imports` → **Product
  labels**.
- **Exact-identity matches available**: none precomputed. Each is a
  distinct dedupe key; practitioner supplies SKU/UPC when entering the
  label facts.
- **Ambiguous matches**: 0. No governed product resembles any of the
  10 without sharing its identity.
- **Records that should remain incomplete**: any of the 10 for which
  the practitioner does not currently hold the physical label. Leave
  as drafts.
- **Records that appear unsuitable for import**: none identified in
  the 10 pilot candidates (all are recognised as `catalog_product`
  with the four expected missing facts).

### Conflicts (all batches, 38 total)

- **28 in Supplement Protocols across 2 identities** — the practitioner
  decides `keep_existing` / `take_incoming` / `skip` per identity via the
  **Conflicts** tab. Restrictions on either row are preserved on every
  outcome.
- **5 in Longevity and Peptide Program across 4 identities**.
- **4 in The Mold Recovery Manual across 4 identities**.
- **1 in MRNA Vax Injury Therapies**.

No conflict is auto-resolved by this pilot.

### Restricted items (506 total) — grouped

- 365 vaccine_related (MRNA Vax Injury Therapies)
- 103 peptide (Longevity and Peptide Program)
- 20 suspected_restricted (Longevity Skincare)
- 82 suspected_restricted (MRNA Vax Injury Therapies)
- 103 suspected_restricted (Longevity and Peptide Program)
- 6 suspected_restricted each (Affiliate Links, Supplement Protocols,
  Mold Recovery Manual)

Each must be reviewed via the **Restricted review** tab under the
governed 5-outcome workflow. None of the five outcomes clears the
restriction — clearance stays a separate governed action.

### Warnings (310 items)

Each of the 310 items with warnings must transition to an explicit
disposition (resolved / superseded / accepted_risk / not_applicable)
via the **Warnings & missing facts** tab. Warnings never disappear.

### Commercial matches

Attachable **only after** the Longevity Skincare labels are verified
with a governed SKU/UPC/manufacturer identifier. Then match via the
**Commercial matching** tab with an exact identifier + supplier
disclosure + reason.

### Recommended next batch

After the Longevity Skincare unrestricted subset (61 candidates) is
worked through, the recommended next batch is **Organic Acid
Interpretation with Recommendations** — 103 items, 0 restricted, 0
conflicts — which lets the practitioner exercise the Knowledge
Reference editor at scale with lowest safety risk.

## Local pilot URL

The local dev server can be started with:

```
APP_EDITION=clinical NEXT_PUBLIC_USE_LIVE_API=true npm run dev
```

and opened at:

```
http://127.0.0.1:3000/settings/imports?tab=warnings
```

for the practitioner to walk the decision queues. The workspace's
Overview tab shows the composite counts + the mandatory-stage pointer.

## Staging counts — after the pilot

Every count identical to the immutable baseline recorded above:

`8 / 32 / 0 / 979 / 38 / 506 / 310 / 0 / 0 / 0 / 0 / 0 / 0`

No governed data was mutated. Every action that would touch a governed
record is queued for the practitioner.

## Defects discovered

None during the pilot. The workspace's minimum-necessary reads worked
as expected and the workflow enforces every mandatory stop.

## Test results

No code was changed during the pilot; the Phase 9E-A.2 CI (which
covers every RPC and every workspace panel) already gates the current
`main`. Focused reruns are unnecessary here.

## Remaining work — not in this PR

- The practitioner walks each queue through the workspace under their
  own signed-in session. That is Phase 9E-B's core deliverable and is
  intentionally outside the scope of this pilot commit.
- Phase 9F and Phase 10 remain unstarted.
