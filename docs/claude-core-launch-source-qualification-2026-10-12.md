# Core launch source qualification — Desktop side (2026-10-12)

Source only, paired with V2 `claude/core-launch-source-qualification-20261012`
(`expo/docs/claude-core-launch-source-qualification-2026-10-12.md` there holds the full
source-to-claim inventory, the owner decision packet, the privacy and store trace and the acceptance
matrix). Base: Desktop `494b4eda` (Ask ALP private caller), which descends from `dcccfa84`. No Ask
ALP or care-messaging file was edited. Nothing was deployed or activated, and PHI stays off.

## Fixed (each failed before)

| # | Defect | Fix | Test |
| --- | --- | --- | --- |
| F2 | A low serum iron beside a HIGH ferritin (or a low ferritin beside a high iron or saturation) produced "Iron status support consideration" | iron-panel veto in `buildMeasuredSupplementConsiderations`; rule `iron/2`, ruleset `measured-supplement-considerations/2` | `aws-lab-analysis-worker.test.ts` |
| F3 | Every consideration's claim id read `below-reporting-lab-range`, even for functional-range or HIGH triggers | the claim names its trigger; the original id is unchanged | same |
| F4 | The owned lab worker treated an unset `LAB_RANGE_MODE` as the synthetic fixture (adult test ranges, any age, sex or pregnancy) | `owned-lab-worker-lambda.ts` refuses unless `reviewed_release` | `owned-lab-worker-lambda.test.ts` |
| F5 | `GET /clinical-core/consumer/catalog/products` returned practitioner-only, injectable, peptide and declared-restricted products with their clinical payload | the consumer audience reads only open, unrestricted supplements; the workforce read is unchanged | `aws-governed-catalog-read-integrity.database.test.ts` |

The worker's consideration objects carry `rulesetVersion` / `ruleKey` / `ruleVersion`, and before V2
F1 the V2 contract refused them. **Deploy the worker and V2 F1 together**: until V2 F1 ships, any
completed analysis that has a consideration is refused by V2.

## Found, not changed

These depend on Brandon's release decision or on a contract change. See V2 doc C1–C10.

- **Daily guidance escalates after the model.** It computes urgent escalation after the model call,
  so model actions return alongside `urgent` (`aws-daily-guidance.ts`, synthetic only).
- **Catalog approval is not label-gated**, and destination validation is scheme-only.
- **Owned results are published as `consumer_lab_analysis_unreviewed`.**
- **Production program inventory** takes the dose from the consumer's saved plan, and its over-dosing
  check is ingredient overlap only.
- **Ask ALP production has no deterministic red-flag screen in the Lambda.** It relies on the V2
  server pre-screen.
