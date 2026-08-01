# Phase 9B — authority and provenance map

Written **before** any migration, as the phase requires. It records what already
exists, who owns it, what must be extended rather than duplicated, and the
defects reconnaissance found.

## 1. What already exists

Row counts are from the confirmed clinical Supabase project at ledger head
`20260801013206`.

### Governed knowledge

| Object | Rows | Owner | Notes |
| --- | --- | --- | --- |
| `clinical_paradigms` | 6 | **platform** (no `organization_id`) | western_conventional, functional, naturopathic, tcm, biohacking, synergistic — exactly the lenses Part 10 names |
| `clinical_domains` | 9 | **platform** | cardiometabolic, endocrine, gastrointestinal, inflammatory_immune, medication_supplement_safety, neurologic, reproductive, sleep, toxicologic_environmental |
| `clinical_knowledge_sources` | 7 | **platform** | code/revision/citation/publisher/release_date/intended_purpose/validation_status/known_limitations/out_of_scope_uses — the registry `differential_questions.knowledge_source_ids` already points at |
| `knowledge_sources` | 0 | ambiguous | a **second, parallel** registry — see defect 1 |
| `evidence_items` | 0 | org | hypothesis-linked evidence with `citation` + `knowledge_ref` free text |
| `differential_questions` | 0 | org | already carries rationale, `distinguishes`, `knowledge_source_ids`, `priority`, `safety_relation`, `answer_type`, `generation_method`, `generation_version`, `dedupe_key` |
| `clinical_hypotheses`, `hypothesis_reviews`, `lens_evaluations`, `lens_safety_blocks` | 0 | org | phase-3 lens engine |
| `safety_rules` | 0 | org | `expression jsonb`, severity, version, source |
| `ingredient_interactions`, `ingredient_evidence` | 0 | platform-ish | keyed by `supplement_ingredients.id` |
| `clinical_knowledge_import_batches` / `_items` | 0 | org | an import pipeline **already exists** for knowledge |

### Product and commerce

