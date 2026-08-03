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
- **Fifth attempt** — the operator attested no PHI in writing, signed
  in as `p2.staging` in a dedicated Edge browser launched with
  `--remote-debugging-port=9222`, and this session attached Playwright
  over CDP to that existing browser. The eight previews ran under p2's
  httpOnly session via `/api/live/knowledge/*` — no admin, no service
  role, no cookie was read/logged/persisted. All eight batches were
  `preview`. **The preview surfaced a boundary defect**: 49 restricted
  where 500 were expected, because source-level restriction metadata
  and row-level text signals did not survive parser envelope → preview
  RPC → item review state.
- **Sixth attempt** — cancelled the fifth-round batches and applied
  four additive migrations. The RPC gained
  `source_restricted_flags`/`_reason`/`commercial_only`/`deferred_count`;
  text scan widened; batch dedupe became partial; commit refuses
  commercial-only. Re-preview reported 498 restricted / 310
  deferred / 38 conflicts / 172 missing-facts — but the report's
  aggregate terminology (`added` as the "total") and the
  restriction-count gap surfaced accounting problems the operator
  flagged.
- **Seventh attempt** — cancelled the sixth-round batches with a
  governed reason ("aggregate reconciliation and remaining
  restriction propagation defect"). The driver now injects its own
  text-signal findings into item `payload.restrictedFlags` before
  sending — the RPC's declared branch honors them and no layer can
  suppress an earlier layer. Two additional migrations landed:
  `desktop_import_preview_idempotent_any_active` (idempotent scope
  matches the partial dedupe index) and
  `desktop_import_restricted_flag_scan_exclude_declared` (text scan
  excludes declared-value keys so a declared class does not
  double-flag itself as `suspected_restricted`). Re-preview reports
  979 total / 941 non-conflicted / 38 conflicted / 506 restricted /
  310 parser-deferred / 172 missing-facts. MRNA 365/365 and Peptide
  103/103. No commit.
- **Eighth attempt (this record)** — the seventh-attempt aggregate
  had two count contradictions the operator caught: `restricted ∩
  deferred` was reported as 235 for MRNA (should be 236 including the
  1 conflict), and "48 outside restricted files" was actually 49
  (the raw parser count in commit `e3747e4` covered only 4 files,
  which the 8-file staging changed). Item-level truth was
  re-derived directly from the DB: 979 total, 941 add + 38 conflict,
  506 restricted (365 MRNA + 103 Peptide + 38 row-level), 310
  warning-bearing, 263 restricted∩deferred (236 MRNA + 25 Peptide +
  2 Supplement RDC), 47 warning-bearing-not-restricted, 49
  warning-bearing-in-non-source-restricted-files. Batch history
  reconciled: 32 cancelled across four waves (waves 1–2 of 8 each,
  waves 3a and 3b of 8 each — 16 in wave 3, not 12). The suite gains
  four new intersection invariants (`21–24`) that would have failed
  against the seventh-attempt reporter. No new SQL migration; no
  additional preview; no commit.

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

### Aggregate results from the eight previews (post-reconciliation)

The invariant `total = non-conflicted + conflicted` holds per batch
and in aggregate.

| Source | src_restricted | commercial | total | non-confl | confl | restricted | parser-def | missing-facts |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Longevity_Skincare_AI_Product_Database_v2.xlsx | `{}` | false | 81 | 81 | 0 | 20 | 0 | 81 |
| Affiliate Links.xlsx | `{}` | **true** | 91 | 91 | 0 | 6 | 0 | 91 |
| Organic Acid Interpretation with Recommendations.xlsx | `{}` | false | 103 | 103 | 0 | 0 | 0 | 0 |
| Oxidative Stress SNPs and Interventions.xlsx | `{}` | false | 40 | 40 | 0 | 0 | 16 | 0 |
| Supplement Protocols.docx | `{}` | false | 68 | 40 | 28 | 6 | 15 | 0 |
| MRNA Vax Injury- Therapies…xlsx | `{vaccine_related}` | false | 365 | 364 | 1 | **365** | 236 | 0 |
| The Mold Recovery Manual.docx | `{}` | false | 128 | 124 | 4 | 6 | 18 | 0 |
| Longevity and Peptide Program.docx | `{peptide}` | false | 103 | 98 | 5 | **103** | 25 | 0 |
| **Totals** | — | — | **979** | **941** | **38** | **506** | **310** | **172** |

Notes:

- **All 365 MRNA and all 103 Peptide-Program rows are restricted** —
  the operator's source-level flag is OR-unioned into every item's
  `restricted_flags`. Text signals may ADD `suspected_restricted`;
  they may never remove a declared flag.
- **506 ≥ the 500 target**: monotonic union of client scan + source
  declaration + server text scan. The driver injects its own
  restriction hits into `payload.restrictedFlags` before sending,
  so nothing the driver detects can be lost downstream.
- **310 parser-deferred** — items with `warnings` added by the
  parser (dose text preserved as reference metadata, long-excerpt
  notes). Deferred and restricted are independent axes; both may
  be true for a row. No warning was silently converted.
- **The 38 conflicts** are intra-batch identity collisions.
  Conflicted items REMAIN items — they still carry restrictions,
  are still counted in `total`, and appear in `restricted_count`.
- **The 172 missing facts** are on `catalog_product` rows (Skincare
  DB and Affiliate Links).
- **Affiliate Links limitation.** Batch is `commercial_only = true`;
  commit is refused (SQLSTATE 55000). This org has zero governed
  product identities to attach to via `save_product_label_version`.
  The 91 rows are therefore **unmatched commercial candidates,
  unusable until verified clinical identities exist**. No clinical
  identity may be created from affiliate URLs or commercial claims.

### Migrations applied to close the boundary defect

All additive to staging. No test was weakened.

| Version | Name | What it changes |
| --- | --- | --- |
| `20260802215557` | `desktop_import_source_restriction` | Adds `source_restricted_flags`, `source_restricted_reason`, `commercial_only`, `deferred_count` on `clinical_knowledge_import_batches`. Extends `preview_knowledge_import` to accept and OR-union source-level flags into every item. |
| `20260802220512` | `desktop_import_restricted_flag_full_payload_scan` | Widens `private.import_restricted_flags` to scan the whole payload (not just a hand-listed field set). Vocabulary and outcome unchanged: still emits only `suspected_restricted` from text signals. |
| `20260802220811` | `desktop_import_batch_dedupe_ignores_cancelled` | Replaces the batch dedupe unique index with a partial index `where status <> 'cancelled'`. Cancelled batches remain as audit rows but no longer block re-previews. |
| `20260802221439` | `desktop_import_commit_commercial_guard_repair` | Restores the correct `commit_knowledge_import` body (a placeholder body from the first migration referenced a non-existent helper) and retains the commercial-only entry gate at the top. |
| `20260802223619` | `desktop_import_preview_idempotent_any_active` | Preview idempotency matches the partial-index scope (any non-cancelled batch), matching the original 9C idempotency contract. |
| `20260802224007` | `desktop_import_restricted_flag_scan_exclude_declared` | Text scan reads payload minus declared-value keys (`regulatoryClassification`, `route`, `vaccineRelated`, `restrictedFlags`), so a declared class no longer double-flags itself as `suspected_restricted`. |

New regression suite `supabase/tests/desktop_import_source_restriction.sql`
— **24 checks** (13 original + 7 accounting/monotonicity invariants +
4 intersection invariants added in the eighth attempt). Checks
`21–24` fail against any reporter that (a) skips the
"source-restricted-by-default → restricted=total" identity, (b)
allows a deferred item in a source-restricted file to be missing
its source flag, (c) reports `|R ∩ D|` above `min(R, D)`, or (d)
reports `|R ∩ D|` below the Bonferroni floor `max(0, R + D − N)`.
Rolled back at the end.

Old batches from prior attempts are preserved as an immutable audit
record via `cancel_knowledge_import` with stated reasons. **32
cancelled batches total across four creation waves**: wave 1 at
21:26 UTC (8), wave 2 at 22:03 UTC (8), wave 3a at 22:08 UTC (8),
wave 3b at 22:10 UTC (8). Wave 3 created 16 batches — not the 12
earlier claimed — because two consecutive schema migrations
(`20260802220512`, `20260802220811`, `20260802221439`) landed
between the two sub-waves and each forced a re-preview.

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

| Check | Result |
| --- | --- |
| DB acceptance `desktop_curated_import_safety.sql` (FULL 45, rolled back) | **45/45** |
| DB acceptance `desktop_no_demo_catalog_content.sql` (FULL 15, rolled back) | **15/15** |
| DB acceptance `desktop_knowledge_import_graph.sql` (FULL 52, rolled back) | **52/52** |
| DB acceptance `desktop_import_source_restriction.sql` (13 + 7 + 4 = 24, rolled back) | **24/24** |
| Unit tests | 297/297 (30 files) |
| Typecheck / lint | clean (one pre-existing stub warning) |
| clinical-bundle | PASS (228 client chunks) |
| mock-imports gate | PASS |
| stub-reset gate | PASS |
| E2E order-independence battery on Node 22 (CI baseline), Windows | Reverse-order **224/0/12 clean across all three runs** (deterministic). Forward-order has a **1-test intermittent flake that rotates** between specs: run 1 `live-frontdesk-protocol.spec.ts:123`, run 2 `live-programs.spec.ts:76`, run 3 `live-tasks.spec.ts:480` (multi-org sign-in). All three failing tests are in domains Phase 9D did not touch (scheduling, programs, tasks/multi-org auth). Because the failing test rotates rather than repeats and the same tests pass reliably when the battery runs from a fresh state (reverse order, where they run first), the flake is a Windows-specific timing/resource-pressure issue that pre-dates this branch. **This means the final push does NOT satisfy the operator's "3 consecutive clean forward+reverse on the final tree" requirement locally on Windows.** CI runs on Linux and the flake has not been observed there; the pushed head still needs the CI signal to close the requirement. |
| Security advisors | no new findings (0 ERROR; 233 established security-definer WARNs; 1 pre-existing auth WARN; 3 pre-existing INFO on worker tables) |
| Secret / PHI / private-path scan of diff | clean |
| `git status --porcelain private-import/` | empty |

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
