if (typeof window !== "undefined") throw new Error("clinical-core/qualification-fixtures is server-only.");
import { clinicalUuid, type ClinicalCoreDatabase, type ClinicalCoreTransaction } from "./database";
import type { ClinicalCoreMigration } from "./migrations";
import { inspectProductionClinicalCoreMigrations } from "./production-migrations";
import { assertQualificationDatabaseName } from "./qualification-target";
import type { SyntheticAcceptanceManifest } from "./synthetic-fixtures";

export class QualificationFixtureError extends Error {
  constructor(readonly category: "fixture_boundary_refused" | "qualification_schema_incomplete" | "fixture_failed", readonly operationIndex?: number) {
    super(category);
    this.name = "QualificationFixtureError";
  }
}

export type QualificationFixtureResult = {
  provisioned: true;
  /** Rows the run inserted this time; a repeated run inserts none and reports the same fixture ids. */
  inserted: number;
  artifactReleaseHash: string;
  fixture: { organizationId: string; workforcePersonId: string; consumerPersonId: string; patientRecordId: string; patientConnectionId: string; isolationOrganizationId: string };
};

const key = (prefix: string, id: string) => `${prefix}_${id.replaceAll("-", "")}`;

/**
 * Fictional, production-shaped fixtures for the isolated qualification database. The production tables constrain every
 * row to `production-clinical` / `clinical_phi` / `contains_phi=true`: those columns describe the schema's posture, not
 * the data, and every value here is fictional (labels, keys and subjects come from the reviewed synthetic acceptance
 * manifest; the one required patient name is the literal placeholder "Fictional Qualification", and no contact or
 * clinical value is written). The manifest must be synthetic-only, and the target's
 * migration ledger must equal the built artifact (every version applied with its hash, nothing unknown): the populated
 * synthetic-staging database fails that check, so this provisioner can never write into it. Inserts are idempotent.
 */
