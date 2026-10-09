# Clinical safety regression evidence — September 20, 2026

Offline tooling; nothing is approved, signed, pinned or deployed. The six-phase ledger's
release-qualification item asks that every input marker is represented or explicitly
excluded with a reason, that ranges are sourced and unit and population appropriate, that
dates are trustworthy, that iron and reproductive context exclude unsuitable products, that
counts and purchase links agree, and that knowledge only cites present context. Until now
the only place that requirement appeared was a human-supplied `safetyRegression` approval
consumed by `assessLabRangeActivation`. This tool produces the evidence that approval can
reference, bound to the exact prepared release bytes.

## What it checks

`runClinicalSafetyRegression(preparedRelease, inputs, now)` in
`src/server/clinical-core/clinical-safety-regression.ts` reads a prepared `lab-ranges/2`
release and the regression inputs and reports one row per check:

| Check | Fails when |
| --- | --- |
| `input_markers_represented_or_excluded` | a marker the extraction worker recognizes (`LAB_INPUT_MARKERS`, plus the plausibility-only analytes) has no range and no reviewed exclusion; an exclusion names an unknown marker, is dated in the future, or wholly excludes a marker that is also represented |
| `ranges_sourced_verified_and_dated` | any source verification other than `V`; a verification or review date in the future; a duplicate population band for the same marker, unit and kind; an expired release |
| `units_match_extraction_vocabulary` | a range for an extraction marker uses a unit the worker would not accept for it |
| `required_populations_covered` | a represented functional-target marker lacks a not-pregnant band for a required population (default: adult female and adult male at 40 years) that is not excluded for that population with a reason |
| `catalog_iron_and_reproductive_exclusions` | with a catalog manifest: an auto-selectable product carries iron, a pregnancy or nursing caution, a restriction or a non-open tier; an iron-containing product has neither a contraindication rule nor an iron caution flag |
| `offers_and_counts_agree` | with a catalog manifest: an offer points at a product that is not in the manifest, uses anything but a plain https destination, or allows direct order for a product that does not; declared counts differ from the rows |
| `knowledge_aliases_resolve` | with a reviewed knowledge payload: an entry is not approved or is contested, or none of its aliases resolves to a recognized marker or shipped range |

Catalog and knowledge checks report `not_applicable` when those artifacts are not supplied,
and the report says so. Every report carries `coverage`: `full` only when the inputs declared
`coverage: "full"`, every artifact was supplied and no check was skipped; otherwise `partial`.
A declared full run adds `full_release_inputs_supplied`, which fails for every skipped check,
and `requiredPopulations` may not be empty. `assessLabRangeActivation` blocks a release whose
`safetyRegression` approval does not carry `coverage: "full"`
(`safety_regression_coverage_not_full`), so partial evidence can never qualify a release. The report carries `payloadSha256` (the prepared bytes, the same
value `assessLabRangeActivation` compares) and `evidenceSha256` (the digest of the report
without that field), plus `approvalPerformed: false` and `activationPerformed: false`. Two runs
over the same inputs produce identical bytes.

## Usage

```
npm run build:lab-range-tools
node dist/lab-range-tools/safety-regression.cjs <prepared-release.json> <regression-inputs.json> <new-report.json>
```

`regression-inputs.json` holds `exclusions` (`marker`, `reason`, `reviewedBy`, `reviewedAt`,
optional `populations`), optional non-empty `requiredPopulations`, optional `coverage`
(`partial` by default; `full` for a release-qualifying run), and may name `catalogFile` and
`knowledgeReleaseFile` instead of inlining `catalog` and `knowledgeRelease`. The report is
created exclusively. Exit code 2 means at least one check failed, 1 means the inputs could not
be assessed; failure output never echoes paths or artifact contents.

## Boundary

A passing report is evidence for the safety reviewer, not the approval. The reviewer records
`safetyRegression {status:'approved', approvedBy, approvedAt, payloadSha256, evidenceSha256, coverage}`
with the values printed by the tool; `assessLabRangeActivation` then refuses any release whose
bytes differ. The tool does not read the deployed pipeline, hosted catalog or provider output,
does not judge clinical correctness of a range, and does not replace the physical acceptance
matrix. Today no real release is prepared, so the checks have run only on synthetic fixtures.
