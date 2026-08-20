if (typeof window !== "undefined") {
  throw new Error("production-rollback-acceptance is server-only.");
}

import { createHash } from "node:crypto";
import { clinicalUuid, ClinicalCoreDatabaseRejection, type ClinicalCoreTransaction } from "./database";
import { createRdsDataAdministrativeDatabase } from "./rds-data-database";

const ORG = "71000000-0000-4000-8000-000000000001";
const OTHER_ORG = "71000000-0000-4000-8000-000000000002";
const WORKFORCE = "72000000-0000-4000-8000-000000000001";
const CONSUMER = "73000000-0000-4000-8000-000000000001";
const LAB_ARTIFACT = "74000000-0000-4000-8000-000000000001";
const PROTOCOL_ARTIFACT = "74000000-0000-4000-8000-000000000002";
const STABLE_RECORD = "75000000-0000-4000-8000-000000000001";
const WORKFORCE_SUBJECT = "acceptance-workforce-subject-01";
const CONSUMER_SUBJECT = "acceptance-consumer-subject-01";
const TOKEN_HASH = "a".repeat(64);
const LAB_HASH = "b".repeat(64);
const RECORD_HASH = "c".repeat(64);

class RollbackSuccess extends Error {
  constructor() { super("rollback_success"); }
}

type AcceptanceEvidence = {
  patientCreated: boolean;
  connectionVerified: boolean;
  explicitLabConsent: boolean;
  providerRegistered: boolean;
  labImported: boolean;
  duplicateProtected: boolean;
  clinicianAccepted: boolean;
  biomarkerReviewIdempotent: boolean;
  clinicalRecordTransferred: boolean;
  clinicalRecordDuplicateProtected: boolean;
  provenancePreserved: boolean;
  crossTenantRefused: boolean;
  auditEventCount: number;
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("configuration_refused");
  return value;
}

async function setContext(
  tx: ClinicalCoreTransaction,
  actor: string,
  organization: string,
  pool: "workforce" | "consumer",
  subject: string,
  purpose: "identity_link" | "consent_management" | "clinical_data",
) {
  await tx.query("select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)", [
    clinicalUuid(actor), clinicalUuid(organization), pool, subject, purpose,
    "production-clinical", "clinical_phi",
  ]);
}

function row<Row extends Record<string, unknown>>(result: { rows: Row[] }): Row {
  const value = result.rows[0];
  if (!value) throw new Error("acceptance_row_missing");
  return value;
}

function json(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return JSON.parse(value) as Record<string, unknown>;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("acceptance_json_invalid");
  return value as Record<string, unknown>;
}