export async function provisionQualificationFixtures(
  database: ClinicalCoreDatabase,
  manifest: SyntheticAcceptanceManifest,
  migrations: ClinicalCoreMigration[],
  target: { qualificationDatabaseName: string; stagingDatabaseName: string },
): Promise<QualificationFixtureResult> {
  if (manifest.environment !== "synthetic-staging" || manifest.dataClassification !== "synthetic_only" || manifest.containsPhi !== false) throw new QualificationFixtureError("fixture_boundary_refused");
  try { assertQualificationDatabaseName(target.qualificationDatabaseName, target.stagingDatabaseName); } catch { throw new QualificationFixtureError("fixture_boundary_refused"); }
  const inspection = await inspectProductionClinicalCoreMigrations(database, migrations);
  if (!inspection.ledgerPresent || inspection.missing.length || inspection.mismatched.length || inspection.unknown.length || migrations.length === 0) throw new QualificationFixtureError("qualification_schema_incomplete");
  const f = manifest.fixture;
  let operationIndex = 0;
  let inserted = 0;
  try {
    return await database.transaction(async (raw) => {
      const tx: ClinicalCoreTransaction = { query: async <R extends Record<string, unknown>>(sql: string, parameters: readonly unknown[] = []) => { operationIndex += 1; return raw.query<R>(sql, parameters); } };
      const insert = async (sql: string, parameters: readonly unknown[]) => { const r = await tx.query<{ n: number }>(sql, parameters); inserted += r.rows.length; };
      await tx.query("select pg_advisory_xact_lock(hashtext($1))", ["ai-desktop-pro:qualification-fixtures"]);
      await insert("insert into clinical_core.organizations(id,organization_label) values($1,$2) on conflict (id) do nothing returning 1 as n", [clinicalUuid(f.organizationId), f.organizationLabel]);
      await insert("insert into clinical_core.organizations(id,organization_label) values($1,$2) on conflict (id) do nothing returning 1 as n", [clinicalUuid(f.isolationOrganizationId), f.isolationOrganizationLabel]);
      for (const [person, label] of [[f.workforcePersonId, "qualification_workforce"], [f.consumerPersonId, "qualification_consumer"], [f.isolationWorkforcePersonId, "qualification_isolation_workforce"]] as const) {
        await insert("insert into clinical_core.persons(id,subject_key) values($1,$2) on conflict (id) do nothing returning 1 as n", [clinicalUuid(person), `subject_${label}_${person.replaceAll("-", "").slice(0, 12)}`]);
      }
      for (const [person, pool, subject] of [[f.workforcePersonId, "workforce", f.workforceSubject], [f.consumerPersonId, "consumer", f.consumerSubject], [f.isolationWorkforcePersonId, "workforce", f.isolationWorkforceSubject]] as const) {
        await insert("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true) on conflict (identity_pool,identity_subject) do nothing returning 1 as n", [clinicalUuid(person), pool, subject]);
      }
      await insert("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner') on conflict (organization_id,person_id) do nothing returning 1 as n", [clinicalUuid(f.organizationId), clinicalUuid(f.workforcePersonId)]);
      await insert("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner') on conflict (organization_id,person_id) do nothing returning 1 as n", [clinicalUuid(f.isolationOrganizationId), clinicalUuid(f.isolationWorkforcePersonId)]);
      await insert("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'Fictional','Qualification') on conflict (id) do nothing returning 1 as n", [clinicalUuid(f.patientRecordId), clinicalUuid(f.organizationId), key("patient", f.patientRecordId)]);
      // The consumer's verified connection to the fixture patient: the one relationship the consumer routes read.
      const connection = await tx.query<{ id: string }>("select id::text id from clinical_core.patient_connections where organization_id=$1 and patient_record_id=$2 and consumer_person_id=$3 and state='verified' order by created_at limit 1",
        [clinicalUuid(f.organizationId), clinicalUuid(f.patientRecordId), clinicalUuid(f.consumerPersonId)]);
      let patientConnectionId = connection.rows[0]?.id;
      if (!patientConnectionId) {
        const created = await tx.query<{ id: string }>("insert into clinical_core.patient_connections(organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,'verified',clock_timestamp()) returning id::text id",
          [clinicalUuid(f.organizationId), clinicalUuid(f.patientRecordId), clinicalUuid(f.consumerPersonId)]);
        patientConnectionId = created.rows[0]?.id; inserted += 1;
      }
      if (!patientConnectionId) throw new QualificationFixtureError("fixture_failed", operationIndex);
      const artifacts = [
        ["programs", f.consentArtifactId, f.consentArtifactSha256], ["lab_results_import", f.labConsentArtifactId, f.labConsentArtifactSha256],
        ["protocols_supplements", f.protocolConsentArtifactId, f.protocolConsentArtifactSha256], ["nutrition", f.nutritionConsentArtifactId, f.nutritionConsentArtifactSha256],
        ["symptoms_adherence", f.symptomsConsentArtifactId, f.symptomsConsentArtifactSha256], ["forms_checkins", f.formsConsentArtifactId, f.formsConsentArtifactSha256],
      ] as const;
      for (const [scope, id, sha256] of artifacts) {
        await insert("insert into clinical_core.consent_artifacts(id,organization_id,scope,artifact_version,content_sha256,jurisdiction,status,approved_at,approved_by_person_id) values($1,$2,$3,$4,$5,'US-FICTIONAL','approved',clock_timestamp(),$6) on conflict (id) do nothing returning 1 as n",
          [clinicalUuid(id), clinicalUuid(f.organizationId), scope, `qualification-${id.replaceAll("-", "").slice(0, 20)}`, sha256, clinicalUuid(f.workforcePersonId)]);
        const granted = await tx.query<{ n: number }>("select count(*)::int n from clinical_core.consent_grants where organization_id=$1 and patient_record_id=$2 and connection_id=$3 and scope=$4 and status='granted'",
          [clinicalUuid(f.organizationId), clinicalUuid(f.patientRecordId), clinicalUuid(patientConnectionId), scope]);
        if (Number(granted.rows[0]?.n ?? 0) === 0) {
          await insert("insert into clinical_core.consent_grants(organization_id,patient_record_id,connection_id,artifact_id,scope,status,method,representative_authority,version,recorded_by_person_id) values($1,$2,$3,$4,$5,'granted','patient_app','self',1,$6) returning 1 as n",
            [clinicalUuid(f.organizationId), clinicalUuid(f.patientRecordId), clinicalUuid(patientConnectionId), clinicalUuid(id), scope, clinicalUuid(f.consumerPersonId)]);
        }
      }
      await insert("insert into clinical_core.sync_providers(id,organization_id,stable_id,contract_version,lab_contract_version,adapter_version,state,reviewed_by_person_id,reviewed_at) values($1,$2,'alp_patient_sync','patient-sync/1','lab-result/1','aws-clinical-state/1','active',$3,clock_timestamp()) on conflict (id) do nothing returning 1 as n",
        [clinicalUuid(f.syncProviderId), clinicalUuid(f.organizationId), clinicalUuid(f.workforcePersonId)]);
      return {
        provisioned: true as const, inserted, artifactReleaseHash: inspection.artifactReleaseHash,
        fixture: { organizationId: f.organizationId, workforcePersonId: f.workforcePersonId, consumerPersonId: f.consumerPersonId, patientRecordId: f.patientRecordId, patientConnectionId, isolationOrganizationId: f.isolationOrganizationId },
      };
    });
  } catch (error) {
    if (error instanceof QualificationFixtureError) throw error;
    throw new QualificationFixtureError("fixture_failed", operationIndex || undefined);
  }
}
