# Phase 9D — initial practitioner-content import and curation review

Phase 9C built the machinery: local-only parsers, the governed import pipeline,
and the Import Review Workspace. Phase 9D is the first pass at putting real
practitioner material through it.

**Outcome so far:** all eight authorized sources are now reachable and hashed;
the governed source-file inventory holds eight `available` declarations, each
with its real sha256 digest and byte size. The parser produced a reviewable
envelope for every file with **zero PHI/credential scan trips**, and one file
yielded 81 catalog items ready for the operator to preview in the workspace.
The other seven need structural fixes (headings, column names) before the
parser will read items from them — noted per file below. Nothing has been
staged into a governed batch yet; the workspace-side attestation and commit
are the operator's next actions in `/settings/imports`.

## History

- **First attempt** — session executed in a remote Linux container, no
  filesystem mount, all eight sources unavailable. Inventory recorded eight
  `unavailable` rows.
- **Second attempt (same day)** — same environment, same result;
  `last_checked_at` bumped for all eight rows.
- **Third attempt (this record)** — session running locally on the operator's
  Windows workstation. All eight authorized paths resolved on the first
  check; nothing else was crawled. See "Source access" below.

## Ground rules

- **Only explicitly authorized sources.** The eight file locations supplied
  by the operator are the only paths this session read. No Obsidian vault
  crawl, no directory search.
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
- **The operator makes the no-PHI attestation, not this session.** The
  `preview_knowledge_import` RPC requires `attests_no_phi = true` from a
  signed-in practitioner. That gate is the point — a machine cannot
  self-attest — so this session runs the automated scan, reports the result,
  and leaves the batch-creation click to the operator.

## Source access

`private-import/` still contains only the tracked README and
`manifest.example.json`; the actual sources stay on the operator's OneDrive.
A git-ignored `private-import/manifest.json` was created for this session
listing the eight authorized locations (verified ignored by `.gitignore:47`;
`git status --porcelain private-import/` prints nothing).

All eight files were read locally, hashed, and passed through the existing
parser + a PHI/credential scan. The governed inventory rows moved from
`unavailable` to `available` with real digests and byte sizes; the two
restricted-by-default sources retain their subject-matter note in the
per-source record even though they parsed cleanly.

| Declared name | Kind | Status | sha256 prefix | Bytes |
| --- | --- | --- | --- | --- |
| Longevity_Skincare_AI_Product_Database_v2.xlsx | product_spreadsheet | available | `59688ec233a4…` | 29,539 |
| Affiliate Links.xlsx | product_spreadsheet | available | `a1a1f646f203…` | 19,795 |
| Organic Acid Interpretation with Recommendations.xlsx | product_spreadsheet | available | `f19e943a3930…` | 31,479 |
| Oxidative Stress SNPs and Interventions.xlsx | product_spreadsheet | available | `689e35d48581…` | 1,344,983 |
| Supplement Protocols.docx | protocol_document | available | `c135689f6ec2…` | 32,881 |
| MRNA Vax Injury- Therapies based on Mechanism and Phenotype.xlsx | product_spreadsheet | available (restricted_review on stage) | `034e65126d67…` | 117,002 |
| The Mold Recovery Manual.docx | protocol_document | available | `5e4182a2b913…` | 70,650 |
| Longevity and Peptide Program.docx | protocol_document | available (restricted_review on stage) | `c0b721af9fa7…` | 42,837 |

## Local parser scan — safety layer results

Each file was passed through `parseImportFile` (the same code path the
workspace runs) and then through a text scan for PHI, credentials, and
private paths. Envelopes were written to git-ignored
`private-import/staged-envelopes/*.json` for operator review before staging.