async function acceptance(tx: ClinicalCoreTransaction): Promise<AcceptanceEvidence> {
  await tx.query(`insert into clinical_core.organizations(
    id,organization_label,environment,data_classification,contains_phi,status
  ) values ($1,$2,'production-clinical','clinical_phi',true,'active')`, [
    clinicalUuid(ORG), "Rollback acceptance organization",
  ]);
  await tx.query(`insert into clinical_core.persons(
    id,subject_key,data_classification,contains_phi,status
  ) values
    ($1,'subject_acceptance_workforce_01','clinical_phi',true,'active'),
    ($2,'subject_acceptance_consumer_01','clinical_phi',true,'active')`, [
    clinicalUuid(WORKFORCE), clinicalUuid(CONSUMER),
  ]);
  await tx.query(`insert into clinical_core.identities(
    person_id,identity_pool,identity_subject,production_bound,status
  ) values ($1,'workforce',$2,true,'active'),($3,'consumer',$4,true,'active')`, [
    clinicalUuid(WORKFORCE), WORKFORCE_SUBJECT, clinicalUuid(CONSUMER), CONSUMER_SUBJECT,
  ]);
  await tx.query(`insert into clinical_core.organization_memberships(
    organization_id,person_id,role,status
  ) values ($1,$2,'practitioner','active')`, [clinicalUuid(ORG), clinicalUuid(WORKFORCE)]);

  await setContext(tx, WORKFORCE, ORG, "workforce", WORKFORCE_SUBJECT, "clinical_data");
  const patient = json(row(await tx.query<{ data: unknown }>(
    "select clinical_core.create_patient_profile($1,$2,$3,$4::date,$5,$6,$7,$8) as data",
    [clinicalUuid(ORG), "Rollback", "Acceptance", "1980-01-01", "unknown", "ACCEPT-001", null, null],
  )).data);
  const patientId = String(patient.id ?? "");

  await setContext(tx, WORKFORCE, ORG, "workforce", WORKFORCE_SUBJECT, "identity_link");
  const invitation = row(await tx.query<{ connection_id: string }>(
    "select * from clinical_core.issue_connection_invitation($1,$2,$3,$4::timestamptz,$5)",
    [clinicalUuid(ORG), clinicalUuid(patientId), TOKEN_HASH, new Date(Date.now() + 3_600_000).toISOString(), "acceptance:invitation:01"],
  ));
  const connectionId = invitation.connection_id;

  await setContext(tx, CONSUMER, ORG, "consumer", CONSUMER_SUBJECT, "identity_link");
  const connection = row(await tx.query<{ state: string }>(
    "select * from clinical_core.claim_connection_invitation($1,$2)",
    [TOKEN_HASH, clinicalUuid(CONSUMER)],
  ));

  await tx.query(`insert into clinical_core.consent_artifacts(
    id,organization_id,scope,artifact_version,content_sha256,jurisdiction,status,
    approved_at,approved_by_person_id
  ) values
    ($1,$2,'lab_results_import','acceptance-lab/1',$3,'US','approved',clock_timestamp(),$4),
    ($5,$2,'protocols_supplements','acceptance-protocol/1',$6,'US','approved',clock_timestamp(),$4)`, [
    clinicalUuid(LAB_ARTIFACT), clinicalUuid(ORG), "d".repeat(64), clinicalUuid(WORKFORCE),
    clinicalUuid(PROTOCOL_ARTIFACT), "e".repeat(64),
  ]);
  await tx.query(`insert into clinical_core.sync_providers(
    organization_id,stable_id,contract_version,lab_contract_version,adapter_version,
    state,reviewed_by_person_id,reviewed_at
  ) values ($1,'alp_patient_sync','patient-sync/1','lab-result/1','production-candidate/1',
    'active',$2,clock_timestamp())`, [clinicalUuid(ORG), clinicalUuid(WORKFORCE)]);

  await setContext(tx, CONSUMER, ORG, "consumer", CONSUMER_SUBJECT, "consent_management");
  await tx.query("select * from clinical_core.record_consent_grant($1,$2,'lab_results_import','patient_app','self')", [
    clinicalUuid(connectionId), clinicalUuid(LAB_ARTIFACT),
  ]);
  await tx.query("select * from clinical_core.record_consent_grant($1,$2,'protocols_supplements','patient_app','self')", [
    clinicalUuid(connectionId), clinicalUuid(PROTOCOL_ARTIFACT),
  ]);

  await setContext(tx, CONSUMER, ORG, "consumer", CONSUMER_SUBJECT, "clinical_data");
  const occurredAt = new Date().toISOString();
  const labArguments = [
    clinicalUuid(connectionId), "alp_patient_sync", "lab:acceptance:event:01",
    "panel_acceptance_01", "marker_acceptance_01", "version:acceptance:01",
    "Rollback panel", "AI Longevity Pro V2", "Rollback marker", 42,
    "unit", 10, 50, "normal", occurredAt, occurredAt, LAB_HASH,
  ] as const;
  const firstLab = row(await tx.query<{ event_id: string; state: string; duplicate: boolean }>(
    "select * from clinical_core.record_lab_import($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::timestamptz,$16::timestamptz,$17)",
    labArguments,
  ));
  const duplicateLab = row(await tx.query<{ duplicate: boolean }>(
    "select * from clinical_core.record_lab_import($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::timestamptz,$16::timestamptz,$17)",
    labArguments,
  ));

  const recordArguments = [
    clinicalUuid(connectionId), clinicalUuid(STABLE_RECORD), "protocols", "record:acceptance:01",
    "version:acceptance:01", "write:acceptance:01", JSON.stringify({ id: STABLE_RECORD, title: "Rollback protocol" }),
    RECORD_HASH, false,
  ] as const;
  const firstRecord = row(await tx.query<{ duplicate: boolean }>(
    "select * from clinical_core.record_consumer_clinical_version($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)",
    recordArguments,
  ));
  const duplicateRecord = row(await tx.query<{ duplicate: boolean }>(
    "select * from clinical_core.record_consumer_clinical_version($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)",
    recordArguments,
  ));

  await tx.query("savepoint tenant_isolation_probe");
  let crossTenantRefused = false;
  try {
    await setContext(tx, CONSUMER, OTHER_ORG, "consumer", CONSUMER_SUBJECT, "clinical_data");
    await tx.query("select * from clinical_core.list_patient_lab_observations($1)", [clinicalUuid(patientId)]);
  } catch (error) {
    crossTenantRefused = error instanceof ClinicalCoreDatabaseRejection;
    await tx.query("rollback to savepoint tenant_isolation_probe");
  }
  if (!crossTenantRefused) throw new Error("cross_tenant_probe_failed");

  const versions = await tx.query(
    "select * from clinical_core.list_consumer_clinical_records($1,'protocols',null,null,100)",
    [clinicalUuid(connectionId)],
  );

  await setContext(tx, WORKFORCE, ORG, "workforce", WORKFORCE_SUBJECT, "clinical_data");
  const review = row(await tx.query<{ state: string; observation_id: string; duplicate: boolean }>(
    "select * from clinical_core.review_lab_import($1,'accept',null)", [clinicalUuid(firstLab.event_id)],
  ));
  const firstBiomarkerReview = json(row(await tx.query<{ data: unknown }>(
    "select clinical_core.review_biomarker($1,'accepted',null) as data", [clinicalUuid(review.observation_id)],
  )).data);
  const duplicateBiomarkerReview = json(row(await tx.query<{ data: unknown }>(
    "select clinical_core.review_biomarker($1,'accepted',null) as data", [clinicalUuid(review.observation_id)],
  )).data);
  const observations = await tx.query<{ provenance: unknown }>(
    "select * from clinical_core.list_patient_lab_observations($1)", [clinicalUuid(patientId)],
  );
  const counts = row(await tx.query<{ audit_count: number }>(
    "select count(*)::int as audit_count from clinical_audit.events where organization_id=$1",
    [clinicalUuid(ORG)],
  ));
  const provenance = json(observations.rows[0]?.provenance);

  return {
    patientCreated: Boolean(patientId),
    connectionVerified: connection.state === "verified",
    explicitLabConsent: true,
    providerRegistered: true,
    labImported: firstLab.state === "review_pending" && firstLab.duplicate === false,
    duplicateProtected: duplicateLab.duplicate === true,
    clinicianAccepted: review.state === "accepted" && review.duplicate === false,
    biomarkerReviewIdempotent: firstBiomarkerReview.already_set === false
      && duplicateBiomarkerReview.already_set === true,
    clinicalRecordTransferred: firstRecord.duplicate === false && versions.rows.length === 1,
    clinicalRecordDuplicateProtected: duplicateRecord.duplicate === true,
    provenancePreserved: provenance.sourceSystem === "ai_longevity_pro_v2"
      && provenance.payloadSha256 === LAB_HASH,
    crossTenantRefused,
    auditEventCount: Number(counts.audit_count),
  };
}

