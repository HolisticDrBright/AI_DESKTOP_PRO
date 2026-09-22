if (typeof window !== "undefined") throw new Error("clinical-core/qualification-target-manifest is server-only.");
import { readFileSync } from "node:fs";
import { assertQualificationDatabaseName, PRODUCTION_ACCOUNT_ID } from "./qualification-target";

/**
 * The explicit hosted qualification target. The hosted harnesses used to take their API origin and database from
 * whatever foundation stack the caller named, and the documented command named the staging foundation: the export
 * harness then drove the staging API and the recording fixture wrote into the staging database. Both are now bound to
 * this reviewed manifest instead. It names the one API, database, bucket, source commit, migration ledger, identities
 * and candidate stacks a run may touch, and names the staging origin, database and foundation stack it must refuse.
 * The PowerShell wrappers verify the live account and stacks against it before any request; the CLIs load it again
 * themselves, so a direct CLI invocation cannot bypass the binding, and refuse any ambient override that disagrees.
 */
export type QualificationTargetManifest = {
  schemaVersion: "aws-clinical-core-qualification-target/1";
  environment: "synthetic-staging";
  dataClassification: "synthetic_only";
  containsPhi: false;
  awsAccountId: string;
  awsRegion: string;
  /** The dedicated qualification foundation stack (API, buckets, keys, alarms; never the staging foundation). Its static
   * outputs describe prepared infrastructure and are not candidate execution evidence: the candidate stacks are verified one by one. */
  foundationStackName: string;
  /** The dedicated qualification HTTP API (never the staging API). */
  apiId: string;
  apiOrigin: string;
  databaseClusterArn: string;
  databaseSecretArn: string;
  /** The isolated qualification database (contains `qualification`; never the staging database). */
  databaseName: string;
  /** The reviewed export bucket the personal-storage candidate delivers to; the export harness downloads from this host only. */
  exportBucket: string;
  /** The reviewed recording bucket the recording candidates store fictional audio in. */
  recordingBucket: string;
  /** The exact commit every candidate stack was deployed from; a run from another checkout is refused. */
  sourceCommit: string;
  /** The release hash of the migration artifact the database was applied with; a run with another built artifact is refused. */
  migrationReleaseHash: string;
  /** The designated fictional identities (the reviewed synthetic acceptance manifest's subjects). The second consumer is
   * designated too: an identity the qualification gate refuses outright proves nothing about owner isolation, because the
   * refusal would come from the outer gate rather than from the owner check under test. The retention service subject is
   * present only when the scheduled sweep is under test. */
  identitySubjects: { consumer: string; workforce: string; foreignConsumer: string; retentionService?: string };
  /** Candidate stack names the wrappers verify (PHI false, activation blocked, qualification enabled, same source commit). */
  stacks: Record<string, string>;
  refused: { stagingFoundationStackName: string; stagingApiOrigin: string; stagingDatabaseName: string };
  reviewedAt: string;
};

export type QualificationTargetRefusal = "target_manifest_invalid" | "target_placeholder" | "target_account_refused" | "target_staging_refused" | "target_database_refused"
  | "target_override_refused" | "target_source_mismatch" | "target_ledger_mismatch" | "target_stack_refused";
export class QualificationTargetManifestError extends Error {
  constructor(readonly category: QualificationTargetRefusal, readonly field?: string) { super(category); this.name = "QualificationTargetManifestError"; }
}

const TOP = ["schemaVersion", "environment", "dataClassification", "containsPhi", "awsAccountId", "awsRegion", "foundationStackName", "apiId", "apiOrigin", "databaseClusterArn", "databaseSecretArn", "databaseName", "exportBucket",
  "recordingBucket", "sourceCommit", "migrationReleaseHash", "identitySubjects", "stacks", "refused", "reviewedAt"] as const;
// Every candidate stack the qualification target holds. A run verifies the ones its harness depends on, but the manifest
// names them all, so a stack that is quietly missing from the target is visible before a run rather than after one.
const CANDIDATES = ["personal-storage", "privacy-operations", "owned-lab", "owned-voice", "recording-authority", "recording-capture",
  "recording-transcription", "recording-drafting", "recording-cleanup-review", "recording-cleanup-execution"] as const;