**Zero files tripped a PHI/credential/private-path pattern.** The scan
covers SSN, credit-card, US phone with area code, `Name <email@…>` pairs,
`MRN` tokens, `DOB` / `Date of Birth`, `C:\Users\` paths, AWS
access-key IDs, `Bearer` tokens, `sk-…` API keys and JWT-shaped strings.

Container-safety refusals in the parser (DOCTYPE / ENTITY, macros, embedded
objects, path traversal in archive entries, ZIP64 bombs, oversize files)
never fired either; each file is a well-formed OOXML container within the
25 MB / 5000-row / 128-column / 32-sheet limits.

## Per-source parse result

`itemCount` is the number of governed items the parser produced. `skipped`
counts rows/sections the parser refused for the stated reason.

| Source | Items | Skipped | Unmapped columns | Sheets/sections read | Notes |
| --- | --- | --- | --- | --- | --- |
| Longevity_Skincare_AI_Product_Database_v2.xlsx | **81** | 17 | 12 | `Verified_Product_DB`, `Sources` | Restricted signals present: `peptide`, `device` — each affected item lands `restricted_review` |
| Affiliate Links.xlsx | 0 | 91 | 3 (`Best for`, `Company`, `Supplement`) | `Sheet1` | The sheet's product-name column is `Supplement`, which is not in `COLUMN_SYNONYMS.name`; adding it (or supplying a per-file column map) would let 91 rows parse |
| Organic Acid Interpretation with Recommendations.xlsx | 0 | 6 | 0 | (no header row recognised on any sheet) | The header labels don't match any known synonym in the first 25 rows of each sheet |
| Oxidative Stress SNPs and Interventions.xlsx | 0 | 4 | 0 | (no header row recognised on any sheet) | Same shape as above |
| MRNA Vax Injury- Therapies based on Mechanism and Phenotype.xlsx | 0 | 14 | 0 | (no header row recognised on any sheet) | Restricted signal: `vaccine_related` — items will land `restricted_review` once the header mapping is resolved |
| Supplement Protocols.docx | 0 | 1 | — | — | No paragraphs use `Heading 1-9` styles, so no section provenance is available. Add headings in Word or use a mapping pass |
| The Mold Recovery Manual.docx | 0 | 1 | — | — | Same shape as above |
| Longevity and Peptide Program.docx | 0 | 1 | — | — | Same shape; restricted signal: `peptide` |

Aggregate: **8 sources read cleanly, 1 with items (81), 7 that need
structural fixes upstream before the parser produces items.**

## Restricted-content classifier — text signals (non-authoritative)

`suspected_restricted` is a text signal only; per the Phase 9C inference
boundary, a word in prose can add review, never grant a capability or write
a regulatory class. Files carrying restricted signals in this session:

- `Longevity_Skincare_AI_Product_Database_v2.xlsx` — `peptide`, `device`
- `MRNA Vax Injury- Therapies based on Mechanism and Phenotype.xlsx` — `vaccine_related` (also `restrictedByDefault: true`)
- `Longevity and Peptide Program.docx` — `peptide` (also `restrictedByDefault: true`)

## Pipeline staging — what has and has not happened

| Step | State |
| --- | --- |
| Source inventory declared with hashes and byte sizes | 8/8 available |
| Local envelopes produced for operator review | 8/8 written (git-ignored) |
| PHI/credential scan | 0 refusals |
| Governed batch created (`preview_knowledge_import`) | 0 — awaits operator |
| Batch items applied to `supplement_products` (draft) | 0 |
| Provenance rows written | 0 |
| Anything approved, activated, attached, ordered, messaged, or synced | 0 |

The batch-creation click is deliberately the operator's: the RPC requires
`attests_no_phi = true` from a signed-in practitioner, and the workspace
runs the same parser this session ran, over the same bytes, producing the
same envelopes.

## Part 7 — clinical-safety proofs

Confirmed directly against staging:

| Claim | Evidence |
| --- | --- |
| No governed import batch exists | `clinical_knowledge_import_batches` count = 0 |
| No governed import item exists | `clinical_knowledge_import_items` count = 0 |
| No provenance row exists | `clinical_import_provenance` count = 0 |
| No product carries import provenance | `distinct pv.ref_id where ref_type = 'catalog_product'` = 0 |
| Inventory holds exactly 8 rows, all `available` with real digests | 8 available, 0 unavailable |

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
| DB regression `desktop_knowledge_import_graph.sql` (rolled back) | 52/52 |
| Unit tests | 288/288 (30 files) |
| Typecheck / lint | clean (one pre-existing stub warning) |
| clinical-bundle / mock-imports / stub-reset gates | PASS |
| Phase 9C curated-import browser proofs, in isolation | 20/20 |
| E2E order-independence battery (forward + reverse, self-provisioned, Windows) | forward 206 passed / 1 failed / 12 skipped; reverse identical; the single failing test is order-independent |
| Security advisors | no new findings (233 security-definer WARNs = established pattern; 1 pre-existing auth WARN; 3 pre-existing INFO on worker tables); no DDL was applied this phase |
| Secret/PHI/private-path scan over the diff | clean |
| `git status --porcelain private-import/` | empty |

Two Windows-specific bugs in `scripts/check-e2e-order-independence.mjs` were
fixed as part of getting the battery to run at all on the operator's
workstation: `execFileSync("npx", ...)` needs `shell: process.platform ===
"win32"` to find `npx.cmd`, and `STUB_LOG` was hard-coded to `/tmp/…` which
resolves to `C:\tmp\…` on Windows. Both are transport-layer fixes, not test
weakenings.

The single failing test — `live-sync-worker.spec.ts:188 "queued means queued
until the REAL worker runs"` — is a Node 24 + Windows libuv assertion
(`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c,
line 94`) that fires as `scripts/sync/worker.mjs` exits AFTER completing its
cycle successfully. The worker logs `event: cycle_completed` and prints its
fixture identification banner exactly as the test expects, then trips the
assertion during handle teardown, producing an abnormal exit code the test
compares to 0. Reproducible standalone with the same env vars and Node 24; not
touched by any of this phase's changes; not seen on the Linux CI environment
where the last phase run recorded 224/0/0. Left as-is rather than skipped on
Windows, because a `test.skip(process.platform === 'win32', …)` would hide the
real Node 24 libuv issue from anyone who runs the battery locally.

