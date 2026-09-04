if (typeof window !== "undefined") {
  throw new Error("clinical-core/aws-governed-catalog-review is server-only.");
}

import { clinicalUuid, type ClinicalCoreDatabase, type ClinicalCoreTransaction } from "./database";
import type { CatalogEnvironment } from "./aws-governed-catalog-reader";
import {
  catalogSha256,
  productContentForHash,
  validateGovernedCatalogManifest,
  type CatalogProductSeed,
  type GovernedCatalogSeedManifest,
} from "./aws-governed-catalog";

export type CatalogReviewSubject =
  | "product_version"
  | "product_label_version"
  | "protocol_template_version"
  | "affiliate_offer_version"
  | "safety_rule_version"
  | "knowledge_source_version";
export type CatalogReviewOutcome = "approved" | "rejected" | "changes_requested";

export type CatalogReviewInput = {
  subjectType: CatalogReviewSubject;
  stableId: string;
  version: number;
  reviewerPersonId: string;
  outcome: CatalogReviewOutcome;
  reason: string;
  environment: CatalogEnvironment;
};

export type CatalogReviewResult = {
  subjectType: CatalogReviewSubject;
  stableId: string;
  version: number;
  outcome: CatalogReviewOutcome;
  selectable: boolean;
  reviewedAt: string;
};

export type CatalogReleaseApprovalResult = {
  manifestSha256: string;
  outcome: "approved";
  counts: {
    products: number;
    productLabels: number;
    protocolTemplates: number;
    safetyRules: number;
    knowledgeSources: number;
    commercialOffers: 0;
  };
};

export type CommercialCatalogActivationResult = {
  outcome: "approved";
  selectionSha256: string;
  productsActivated: number;
  offersActivated: number;
};

