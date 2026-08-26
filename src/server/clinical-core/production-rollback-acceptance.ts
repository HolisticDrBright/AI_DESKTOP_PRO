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
const LAB_SUMMARY_ARTIFACT = "74000000-0000-4000-8000-000000000003";
const STABLE_RECORD = "75000000-0000-4000-8000-000000000001";
const SYNC_WORKER = "76000000-0000-4000-8000-000000000001";
const CATALOG_BATCH = "77000000-0000-4000-8000-000000000001";
const CATALOG_PRODUCT_VERSION = "77000000-0000-4000-8000-000000000002";
const CATALOG_OFFER_VERSION = "77000000-0000-4000-8000-000000000003";
const TEMPLATE_VERSION_ONE = "77000000-0000-4000-8000-000000000004";
const TEMPLATE_VERSION_TWO = "77000000-0000-4000-8000-000000000005";
const SUCCESSOR_TEMPLATE_VERSION = "77000000-0000-4000-8000-000000000006";
const WORKFORCE_SUBJECT = "acceptance-workforce-subject-01";
const CONSUMER_SUBJECT = "acceptance-consumer-subject-01";
const LAB_HASH = "b".repeat(64);
const RECORD_HASH = "c".repeat(64);

class RollbackSuccess extends Error {
  constructor() { super("rollback_success"); }
}

let acceptanceStage = "not_started";

