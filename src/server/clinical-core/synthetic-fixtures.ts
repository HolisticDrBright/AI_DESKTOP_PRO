if (typeof window !== "undefined") {
  throw new Error("clinical-core/synthetic-fixtures is server-only.");
}

import { readFileSync } from "node:fs";
import { clinicalUuid, type ClinicalCoreDatabase, type ClinicalCoreTransaction } from "./database";

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
    labConsentArtifactId: string;
    labConsentArtifactSha256: string;
    protocolConsentArtifactId: string;
    protocolConsentArtifactSha256: string;
    nutritionConsentArtifactId: string;
    nutritionConsentArtifactSha256: string;
    symptomsConsentArtifactId: string;
    symptomsConsentArtifactSha256: string;
    formsConsentArtifactId: string;
    formsConsentArtifactSha256: string;
    syncProviderId: string;
    isolationOrganizationId: string;
    isolationOrganizationLabel: string;
    isolationWorkforcePersonId: string;
    isolationWorkforceSubject: string;
  };
};

export class SyntheticFixtureError extends Error {
  constructor(
    readonly category: "manifest_invalid" | "fixture_mismatch" | "fixture_failed",
    readonly operationIndex?: number,
  ) {
    super(category);
    this.name = "SyntheticFixtureError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUBJECT = /^[A-Za-z0-9:_-]{8,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;
const EXACT_TOP = ["schemaVersion", "environment", "dataClassification", "containsPhi", "awsAccountId", "awsRegion", "reviewedAt", "fixture"];
const EXACT_FIXTURE = ["organizationId", "organizationLabel", "workforcePersonId", "workforceSubject", "consumerPersonId", "consumerSubject", "patientRecordId", "consentArtifactId", "consentArtifactSha256", "labConsentArtifactId", "labConsentArtifactSha256", "protocolConsentArtifactId", "protocolConsentArtifactSha256", "nutritionConsentArtifactId", "nutritionConsentArtifactSha256", "symptomsConsentArtifactId", "symptomsConsentArtifactSha256", "formsConsentArtifactId", "formsConsentArtifactSha256", "syncProviderId", "isolationOrganizationId", "isolationOrganizationLabel", "isolationWorkforcePersonId", "isolationWorkforceSubject"];
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
    || ![f.organizationId, f.workforcePersonId, f.consumerPersonId, f.patientRecordId, f.consentArtifactId,
      f.labConsentArtifactId, f.protocolConsentArtifactId, f.nutritionConsentArtifactId,
      f.symptomsConsentArtifactId, f.formsConsentArtifactId, f.syncProviderId,
      f.isolationOrganizationId, f.isolationWorkforcePersonId].every((entry) => UUID.test(entry))
    || new Set([f.organizationId, f.isolationOrganizationId]).size !== 2
    || new Set([f.workforcePersonId, f.consumerPersonId, f.isolationWorkforcePersonId]).size !== 3
    || !SUBJECT.test(f.workforceSubject)
    || !SUBJECT.test(f.consumerSubject)
    || !SUBJECT.test(f.isolationWorkforceSubject)
    || new Set([f.workforceSubject, f.consumerSubject, f.isolationWorkforceSubject]).size !== 3
    || !/^Synthetic acceptance [A-Za-z0-9 _-]{1,80}$/.test(f.organizationLabel)
    || !/^Synthetic acceptance [A-Za-z0-9 _-]{1,80}$/.test(f.isolationOrganizationLabel)
    || !SHA256.test(f.consentArtifactSha256)
    || !SHA256.test(f.labConsentArtifactSha256)
    || !SHA256.test(f.protocolConsentArtifactSha256)
    || !SHA256.test(f.nutritionConsentArtifactSha256)
    || !SHA256.test(f.symptomsConsentArtifactSha256)
    || !SHA256.test(f.formsConsentArtifactSha256)
  ) throw new SyntheticFixtureError("manifest_invalid");
  return manifest;
}

