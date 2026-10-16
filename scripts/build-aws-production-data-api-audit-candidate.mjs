import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProductionFoundation } from "./build-aws-production-foundation.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultSource = resolve(root, "infra/aws-clinical-core/template.json");
const defaultOutput = resolve(root, "dist/aws-clinical-core/production-data-api-audit-candidate.json");

// This is a review-only successor to the exact production foundation, not a
// change to its default deployment artifact. A changed parent needs a new review.
export const reviewedParentSha256 = "a741599b1febd1b8a9d76123ce68bf6c2c162a9412fc5ec7480821710a2d872d";

export function sha256(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function buildDataApiAuditCandidate(productionFoundation) {
  if (sha256(productionFoundation) !== reviewedParentSha256) {
    throw new Error("Production foundation differs from the reviewed audit parent");
  }

  const candidate = structuredClone(productionFoundation);
  const trail = candidate.Resources.AuditTrail.Properties;
  delete trail.EventSelectors;
  trail.AdvancedEventSelectors = [
    {
      Name: "All management events",
      FieldSelectors: [{ Field: "eventCategory", Equals: ["Management"] }],
    },
    {
      Name: "Clinical documents object events",
      FieldSelectors: [
        { Field: "eventCategory", Equals: ["Data"] },
        { Field: "resources.type", Equals: ["AWS::S3::Object"] },
        { Field: "resources.ARN", StartsWith: [{ "Fn::Sub": "${ClinicalDocumentsBucket.Arn}/" }] },
      ],
    },
    {
      Name: "Clinical cluster RDS Data API events",
      FieldSelectors: [
        { Field: "eventCategory", Equals: ["Data"] },
        { Field: "resources.type", Equals: ["AWS::RDS::DBCluster"] },
        { Field: "resources.ARN", Equals: [{ "Fn::GetAtt": ["ClinicalDatabaseCluster", "DBClusterArn"] }] },
      ],
    },
  ];
  return candidate;
}

export function buildFromDisk(sourcePath = defaultSource, outputPath = defaultOutput) {
  const source = JSON.parse(readFileSync(sourcePath, "utf8"));
  const candidate = buildDataApiAuditCandidate(buildProductionFoundation(source));
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(candidate)}\n`);
  return { outputPath, sha256: sha256(candidate) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = buildFromDisk(
    resolve(process.argv[2] ?? defaultSource),
    resolve(process.argv[3] ?? defaultOutput),
  );
  console.log(`${result.outputPath} ${result.sha256}`);
}
