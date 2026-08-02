# Phase 9D — initial practitioner-content import and curation review

Phase 9C built the machinery: local-only parsers, the governed import pipeline,
and the Import Review Workspace. Phase 9D was the first attempt to put real
practitioner material through it.

**Outcome: no source file was reachable from the execution environment, so no
content was imported and none was invented.** The phase's durable product is
the honest record of that fact — eight `unavailable` declarations in the
governed source-file inventory, each with its reason — plus a re-verified
safety battery over the machinery that will process the files when they exist.

## Phase 9C closed

PR #26 was verified at head `5ae91a9` (CI green on the exact head, zero review
threads, clean tree), marked ready, and merged:

- **Merge SHA: `35c76a142edfcba22ae9713e7e635739c976b390`**
- Post-merge smoke: typecheck clean, lint clean (one pre-existing stub
  warning), units 288/288, clinical-bundle / mock-imports / stub-reset gates
  all PASS.

## Ground rules

- **Only explicitly authorized sources.** The operator supplied eight exact
  file locations; only those exact paths were tested for existence. Nothing
  was crawled or searched for. An Obsidian vault is explicitly out of scope
  until a future manifest names an exact export path.
- **Sources are never altered**, and nothing raw ever reaches Git: no
  documents, no spreadsheet values, no private paths, no affiliate
  credentials, no copied protocol text. File identity in this repository and
  in PR text is by sha256 hash and declared *name* only.
- **Refusal over redaction.** A source containing patient identifiers,
  credentials, unsafe document structure, or exceeding parsing limits is
  refused and reported. It is not "cleaned".
- **Drafts only.** Nothing imported in this phase may be published,
  selectable, attachable, sold, delivered, or visible to the copilot.
  Restricted content (peptide, prescription, IV, device,
  jurisdiction-sensitive, vaccine-related) lands `restricted_review`.

## Part 3 — source access

`private-import/` contained only the tracked README and
`manifest.example.json`; no operator manifest existed. A local
**git-ignored** `private-import/manifest.json` was created (verified ignored
by `.gitignore:47`; `git status --porcelain private-import/` prints nothing)
recording the eight authorized locations and the result of checking each.

The session runs in a remote Linux container. The operator's Windows
workstation filesystem is not mounted (`/mnt/c` does not exist), so every
authorized location was **unavailable**. Only the exact supplied paths were
tested — no directory listing, no search, no Obsidian lookup.

All eight files were declared in the governed staging inventory via
`record_import_source_file` — by **name only**, never path — as
`unavailable`, each with its reason. The two sources whose names indicate
restricted subject matter (the vaccine-related spreadsheet and the peptide
program document) carry an additional note in their reason: when they become
readable, every imported item must land `restricted_review`.

| Declared name | Kind | Status |
| --- | --- | --- |
| Longevity_Skincare_AI_Product_Database_v2.xlsx | product_spreadsheet | unavailable |
| Affiliate Links.xlsx | product_spreadsheet | unavailable |
| Organic Acid Interpretation with Recommendations.xlsx | product_spreadsheet | unavailable |
| Oxidative Stress SNPs and Interventions.xlsx | product_spreadsheet | unavailable |
| Supplement Protocols.docx | protocol_document | unavailable |
| MRNA Vax Injury- Therapies based on Mechanism and Phenotype.xlsx | product_spreadsheet | unavailable (restricted_review on arrival) |
| The Mold Recovery Manual.docx | protocol_document | unavailable |
| Longevity and Peptide Program.docx | protocol_document | unavailable (restricted_review on arrival) |

No sha256 digests exist for any of them — a hash requires reading the file,
and the inventory's own constraint (`cisf_available_is_evidenced`) makes it
impossible to claim `available` without one.

## Part 4 — pre-import privacy and safety scan

Not runnable: a scan reads bytes, and no bytes were readable. Zero sources
were scanned, zero were refused. Nothing was "cleaned", because there was
nothing to clean. The scan obligations (PHI, credentials, macros/embedded
objects, size/compression limits) remain attached to each file for the
session in which it first becomes readable — the parser layer enforces the
structural half of them mechanically regardless.

## Parts 5–6 — import batches and review workflow

Empty by consequence, not by omission:

| Batch | Content | Imported |
| --- | --- | --- |
| A — products + commercial | manufacturers, names/variants, SKU/UPC candidates, label facts, supplier facts, affiliate URLs (commercial model only) | 0 items |
| B — protocol templates (draft-only) | phases, candidate product mappings, diet/lifestyle, monitoring, follow-ups, stopping rules, differentiating questions, lab suggestions | 0 items |
| C — interpretation candidates | biomarker relationships, lab interpretation rules, differentiating questions, monitoring concepts, intervention classes, source references | 0 items |

Nothing was fabricated to fill them. Zero items passed through the Import
Review Workspace because zero items exist; the workspace itself is exercised
end-to-end by the browser proofs below.

## Part 7 — clinical-safety proofs

Confirmed directly against staging after the inventory declarations:

| Claim | Evidence |
| --- | --- |
| No import batch exists | `clinical_knowledge_import_batches` count = 0 |
| No import item exists | `clinical_knowledge_import_items` count = 0 |
| No provenance row exists | `clinical_import_provenance` count = 0 |
| No product carries import provenance | provenance-joined `supplement_products` count = 0 |
| Inventory holds exactly the 8 declarations | 8 `unavailable`, 0 `available` |

Nothing was auto-published, nothing is selectable or attachable, no dose
exists, no affiliate link entered any payload, no restricted item is visible
anywhere, no lab order / plan change / invoice / cart / message / note /
sync event was created, and the copilot remains disabled with nothing new to
read. The mechanisms enforcing each of these are asserted by the 45-check
acceptance suite and the 20 browser proofs re-run below.

## Part 8 — verification

| Check | Result |
| --- | --- |
| DB acceptance `desktop_curated_import_safety.sql` (rolled back, staging) | 45/45 |
| DB regression `desktop_no_demo_catalog_content.sql` (rolled back) | 15/15 |
| Unit tests | 288/288 (30 files) |
| Typecheck / lint | clean (one pre-existing stub warning) |
| clinical-bundle / mock-imports / stub-reset gates | PASS |
| E2E battery (forward + reverse, self-provisioned) | 224 passed in both orders, 0 failed |
| Security advisors | no new findings (233 security-definer WARNs = established pattern; 1 pre-existing auth WARN; 3 pre-existing INFO on worker tables); no DDL was applied this phase |
| Secret/PHI/private-path scan over the diff | clean |
| `git status --porcelain private-import/` | empty |

No real staging import ran, because no source file was available; staging
import content is empty and says so.

## Remaining practitioner work

1. Run a session on a machine that can read the eight files (or copy them
   into `private-import/` on one that can).
2. Complete `private-import/manifest.json` with real hashes and per-file
   attestations.
3. Declare, scan, parse, stage, review, and commit each file through the
   Import Review Workspace — drafts only, exactly as the Phase 9C operator
   steps describe.
4. Clinician review of everything that lands `restricted_review`, plus
   jurisdiction review before any restricted item goes further.

## Recommended next phase

Run the actual import from an environment with file access (a desktop
session), then a curation phase working the review queue: label-identity
verification for products, citation sourcing for Batch C candidates, and the
first clinician sign-offs.