export async function provisionSyntheticAcceptanceFixtures(
  database: ClinicalCoreDatabase,
  manifest: SyntheticAcceptanceManifest,
): Promise<{ provisioned: true; records: 18 }> {
  let operationIndex = 0;
  try {
    return await database.transaction(async (tx) => {
      const rawTransaction = tx;
      const instrumented: ClinicalCoreTransaction = {
        query: async <Row extends Record<string, unknown>>(sql: string, parameters: readonly unknown[] = []) => {
          operationIndex += 1;
          return rawTransaction.query<Row>(sql, parameters);
        },
      };
      tx = instrumented;
      const f = manifest.fixture;
      const patientKey = `patient_syn_acceptance_${f.patientRecordId.replaceAll("-", "").slice(0, 12)}`;
      const artifactVersion = `synthetic-${f.consentArtifactId.replaceAll("-", "").slice(0, 20)}`;
      await tx.query(`insert into clinical_core.organizations
        (id, synthetic_label, environment, data_classification, contains_phi, status)
        values ($1, $2, 'synthetic-staging', 'synthetic_only', false, 'active') on conflict (id) do nothing`,
      [clinicalUuid(f.organizationId), f.organizationLabel]);
      await assertCount(tx, `select count(*)::int as count from clinical_core.organizations
        where id=$1 and synthetic_label=$2 and environment='synthetic-staging'
          and data_classification='synthetic_only' and contains_phi=false and status='active'`,
      [clinicalUuid(f.organizationId), f.organizationLabel]);

      await upsertPerson(tx, f.workforcePersonId, "syn_acceptance_workforce");
      await upsertPerson(tx, f.consumerPersonId, `syn_acceptance_consumer_${f.consumerPersonId.replaceAll("-", "").slice(0, 12)}`);
      await upsertIdentity(tx, f.workforcePersonId, "workforce", f.workforceSubject);
      await upsertIdentity(tx, f.consumerPersonId, "consumer", f.consumerSubject);

      await tx.query(`insert into clinical_core.organization_memberships
        (organization_id, person_id, role, status) values ($1,$2,'practitioner','active')
        on conflict (organization_id, person_id) do nothing`, [clinicalUuid(f.organizationId), clinicalUuid(f.workforcePersonId)]);
      await assertCount(tx, `select count(*)::int as count from clinical_core.organization_memberships
        where organization_id=$1 and person_id=$2 and role='practitioner' and status='active'`,
      [clinicalUuid(f.organizationId), clinicalUuid(f.workforcePersonId)]);

      await tx.query(`insert into clinical_core.patient_records
        (id, organization_id, synthetic_record_key, data_classification, contains_phi, status)
        values ($1,$2,$3,'synthetic_only',false,'active') on conflict (id) do nothing`,
      [clinicalUuid(f.patientRecordId), clinicalUuid(f.organizationId), patientKey]);
      await assertCount(tx, `select count(*)::int as count from clinical_core.patient_records
        where id=$1 and organization_id=$2 and synthetic_record_key=$3
          and data_classification='synthetic_only' and contains_phi=false and status='active'`,
      [clinicalUuid(f.patientRecordId), clinicalUuid(f.organizationId), patientKey]);

      await tx.query(`insert into clinical_core.consent_artifacts
        (id, organization_id, scope, artifact_version, content_sha256, jurisdiction, status, approved_at, approved_by_person_id)
        values ($1,$2,'programs',$3,$4,'US-SYNTHETIC','approved',clock_timestamp(),$5)
        on conflict (id) do nothing`,
      [clinicalUuid(f.consentArtifactId), clinicalUuid(f.organizationId), artifactVersion, f.consentArtifactSha256, clinicalUuid(f.workforcePersonId)]);
      await assertCount(tx, `select count(*)::int as count from clinical_core.consent_artifacts
        where id=$1 and organization_id=$2 and scope='programs' and artifact_version=$3
          and content_sha256=$4 and jurisdiction='US-SYNTHETIC' and status='approved'
          and approved_by_person_id=$5`,
      [clinicalUuid(f.consentArtifactId), clinicalUuid(f.organizationId), artifactVersion, f.consentArtifactSha256, clinicalUuid(f.workforcePersonId)]);

      const labArtifactVersion = `synthetic-${f.labConsentArtifactId.replaceAll("-", "").slice(0, 20)}`;
      await tx.query(`insert into clinical_core.consent_artifacts
        (id, organization_id, scope, artifact_version, content_sha256, jurisdiction, status, approved_at, approved_by_person_id)
        values ($1,$2,'lab_results_import',$3,$4,'US-SYNTHETIC','approved',clock_timestamp(),$5)
        on conflict (id) do nothing`,
      [clinicalUuid(f.labConsentArtifactId), clinicalUuid(f.organizationId), labArtifactVersion,
        f.labConsentArtifactSha256, clinicalUuid(f.workforcePersonId)]);

      await insertConsentArtifact(tx, f, "protocols_supplements", f.protocolConsentArtifactId, f.protocolConsentArtifactSha256);
      await insertConsentArtifact(tx, f, "nutrition", f.nutritionConsentArtifactId, f.nutritionConsentArtifactSha256);
      await insertConsentArtifact(tx, f, "symptoms_adherence", f.symptomsConsentArtifactId, f.symptomsConsentArtifactSha256);
      await insertConsentArtifact(tx, f, "forms_checkins", f.formsConsentArtifactId, f.formsConsentArtifactSha256);
      await assertCount(tx, `select count(*)::int as count from clinical_core.consent_artifacts
        where id=$1 and organization_id=$2 and scope='lab_results_import' and artifact_version=$3
          and content_sha256=$4 and jurisdiction='US-SYNTHETIC' and status='approved'
          and approved_by_person_id=$5`,
      [clinicalUuid(f.labConsentArtifactId), clinicalUuid(f.organizationId), labArtifactVersion,
        f.labConsentArtifactSha256, clinicalUuid(f.workforcePersonId)]);

      await tx.query(`insert into clinical_core.sync_providers
        (id, organization_id, stable_id, contract_version, lab_contract_version,
         adapter_version, state, reviewed_by_person_id, reviewed_at)
        values ($1,$2,'alp_patient_sync','patient-sync/1','lab-result/1',
          'aws-clinical-state/1','active',$3,clock_timestamp()) on conflict (id) do nothing`,
      [clinicalUuid(f.syncProviderId), clinicalUuid(f.organizationId), clinicalUuid(f.workforcePersonId)]);
      await assertCount(tx, `select count(*)::int as count from clinical_core.sync_providers
        where id=$1 and organization_id=$2 and stable_id='alp_patient_sync'
          and contract_version='patient-sync/1' and lab_contract_version='lab-result/1'
          and adapter_version='aws-clinical-state/1' and state='active'
          and reviewed_by_person_id=$3`,
      [clinicalUuid(f.syncProviderId), clinicalUuid(f.organizationId), clinicalUuid(f.workforcePersonId)]);

      await tx.query(`insert into clinical_core.organizations
        (id, synthetic_label, environment, data_classification, contains_phi, status)
        values ($1, $2, 'synthetic-staging', 'synthetic_only', false, 'active') on conflict (id) do nothing`,
      [clinicalUuid(f.isolationOrganizationId), f.isolationOrganizationLabel]);
      await assertCount(tx, `select count(*)::int as count from clinical_core.organizations
        where id=$1 and synthetic_label=$2 and environment='synthetic-staging'
          and data_classification='synthetic_only' and contains_phi=false and status='active'`,
      [clinicalUuid(f.isolationOrganizationId), f.isolationOrganizationLabel]);
      await upsertPerson(tx, f.isolationWorkforcePersonId, "syn_acceptance_isolation_workforce");
      await upsertIdentity(tx, f.isolationWorkforcePersonId, "workforce", f.isolationWorkforceSubject);
      await tx.query(`insert into clinical_core.organization_memberships
        (organization_id, person_id, role, status) values ($1,$2,'practitioner','active')
        on conflict (organization_id, person_id) do nothing`, [clinicalUuid(f.isolationOrganizationId), clinicalUuid(f.isolationWorkforcePersonId)]);
      await assertCount(tx, `select count(*)::int as count from clinical_core.organization_memberships
        where organization_id=$1 and person_id=$2 and role='practitioner' and status='active'`,
      [clinicalUuid(f.isolationOrganizationId), clinicalUuid(f.isolationWorkforcePersonId)]);
      return { provisioned: true, records: 18 };
    });
  } catch (error) {
    if (error instanceof SyntheticFixtureError) throw error;
    throw new SyntheticFixtureError("fixture_failed", operationIndex || undefined);
  }
}

