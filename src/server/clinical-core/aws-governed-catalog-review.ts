if (typeof window !== "undefined") {
  throw new Error("clinical-core/aws-governed-catalog-review is server-only.");
}

import { clinicalUuid, type ClinicalCoreDatabase, type ClinicalCoreTransaction } from "./database";
import type { CatalogEnvironment } from "./aws-governed-catalog-reader";

export type CatalogReviewSubject =
  | "product_version"
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

async function verifySubject(tx: ClinicalCoreTransaction, input: CatalogReviewInput) {
  if (input.subjectType === "product_version") {
    const found = await tx.query<{
      environment: string;
      declared_restricted: boolean;
      direct_order_allowed: boolean;
      access_tier: string;
      unresolved_safety_rules: number;
    }>(
      `select p.environment, v.declared_restricted, v.direct_order_allowed, v.access_tier,
              (select count(*)::int
               from jsonb_array_elements_text(coalesce(v.clinical_payload->'contraindicationRuleIds', '[]'::jsonb)) as rule_id(stable_id)
               left join clinical_reference.safety_rules r on r.stable_id = rule_id.stable_id
               where r.review_status is distinct from 'approved' or r.active_version is null) as unresolved_safety_rules
       from clinical_reference.catalog_product_versions v
       join clinical_reference.catalog_products p on p.stable_id = v.product_stable_id
       where v.product_stable_id = $1 and v.version = $2`,
      [input.stableId, input.version],
    );
    const row = found.rows[0];
    if (!row) notFound();
    if (row.environment !== input.environment
      || (row.declared_restricted && (row.direct_order_allowed || row.access_tier === "open"))
      || (input.outcome === "approved" && Number(row.unresolved_safety_rules) > 0)) precondition();
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
