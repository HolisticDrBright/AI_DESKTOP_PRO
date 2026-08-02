# Phase 9D — initial practitioner-content import and curation review

Phase 9C built the machinery: local-only parsers, the governed import
pipeline, and the Import Review Workspace. Phase 9D put real practitioner
material through it, then extended the parser where the material demanded
it, and repaired the Windows-side test failure that surfaced on the way.

**Outcome so far:** after the operator's explicit no-PHI attestation,
eight preview batches now exist in the governed pipeline — all
`status=preview`, none committed, none applied. The RPC's classifier
reports 941 new items, 38 intra-file conflicts, 49 `suspected_restricted`
name-based signals across the eight batches. The catalog review queue,
the protocol product picker, and the provenance surface all show zero
imported records — commit is a separate step nobody has taken.

## History

- **First attempt** — session executed in a remote Linux container, no
  filesystem mount, all eight sources unavailable. Inventory recorded
  eight `unavailable` rows.
- **Second attempt (same day)** — same environment, same result;
  `last_checked_at` bumped.
- **Third attempt** — session running locally on the operator's Windows
  workstation. All eight authorized paths resolved on the first check;
  0 PHI/credential trips; inventory rows moved to `available` with real
  hashes and byte sizes; local envelopes produced.
- **Fourth attempt** — extended the parser to cover the real column
  headers and DOCX structural patterns the operator's files actually
  use, fixed the Node 24 Windows worker teardown, re-ran the full
  battery in both spec orders, produced the pre-import report and
  stopped at the attestation checkpoint.
- **Fifth attempt (this record)** — the operator attested no PHI in
  writing, signed in as `p2.staging` in a dedicated Edge browser
  launched with `--remote-debugging-port=9222`, and this session
  attached Playwright over CDP to that existing browser. The eight
  previews ran under p2's httpOnly session via `/api/live/knowledge/*`
  — no admin, no service role, no cookie was read/logged/persisted.
  All eight batches are `preview`. No commit.

## Ground rules

- **Only explicitly authorized sources.** The eight file locations
  supplied by the operator are the only paths this session read. No
  Obsidian vault crawl, no directory search.
- **Sources are never altered**, and nothing raw ever reaches Git: no
  documents, no spreadsheet values, no private paths, no affiliate
  credentials, no copied protocol text. File identity in this repository
  and in PR text is by sha256 hash and declared *name* only.
- **Refusal over redaction.** A source containing patient identifiers,
  credentials, unsafe document structure, or exceeding parsing limits
  is refused and reported. It is not "cleaned".
- **Drafts only.** Nothing imported in this phase may be published,
  selectable, attachable, sold, delivered, or visible to the copilot.
  Restricted content (peptide, prescription, IV, device,
  jurisdiction-sensitive, vaccine-related) lands `restricted_review`.
- **The operator makes the no-PHI attestation, not this session.** The
  `preview_knowledge_import` RPC requires `attests_no_phi = true` from
  a signed-in practitioner. That gate is the point — a machine cannot
  self-attest — so this session runs the automated scan, reports the
  result, and stops at a pre-import report until the operator attests
  in the workspace.

## Parser extensions

### Reviewed synonyms — `src/server/import/normalize.ts`

`COLUMN_SYNONYMS` picked up the header names the operator's material
actually uses:

- `supplement` → `name`, `company` → `brand` (Affiliate Links.xlsx)
- `product type`, `type` → `category` (Skincare DB)
- `code` → `discountCode` (commercial data; NEVER `sku`)
- `bestFor` for a "Best for" column
- `link` continues to map to `sourceUrl` under the acceptable-URL check

The affiliate-links `Code` column is deliberately its own field: a
discount code and a product SKU are different facts, and letting one
masquerade as the other is how a coupon ends up on a protocol.

### Reference-sheet mode