const API_ID = /^[a-z0-9]{10}$/, REGION = /^[a-z]{2}-[a-z]+-\d$/, BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, STACK = /^[A-Za-z][A-Za-z0-9-]{0,127}$/, HEX40 = /^[a-f0-9]{40}$/, HEX64 = /^[a-f0-9]{64}$/;
const CLUSTER = /^arn:aws:rds:([a-z0-9-]+):(\d{12}):cluster:[A-Za-z0-9-]{1,63}$/, SECRET = /^arn:aws:secretsmanager:([a-z0-9-]+):(\d{12}):secret:[A-Za-z0-9/_+=.@!-]+$/;
const PLACEHOLDER = /replace|^0+$|^REPLACE/i;
const FORBIDDEN_KEY = /(email|phone|password|secret_value|token|authorization|cookie)/i;

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function str(value: unknown, field: string): string { if (typeof value !== "string" || value.length === 0 || value.length > 512) throw new QualificationTargetManifestError("target_manifest_invalid", field); return value; }

/** Every designated subject, in the order a stack parameter lists them: consumer, workforce, the second consumer, and the
 * retention service when the sweep is under test. */
export function designatedSubjects(subjects: QualificationTargetManifest["identitySubjects"]): string[] {
  return [subjects.consumer, subjects.workforce, subjects.foreignConsumer, ...(subjects.retentionService ? [subjects.retentionService] : [])];
}

export function loadQualificationTargetManifest(file: string): QualificationTargetManifest {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); } catch { throw new QualificationTargetManifestError("target_manifest_invalid", "file"); }
  return validateQualificationTargetManifest(parsed);
}

/** Shape, posture, account, region, staging refusals and placeholders. A manifest that still carries an example value
 * (`replace…`, all-zero hashes) is refused: the owner fills a copy, and the example itself can never bind a run. */
