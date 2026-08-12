if (typeof window !== "undefined") {
  throw new Error("clinical-core/synthetic-fixtures is server-only.");
}

import { readFileSync } from "node:fs";
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from "./database";

export type SyntheticAcceptanceManifest = {
  schemaVersion: "aws-clinical-core-synthetic-acceptance/1";
  environment: "synthetic-staging";
  dataClassification: "synthetic_only";
  containsPhi: false;
  awsAccountId: string;
  awsRegion: string;
  reviewedAt: string;
  fixture: {
    organizationId: string;
    organizationLabel: string;
    workforcePersonId: string;
    workforceSubject: string;
    consumerPersonId: string;
    consumerSubject: string;
    patientRecordId: string;
    consentArtifactId: string;
    consentArtifactSha256: string;
  };
};

export class SyntheticFixtureError extends Error {
  constructor(readonly category: "manifest_invalid" | "fixture_mismatch" | "fixture_failed") {
    super(category);
    this.name = "SyntheticFixtureError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUBJECT = /^[A-Za-z0-9:_-]{8,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;
const EXACT_TOP = ["schemaVersion", "environment", "dataClassification", "containsPhi", "awsAccountId", "awsRegion", "reviewedAt", "fixture"];
const EXACT_FIXTURE = ["organizationId", "organizationLabel", "workforcePersonId", "workforceSubject", "consumerPersonId", "consumerSubject", "patientRecordId", "consentArtifactId", "consentArtifactSha256"];
const FORBIDDEN_KEY = /(email|phone|name|address|birth|dob|password|secret|token|authorization|cookie)/i;

export function loadSyntheticAcceptanceManifest(file: string): SyntheticAcceptanceManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new SyntheticFixtureError("manifest_invalid");
  }
  return validateSyntheticAcceptanceManifest(parsed);
}

export function validateSyntheticAcceptanceManifest(value: unknown): SyntheticAcceptanceManifest {
  if (!isRecord(value) || !hasExactKeys(value, EXACT_TOP) || !isRecord(value.fixture) || !hasExactKeys(value.fixture, EXACT_FIXTURE)) {
    throw new SyntheticFixtureError("manifest_invalid");
  }
  if (Object.keys(value).concat(Object.keys(value.fixture)).some((key) => FORBIDDEN_KEY.test(key))) {
    throw new SyntheticFixtureError("manifest_invalid");
  }
  const manifest = value as SyntheticAcceptanceManifest;
  const f = manifest.fixture;
  if (
    manifest.schemaVersion !== "aws-clinical-core-synthetic-acceptance/1"
    || manifest.environment !== "synthetic-staging"
    || manifest.dataClassification !== "synthetic_only"
    || manifest.containsPhi !== false
    || !/^\d{12}$/.test(manifest.awsAccountId)
    || manifest.awsAccountId === "000000000000"
    || !REGION.test(manifest.awsRegion)
    || !validTimestamp(manifest.reviewedAt)
    || ![f.organizationId, f.workforcePersonId, f.consumerPersonId, f.patientRecordId, f.consentArtifactId].every((entry) => UUID.test(entry))
    || new Set([f.workforcePersonId, f.consumerPersonId]).size !== 2
    || !SUBJECT.test(f.workforceSubject)
    || !SUBJECT.test(f.consumerSubject)
    || f.workforceSubject === f.consumerSubject
    || !/^Synthetic acceptance [A-Za-z0-9 _-]{1,80}$/.test(f.organizationLabel)
    || !SHA256.test(f.consentArtifactSha256)
  ) throw new SyntheticFixtureError("manifest_invalid");
  return manifest;
}