async function insertConsentArtifact(
  tx: ClinicalCoreTransaction,
  fixture: SyntheticAcceptanceManifest["fixture"],
  scope: "protocols_supplements" | "nutrition" | "symptoms_adherence" | "forms_checkins",
  artifactId: string,
  sha256: string,
) {
  const artifactVersion = `synthetic-${artifactId.replaceAll("-", "").slice(0, 20)}`;
  await tx.query(`insert into clinical_core.consent_artifacts
    (id, organization_id, scope, artifact_version, content_sha256, jurisdiction, status, approved_at, approved_by_person_id)
    values ($1,$2,$3,$4,$5,'US-SYNTHETIC','approved',clock_timestamp(),$6)
    on conflict (id) do nothing`, [clinicalUuid(artifactId), clinicalUuid(fixture.organizationId), scope,
    artifactVersion, sha256, clinicalUuid(fixture.workforcePersonId)]);
  await assertCount(tx, `select count(*)::int as count from clinical_core.consent_artifacts
    where id=$1 and organization_id=$2 and scope=$3 and artifact_version=$4
      and content_sha256=$5 and jurisdiction='US-SYNTHETIC' and status='approved'
      and approved_by_person_id=$6`, [clinicalUuid(artifactId), clinicalUuid(fixture.organizationId), scope,
    artifactVersion, sha256, clinicalUuid(fixture.workforcePersonId)]);
}

async function upsertPerson(tx: ClinicalCoreTransaction, id: string, key: string) {
  await tx.query(`insert into clinical_core.persons
    (id, synthetic_subject_key, data_classification, contains_phi, status)
    values ($1,$2,'synthetic_only',false,'active') on conflict (id) do nothing`, [clinicalUuid(id), key]);
  await assertCount(tx, `select count(*)::int as count from clinical_core.persons
    where id=$1 and synthetic_subject_key=$2 and data_classification='synthetic_only'
      and contains_phi=false and status='active'`, [clinicalUuid(id), key]);
}

async function upsertIdentity(tx: ClinicalCoreTransaction, personId: string, pool: "workforce" | "consumer", subject: string) {
  await tx.query(`insert into clinical_core.identities
    (person_id, identity_pool, identity_subject, synthetic_attested, status)
    values ($1,$2,$3,true,'active') on conflict (person_id, identity_pool) do update
      set identity_subject=excluded.identity_subject, synthetic_attested=true, status='active'`, [clinicalUuid(personId), pool, subject]);
  await assertCount(tx, `select count(*)::int as count from clinical_core.identities
    where person_id=$1 and identity_pool=$2 and identity_subject=$3 and synthetic_attested=true and status='active'`,
  [clinicalUuid(personId), pool, subject]);
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