export function validateQualificationTargetManifest(value: unknown): QualificationTargetManifest {
  if (!isRecord(value) || Object.keys(value).length !== TOP.length || TOP.some((k) => !(k in value))) throw new QualificationTargetManifestError("target_manifest_invalid", "keys");
  if (Object.keys(value).some((k) => FORBIDDEN_KEY.test(k))) throw new QualificationTargetManifestError("target_manifest_invalid", "keys");
  if (value.schemaVersion !== "aws-clinical-core-qualification-target/1" || value.environment !== "synthetic-staging" || value.dataClassification !== "synthetic_only" || value.containsPhi !== false) {
    throw new QualificationTargetManifestError("target_manifest_invalid", "posture");
  }
  const account = str(value.awsAccountId, "awsAccountId"), region = str(value.awsRegion, "awsRegion");
  if (!/^\d{12}$/.test(account) || !REGION.test(region)) throw new QualificationTargetManifestError("target_manifest_invalid", "awsAccountId");
  if (account === PRODUCTION_ACCOUNT_ID || account === "000000000000") throw new QualificationTargetManifestError("target_account_refused", "awsAccountId");
  const apiId = str(value.apiId, "apiId"), apiOrigin = str(value.apiOrigin, "apiOrigin");
  if (!API_ID.test(apiId) || apiOrigin !== `https://${apiId}.execute-api.${region}.amazonaws.com`) throw new QualificationTargetManifestError("target_manifest_invalid", "apiOrigin");
  const cluster = str(value.databaseClusterArn, "databaseClusterArn").match(CLUSTER), secret = str(value.databaseSecretArn, "databaseSecretArn").match(SECRET);
  if (!cluster || !secret) throw new QualificationTargetManifestError("target_manifest_invalid", "databaseClusterArn");
  if (cluster[1] !== region || cluster[2] !== account || secret[1] !== region || secret[2] !== account) throw new QualificationTargetManifestError("target_account_refused", "databaseClusterArn");
  if (!isRecord(value.refused) || Object.keys(value.refused).length !== 3) throw new QualificationTargetManifestError("target_manifest_invalid", "refused");
  const refused = { stagingFoundationStackName: str(value.refused.stagingFoundationStackName, "refused"), stagingApiOrigin: str(value.refused.stagingApiOrigin, "refused"), stagingDatabaseName: str(value.refused.stagingDatabaseName, "refused") };
  if (!STACK.test(refused.stagingFoundationStackName) || !/^https:\/\/[a-z0-9]{10}\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/.test(refused.stagingApiOrigin)) throw new QualificationTargetManifestError("target_manifest_invalid", "refused");
  if (apiOrigin === refused.stagingApiOrigin) throw new QualificationTargetManifestError("target_staging_refused", "apiOrigin");
  const foundationStackName = str(value.foundationStackName, "foundationStackName");
  if (!STACK.test(foundationStackName)) throw new QualificationTargetManifestError("target_manifest_invalid", "foundationStackName");
  if (foundationStackName === refused.stagingFoundationStackName) throw new QualificationTargetManifestError("target_staging_refused", "foundationStackName");
  const databaseName = str(value.databaseName, "databaseName");
  try { assertQualificationDatabaseName(databaseName, refused.stagingDatabaseName); } catch { throw new QualificationTargetManifestError("target_database_refused", "databaseName"); }
  const exportBucket = str(value.exportBucket, "exportBucket"), recordingBucket = str(value.recordingBucket, "recordingBucket");
  const sourceCommit = str(value.sourceCommit, "sourceCommit"), migrationReleaseHash = str(value.migrationReleaseHash, "migrationReleaseHash");
  if (!BUCKET.test(exportBucket) || !BUCKET.test(recordingBucket) || !HEX40.test(sourceCommit) || !HEX64.test(migrationReleaseHash)) throw new QualificationTargetManifestError("target_manifest_invalid", "exportBucket");
  if (exportBucket === recordingBucket) throw new QualificationTargetManifestError("target_manifest_invalid", "recordingBucket");
  const subjectValues = value.identitySubjects;
  if (!isRecord(subjectValues) || Object.keys(subjectValues).some((k) => !["consumer", "workforce", "foreignConsumer", "retentionService"].includes(k))) throw new QualificationTargetManifestError("target_manifest_invalid", "identitySubjects");
  const identitySubjects: QualificationTargetManifest["identitySubjects"] = { consumer: str(subjectValues.consumer, "identitySubjects"), workforce: str(subjectValues.workforce, "identitySubjects"),
    foreignConsumer: str(subjectValues.foreignConsumer, "identitySubjects"), ...(subjectValues.retentionService === undefined ? {} : { retentionService: str(subjectValues.retentionService, "identitySubjects") }) };
  const designated = designatedSubjects(identitySubjects);
  if (new Set(designated).size !== designated.length) throw new QualificationTargetManifestError("target_manifest_invalid", "identitySubjects");
  const stackValues = value.stacks;
  if (!isRecord(stackValues) || CANDIDATES.some((c) => !(c in stackValues)) || Object.keys(stackValues).length !== CANDIDATES.length) throw new QualificationTargetManifestError("target_manifest_invalid", "stacks");
  const stacks: Record<string, string> = {};
  for (const candidate of CANDIDATES) {
    const name = str(stackValues[candidate], "stacks");
    if (!STACK.test(name)) throw new QualificationTargetManifestError("target_manifest_invalid", "stacks");
    if (name === refused.stagingFoundationStackName) throw new QualificationTargetManifestError("target_staging_refused", "stacks");
    if (name === foundationStackName) throw new QualificationTargetManifestError("target_manifest_invalid", "stacks");
    stacks[candidate] = name;
  }
  if (new Set(Object.values(stacks)).size !== CANDIDATES.length) throw new QualificationTargetManifestError("target_manifest_invalid", "stacks");
  const reviewedAt = str(value.reviewedAt, "reviewedAt");
  if (Number.isNaN(Date.parse(reviewedAt))) throw new QualificationTargetManifestError("target_manifest_invalid", "reviewedAt");
  for (const [field, candidate] of [["apiId", apiId], ["exportBucket", exportBucket], ["sourceCommit", sourceCommit], ["migrationReleaseHash", migrationReleaseHash], ["databaseSecretArn", secret[0]],
    ["recordingBucket", recordingBucket], ...designated.map((subject) => ["identitySubjects", subject] as const)] as const) {
    if (PLACEHOLDER.test(candidate)) throw new QualificationTargetManifestError("target_placeholder", field);
  }
  return { schemaVersion: "aws-clinical-core-qualification-target/1", environment: "synthetic-staging", dataClassification: "synthetic_only", containsPhi: false, awsAccountId: account, awsRegion: region, foundationStackName, apiId, apiOrigin,
    databaseClusterArn: cluster[0], databaseSecretArn: secret[0], databaseName, exportBucket, recordingBucket, sourceCommit, migrationReleaseHash, identitySubjects, stacks, refused, reviewedAt };
}