export class GovernedCatalogReviewError extends Error {
  constructor(readonly category:
    | "review_request_invalid"
    | "review_subject_not_found"
    | "review_precondition_failed"
    | "database_unavailable") {
    super(category);
    this.name = "GovernedCatalogReviewError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDS: Record<CatalogReviewSubject, RegExp> = {
  product_version: /^prd_[a-z0-9][a-z0-9_-]{2,95}$/,
  product_label_version: /^lbl_[a-z0-9][a-z0-9_-]{2,95}$/,
  protocol_template_version: /^tpl_[a-z0-9][a-z0-9_-]{2,95}$/,
  affiliate_offer_version: /^off_[a-z0-9][a-z0-9_-]{2,95}$/,
  safety_rule_version: /^saf_[a-z0-9][a-z0-9_-]{2,95}$/,
  knowledge_source_version: /^src_[a-z0-9][a-z0-9_-]{2,95}$/,
};

export async function reviewGovernedCatalogVersion(
  database: ClinicalCoreDatabase,
  input: CatalogReviewInput,
): Promise<CatalogReviewResult> {
  validate(input);
  try {
    return await database.transaction(async (tx) => {
      await tx.query("select pg_advisory_xact_lock(hashtext($1))", [
        `catalog-review:${input.subjectType}:${input.stableId}`,
      ]);
      await verifySubject(tx, input);
      const event = await tx.query<{ reviewed_at: string }>(
        `insert into clinical_reference.catalog_review_events
          (subject_type, subject_stable_id, subject_version, outcome,
           reviewer_person_id, reason)
         values ($1, $2, $3, $4, $5, $6) returning reviewed_at`,
        [input.subjectType, input.stableId, input.version, input.outcome,
          clinicalUuid(input.reviewerPersonId), input.reason.trim()],
      );
      const reviewedAt = event.rows[0]?.reviewed_at;
      if (!reviewedAt) throw new GovernedCatalogReviewError("database_unavailable");
      await updateRegistry(tx, input);
      return {
        subjectType: input.subjectType,
        stableId: input.stableId,
        version: input.version,
        outcome: input.outcome,
        selectable: input.outcome === "approved",
        reviewedAt,
      };
    });
  } catch (error) {
    if (error instanceof GovernedCatalogReviewError) throw error;
    throw new GovernedCatalogReviewError("database_unavailable");
  }
}

/**
 * Approves a validated, clinical-only release in bounded set operations. The
 * caller's product-availability approval is intentionally not reused as
 * approval for commercial destinations, doses, or unresolved label evidence.
 */
export async function approveGovernedCatalogRelease(
  database: ClinicalCoreDatabase,
  input: {
    manifest: GovernedCatalogSeedManifest;
    reviewerPersonId: string;
    reason: string;
    environment: CatalogEnvironment;
  },
): Promise<CatalogReleaseApprovalResult> {
  const manifest = validateGovernedCatalogManifest(input.manifest);
  if (!UUID.test(input.reviewerPersonId)
    || input.reason.trim().length < 1 || input.reason.length > 2_000
    || manifest.targetEnvironment !== input.environment
    || manifest.commercialOffers.length !== 0
    || manifest.products.some((product) => product.directOrderAllowed)) {
    throw new GovernedCatalogReviewError("review_request_invalid");
  }

  const readyLabels = manifest.productLabels.filter((label) => label.labelFound
    && !label.physicalLabelRequired && !label.substantiveConflict && !label.practitionerDecisionRequired);
  const groups: Array<{
    subjectType: CatalogReviewSubject;
    registry: string;
    versionTable: string;
    versionForeignKey: string;
    subjects: Array<{ stableId: string; version: number }>;
  }> = [
    { subjectType: "safety_rule_version", registry: "clinical_reference.safety_rules", versionTable: "clinical_reference.safety_rule_versions", versionForeignKey: "rule_stable_id", subjects: manifest.safetyRules.map(key) },
    { subjectType: "knowledge_source_version", registry: "clinical_reference.knowledge_sources", versionTable: "clinical_reference.knowledge_source_versions", versionForeignKey: "source_stable_id", subjects: manifest.knowledgeSources.map(key) },
    { subjectType: "product_label_version", registry: "clinical_reference.product_labels", versionTable: "clinical_reference.product_label_versions", versionForeignKey: "label_stable_id", subjects: readyLabels.map(key) },
    { subjectType: "product_version", registry: "clinical_reference.catalog_products", versionTable: "clinical_reference.catalog_product_versions", versionForeignKey: "product_stable_id", subjects: manifest.products.map(key) },
    { subjectType: "protocol_template_version", registry: "clinical_reference.protocol_templates", versionTable: "clinical_reference.protocol_template_versions", versionForeignKey: "template_stable_id", subjects: manifest.protocolTemplates.map(key) },
  ];

  try {
    await database.transaction(async (tx) => {
      await tx.query("select pg_advisory_xact_lock(hashtext($1))", [`catalog-release-review:${manifest.manifestSha256}`]);
      for (const group of groups) await approveGroup(tx, group, input);
    });
  } catch (error) {
    if (error instanceof GovernedCatalogReviewError) throw error;
    throw new GovernedCatalogReviewError("database_unavailable");
  }

  return {
    manifestSha256: manifest.manifestSha256,
    outcome: "approved",
    counts: {
      products: manifest.products.length,
      productLabels: readyLabels.length,
      protocolTemplates: manifest.protocolTemplates.length,
      safetyRules: manifest.safetyRules.length,
      knowledgeSources: manifest.knowledgeSources.length,
      commercialOffers: 0,
    },
  };
}

/**
 * Activates only unrestricted direct-order offers whose exact product already
 * has a clean, approved label. The caller must attest the deterministic set
 * hash so a changing database selection cannot be approved accidentally.
 */
export async function activateLabelReadyCommercialOffers(
  database: ClinicalCoreDatabase,
  input: {
    reviewerPersonId: string;
    reason: string;
    environment: CatalogEnvironment;
    expectedSelectionSha256: string;
  },
): Promise<CommercialCatalogActivationResult> {
  if (!UUID.test(input.reviewerPersonId)
    || input.reason.trim().length < 1 || input.reason.length > 2_000
    || !["synthetic-staging", "production-clinical"].includes(input.environment)
    || !/^[0-9a-f]{64}$/.test(input.expectedSelectionSha256)) {
    throw new GovernedCatalogReviewError("review_request_invalid");
  }
  try {
    return await database.transaction(async (tx) => {
      await tx.query("select pg_advisory_xact_lock(hashtext($1))", [
        `catalog-commercial-activation:${input.environment}`,
      ]);
      const found = await tx.query<CommercialActivationRow>(
        `select o.stable_id as offer_stable_id, ov.version as offer_version,
                ov.content_sha256 as offer_content_sha256,
                p.stable_id as product_stable_id, p.active_version as product_version,
                pv.display_name, pv.product_type, pv.access_tier,
                pv.declared_restricted, pv.direct_order_allowed,
                pv.clinical_payload::text as clinical_payload_json,
                pv.source_refs::text as source_refs_json,
                pv.import_batch_id::text as import_batch_id
         from commercial_reference.affiliate_offers o
         join commercial_reference.affiliate_offer_versions ov
           on ov.offer_stable_id = o.stable_id
         join clinical_reference.catalog_products p on p.stable_id = ov.product_stable_id
         join clinical_reference.catalog_product_versions pv
           on pv.product_stable_id = p.stable_id and pv.version = p.active_version
         where ov.environment = $1
           and o.review_status = 'needs_review' and o.active_version is null
           and ov.direct_order_allowed = true and ov.declared_restricted = false
           and p.environment = $1 and p.review_status = 'approved'
           and pv.product_type = 'supplement' and pv.access_tier = 'open'
           and pv.declared_restricted = false
           and exists (
             select 1 from clinical_reference.product_labels l
             join clinical_reference.product_label_versions lv
               on lv.label_stable_id = l.stable_id and lv.version = l.active_version
             where l.product_stable_id = p.stable_id and l.review_status = 'approved'
               and lv.label_found = true and lv.physical_label_required = false
               and lv.substantive_conflict = false and lv.practitioner_decision_required = false
           )
         order by o.stable_id`,
        [input.environment],
      );
      const selectionSha256 = catalogSha256(found.rows.map((row) => ({
        offerStableId: row.offer_stable_id,
        offerVersion: Number(row.offer_version),
        offerContentSha256: row.offer_content_sha256,
        productStableId: row.product_stable_id,
        productVersion: Number(row.product_version),
      })));
      if (found.rows.length < 1 || selectionSha256 !== input.expectedSelectionSha256) {
        throw new GovernedCatalogReviewError("review_precondition_failed");
      }

      for (const row of found.rows) {
        let productVersion = Number(row.product_version);
        if (!row.direct_order_allowed) {
          productVersion += 1;
          const product: Omit<CatalogProductSeed, "contentSha256"> = {
            stableId: row.product_stable_id,
            version: productVersion,
            displayName: row.display_name,
            productType: row.product_type,
            accessTier: row.access_tier,
            declaredRestricted: false,
            directOrderAllowed: true,
            clinicalPayload: parsedRecord(row.clinical_payload_json),
            sourceRefs: parsedStrings(row.source_refs_json),
          };
          const contentSha256 = catalogSha256(productContentForHash(product));
          await tx.query(
            `insert into clinical_reference.catalog_product_versions
              (product_stable_id, version, display_name, product_type, access_tier,
               declared_restricted, direct_order_allowed, content_sha256, clinical_payload,
               source_refs, review_status, import_batch_id)
             values ($1,$2,$3,$4,$5,false,true,$6,$7::jsonb,$8::jsonb,'needs_review',$9)`,
            [row.product_stable_id, productVersion, row.display_name, row.product_type,
              row.access_tier, contentSha256, row.clinical_payload_json,
              row.source_refs_json, clinicalUuid(row.import_batch_id)],
          );
          await tx.query(
            `insert into clinical_reference.catalog_review_events
              (subject_type, subject_stable_id, subject_version, outcome, reviewer_person_id, reason)
             values ('product_version',$1,$2,'approved',$3,$4)`,
            [row.product_stable_id, productVersion, clinicalUuid(input.reviewerPersonId), input.reason.trim()],
          );
          await tx.query(
            `update clinical_reference.catalog_products
             set review_status='approved', active_version=$2, updated_at=clock_timestamp()
             where stable_id=$1`,
            [row.product_stable_id, productVersion],
          );
        }
        await tx.query(
          `insert into clinical_reference.catalog_review_events
            (subject_type, subject_stable_id, subject_version, outcome, reviewer_person_id, reason)
           values ('affiliate_offer_version',$1,$2,'approved',$3,$4)`,
          [row.offer_stable_id, Number(row.offer_version),
            clinicalUuid(input.reviewerPersonId), input.reason.trim()],
        );
        await tx.query(
          `update commercial_reference.affiliate_offers
           set review_status='approved', active_version=$2, updated_at=clock_timestamp()
           where stable_id=$1`,
          [row.offer_stable_id, Number(row.offer_version)],
        );
      }
      return {
        outcome: "approved",
        selectionSha256,
        productsActivated: found.rows.length,
        offersActivated: found.rows.length,
      };
    });
  } catch (error) {
    if (error instanceof GovernedCatalogReviewError) throw error;
    throw new GovernedCatalogReviewError("database_unavailable");
  }
}

type CommercialActivationRow = {
  offer_stable_id: string;
  offer_version: number;
  offer_content_sha256: string;
  product_stable_id: string;
  product_version: number;
  display_name: string;
  product_type: CatalogProductSeed["productType"];
  access_tier: CatalogProductSeed["accessTier"];
  declared_restricted: boolean;
  direct_order_allowed: boolean;
  clinical_payload_json: string;
  source_refs_json: string;
  import_batch_id: string;
};

function parsedRecord(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new GovernedCatalogReviewError("review_precondition_failed");
  }
  return parsed as Record<string, unknown>;
}