Four of the eight spreadsheets are not product catalogs — they are
lab-interpretation and intervention-reference sheets. A new
`REFERENCE_ROW_SYNONYMS` map recognises columns like `Metabolite`,
`SNP`, `Nutrient`, `Compound`, `Biomarker`, `Intervention`,
`Mechanism`, `Suggested Dose`, `Supplements`, `Additional Lab Testing`,
`Clinical Pearl`, and `Lifestyle Recommendations`.

A sheet is EITHER a catalog OR a reference, never both. If the header
row carries a product-name column the sheet is a catalog (as before);
otherwise, if it carries at least two reference columns, every row
lands as `knowledge_reference` with the subject label as identity.
Suggested-dose text is preserved as reference metadata; the standing
rule "a dose requires an exact product label" is unchanged and the
payload carries no governed `dose` or `servingSize` field for these
rows.

### DOCX section detection beyond `Heading 1-9`

Three of the eight files are .docx documents whose sections are marked
by formatting (bold, `Chapter N:`, `Prompt:`) rather than by Word
heading styles. `parseDocx` now emits per-paragraph `boldRun`,
`tableIndex`, `tableRowIndex`, `tableCellIndex`, and `styleId`.
`normalizeProtocolDocument` detects section boundaries in this order,
first match wins:

1. `Heading 1-9` style (explicit author intent, as before).
2. `^Chapter\s+[0-9IVX]+[:.–—-]?\s+` / `^Section…` / `^Part…`.
3. `^\d+\)\s+` numbered list prefix on a standalone line.
4. `<= 80` character paragraph ending in `:` — a label line.
5. `<= 120` character paragraph whose every visible run is bold.

The decision reason is recorded on each section (`detectionReason`) so
a reviewer sees WHY the parser split there. Format decides WHERE a
section begins; it never decides what the section CLAIMS. Format-based
heuristics only apply outside tables — a bold table-header cell must
not become its own section.

### Tables become row-level references

Each non-header table row becomes a `knowledge_reference` with
`tableIndex`, `tableRowIndex`, and any recognised reference columns
mapped. If the first row aligns with reference synonyms it is treated
as headers; otherwise every cell is kept under a `col1..colN` label so
a reviewer can still recover the raw content. A dose text captured
this way emits a per-item warning: it is reference metadata, not a
governed dose.

## Source access

`private-import/` still contains only the tracked README and
`manifest.example.json`; the operator's sources stay on their local
OneDrive. A git-ignored `private-import/manifest.json` was created for
this session listing the eight authorized locations (verified ignored
by `.gitignore:47`; `git status --porcelain private-import/` prints
nothing).

All eight files were read locally, hashed, and passed through the
extended parser + PHI/credential scan. Inventory rows are `available`
with real sha256 + byte size.

| Declared name                                                       | Kind                | Status                                              | sha256 prefix    | Bytes     |
| ---                                                                 | ---                 | ---                                                 | ---              | ---       |
| Longevity_Skincare_AI_Product_Database_v2.xlsx                      | product_spreadsheet | available                                           | `59688ec233a4…`  | 29,539    |
| Affiliate Links.xlsx                                                | product_spreadsheet | available                                           | `a1a1f646f203…`  | 19,795    |
| Organic Acid Interpretation with Recommendations.xlsx               | product_spreadsheet | available                                           | `f19e943a3930…`  | 31,479    |
| Oxidative Stress SNPs and Interventions.xlsx                        | product_spreadsheet | available                                           | `689e35d48581…`  | 1,344,983 |
| Supplement Protocols.docx                                           | protocol_document   | available                                           | `c135689f6ec2…`  | 32,881    |
| MRNA Vax Injury- Therapies based on Mechanism and Phenotype.xlsx    | product_spreadsheet | available (restricted_review on stage — vaccine)    | `034e65126d67…`  | 117,002   |
| The Mold Recovery Manual.docx                                       | protocol_document   | available                                           | `5e4182a2b913…`  | 70,650    |
| Longevity and Peptide Program.docx                                  | protocol_document   | available (restricted_review on stage — peptide)    | `c0b721af9fa7…`  | 42,837    |