type AcceptanceEvidence = {
  patientCreated: boolean;
  connectionVerified: boolean;
  shortInvitationCode: boolean;
  connectionLifecycleVersioned: boolean;
  desktopConsentGoverned: boolean;
  syncOverviewBounded: boolean;
  syncOperationsBounded: boolean;
  connectionRevokeCascade: boolean;
  explicitLabConsent: boolean;
  providerRegistered: boolean;
  providerReviewed: boolean;
  labImported: boolean;
  duplicateProtected: boolean;
  clinicianAccepted: boolean;
  biomarkerReviewIdempotent: boolean;
  clinicalRecordTransferred: boolean;
  clinicalRecordDuplicateProtected: boolean;
  provenancePreserved: boolean;
  workerClaimed: boolean;
  outboundAcknowledged: boolean;
  callbackReplayProtected: boolean;
  inboundLabReviewPending: boolean;
  inboundDuplicateProtected: boolean;
  inboundChartMaterialized: boolean;
  crossTenantRefused: boolean;
  auditEventCount: number;
  catalogListGoverned: boolean;
  labelVerificationAttributed: boolean;
  commercialClinicalSeparated: boolean;
  templateDetailDerived: boolean;
  templateComparisonBounded: boolean;
  safetyReviewAppendOnly: boolean;
  templateSuperseded: boolean;
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
  acceptanceStage = "seed_identity";
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
  ) values ($1,$2,'admin','active')`, [clinicalUuid(ORG), clinicalUuid(WORKFORCE)]);

  await setContext(tx, WORKFORCE, ORG, "workforce", WORKFORCE_SUBJECT, "clinical_data");
  acceptanceStage = "seed_governed_catalog";
  await tx.query(`insert into clinical_reference.catalog_import_batches(
    id,contract_version,source_package_id,source_package_version,manifest_sha256,
    environment,data_classification,contains_phi,status,product_count,protocol_template_count,completed_at
  ) values ($1,'governed-catalog-seed/1','rollback_acceptance','1.0.0',$2,
    'production-clinical','reference_only',false,'succeeded',1,2,clock_timestamp())`, [
    clinicalUuid(CATALOG_BATCH), "1".repeat(64),
  ]);
  await tx.query(`insert into clinical_reference.catalog_products(
    stable_id,review_status,active_version,environment,data_classification,contains_phi
  ) values ('prd_rollback_acceptance','approved',1,'production-clinical','reference_only',false)`);
  await tx.query(`insert into clinical_reference.catalog_product_versions(
    id,product_stable_id,version,display_name,brand,product_type,access_tier,
    declared_restricted,direct_order_allowed,label_sha256,content_sha256,clinical_payload,
    source_refs,review_status,import_batch_id
  ) values ($1,'prd_rollback_acceptance',1,'Rollback catalog product','Acceptance brand',
    'supplement','open',false,true,$2,$3,$4::jsonb,$5::jsonb,'approved',$6)`, [
    clinicalUuid(CATALOG_PRODUCT_VERSION), "2".repeat(64), "3".repeat(64),
    JSON.stringify({ servingSize: "One capsule", ingredientRows: [{ name: "Acceptance ingredient" }],
      warnings: "Practitioner review required", sku: "ACCEPT-001" }),
    JSON.stringify([{ sourceId: "src_rollback_acceptance" }]), clinicalUuid(CATALOG_BATCH),
  ]);
  await tx.query(`insert into commercial_reference.affiliate_offers(
    stable_id,product_stable_id,review_status,active_version
  ) values ('off_rollback_acceptance','prd_rollback_acceptance','approved',1)`);
  await tx.query(`insert into commercial_reference.affiliate_offer_versions(
    id,offer_stable_id,version,kind,destination_url,supplier_name,commission_disclosure,
    availability_status,declared_restricted,direct_order_allowed,content_sha256,
    review_status,environment,import_batch_id,last_verified_at
  ) values ($1,'off_rollback_acceptance',1,'affiliate','https://example.test/catalog',
    'Acceptance supplier','A commission may be earned.','available',false,true,$2,
    'approved','production-clinical',$3,clock_timestamp())`, [
    clinicalUuid(CATALOG_OFFER_VERSION), "4".repeat(64), clinicalUuid(CATALOG_BATCH),
  ]);
  acceptanceStage = "verify_catalog_label";
  await tx.query("select clinical_core.verify_product_label_version($1,$2)", [
    clinicalUuid(CATALOG_PRODUCT_VERSION), "Rollback-only exact label review",
  ]);
  acceptanceStage = "read_governed_catalog";
  const catalog = json(row(await tx.query<{ data: unknown }>(
    "select clinical_core.get_product_catalog($1,null,null,100) as data", [clinicalUuid(ORG)],
  )).data);
  const labelDetail = json(row(await tx.query<{ data: unknown }>(
    "select clinical_core.get_product_label_detail($1) as data", [clinicalUuid(CATALOG_PRODUCT_VERSION)],
  )).data);

  acceptanceStage = "seed_governed_templates";
  await tx.query(`insert into clinical_reference.protocol_templates(
    stable_id,review_status,active_version,environment,data_classification,contains_phi
  ) values
    ('tpl_rollback_acceptance','approved',2,'production-clinical','reference_only',false),
    ('tpl_rollback_successor','approved',1,'production-clinical','reference_only',false)`);
  await tx.query(`insert into clinical_reference.protocol_template_versions(
    id,template_stable_id,version,title,summary,content_sha256,source_refs,
    review_status,approved_at,import_batch_id
  ) values
    ($1,'tpl_rollback_acceptance',1,'Rollback template v1','First reviewed version',$2,$3::jsonb,
      'approved',clock_timestamp(),$4),
    ($5,'tpl_rollback_acceptance',2,'Rollback template v2','Second reviewed version',$6,$3::jsonb,
      'approved',clock_timestamp(),$4),
    ($7,'tpl_rollback_successor',1,'Rollback successor','Reviewed successor',$8,$3::jsonb,
      'approved',clock_timestamp(),$4)`, [
    clinicalUuid(TEMPLATE_VERSION_ONE), "5".repeat(64),
    JSON.stringify([{ sourceId: "src_rollback_acceptance" }]), clinicalUuid(CATALOG_BATCH),
    clinicalUuid(TEMPLATE_VERSION_TWO), "6".repeat(64),
    clinicalUuid(SUCCESSOR_TEMPLATE_VERSION), "7".repeat(64),
  ]);
  await tx.query(`insert into clinical_reference.protocol_template_items(
    template_version_id,position,product_stable_id,label,kind,instructions,dosage_text,
    timing_text,route,dose_source_kind,dose_source_ref,monitoring_requirements,
    stopping_rules,contraindications
  ) values
    ($1,1,'prd_rollback_acceptance','Acceptance product','supplement','Review before use',
      'One capsule','Daily','oral','label','src_rollback_acceptance','[]'::jsonb,
      '["Stop and review"]'::jsonb,'[]'::jsonb),
    ($2,1,'prd_rollback_acceptance','Acceptance product','supplement','Review before use',
      'Two capsules','Daily','oral','label','src_rollback_acceptance','[]'::jsonb,
      '["Stop and review"]'::jsonb,'[]'::jsonb),
    ($3,1,'prd_rollback_acceptance','Acceptance product','supplement','Review before use',
      'Two capsules','Daily','oral','label','src_rollback_acceptance','[]'::jsonb,
      '["Stop and review"]'::jsonb,'[]'::jsonb)`, [
    clinicalUuid(TEMPLATE_VERSION_ONE), clinicalUuid(TEMPLATE_VERSION_TWO),
    clinicalUuid(SUCCESSOR_TEMPLATE_VERSION),
  ]);
  acceptanceStage = "review_governed_template";
  const templateDetail = json(row(await tx.query<{ data: unknown }>(
    "select clinical_core.get_protocol_template_detail('tpl_rollback_acceptance') as data",
  )).data);
  const comparison = json(row(await tx.query<{ data: unknown }>(
    "select clinical_core.compare_protocol_template_versions($1,$2) as data", [
      clinicalUuid(TEMPLATE_VERSION_ONE), clinicalUuid(TEMPLATE_VERSION_TWO),
    ],
  )).data);
  const safetyReview = json(row(await tx.query<{ data: unknown }>(
    "select clinical_core.record_protocol_template_safety_review($1,'passed',$2) as data", [
      clinicalUuid(TEMPLATE_VERSION_TWO), "Rollback-only sourced-dose review",
    ],
  )).data);
  const superseded = json(row(await tx.query<{ data: unknown }>(
    "select clinical_core.supersede_protocol_template('tpl_rollback_acceptance','tpl_rollback_successor',$1) as data",
    ["Rollback-only reviewed successor"],
  )).data);

  acceptanceStage = "create_patient";
  const patient = json(row(await tx.query<{ data: unknown }>(
    "select clinical_core.create_patient_profile($1,$2,$3,$4::date,$5,$6,$7,$8) as data",
    [clinicalUuid(ORG), "Rollback", "Acceptance", "1980-01-01", "unknown", "ACCEPT-001", null, null],
  )).data);
  const patientId = String(patient.id ?? "");

  acceptanceStage = "create_short_invitation";
  const invitation = json(row(await tx.query<{ data: unknown }>(
    "select clinical_core.create_sync_invitation($1,$2) as data",
    [clinicalUuid(ORG), clinicalUuid(patientId)],
  )).data);
  const connectionId = String(invitation.connectionId ?? "");
  const invitationToken = String(invitation.token ?? "");
  const tokenHash = createHash("sha256").update(invitationToken).digest("hex");

  await setContext(tx, CONSUMER, ORG, "consumer", CONSUMER_SUBJECT, "identity_link");
  acceptanceStage = "claim_invitation";
  const connection = row(await tx.query<{ state: string }>(
    "select * from clinical_core.claim_connection_invitation($1,$2)",
    [tokenHash, clinicalUuid(CONSUMER)],
  ));

  await setContext(tx, WORKFORCE, ORG, "workforce", WORKFORCE_SUBJECT, "clinical_data");
  acceptanceStage = "pause_connection";
  const paused = json(row(await tx.query<{ data: unknown }>(
    "select clinical_core.pause_sync_connection($1,1) as data", [clinicalUuid(connectionId)],
  )).data);
  acceptanceStage = "resume_connection";
  const resumed = json(row(await tx.query<{ data: unknown }>(
    "select clinical_core.resume_sync_connection($1,2) as data", [clinicalUuid(connectionId)],
  )).data);

  acceptanceStage = "seed_consent_provider";
  acceptanceStage = "seed_consent_artifacts";
  await tx.query(`insert into clinical_core.consent_artifacts(
    id,organization_id,scope,artifact_version,content_sha256,jurisdiction,status,
    approved_at,approved_by_person_id
  ) values
    ($1,$2,'lab_results_import','acceptance-lab/1',$3,'US','approved',clock_timestamp(),$4),
    ($5,$2,'protocols_supplements','acceptance-protocol/1',$6,'US','approved',clock_timestamp(),$4),
    ($7,$2,'lab_summaries','acceptance-lab-summary/1',$8,'US','approved',clock_timestamp(),$4)`, [
    clinicalUuid(LAB_ARTIFACT), clinicalUuid(ORG), "d".repeat(64), clinicalUuid(WORKFORCE),
    clinicalUuid(PROTOCOL_ARTIFACT), "e".repeat(64),
    clinicalUuid(LAB_SUMMARY_ARTIFACT), "a".repeat(64),
  ]);
  acceptanceStage = "register_sync_provider";
  const providerRegistration = json(row(await tx.query<{ data: unknown }>(
    "select clinical_core.register_sync_provider($1,'aws-production-candidate/1') as data",
    [clinicalUuid(ORG)],
  )).data);
  acceptanceStage = "review_sync_provider";
  const providerReview = json(row(await tx.query<{ data: unknown }>(
    "select clinical_core.review_sync_provider($1,'approve',$2::integer) as data",
    [clinicalUuid(String(providerRegistration.providerId)), Number(providerRegistration.version)],
  )).data);

  await setContext(tx, CONSUMER, ORG, "consumer", CONSUMER_SUBJECT, "consent_management");
  acceptanceStage = "consumer_lab_consent";
  await tx.query("select * from clinical_core.record_consent_grant($1,$2,'lab_results_import','patient_app','self')", [
    clinicalUuid(connectionId), clinicalUuid(LAB_ARTIFACT),
  ]);
  await setContext(tx, WORKFORCE, ORG, "workforce", WORKFORCE_SUBJECT, "clinical_data");
  acceptanceStage = "desktop_protocol_consent";
  const desktopConsent = json(row(await tx.query<{ data: unknown }>(
    `select clinical_core.set_sync_consent_scope(
      $1,'protocols_supplements',true,'Governed consent artifact','acceptance-protocol/1','US','in_person','self'
    ) as data`, [clinicalUuid(connectionId)],
  )).data);

  await setContext(tx, CONSUMER, ORG, "consumer", CONSUMER_SUBJECT, "clinical_data");
  acceptanceStage = "clinical_transfer";
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
  acceptanceStage = "tenant_isolation";
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
  acceptanceStage = "clinical_review";
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

  acceptanceStage = "aws_worker_roundtrip";
  acceptanceStage = "grant_lab_summary_consent";
  await tx.query(`select clinical_core.set_sync_consent_scope(
    $1,'lab_summaries',true,'Governed consent artifact','acceptance-lab-summary/1','US','in_person','self'
  )`, [clinicalUuid(connectionId)]);
  acceptanceStage = "queue_sync_lab_summary";
  const queued = json(row(await tx.query<{ data: unknown }>(
    "select clinical_core.queue_sync_export($1,'lab_summary',$2) as data",
    [clinicalUuid(connectionId), clinicalUuid(patientId)],
  )).data);
  acceptanceStage = "assume_sync_worker_role";
  await tx.query("set local role clinical_sync_worker");
  acceptanceStage = "claim_sync_outbound";
  const claimed = json(row(await tx.query<{ data: unknown }>(
    "select clinical_core.claim_sync_outbound($1,10,120,$2) as data",
    [clinicalUuid(ORG), clinicalUuid(SYNC_WORKER)],
  )).data);
  const claimedEvents = Array.isArray(claimed.events) ? claimed.events as Array<Record<string, unknown>> : [];
  const claimedEvent = claimedEvents[0];
  if (!claimedEvent) throw new Error("acceptance_claim_missing");
  const claimedEventUid = String(claimedEvent.eventUid ?? "");
  acceptanceStage = "recheck_sync_export";
  const rechecked = json(row(await tx.query<{ data: unknown }>(
    "select clinical_core.recheck_sync_export($1) as data", [clinicalUuid(claimedEventUid)],
  )).data);
  acceptanceStage = "record_sync_delivered";
  await tx.query("select clinical_core.record_sync_delivery($1,$2,'delivered',clock_timestamp(),null,null)", [
    clinicalUuid(claimedEventUid), "alp:acceptance:delivered:01",
  ]);
  acceptanceStage = "record_sync_acknowledged";
  const acknowledged = json(row(await tx.query<{ data: unknown }>(
    "select clinical_core.record_sync_delivery($1,$2,'acknowledged',clock_timestamp(),null,null) as data", [
      clinicalUuid(claimedEventUid), "alp:acceptance:ack:0001",
    ],
  )).data);
  acceptanceStage = "register_callback_nonce";
  const nonceOne = json(row(await tx.query<{ data: unknown }>(
    "select clinical_core.register_sync_callback_nonce($1,'alp_patient_sync',$2) as data",
    [clinicalUuid(ORG), "acceptance_nonce_00000001"],
  )).data);
  acceptanceStage = "register_callback_replay";
  const nonceTwo = json(row(await tx.query<{ data: unknown }>(
    "select clinical_core.register_sync_callback_nonce($1,'alp_patient_sync',$2) as data",
    [clinicalUuid(ORG), "acceptance_nonce_00000001"],
  )).data);
  const inboundPayload = {
    panelId: "panel_acceptance_worker_01",
    panelName: "Rollback worker panel",
    sourceLabel: "AI Longevity Pro V2",
    collectedAt: occurredAt,
    markers: [{ markerId: "marker_acceptance_worker_01", markerName: "Rollback worker marker",
      value: 44, unit: "unit", referenceMin: 10, referenceMax: 50, sourceStatus: "normal" }],
  };
  const inboundArguments = [
    clinicalUuid(connectionId), "lab:acceptance:worker:01", "lab-result/1", "lab_result",
    JSON.stringify(inboundPayload), "f".repeat(64), occurredAt, "panel_acceptance_worker_01",
    "version:acceptance:worker:01", null, null,
  ] as const;
  acceptanceStage = "record_sync_lab_result";
  const inbound = json(row(await tx.query<{ data: unknown }>(
    "select clinical_core.record_sync_lab_result($1,$2,$3,$4,$5::jsonb,$6,$7::timestamptz,$8,$9,$10,$11) as data",
    inboundArguments,
  )).data);
  acceptanceStage = "record_sync_lab_duplicate";
  const inboundDuplicate = json(row(await tx.query<{ data: unknown }>(
    "select clinical_core.record_sync_lab_result($1,$2,$3,$4,$5::jsonb,$6,$7::timestamptz,$8,$9,$10,$11) as data",
    inboundArguments,
  )).data);
  acceptanceStage = "restore_workforce_role";
  await tx.query("reset role");
  await setContext(tx, WORKFORCE, ORG, "workforce", WORKFORCE_SUBJECT, "clinical_data");
  acceptanceStage = "review_sync_lab_inbound";
  const inboundReview = json(row(await tx.query<{ data: unknown }>(
    "select clinical_core.review_sync_inbound($1,'accept',null) as data",
    [clinicalUuid(String(inbound.eventId))],
  )).data);
  acceptanceStage = "list_materialized_sync_labs";
  const finalObservations = await tx.query(
    "select * from clinical_core.list_patient_lab_observations($1)", [clinicalUuid(patientId)],
  );
  acceptanceStage = "sync_overview";
  const overview = json(row(await tx.query<{ data: unknown }>(
    "select clinical_core.get_patient_sync_overview($1) as data", [clinicalUuid(patientId)],
  )).data);
  acceptanceStage = "sync_operations";
  const operations = json(row(await tx.query<{ data: unknown }>(
    "select clinical_core.get_org_sync_operations($1) as data", [clinicalUuid(ORG)],
  )).data);
  acceptanceStage = "connection_revoke";
  await tx.query("savepoint connection_revoke_probe");
  const revoked = json(row(await tx.query<{ data: unknown }>(
    "select clinical_core.revoke_sync_connection($1,3,'rollback acceptance probe') as data",
    [clinicalUuid(connectionId)],
  )).data);
  const revokedScopes = await tx.query<{ status: string }>(
    "select status from clinical_core.current_consent where connection_id=$1 order by scope",
    [clinicalUuid(connectionId)],
  );
  const connectionRevokeCascade = revoked.state === "revoked"
    && revoked.version === 4
    && revokedScopes.rows.length === 3
    && revokedScopes.rows.every((scope) => scope.status === "revoked");
  await tx.query("rollback to savepoint connection_revoke_probe");

  const catalogClinical = json(catalog.clinical);
  const catalogProducts = Array.isArray(catalogClinical.products)
    ? catalogClinical.products as Array<Record<string, unknown>> : [];
  const labelClinical = json(labelDetail.clinical);
  const labelCommercial = json(labelDetail.commercial);
  return {
    patientCreated: Boolean(patientId),
    connectionVerified: connection.state === "verified",
    shortInvitationCode: /^[A-Z0-9_-]{10}$/.test(invitationToken)
      && invitation.token === invitationToken && invitationToken.length === 10,
    connectionLifecycleVersioned: paused.state === "paused" && paused.version === 2
      && resumed.state === "verified" && resumed.version === 3,
    desktopConsentGoverned: desktopConsent.status === "granted"
      && desktopConsent.scope === "protocols_supplements",
    syncOverviewBounded: overview.deliveryEnabled === false
      && Array.isArray(overview.outbound) && overview.outbound.length <= 50
      && Array.isArray(overview.inbound) && overview.inbound.length <= 50,
    syncOperationsBounded: operations.providerConfigured === true
      && json(operations.connections).verified === 1
      && json(operations.outbound).queued === 0,
    connectionRevokeCascade,
    explicitLabConsent: true,
    providerRegistered: providerRegistration.state === "pending_review",
    providerReviewed: providerReview.state === "active" && providerReview.deliveryEnabled === false,
    labImported: firstLab.state === "review_pending" && firstLab.duplicate === false,
    duplicateProtected: duplicateLab.duplicate === true,
    clinicianAccepted: review.state === "accepted" && review.duplicate === false,
    biomarkerReviewIdempotent: firstBiomarkerReview.already_set === false
      && duplicateBiomarkerReview.already_set === true,
    clinicalRecordTransferred: firstRecord.duplicate === false && versions.rows.length === 1,
    clinicalRecordDuplicateProtected: duplicateRecord.duplicate === true,
    provenancePreserved: provenance.sourceSystem === "ai_longevity_pro_v2"
      && provenance.payloadSha256 === LAB_HASH,
    workerClaimed: String(queued.eventId ?? "") === claimedEventUid && rechecked.deliverable === true,
    outboundAcknowledged: acknowledged.state === "delivered" && acknowledged.duplicate === false,
    callbackReplayProtected: nonceOne.replay === false && nonceTwo.replay === true,
    inboundLabReviewPending: inbound.state === "review_pending" && inbound.chartMaterialized === false,
    inboundDuplicateProtected: inboundDuplicate.duplicate === true,
    inboundChartMaterialized: inboundReview.state === "accepted"
      && inboundReview.chartMaterialized === true && finalObservations.rows.length === 2,
    crossTenantRefused,
    auditEventCount: Number(counts.audit_count),
    catalogListGoverned: catalogProducts.length === 1
      && catalogProducts[0]?.productCode === "prd_rollback_acceptance",
    labelVerificationAttributed: labelClinical.verificationState === "verified"
      && typeof labelClinical.verifiedAt === "string",
    commercialClinicalSeparated: Array.isArray(labelCommercial.links)
      && labelCommercial.links.length === 1
      && !JSON.stringify(labelClinical).includes("example.test"),
    templateDetailDerived: templateDetail.templateId === "tpl_rollback_acceptance"
      && templateDetail.unsourcedDoseCount === 0
      && Array.isArray(templateDetail.patientInstructionPreview),
    templateComparisonBounded: comparison.sameTemplate === true
      && comparison.doseChangeCount === 1,
    safetyReviewAppendOnly: safetyReview.ok === true
      && safetyReview.outcome === "passed" && safetyReview.unsourcedDoseCount === 0,
    templateSuperseded: superseded.ok === true
      && superseded.supersededBy === "tpl_rollback_successor",
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
      const failed = Object.entries(evidence)
        .filter(([key, value]) => key === "auditEventCount" ? Number(value) < 10 : value !== true)
        .map(([key]) => key);
      if (failed.length > 0) {
        throw new Error(`acceptance_invariant_failed:${failed.join(":").toLowerCase()}`);
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
  if (error instanceof Error && error.message === "query_failed") {
    console.error(`acceptance_${acceptanceStage}_failed`);
    process.exitCode = 1;
    return;
  }
  console.error(error instanceof Error && /^[a-z0-9_:.-]+$/.test(error.message)
    ? error.message : "production_acceptance_failed");
  process.exitCode = 1;
});