function parsedStrings(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.some((entry) => typeof entry !== "string")) {
    throw new GovernedCatalogReviewError("review_precondition_failed");
  }
  return parsed;
}

async function approveGroup(
  tx: ClinicalCoreTransaction,
  group: {
    subjectType: CatalogReviewSubject;
    registry: string;
    versionTable: string;
    versionForeignKey: string;
    subjects: Array<{ stableId: string; version: number }>;
  },
  input: { reviewerPersonId: string; reason: string },
) {
  if (group.subjects.length === 0) return;
  const payload = JSON.stringify(group.subjects.map((subject) => ({
    stable_id: subject.stableId,
    version: subject.version,
  })));
  const found = await tx.query<{ stable_id: string }>(
    `with requested as (
       select stable_id, version
       from jsonb_to_recordset($1::jsonb) as x(stable_id text, version integer)
     )
     select r.stable_id
     from requested q
     join ${group.registry} r on r.stable_id = q.stable_id
     join ${group.versionTable} v on v.${group.versionForeignKey} = q.stable_id and v.version = q.version`,
    [payload],
  );
  if (found.rows.length !== group.subjects.length) throw new GovernedCatalogReviewError("review_subject_not_found");
  await tx.query(
    `with requested as (
       select stable_id, version
       from jsonb_to_recordset($1::jsonb) as x(stable_id text, version integer)
     )
     insert into clinical_reference.catalog_review_events
       (subject_type, subject_stable_id, subject_version, outcome, reviewer_person_id, reason)
     select $2, stable_id, version, 'approved', $3, $4 from requested`,
    [payload, group.subjectType, clinicalUuid(input.reviewerPersonId), input.reason.trim()],
  );
  const activated = await tx.query<{ stable_id: string }>(
    `with requested as (
       select stable_id, version
       from jsonb_to_recordset($1::jsonb) as x(stable_id text, version integer)
     )
     update ${group.registry} r
     set review_status = 'approved', active_version = q.version, updated_at = clock_timestamp()
     from requested q
     where r.stable_id = q.stable_id
     returning r.stable_id`,
    [payload],
  );
  if (activated.rows.length !== group.subjects.length) throw new GovernedCatalogReviewError("database_unavailable");
}

