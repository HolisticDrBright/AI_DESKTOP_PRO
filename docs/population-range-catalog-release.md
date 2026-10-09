# Population-aware ranges and catalog-release reconciliation

September 14, 2026. Source engineering, not public/PHI activation.

## Completed in this phase

- Signed `lab-ranges/2` verification and runtime matching support exact calendar age bounds in days/months/years, open/closed endpoints, sex, pregnancy status/trimester, cycle phase, reproductive stage, contraception and assay identity. Month-end anniversaries clamp to the last valid calendar day; no approximate 30-day month is used.
- Missing, invalid, future-dated or incompatible collection context never falls back to today's profile. Overlapping matches refuse to select a winner. Explicit null scope in an approved rule means that dimension is not required; a scoped rule requires known matching data.
- Conventional reference intervals and functional targets are separate kinds. The existing functional-range worker consumes only functional targets. Conventional-library intervals are NOT silently substituted for reported lab reference ranges; a separately labeled presentation path still needs integration.
- Structured lab API and worker accept optional per-observation `collectionContext`; V2's input contract matches it. The existing app does not invent or collect those new fields automatically. Production-owned record persistence, consent-aware collection/editing, verified extraction and historical context hydration still require engineering. Current document-only jobs lacking collection context get no v2 match.
- Source-bound unsigned preparation verifies the pinned manifest/file/row hashes, source type, marker/unit, approval, verification, contested state and hormone activation/parent links. Explicit reviewed numeric mappings must be supplied; text ranges and summaries are not automatically parsed into guessed rules.
- Catalog v1.2.0 serving-size resolutions are reconciled only when exact prior cross-check strings, adopted label values, reviewer/date and the matching hashed catalog decision agree. The original cross-check verdict, evidence hashes and prior values remain in the adapted payload. Physical-label requirements and unrelated conflicts remain.
- Of seven prior cross-check conflict flags, three serving-size flags resolve; four remain. This differs from the three open source-label conflicts because the historical cross-check set is separate. Two of the resolved products still require physical labels.
- New source editions use distinct immutable record versions: 1.2.0 maps to 102000 and the expanded derivative to 102001. Earlier 1.0/1.1 source imports retain their original version behavior. The last decimal digit is reserved for derived editions; supported future source versions fit the existing database cap (major 1–9, minor/patch 0–99). Do not reuse an issued edition for changed content; freeze a new edition and run preflight-conflicts before import. No old row or approval was overwritten.

## Verification

- Desktop: 1,252 unit tests passed, 11 conditional/hosted tests skipped. Actual-source local acceptance separately ran the catalog source and expanded-release checks, including all 847 product rows (137 original + 710 candidates), 98 labels, 95 original offers, 32 templates, 163 steps and 76 unique knowledge sources. The source has 77 source rows; duplicate FDA rows 15 and 73 are retained as provenance on one source.
- V2: 464 tests passed, one hosted test skipped. Both typechecks passed. Desktop lint had no errors and four existing warnings; V2 lint passed.
- One simultaneous full-suite run produced four V2 timeouts (image-parser child processes and a nutrition setup hook). The unchanged full V2 suite passed when rerun alone; no timeout limits were relaxed.
- Lab API/worker, catalog API, production clinical API and V2 patient backend bundles built. Local V2 smoke: healthy process, ordinary routes refused, PHI false. These are NOT AWS deployment, live AI, database import, native layout or physical-device acceptance.

## Unsigned preparation workflow

Run `npm run build:lab-range-tools` in Desktop.

Then run the generated tool with five positional arguments:

`node dist/lab-range-tools/prepare.cjs <source-directory> <source-json-file> <explicit-numeric-mapping-json> <canonical-LF-manifest-sha256> <new-output-file>`

Allowed source files: hormone_population_ranges.json, conventional_intervals.json, functional_statements.json, optimal_ranges.json. Hormone preparation also reads the manifest-pinned optimal_ranges.json parent file. Mappings must already have the precise lab-ranges/2 schema, exact source hashes and review/evidence metadata. Missing evidence, ineligible sources, disputed claims or unsupported structure refuse preparation.

The output is unsigned JSON created exclusively (an existing output file is not overwritten). Review the exact numeric/population/assay mappings, then use the existing authorized Ed25519 signing/deployment process. No key is created or read by this tool. An approval of a text source is not automatically approval of every possible numeric mapping.

## Deployment and remaining commercial engineering

Deploy the compatible lab API/worker before any mobile client starts sending collectionContext or any v2 range release is selected. Keep the old signed release pinned until the new exact candidate has passed synthetic acceptance; do not let release changes alter in-flight jobs.

No real range mappings were approved, signed or activated in this phase. The 70 hormone bands remain source-verification R in the current source snapshot. Pediatric approval updates, source verification and precise mappings must be imported and checked separately.

Before commercial launch, remaining work still includes production-owned lab/document conversion and consent/history hydration; conventional-library presentation; personal plan/intake hydration and conflict replacement; privacy request fulfillment; signed clinical release evaluation; coordinated functional deployments; physical iOS/Android, subscription and restore/abuse/security acceptance. Provider agreements, production email approval, launch age/region/intended-use policy, store/business accounts and physical-device actions are separate owner gates. The apps are not commercially ready merely because these tests pass.