## Safety scan

Zero files tripped any refusal pattern: SSN, credit card, US phone with
area code, `Name <email@…>` pair, `MRN` token, `DOB` / `Date of
Birth`, Windows `C:\Users\…` path, AWS access-key ID (`AKIA…`),
`Bearer` token, `sk-…` API key, JWT-shaped string (`eyJhbG…`). The
parser's container-safety refusals (DOCTYPE / ENTITY, macros, embedded
objects, ZIP traversal, ZIP64 bombs, oversize) never fired either;
every file is a well-formed OOXML container within the
25 MB / 5000-row / 128-column / 32-sheet limits.

## Per-source dispositions

Every source row/section is one of five things — imported cleanly,
deferred with a warning for the reviewer, restricted for clinician
review, conflicted (only at preview time — 0 here), or ignored (no
identifying value).

| Source                                                              | imported | deferred | restricted | ignored | Notes                                                                                                                |
| ---                                                                 | ---:     | ---:     | ---:       | ---:    | ---                                                                                                                  |
| Longevity_Skincare_AI_Product_Database_v2.xlsx                      | 63       | 0        | 18         | 4       | Products; 10 unmapped columns kept in `sourceRaw` (Priority, Routine Slot, Verification Level, etc.). 18 rows tripped `peptide` or `device` signals. |
| Affiliate Links.xlsx                                                | 85       | 0        | 6          | 0       | Products with commercial fields; the `Code` column routes to `discountCode`. Six rows tripped `peptide` or `vaccine_related` signals. |
| Organic Acid Interpretation with Recommendations.xlsx               | 103      | 0        | 0          | 0       | REFERENCE sheets across six named topic areas; each row lands with metabolite as subject and no dose claim on the payload. |
| Oxidative Stress SNPs and Interventions.xlsx                        | 24       | 16       | 0          | 2       | REFERENCE sheets; 16 rows carry a `suggestedDose` text preserved as reference metadata, with a per-item warning that dose text is not a governed claim. |
| Supplement Protocols.docx                                           | 52       | 14       | 2          | 3       | Numbered/label/bold sections captured; two paragraphs tripped `peptide` signals. |
| MRNA Vax Injury- Therapies based on Mechanism and Phenotype.xlsx    | 0        | 0        | 365        | 0       | Whole file is `restricted_review` on stage — vaccine-related declaration; every row inherits it. Table rows within phenotype sheets carry dose-text metadata. |
| The Mold Recovery Manual.docx                                       | 104      | 18       | 6          | 533     | Detection reasons split between `label:colon`, `bold:short`, and `numbered:chapter`. 533 empty section labels reflect the doc's structure (many bold subheadings with no body between). |
| Longevity and Peptide Program.docx                                  | 0        | 0        | 103        | 52      | Whole file is `restricted_review` on stage — peptide-program declaration. |
| **Totals**                                                          | **431**  | **48**   | **500**    | **594** |                                                                                                                     |

## Pipeline staging — preview batches created under p2's session

The operator attested no PHI in writing, signed into a dedicated Edge
browser at `--remote-debugging-port=9222` as
`p2.staging@brightlongevity.test`, and the session driver attached
Playwright over CDP to that browser and called the app's own
`/api/live/knowledge/*` endpoints — each request carried p2's httpOnly
session cookie automatically. No cookie was read, logged, or
persisted, and no admin/service-role connection was used for any
`preview_knowledge_import` call.