async function run() {
  if (required("PHI_ALLOWED") !== "false" || required("CONFIRM_ROLLBACK_ONLY") !== "true") {
    throw new Error("activation_boundary_refused");
  }
  const clusterArn = required("CLINICAL_DATABASE_CLUSTER_ARN");
  const account = required("EXPECTED_AWS_ACCOUNT_ID");
  if (!clusterArn.includes(`:${account}:cluster:`)) throw new Error("account_boundary_refused");
  const database = createRdsDataAdministrativeDatabase({
    clusterArn,
    secretArn: required("CLINICAL_DATABASE_SECRET_ARN"),
    databaseName: required("CLINICAL_DATABASE_NAME"),
    region: required("AWS_REGION"),
  }, { purpose: "reviewed_production_schema_migration" });

  let evidence: AcceptanceEvidence | undefined;
  try {
    await database.transaction(async (tx) => {
      evidence = await acceptance(tx);
      if (!Object.entries(evidence).every(([key, value]) => key === "auditEventCount" ? Number(value) >= 10 : value === true)) {
        throw new Error("acceptance_invariant_failed");
      }
      throw new RollbackSuccess();
    });
  } catch (error) {
    if (!(error instanceof RollbackSuccess)) throw error;
  }
  if (!evidence) throw new Error("acceptance_evidence_missing");
  const evidenceHash = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
  console.log(JSON.stringify({ mode: "production_contract_rollback_only", ...evidence, evidenceHash }));
}

run().catch((error) => {
  console.error(error instanceof Error && /^[a-z0-9_:.-]+$/.test(error.message)
    ? error.message : "production_acceptance_failed");
  process.exitCode = 1;
});
