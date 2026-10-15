# Production governed-catalog schema bridge — release blocker

The workforce catalog API is a source candidate, not a deployable production catalog today. The production clinical database and the standalone governed-catalog package have different table and privilege contracts. A current clinic membership check alone does not bridge them.

## Reproduced source facts

- `infra/aws-clinical-core/catalog-migrations/` defines `clinical_reference.product_label_versions` and `clinical_reference.protocol_template_steps`. The existing `aws-governed-catalog-reader.ts` queries those tables directly under `clinical_core_api`.
- The assembled production clinical artifact defines `clinical_reference.product_label_verifications` and `clinical_reference.protocol_template_items` instead. It has no `product_label_versions` table and does not grant the API role direct `SELECT` on `catalog_product_versions`. The production catalog is exposed through separately authorized `clinical_core` functions.
- `catalog-production-schema-compatibility.database.test.ts` applies the real production migration artifact and pins those observations. The reader now checks the standalone schema shape before it can return even an empty production page; an incompatible target returns `catalog_unavailable`, not a false empty catalog.
- The unregistered `workforce-current-membership-context.sql` candidate can resolve an approved workforce subject and clinic in the clinical database. A separate catalog-only database cannot use that function without a reviewed, same-transaction authority design. No cross-database or stale-token shortcut is accepted.

## Required engineering before production catalog activation

1. Choose one authoritative production database and a single documented catalog contract. The recommended route is a reviewed production-clinical projection/RPC over the existing production catalog tables, with current membership and catalog data read in the same transaction. Do not grant broad direct table access to `clinical_core_api` merely to reuse the standalone reader.
2. Map exact reviewed label-version identity, verification, product type/tier/restrictions, commercial offer authority, protocol items and dose provenance to the published API contract. If the production schema cannot represent a field, add a preserving reviewed migration or version the API contract; do not fabricate an ID, label, dose or purchase eligibility.
3. Keep Core education-only offer suppression and all clinical holds independent of the catalog transport. Review the consumer route separately from the workforce route; a workforce membership decision must not be reused as consumer authority.
4. Add a real assembled-schema test with an approved fictional product and two clinics: active member succeeds, removed/suspended/cross-clinic member refuses, in-flight revocation is ordered correctly, and a missing or mismatched schema refuses before any empty success. Then run the same matrix against hosted fictional PostgreSQL, including the exact Lambda/database target.
5. Record the chosen artifact, schema migration hashes, API source hash, deployment target and rollback evidence. Keep the route disabled until those tests, reviewed source data and release approvals exist.

This note is not permission to apply SQL, enable commerce, deploy a catalog route, process PHI or mark any original readiness phase complete.