| Step                                                                | State                                                                                     |
| ---                                                                 | ---                                                                                       |
| Source inventory declared with hashes and byte sizes                | 8/8 available                                                                             |
| Local envelopes produced for operator review                        | 8/8 written (git-ignored `private-import/staged-envelopes/*.envelope.json`)               |
| Automated PHI/credential/private-path scan                          | 0 refusals across 8 files                                                                 |
| Aggregate pre-import report                                         | `private-import/pre-import-report.md` (git-ignored)                                       |
| Governed preview batch created (`preview_knowledge_import`)         | **8/8, all `status=preview`**                                                             |
| Batch items applied to `supplement_products` (draft)                | 0                                                                                         |
| Provenance rows written                                             | 0                                                                                         |
| Products in the catalog review queue                                | 0                                                                                         |
| Products returned by protocol product picker for "youth reset"/"peptide" | 0                                                                                    |
| Anything approved, activated, attached, ordered, messaged, synced   | 0                                                                                         |

### Aggregate results from the eight previews (as the RPC classified them)

| Source                                                              | added | conflicts | ambiguous | restricted | missingFacts | changeKind |
| ---                                                                 | ---:  | ---:      | ---:      | ---:       | ---:         | ---        |
| Longevity_Skincare_AI_Product_Database_v2.xlsx                      | 81    | 0         | 0         | 10         | 81           | all `add`  |
| Affiliate Links.xlsx                                                | 91    | 0         | 0         | 0          | 91           | all `add`  |
| Organic Acid Interpretation with Recommendations.xlsx               | 103   | 0         | 0         | 0          | 0            | all `add`  |
| Oxidative Stress SNPs and Interventions.xlsx                        | 40    | 0         | 0         | 0          | 0            | all `add`  |
| Supplement Protocols.docx                                           | 40    | 28        | 0         | 0          | 0            | 40 add + 28 conflict |
| MRNA Vax Injury- Therapies based on Mechanism and Phenotype.xlsx    | 364   | 1         | 0         | 35         | 0            | 364 add + 1 conflict |
| The Mold Recovery Manual.docx                                       | 124   | 4         | 0         | 0          | 0            | 124 add + 4 conflict |
| Longevity and Peptide Program.docx                                  | 98    | 5         | 0         | 4          | 0            | 98 add + 5 conflict |
| **Totals**                                                          | **941** | **38**  | **0**     | **49**     | **172**      |            |

Notes on interpretation:

- **All 49 `restricted` are `suspected_restricted`** — a text signal on a
  name/heading, not a declared regulatory class or route. Per the Phase 9C
  inference boundary this cannot grant capability, only add review. No
  declared `regulatoryClassification` / `route` / `vaccineRelated` values
  were present on any row in the incoming payloads, so the classifier
  raised no authoritative flag.
- **The 38 conflicts** are intra-batch identity collisions (two rows/
  sections in the same file claiming the same identity), predominantly
  duplicate section titles in the docx files. `commit_knowledge_import`
  refuses while any conflict is unresolved.
- **The 172 missing facts** are on `catalog_product` rows (Skincare DB
  and Affiliate Links). They record which of `dose form`, `serving size`,
  `ingredient amounts and units`, and `regulatory classification` the
  source did not supply, per the "unknown stays Unknown" rule. Every
  such product will land `incomplete` on commit.
- **Reference-mode sheets** (Organic Acid, Oxidative Stress, MRNA Vax,
  and each of the three docx documents) produce `knowledge_reference`
  items, which do not carry the product-facts audit and do not appear in
  the catalog review queue.
- **Ambiguous = 0** because no similar-product prior state exists yet
  in this staging org; ambiguity emerges on subsequent imports that
  look like near-duplicates of already-present products.

The commit path is deliberately still the operator's next click after
per-batch conflict resolution.

## Windows Node 24 teardown fix

`scripts/sync/worker.mjs` used `process.exit(code)` after its cycle
finished. On Node 24 Windows this races the runtime's async-handle
teardown and fires `!(handle->flags & UV_HANDLE_CLOSING)` at
`src\win\async.c:94`, producing an abnormal exit code the E2E test
compared to 0. Reproducible with `node --version` = 24 and the same
worker env vars; not reproducible on Node 22 (the CI baseline) and not
on Linux.

