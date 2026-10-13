/**
 * Writes the catalog offer coverage report (catalog-offer-coverage/1) for the expanded release built
 * from V2's checked-in governed catalog and candidate packages, through the same builder the importer
 * uses. Reference data only; no network, no database, no AWS.
 *
 *   CLINICAL_CATALOG_ORIGINAL_SOURCE_DIR=…/data/governed-catalog
 *   CLINICAL_CATALOG_ORIGINAL_SOURCE_MANIFEST_SHA256=<sha256 of its manifest.json bytes>
 *   CLINICAL_CATALOG_CANDIDATE_SOURCE_DIR=…/data/new-catalog-candidates
 *   CLINICAL_CATALOG_CANDIDATE_SOURCE_MANIFEST_SHA256=<sha256 of its manifest.json bytes>
 *   CLINICAL_CATALOG_CANDIDATE_APPROVAL=…/data/new-catalog-candidates/catalog-owner-approval.json
 *   CATALOG_COVERAGE_OUTPUT=<file to create>
 */
import { writeFileSync } from "node:fs";
import { loadAndBuildExpandedCatalogRelease } from "../src/server/clinical-core/aws-expanded-catalog-release";
import { loadAndAdaptGovernedCatalogSourcePackage } from "../src/server/clinical-core/aws-governed-catalog-seed-adapter";
import { auditCatalogOfferCoverage } from "../src/server/clinical-core/catalog-offer-coverage";

const env = (name: string) => { const v = process.env[name]; if (!v) throw new Error(`${name} is required`); return v; };
const manifest = loadAndBuildExpandedCatalogRelease({
  originalDirectory: env("CLINICAL_CATALOG_ORIGINAL_SOURCE_DIR"), originalManifestFileSha256: env("CLINICAL_CATALOG_ORIGINAL_SOURCE_MANIFEST_SHA256"),
  candidateDirectory: env("CLINICAL_CATALOG_CANDIDATE_SOURCE_DIR"), candidateManifestFileSha256: env("CLINICAL_CATALOG_CANDIDATE_SOURCE_MANIFEST_SHA256"),
  approvalFile: env("CLINICAL_CATALOG_CANDIDATE_APPROVAL"), targetEnvironment: "synthetic-staging",
});
// The original package on its own: its offers travel in the original release, not the expanded one.
const original = loadAndAdaptGovernedCatalogSourcePackage({ directory: env("CLINICAL_CATALOG_ORIGINAL_SOURCE_DIR"),
  targetEnvironment: "synthetic-staging", expectedManifestFileSha256: env("CLINICAL_CATALOG_ORIGINAL_SOURCE_MANIFEST_SHA256") });
const report = { expandedRelease: auditCatalogOfferCoverage(manifest), originalRelease: auditCatalogOfferCoverage(original) };
writeFileSync(env("CATALOG_COVERAGE_OUTPUT"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
for (const [name, r] of Object.entries(report)) console.log(name, JSON.stringify(r.counts), JSON.stringify(r.held.map(h => [h.authoringId, h.offerStableIds.length, h.consumerActionable])));