function key(value: { stableId: string; version: number }) {
  return { stableId: value.stableId, version: value.version };
}

async function verifySubject(tx: ClinicalCoreTransaction, input: CatalogReviewInput) {
  if (input.subjectType === "product_version") {
    const found = await tx.query<{
      environment: string;
      declared_restricted: boolean;
      direct_order_allowed: boolean;
      access_tier: string;
      unresolved_safety_rules: number;
      label_ready: boolean;
    }>(
      `select p.environment, v.declared_restricted, v.direct_order_allowed, v.access_tier,
              (select count(*)::int
               from jsonb_array_elements_text(coalesce(v.clinical_payload->'contraindicationRuleIds', '[]'::jsonb)) as rule_id(stable_id)
               left join clinical_reference.safety_rules r on r.stable_id = rule_id.stable_id
               where r.review_status is distinct from 'approved' or r.active_version is null) as unresolved_safety_rules,
              exists (
                select 1 from clinical_reference.product_labels l
                join clinical_reference.product_label_versions lv
                  on lv.label_stable_id = l.stable_id and lv.version = l.active_version
                where l.product_stable_id = v.product_stable_id
                  and l.review_status = 'approved'
                  and lv.label_found = true
                  and lv.physical_label_required = false
                  and lv.substantive_conflict = false
                  and lv.practitioner_decision_required = false
              ) as label_ready
       from clinical_reference.catalog_product_versions v
       join clinical_reference.catalog_products p on p.stable_id = v.product_stable_id
       where v.product_stable_id = $1 and v.version = $2`,
      [input.stableId, input.version],
    );
    const row = found.rows[0];
    if (!row) notFound();
    if (row.environment !== input.environment
      || (row.declared_restricted && (row.direct_order_allowed || row.access_tier === "open"))
      || (input.outcome === "approved" && (Number(row.unresolved_safety_rules) > 0
        || (row.direct_order_allowed && !row.label_ready)))) precondition();
    return;
  }
  if (input.subjectType === "product_label_version") {
    const found = await tx.query<{
      environment: string;
      label_found: boolean;
      physical_label_required: boolean;
      substantive_conflict: boolean;
      practitioner_decision_required: boolean;
    }>(
      `select l.environment, v.label_found, v.physical_label_required,
              v.substantive_conflict, v.practitioner_decision_required
       from clinical_reference.product_label_versions v
       join clinical_reference.product_labels l on l.stable_id = v.label_stable_id
       where v.label_stable_id = $1 and v.version = $2`,
      [input.stableId, input.version],
    );
    const row = found.rows[0];
    if (!row) notFound();
    if (row.environment !== input.environment || (input.outcome === "approved" && (
      !row.label_found || row.physical_label_required || row.substantive_conflict
      || row.practitioner_decision_required
    ))) precondition();
    return;
  }
  if (input.subjectType === "protocol_template_version") {
    const found = await tx.query<{ environment: string; unresolved_products: number; unsourced_doses: number }>(
      `select t.environment,
              count(*) filter (where p.review_status <> 'approved' or p.active_version is null)::int as unresolved_products,
              count(*) filter (where coalesce(btrim(i.dosage_text), '') <> ''
                and coalesce(btrim(i.dose_source_ref), '') = '')::int as unsourced_doses
       from clinical_reference.protocol_template_versions v
       join clinical_reference.protocol_templates t on t.stable_id = v.template_stable_id
       left join clinical_reference.protocol_template_items i
         on i.template_stable_id = v.template_stable_id and i.template_version = v.version
       left join clinical_reference.catalog_products p on p.stable_id = i.product_stable_id
       where v.template_stable_id = $1 and v.version = $2
       group by t.environment`,
      [input.stableId, input.version],
    );
    const row = found.rows[0];
    if (!row) notFound();
    if (row.environment !== input.environment
      || (input.outcome === "approved" && (Number(row.unresolved_products) > 0 || Number(row.unsourced_doses) > 0))) precondition();
    return;
  }
  if (input.subjectType === "safety_rule_version" || input.subjectType === "knowledge_source_version") {
    const versionTable = input.subjectType === "safety_rule_version"
      ? "clinical_reference.safety_rule_versions"
      : "clinical_reference.knowledge_source_versions";
    const registryTable = input.subjectType === "safety_rule_version"
      ? "clinical_reference.safety_rules"
      : "clinical_reference.knowledge_sources";
    const foreignKey = input.subjectType === "safety_rule_version" ? "rule_stable_id" : "source_stable_id";
    const found = await tx.query<{ environment: string }>(
      `select r.environment
       from ${versionTable} v
       join ${registryTable} r on r.stable_id = v.${foreignKey}
       where v.${foreignKey} = $1 and v.version = $2`,
      [input.stableId, input.version],
    );
    const row = found.rows[0];
    if (!row) notFound();
    if (row.environment !== input.environment) precondition();
    return;
  }
  const found = await tx.query<{
    environment: string;
    declared_restricted: boolean;
    direct_order_allowed: boolean;
    product_review_status: string | null;
  }>(
    `select v.environment, v.declared_restricted, v.direct_order_allowed,
            p.review_status as product_review_status
     from commercial_reference.affiliate_offer_versions v
     left join clinical_reference.catalog_products p on p.stable_id = v.product_stable_id
     where v.offer_stable_id = $1 and v.version = $2`,
    [input.stableId, input.version],
  );
  const row = found.rows[0];
  if (!row) notFound();
  if (row.environment !== input.environment
    || (input.outcome === "approved" && row.direct_order_allowed && (
      row.declared_restricted || row.product_review_status !== "approved"
    ))) precondition();
}