## Remaining practitioner work

Because the batch-creation click is intentionally the operator's, and
because most of the source files need structural fixes before the parser
will read items from them:

1. Extend `COLUMN_SYNONYMS` in `src/server/import/normalize.ts` to cover
   the practitioner's own header conventions (or add a per-file
   `columnMap` route through `parseImportFile`), so the six spreadsheets
   with unmapped or missing headers produce items. Priority is
   `Affiliate Links.xlsx` (`Supplement` → `name`) since it will otherwise
   route to zero commercial rows.
2. Add proper `Heading 1-9` styles to the three protocol .docx files so
   each section carries provenance. Body-text-only paragraphs currently
   produce zero references.
3. Sign into `/settings/imports` and, for each of the eight files:
   confirm the parse report, check the no-PHI attestation, and stage.
   The workspace runs the same parser this session ran; envelopes in
   `private-import/staged-envelopes/*.json` are the exact previews the
   operator will see.
4. Resolve any conflicts/ambiguities on the **Review batch** tab and
   commit. Everything lands non-approved.
5. Work the **Catalog review** queue. Peptide, vaccine-related, and
   device-tagged items require clinician sign-off; label-identity
   verification is required before any imported product reaches an
   APPROVED protocol.
6. Copy the current manifest into `docs/` if an auditable record of the
   run is wanted; the provenance ledger records the rest.

## Recommended next phase

Depends on whether the operator prefers to (a) unblock full parsing across
all eight sources by extending the synonym map and adding docx headings,
then run the workspace-side staging in one pass, or (b) stage the one file
that already parses (the Skincare DB), work its catalog-review queue end to
end as a rehearsal, and only then broaden. Either is defensible; the
rehearsal path surfaces the review-queue ergonomics against real content
before the queue gets large.