| Object | Rows | Owner | Notes |
| --- | --- | --- | --- |
| `product_label_versions` | 0 | org | `product_code`, `version`, `exact_label jsonb`, `label_sha256`, `source_url`, `verified_at/by`, **and `affiliate_url`** — see defect 2 |
| `product_ingredient_amounts` | 0 | org | `product_version_id` → `supplement_ingredients` with amount/unit/form |
| `product_commercial_links` | 0 | org | kind/label/url/**disclosure** — the correct home for affiliate data, already built |
| `products_services` | 0 | org | inventory/billing catalog; **`catalog_product_id` already links inventory → catalog** |
| `inventory_stock`, `inventory_ledger` | 0 | org | phase-8A |

### Protocols

`protocol_templates` → `protocol_versions` → `protocol_phases` / `protocol_items`,
with a complete lifecycle already live: `create_protocol_template`,
`create_protocol_draft`, `save_protocol_draft`, `approve_protocol_template_version`,
`approve_protocol_version`, `activate_protocol_version`, `revise_protocol_version`,
`set_protocol_lifecycle`, `archive_protocol_template`, `search_protocol_catalog`,
`check_protocol_interactions`, `review_protocol_item_interactions`.

`protocol_versions` already has `source_template_id` + `source_template_version`
(the detached-snapshot pattern) and `supersedes_version_id`.
`protocol_items.catalog_product_version_id` is the **protocol → catalog** mapping.

## 2. Ungoverned clinical recommendation reachable from production

**None.** Checked and confirmed:

- `localStorage` is used only for UI preferences (material, atmosphere, scale)
  in `src/lib/providers.tsx`.
- `sessionStorage` in `src/adapters/session-store.ts` caches **audit events**,
  not clinical recommendations.
- 33 `*.mock.ts` adapters exist but the mock-import gate proves none is reachable
  from any of the 184 production entry files (321 reachable modules scanned).
- The clinical bundle scan proves no synthetic identity reaches the 205 client
  chunks.

The one static clinical content set that IS reachable is the Phase 9A starter
diet library — deliberately, as product content, every entry review-gated and
graded `practitioner_experience`.

## 3. Defects reconnaissance found

### Defect 1 — two parallel source registries

`knowledge_sources` and `clinical_knowledge_sources` both exist. The former is
empty, is referenced by nothing, and carries a **`body text`** column intended to
hold source text — which the phase explicitly forbids ("do not store copyrighted
documents or long copied passages"). It also lacks a content hash, DOI/PMID,
supersession relationship, reviewer, and jurisdiction.

**Resolution:** `clinical_knowledge_sources` is the governed registry — it is the
one `differential_questions` already cites. Extend *it* with the Part 4 fields.
Retire `knowledge_sources`, dropping `body` rather than carrying a
copyright-shaped hole forward. It is empty, so nothing is lost.

### CORRECTION — reconnaissance was wrong about `product_label_versions`

The original draft of this map called `product_label_versions` an orphaned
fourth registry and proposed retiring it. **That was wrong**, and acting on it
briefly broke two live RPCs and an existing safety test.

The recon query asked *"what foreign key points at this table?"* and got
nothing back. But the table is reached by **RPC** — `save_product_label_version`
and `verify_product_label_version` — and asserted by the Phase-1 acceptance test
*"verified product label is immutable"*. **Absence of an inbound foreign key is
not absence of a dependent.** Any future reconnaissance in this repository must
check function bodies and test files, not just `pg_constraint`.

The table was restored from its authoritative migration, including its guard
trigger, and the original assertions pass again. Its `affiliate_url` column is a
real defect, but deleting the table does not fix it — the defect is recorded as
**outstanding** below, with the migration path stated.

### CORRECTION — reference immutability was already stronger than assumed

`clinical_knowledge_sources` has carried `private.forbid_mutation` since the
Phase-1 registry: **any** update raises `22023`. Two triggers added early in
this phase to enforce a draft to approved to superseded lifecycle could
therefore never fire. An unreachable trigger reads like a guarantee while being
none, which is worse than not having it.

Resolution: keep the Phase-1 model, which is the better one — a reference row
never changes, and a new edition is a new row (`code` + `revision` already
support that). Lifecycle moved to an append-only state log,
`clinical_knowledge_source_states`, and supersession marks dependent claims
stale on insert rather than on update.

### Defect 2 — commercial data on the clinical record

`product_label_versions.affiliate_url` places affiliate data on the same row as
the clinical label. The phase requires affiliate and commercial data to be
stored separately, and `product_commercial_links` already exists for exactly
that. Co-locating them makes "an affiliate link must never influence clinical
eligibility, ranking, safety, or evidence scoring" a matter of discipline rather
than structure.

**Status: OUTSTANDING.** Not fixed in this phase.

`product_label_versions` cannot simply lose the column, because
`save_product_label_version` accepts an affiliate argument and writes it, and
changing that signature would break the Phase-1 acceptance test. The migration
path, for a later phase:

1. add a `product_label_commercial_links` table keyed to the label version;
2. change `save_product_label_version` to route its affiliate argument there;
3. backfill (currently zero rows), then drop `affiliate_url`;
4. keep the RPC signature stable throughout so no existing test changes.

Meanwhile the catalog spine this phase actually builds on —
`supplement_products` / `supplement_product_versions` — carries **no** commercial
column at all, which the acceptance suite asserts.

### Defect 3 — the label record cannot express a label

`product_label_versions` has `exact_label jsonb` and little else. Part 5 requires
manufacturer, UPC/manufacturer identifier, regulatory classification, serving
size, other ingredients, allergens, directions, warnings, storage, jurisdiction,
label version + verification date, and a verified/incomplete/stale/
discontinued/conflicted state. A free-form JSON blob cannot be queried for
safety, and "unknown" cannot be distinguished from "not recorded".

**Resolution:** add typed columns; keep `exact_label` for the verbatim short
excerpt and structured summary only.

## 4. What is genuinely missing

Not present anywhere and therefore new in this phase:

- structured **claims** linked to exact references
- **lab/assessment suggestion** catalog with rationale, prerequisites,
  limitations and screening/confirmatory/monitoring/exploratory intent
- **interpretation rules** over biomarkers
- **intervention classes**
- the **product import pipeline** (the knowledge importer exists; the product one
  does not)
- the **protocol copilot**
- the remaining **18 clinical domains** from Part 8

## 5. Authority model

| Authority | Scope | Who may write |
| --- | --- | --- |
| **Platform curator** | `clinical_paradigms`, `clinical_domains`, `clinical_knowledge_sources`, governed claims, reference protocol templates, interpretation rules | a platform curator role; no organization may edit |
| **Organization practitioner** | org protocol templates, org product catalog, org safety rules, org questions, patient protocols and plans | owner / admin / practitioner within that organization |
| **Read-only** | platform-governed content is world-readable to authenticated members; organization content is tenant-isolated | membership, plus patient access for patient-scoped rows |

Platform-governed tables have **no `organization_id`**, which is what makes the
distinction structural rather than conventional. Proprietary organization content
carries `organization_id` and is isolated by RLS.

Lifecycle authority, unchanged from the rest of the runtime:

| Transition | Requires |
| --- | --- |
| create / edit draft | author role in the owning scope |
| submit for review | author |
| approve, publish | approver (owner/admin/practitioner; platform curator for governed content) |
| supersede, archive | approver, with a reason |
| any write at all | `auth.uid()`, active membership, tenant agreement |

## 6. Consequences for this phase

1. **Extend, do not duplicate.** `clinical_knowledge_sources`, `clinical_domains`,
   `product_label_versions`, `product_commercial_links`, `protocol_*` and the
   existing import tables are the homes. Three new concept families are added
   (claims, lab suggestions, interpretation rules/intervention classes) because
   nothing today expresses them.
2. **`check_protocol_interactions` is already honest** — it returns
   `not_completed` with a stated reason when the product has no structured
   ingredients, when no medications are recorded, or when medications carry no
   coded identifiers, and it never manufactures a finding. It is extended, not
   replaced.
3. **Nothing needs data migration.** Every table this phase touches is empty
   except `clinical_domains` (9), `clinical_paradigms` (6) and
   `clinical_knowledge_sources` (7), all of which are additive extensions.
