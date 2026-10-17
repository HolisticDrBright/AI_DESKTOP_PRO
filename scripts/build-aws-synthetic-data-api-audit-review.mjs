import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = resolve(root, 'infra/aws-clinical-core/template.json');
const outputPath = resolve(root, 'dist/aws-clinical-core/synthetic-data-api-audit-review.json');

// Current synthetic foundation GetTemplate(Original) matched this checked-in source byte-equivalently
// under canonical JSON on 2026-10-16. A changed parent requires a new live review.
export const reviewedParentSha256 = 'caef0835807f66820b2814aa9314660ba3b9a562591cd6989335118698b1522f';
export const reviewedCandidateSha256 = '371d8136e8e3215707338e3721cefb732d953dac32d05afc36dd90e330ac4152';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function digestTemplate(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

const expectedSelectors = [{
  IncludeManagementEvents: true,
  ReadWriteType: 'All',
  DataResources: [{
    Type: 'AWS::S3::Object',
    Values: [{ 'Fn::Sub': '${ClinicalDocumentsBucket.Arn}/' }],
  }],
}];

export function buildSyntheticDataApiAuditReview(parent, expectedSha256 = reviewedParentSha256) {
  if (digestTemplate(parent) !== expectedSha256) {
    throw new Error('Synthetic foundation is not the exact reviewed parent');
  }
  const trail = parent?.Resources?.AuditTrail;
  if (trail?.Type !== 'AWS::CloudTrail::Trail' ||
      parent?.Resources?.ClinicalDatabaseCluster?.Type !== 'AWS::RDS::DBCluster' ||
      parent?.Resources?.ClinicalDocumentsBucket?.Type !== 'AWS::S3::Bucket' ||
      trail.Properties?.AdvancedEventSelectors !== undefined ||
      JSON.stringify(canonical(trail.Properties?.EventSelectors)) !== JSON.stringify(canonical(expectedSelectors))) {
    throw new Error('Synthetic audit trail is not in the reviewed management-and-documents posture');
  }
  const candidate = structuredClone(parent);
  delete candidate.Resources.AuditTrail.Properties.EventSelectors;
  candidate.Resources.AuditTrail.Properties.AdvancedEventSelectors = [
    {
      Name: 'All management events',
      FieldSelectors: [{ Field: 'eventCategory', Equals: ['Management'] }],
    },
    {
      Name: 'Clinical documents object events',
      FieldSelectors: [
        { Field: 'eventCategory', Equals: ['Data'] },
        { Field: 'resources.type', Equals: ['AWS::S3::Object'] },
        { Field: 'resources.ARN', StartsWith: [{ 'Fn::Sub': '${ClinicalDocumentsBucket.Arn}/' }] },
      ],
    },
    {
      Name: 'Clinical cluster RDS Data API events',
      FieldSelectors: [
        { Field: 'eventCategory', Equals: ['Data'] },
        { Field: 'resources.type', Equals: ['AWS::RDS::DBCluster'] },
        { Field: 'resources.ARN', Equals: [{ 'Fn::GetAtt': ['ClinicalDatabaseCluster', 'DBClusterArn'] }] },
      ],
    },
  ];
  if (expectedSha256 === reviewedParentSha256 && digestTemplate(candidate) !== reviewedCandidateSha256) {
    throw new Error('Synthetic audit review candidate differs from the pinned result');
  }
  return candidate;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== '--build-review-only') {
    console.error('Usage: node scripts/build-aws-synthetic-data-api-audit-review.mjs --build-review-only');
    process.exitCode = 2;
  } else {
    const parent = JSON.parse(readFileSync(sourcePath, 'utf8'));
    const candidate = buildSyntheticDataApiAuditReview(parent);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(candidate)}\n`);
    console.log(JSON.stringify({ outputPath, parentSha256: digestTemplate(parent),
      candidateSha256: digestTemplate(candidate), awsWrites: false, executionAuthorized: false }));
  }
}