The honest fix is not to force exit at all: set `process.exitCode =
code` and let Node drain its event loop. The worker's cycle output is
unchanged and both Node 22 and Node 24 now exit cleanly in ~0.2 s.

Two smaller Windows fixes to `scripts/check-e2e-order-independence.mjs`:

- `execFileSync("npx", …)` cannot launch `npx.cmd` on Windows. The
  driver now spawns `process.execPath` on the JS entry points
  (`node_modules/next/dist/bin/next`,
  `node_modules/@playwright/test/cli.js`) — cross-platform, no shell,
  no Node 24 DEP0190 arg-escape warning.
- `STUB_LOG` was hard-coded to `/tmp/…` which resolves to `C:\tmp\…`
  on Windows and made the driver crash before starting the fixture
  backend. Now `join(tmpdir(), …)`.

One test in `e2e/live-curated-import.spec.ts` (test 17, the
"backend-down is a FAILURE" proof) was hitting a strict-mode two-match
error under Node 24 because Next.js's `__next-route-announcer__` also
carries `role="alert"`. The test now targets the app's error alert by
`data-testid="clinical-error"` (added to `ClinicalError` in
`ClinicalStates.tsx`) and asserts its content — stricter than the
role-based selector, not looser.

## Verification

| Check                                                                              | Result                                                    |
| ---                                                                                | ---                                                       |
| DB acceptance `desktop_curated_import_safety.sql` (rolled back)                    | 45/45                                                     |
| DB regression `desktop_no_demo_catalog_content.sql` (rolled back)                  | 15/15                                                     |
| DB regression `desktop_knowledge_import_graph.sql` (rolled back)                   | 52/52                                                     |
| Unit tests                                                                         | 297/297 (30 files; +9 new parser specs)                   |
| Typecheck / lint                                                                   | clean (one pre-existing stub warning)                     |
| clinical-bundle / mock-imports / stub-reset gates                                  | PASS                                                      |
| E2E order-independence battery on Node 22 (CI baseline), Windows                   | 224 passed in both orders, 0 failed                       |
| E2E order-independence battery on Node 24, Windows                                 | 224 passed in both orders, 0 failed                       |
| Security advisors                                                                  | no new findings (0 ERROR; 233 established security-definer WARNs; 1 pre-existing auth WARN; 3 pre-existing INFO on worker tables); no DDL was applied this phase |
| Secret / PHI / private-path scan of diff                                           | clean                                                     |
| `git status --porcelain private-import/`                                           | empty                                                     |

## Remaining practitioner work

1. On the **Review batch** panel in `/settings/imports`, resolve the
   38 intra-batch conflicts across four batches (28 in Supplement
   Protocols, 5 in Peptide Program, 4 in Mold Recovery, 1 in MRNA
   Vax). `commit_knowledge_import` refuses while any conflict is
   unresolved.
2. Decide whether to keep or cancel each of the eight preview batches
   — the app's cancel path is `knowledge/import-cancel` and requires a
   stated reason.
3. On commit, every row will land as a NON-APPROVED draft. Then work
   the **Catalog review** queue. Suspected-restricted items (10 in
   Skincare DB, 35 in MRNA Vax, 4 in Peptide Program) require
   clinician sign-off; the label-identity gate must be satisfied
   before any imported product can reach an APPROVED protocol.
4. Missing-facts items (81 in Skincare DB, 91 in Affiliate Links) will
   land `incomplete` on commit and cannot become selectable until the
   missing product facts are recorded (dose form, serving size,
   ingredient amounts, regulatory classification).

## Recommended next phase

Once the operator has staged and committed the 8 files, the natural
next phase is a curation pass through the review queue: label-identity
verification for the products, clinician sign-off on restricted rows,
and the first governed protocol drafts that cite the imported reference
rows.