export type BoundQualificationTarget = {
  apiOrigin: string; expectedAwsAccountId: string; observedAwsAccountId: string; region: string; sourceCommit: string; migrationReleaseHash: string; expectedExportBucket: string;
  database: { clusterArn: string; secretArn: string; databaseName: string; stagingDatabaseName: string };
};

/**
 * Binds a run to the manifest from what the caller observed: the STS account, the checkout's commit and the built
 * artifact's release hash must equal the manifest's; the production account is refused whatever the manifest says; and
 * an ambient `CLINICAL_API_ORIGIN` or `CLINICAL_DATABASE_NAME` that names anything other than the manifest's target is
 * refused rather than obeyed (the earlier wrappers overwrote those variables with the staging foundation's outputs).
 */
export function bindQualificationTarget(manifest: QualificationTargetManifest, observed: { awsAccountId: string; sourceCommit: string; migrationReleaseHash: string },
  env: Record<string, string | undefined>): BoundQualificationTarget {
  if (!/^\d{12}$/.test(observed.awsAccountId) || observed.awsAccountId === PRODUCTION_ACCOUNT_ID || observed.awsAccountId !== manifest.awsAccountId) throw new QualificationTargetManifestError("target_account_refused", "observed");
  if (!HEX40.test(observed.sourceCommit) || observed.sourceCommit !== manifest.sourceCommit) throw new QualificationTargetManifestError("target_source_mismatch", "sourceCommit");
  if (!HEX64.test(observed.migrationReleaseHash) || observed.migrationReleaseHash !== manifest.migrationReleaseHash) throw new QualificationTargetManifestError("target_ledger_mismatch", "migrationReleaseHash");
  const overrides: Array<[string, string]> = [["CLINICAL_API_ORIGIN", manifest.apiOrigin], ["CLINICAL_DATABASE_NAME", manifest.databaseName], ["CLINICAL_DATABASE_CLUSTER_ARN", manifest.databaseClusterArn],
    ["CLINICAL_DATABASE_SECRET_ARN", manifest.databaseSecretArn], ["EXPECTED_AWS_ACCOUNT_ID", manifest.awsAccountId], ["AWS_REGION", manifest.awsRegion]];
  for (const [name, expected] of overrides) {
    const value = env[name]?.trim();
    if (value && value !== expected) throw new QualificationTargetManifestError("target_override_refused", name);
  }
  return { apiOrigin: manifest.apiOrigin, expectedAwsAccountId: manifest.awsAccountId, observedAwsAccountId: observed.awsAccountId, region: manifest.awsRegion, sourceCommit: manifest.sourceCommit,
    migrationReleaseHash: manifest.migrationReleaseHash, expectedExportBucket: manifest.exportBucket,
    database: { clusterArn: manifest.databaseClusterArn, secretArn: manifest.databaseSecretArn, databaseName: manifest.databaseName, stagingDatabaseName: manifest.refused.stagingDatabaseName } };
}

/** What each candidate stack is, in the terms its own template uses. The candidates do not all speak the same dialect:
 * personal-storage, privacy-operations and the recording candidates take `ApiId` and export `SourceCommit`, while
 * owned-lab and owned-voice attach to the shared API as `ClinicalApiId` and export neither, so a single required set
 * would refuse a correctly deployed stack. Buckets are required only of the candidates that use them. */
type QualificationStackSpec = { api: "ApiId" | "ClinicalApiId" | null; buckets: ReadonlyArray<"ExportBucketName" | "RecordingBucket">; sourceCommitOutput: boolean };
export const QUALIFICATION_STACK_SPECS: Record<string, QualificationStackSpec> = {
  "personal-storage": { api: "ApiId", buckets: ["ExportBucketName"], sourceCommitOutput: true },
  "privacy-operations": { api: "ApiId", buckets: ["ExportBucketName"], sourceCommitOutput: true },
  "recording-authority": { api: "ApiId", buckets: [], sourceCommitOutput: true },
  "recording-capture": { api: "ApiId", buckets: ["RecordingBucket"], sourceCommitOutput: true },
  "recording-transcription": { api: "ApiId", buckets: ["RecordingBucket"], sourceCommitOutput: true },
  "recording-drafting": { api: "ApiId", buckets: ["RecordingBucket"], sourceCommitOutput: true },
  "recording-cleanup-review": { api: "ApiId", buckets: [], sourceCommitOutput: true },
  "recording-cleanup-execution": { api: "ApiId", buckets: ["RecordingBucket"], sourceCommitOutput: true },
  "owned-lab": { api: "ClinicalApiId", buckets: [], sourceCommitOutput: false },
  "owned-voice": { api: "ClinicalApiId", buckets: [], sourceCommitOutput: false },
};
const USABLE_STACK_STATUS = new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE", "IMPORT_COMPLETE", "IMPORT_ROLLBACK_COMPLETE"]);