async function updateRegistry(tx: ClinicalCoreTransaction, input: CatalogReviewInput) {
  const [schema, table] = registryFor(input.subjectType);
  if (input.outcome === "approved") {
    await tx.query(
      `update ${schema}.${table}
       set review_status = 'approved', active_version = $2, updated_at = clock_timestamp()
       where stable_id = $1`,
      [input.stableId, input.version],
    );
    return;
  }
  await tx.query(
    `update ${schema}.${table}
     set review_status = case when active_version is null then $2 else review_status end,
         updated_at = clock_timestamp()
     where stable_id = $1`,
    [input.stableId, input.outcome === "rejected" ? "rejected" : "needs_review"],
  );
}

function registryFor(subjectType: CatalogReviewSubject): [string, string] {
  if (subjectType === "product_version") return ["clinical_reference", "catalog_products"];
  if (subjectType === "product_label_version") return ["clinical_reference", "product_labels"];
  if (subjectType === "protocol_template_version") return ["clinical_reference", "protocol_templates"];
  if (subjectType === "safety_rule_version") return ["clinical_reference", "safety_rules"];
  if (subjectType === "knowledge_source_version") return ["clinical_reference", "knowledge_sources"];
  return ["commercial_reference", "affiliate_offers"];
}

function validate(input: CatalogReviewInput) {
  if (!IDS[input.subjectType]?.test(input.stableId)
    || !Number.isInteger(input.version) || input.version < 1
    || !UUID.test(input.reviewerPersonId)
    || !["approved", "rejected", "changes_requested"].includes(input.outcome)
    || !["synthetic-staging", "production-clinical"].includes(input.environment)
    || typeof input.reason !== "string" || input.reason.trim().length < 1 || input.reason.length > 2_000) {
    throw new GovernedCatalogReviewError("review_request_invalid");
  }
}

function notFound(): never {
  throw new GovernedCatalogReviewError("review_subject_not_found");
}

function precondition(): never {
  throw new GovernedCatalogReviewError("review_precondition_failed");
}