export async function provisionSyntheticAcceptanceFixtures(
  database: ClinicalCoreDatabase,
  manifest: SyntheticAcceptanceManifest,
): Promise<{ provisioned: true; records: 8 }> {
  try {
    return await database.transaction(async (tx) => {
      const f = manifest.fixture;
      await tx.query(`insert into clinical_core.organizations
        (id, synthetic_label, environment, data_classification, contains_phi, status)
        values ($1, $2, 'synthetic-staging', 'synthetic_only', false, 'active') on conflict (id) do nothing`,
      [f.organizationId, f.organizationLabel]);
      await assertCount(tx, `select count(*)::int as count from clinical_core.organizations
        where id=$1 and synthetic_label=$2 and environment='synthetic-staging'
          and data_classification='synthetic_only' and contains_phi=false and status='active'`,
      [f.organizationId, f.organizationLabel]);

      await upsertPerson(tx, f.workforcePersonId, "syn_acceptance_workforce");
      await upsertPerson(tx, f.consumerPersonId, "syn_acceptance_consumer");
      await upsertIdentity(tx, f.workforcePersonId, "workforce", f.workforceSubject);
      await upsertIdentity(tx, f.consumerPersonId, "consumer", f.consumerSubject);

      await tx.query(`insert into clinical_core.organization_memberships
        (organization_id, person_id, role, status) values ($1,$2,'practitioner','active')
        on conflict (organization_id, person_id) do nothing`, [f.organizationId, f.workforcePersonId]);
      await assertCount(tx, `select count(*)::int as count from clinical_core.organization_memberships
        where organization_id=$1 and person_id=$2 and role='practitioner' and status='active'`,
      [f.organizationId, f.workforcePersonId]);

      await tx.query(`insert into clinical_core.patient_records
        (id, organization_id, synthetic_record_key, data_classification, contains_phi, status)
        values ($1,$2,'patient_syn_acceptance_0001','synthetic_only',false,'active') on conflict (id) do nothing`,
      [f.patientRecordId, f.organizationId]);
      await assertCount(tx, `select count(*)::int as count from clinical_core.patient_records
        where id=$1 and organization_id=$2 and synthetic_record_key='patient_syn_acceptance_0001'
          and data_classification='synthetic_only' and contains_phi=false and status='active'`,
      [f.patientRecordId, f.organizationId]);

      await tx.query(`insert into clinical_core.consent_artifacts
        (id, organization_id, scope, artifact_version, content_sha256, jurisdiction, status, approved_at, approved_by_person_id)
        values ($1,$2,'programs','synthetic-acceptance-v1',$3,'US-SYNTHETIC','approved',clock_timestamp(),$4)
        on conflict (id) do nothing`,
      [f.consentArtifactId, f.organizationId, f.consentArtifactSha256, f.workforcePersonId]);
      await assertCount(tx, `select count(*)::int as count from clinical_core.consent_artifacts
        where id=$1 and organization_id=$2 and scope='programs' and artifact_version='synthetic-acceptance-v1'
          and content_sha256=$3 and jurisdiction='US-SYNTHETIC' and status='approved'
          and approved_by_person_id=$4`,
      [f.consentArtifactId, f.organizationId, f.consentArtifactSha256, f.workforcePersonId]);
      return { provisioned: true, records: 8 };
    });
  } catch (error) {
    if (error instanceof SyntheticFixtureError) throw error;
    throw new SyntheticFixtureError("fixture_failed");
  }
}

async function upsertPerson(tx: ClinicalCoreTransaction, id: string, key: string) {
  await tx.query(`insert into clinical_core.persons
    (id, synthetic_subject_key, data_classification, contains_phi, status)
    values ($1,$2,'synthetic_only',false,'active') on conflict (id) do nothing`, [id, key]);
  await assertCount(tx, `select count(*)::int as count from clinical_core.persons
    where id=$1 and synthetic_subject_key=$2 and data_classification='synthetic_only'
      and contains_phi=false and status='active'`, [id, key]);
}

async function upsertIdentity(tx: ClinicalCoreTransaction, personId: string, pool: "workforce" | "consumer", subject: string) {
  await tx.query(`insert into clinical_core.identities
    (person_id, identity_pool, identity_subject, synthetic_attested, status)
    values ($1,$2,$3,true,'active') on conflict (person_id, identity_pool) do nothing`, [personId, pool, subject]);
  await assertCount(tx, `select count(*)::int as count from clinical_core.identities
    where person_id=$1 and identity_pool=$2 and identity_subject=$3 and synthetic_attested=true and status='active'`,
  [personId, pool, subject]);
}

async function assertCount(tx: ClinicalCoreTransaction, sql: string, parameters: readonly unknown[]) {
  const result = await tx.query<{ count: number }>(sql, parameters);
  if (Number(result.rows[0]?.count) !== 1) throw new SyntheticFixtureError("fixture_mismatch");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  return Object.keys(value).sort().join("|") === [...expected].sort().join("|");
}

function validTimestamp(value: string) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
}