/** The posture a run expects of a candidate. `qualification` is the ordinary one: production activation blocked and the
 * qualification profile serving the designated identities. `drain` is the voice shutdown posture, where the candidate
 * answers every public request with `voice_cleanup_only` and qualification execution is refused by policy, so its stack
 * must report `Activation=draining` and `QualificationExecution=disabled`. */
export type QualificationStackPosture = "qualification" | "drain";

/** What a wrapper reads from each candidate stack, checked the same way in Node so the PowerShell check is not the only one:
 * the posture and source outputs, a stack that actually finished, and every resource parameter the candidate uses against
 * the manifest's own identifiers. A parameter the candidate needs but does not carry is a refusal, not a pass. */
export function assertQualificationStackOutputs(candidate: string, outputs: Record<string, string | undefined>, manifest: QualificationTargetManifest,
  parameters: Record<string, string | undefined> = {}, stackStatus?: string, posture: QualificationStackPosture = "qualification"): void {
  const refuse = (): never => { throw new QualificationTargetManifestError("target_stack_refused", candidate); };
  const spec = QUALIFICATION_STACK_SPECS[candidate];
  if (!spec) refuse();
  if (outputs.PhiAllowed !== "false") refuse();
  if (posture === "drain") {
    if (outputs.Activation !== "draining" || outputs.QualificationExecution !== "disabled") refuse();
  } else if (outputs.Activation !== "blocked" || outputs.QualificationExecution !== "enabled") refuse();
  if (spec!.sourceCommitOutput && outputs.SourceCommit !== manifest.sourceCommit) refuse();
  if (outputs.SourceCommit !== undefined && outputs.SourceCommit !== manifest.sourceCommit) refuse();
  if (stackStatus !== undefined && !USABLE_STACK_STATUS.has(stackStatus)) refuse();
  const expected: Record<string, string> = { DatabaseClusterArn: manifest.databaseClusterArn, DatabaseSecretArn: manifest.databaseSecretArn, DatabaseName: manifest.databaseName,
    QualificationAccountId: manifest.awsAccountId, ApiId: manifest.apiId, ClinicalApiId: manifest.apiId, ExportBucketName: manifest.exportBucket, RecordingBucket: manifest.recordingBucket };
  for (const name of ["DatabaseClusterArn", "DatabaseSecretArn", "DatabaseName", "QualificationAccountId", ...(spec!.api ? [spec!.api] : []), ...spec!.buckets]) {
    if (parameters[name] === undefined || parameters[name] !== expected[name]) refuse();
  }
  if (parameters.SourceCommit !== undefined && parameters.SourceCommit !== manifest.sourceCommit) refuse();
  // The stack serves exactly the designated fictional identities: an undesignated subject would be refused by the outer
  // qualification gate, and a missing one (the second consumer, or the retention service when the sweep is under test)
  // would make its case untestable. A draining candidate serves nobody, so its subject list is not required.
  if (posture === "qualification") {
    const listed = (parameters.QualificationIdentitySubjects ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const required = designatedSubjects(manifest.identitySubjects);
    if (listed.length !== required.length || required.some((subject) => !listed.includes(subject))) refuse();
  }
}

export function assertQualificationFoundationOutputs(outputs: Record<string, string | undefined>, manifest: QualificationTargetManifest): void {
  if (outputs.PhiAllowed !== "false") throw new QualificationTargetManifestError("target_stack_refused", "foundation");
  if (outputs.ApiId !== undefined && outputs.ApiId !== manifest.apiId) throw new QualificationTargetManifestError("target_stack_refused", "foundation");
  if (outputs.ApiOrigin !== undefined && outputs.ApiOrigin !== manifest.apiOrigin) throw new QualificationTargetManifestError("target_stack_refused", "foundation");
  if (outputs.DatabaseName !== undefined && outputs.DatabaseName !== manifest.databaseName) throw new QualificationTargetManifestError("target_stack_refused", "foundation");
  if (outputs.Activation !== undefined && outputs.Activation !== "blocked") throw new QualificationTargetManifestError("target_stack_refused", "foundation");
}
