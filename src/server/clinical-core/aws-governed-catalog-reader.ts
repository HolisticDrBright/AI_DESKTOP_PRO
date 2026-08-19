if (typeof window !== "undefined") {
  throw new Error("clinical-core/aws-governed-catalog-reader is server-only.");
}

import type { ClinicalCoreDatabase } from "./database";
import type { CatalogAccessTier, CatalogProductType } from "./aws-governed-catalog";

export type GovernedCatalogProduct = {
  stableId: string;
  version: number;
  displayName: string;
  productType: CatalogProductType;
  accessTier: CatalogAccessTier;
  declaredRestricted: boolean;
  directOrderAllowed: boolean;
  clinical: Record<string, unknown>;
  sourceRefs: string[];
  reviewStatus: "approved";
};

export type GovernedCommercialOffer = {
  stableId: string;
  version: number;
  productStableId: string;
  destinationUrl: string;
  trackingMetadata: Record<string, unknown>;
  reviewStatus: "approved";
};

export type GovernedProtocolTemplate = {
  stableId: string;
  version: number;
  title: string;
  summary?: string;
  sourceRefs: string[];
  reviewStatus: "approved";
  items: Array<{
    position: number;
    productStableId: string;
    instructions?: string;
    dosageText?: string;
    doseSourceRef?: string;
    monitoringRequirements: string[];
    stoppingRules: string[];
    contraindications: string[];
  }>;
};

export type CatalogPage = {
  products: GovernedCatalogProduct[];
  commercial: { offers: GovernedCommercialOffer[] };
  nextCursor?: string;
};

export type TemplatePage = {
  protocolTemplates: GovernedProtocolTemplate[];
  nextCursor?: string;
};

export interface AwsGovernedCatalogReader {
  listProducts(input: { limit: number; cursor?: string }): Promise<CatalogPage>;
  listProtocolTemplates(input: { limit: number; cursor?: string }): Promise<TemplatePage>;
}

export type CatalogEnvironment = "synthetic-staging" | "production-clinical";

export class GovernedCatalogReadError extends Error {
  constructor(readonly category: "request_invalid" | "catalog_unavailable" | "catalog_response_invalid") {
    super(category);
    this.name = "GovernedCatalogReadError";
  }
}

const STABLE_ID = /^(prd|tpl)_[a-z0-9][a-z0-9_-]{2,95}$/;

export function createAwsGovernedCatalogReader(
  database: ClinicalCoreDatabase,
  environment: CatalogEnvironment,
): AwsGovernedCatalogReader {
  if (!["synthetic-staging", "production-clinical"].includes(environment)) {
    throw new GovernedCatalogReadError("request_invalid");
  }
  return {
    async listProducts(input) {
      assertPage(input);
      try {
        return await database.transaction(async (tx) => {
          await tx.query("select set_config('clinical.catalog.environment', $1, true)", [environment]);
          const rows = await tx.query<ProductRow>(
            `select v.product_stable_id, v.version, v.display_name, v.product_type, v.access_tier,
                    v.declared_restricted, v.direct_order_allowed,
                    v.clinical_payload::text as clinical_payload_json,
                    v.source_refs::text as source_refs_json
             from clinical_reference.catalog_product_versions v
             join clinical_reference.catalog_products p
               on p.stable_id = v.product_stable_id and p.active_version = v.version
             where p.review_status = 'approved'
               and ($1 = '' or v.product_stable_id > $1)
             order by v.product_stable_id limit $2`,
            [input.cursor ?? "", input.limit + 1],
          );
          const pageRows = rows.rows.slice(0, input.limit);
          const productIds = pageRows.map((row) => row.product_stable_id);
          const offers = productIds.length === 0 ? [] : (await tx.query<OfferRow>(
            `select v.offer_stable_id, v.version, v.product_stable_id, v.destination_url,
                    v.tracking_metadata::text as tracking_metadata_json
             from commercial_reference.affiliate_offer_versions v
             join commercial_reference.affiliate_offers o
               on o.stable_id = v.offer_stable_id and o.active_version = v.version
             where o.review_status = 'approved'
               and v.direct_order_allowed = true and v.declared_restricted = false
               and v.product_stable_id = any(string_to_array($1, ','))
             order by v.offer_stable_id`,
            [productIds.join(",")],
          )).rows;
          return {
            products: pageRows.map(toProduct),
            commercial: { offers: offers.map(toOffer) },
            ...(rows.rows.length > input.limit ? { nextCursor: pageRows.at(-1)!.product_stable_id } : {}),
          };
        });
      } catch (error) {
        if (error instanceof GovernedCatalogReadError) throw error;
        throw new GovernedCatalogReadError("catalog_unavailable");
      }
    },

    async listProtocolTemplates(input) {
      assertPage(input);
      try {
        return await database.transaction(async (tx) => {
          await tx.query("select set_config('clinical.catalog.environment', $1, true)", [environment]);
          const rows = await tx.query<TemplateRow>(
            `select v.template_stable_id, v.version, v.title, v.summary,
                    v.source_refs::text as source_refs_json,
                    coalesce(jsonb_agg(jsonb_build_object(
                      'position', i.position,
                      'productStableId', i.product_stable_id,
                      'instructions', i.instructions,
                      'dosageText', i.dosage_text,
                      'doseSourceRef', i.dose_source_ref,
                      'monitoringRequirements', i.monitoring_requirements,
                      'stoppingRules', i.stopping_rules,
                      'contraindications', i.contraindications
                    ) order by i.position) filter (where i.position is not null), '[]'::jsonb)::text as items_json
             from clinical_reference.protocol_template_versions v
             join clinical_reference.protocol_templates t
               on t.stable_id = v.template_stable_id and t.active_version = v.version
             left join clinical_reference.protocol_template_items i
               on i.template_stable_id = v.template_stable_id and i.template_version = v.version
             where t.review_status = 'approved'
               and ($1 = '' or v.template_stable_id > $1)
             group by v.template_stable_id, v.version, v.title, v.summary, v.source_refs
             order by v.template_stable_id limit $2`,
            [input.cursor ?? "", input.limit + 1],
          );
          const pageRows = rows.rows.slice(0, input.limit);
          return {
            protocolTemplates: pageRows.map(toTemplate),
            ...(rows.rows.length > input.limit ? { nextCursor: pageRows.at(-1)!.template_stable_id } : {}),
          };
        });
      } catch (error) {
        if (error instanceof GovernedCatalogReadError) throw error;
        throw new GovernedCatalogReadError("catalog_unavailable");
      }
    },
  };
}

type ProductRow = {
  product_stable_id: string;
  version: number;
  display_name: string;
  product_type: CatalogProductType;
  access_tier: CatalogAccessTier;
  declared_restricted: boolean;
  direct_order_allowed: boolean;
  clinical_payload_json: string;
  source_refs_json: string;
};

type OfferRow = {
  offer_stable_id: string;
  version: number;
  product_stable_id: string;
  destination_url: string;
  tracking_metadata_json: string;
};

type TemplateRow = {
  template_stable_id: string;
  version: number;
  title: string;
  summary: string | null;
  source_refs_json: string;
  items_json: string;
};

function toProduct(row: ProductRow): GovernedCatalogProduct {
  return {
    stableId: checkedId(row.product_stable_id, "prd_"),
    version: checkedVersion(row.version),
    displayName: checkedText(row.display_name, 200),
    productType: checkedEnum(row.product_type, ["supplement", "oral_peptide", "practitioner_only", "injectable_peptide"]),
    accessTier: checkedEnum(row.access_tier, ["open", "practitioner_gated", "injectable"]),
    declaredRestricted: checkedBoolean(row.declared_restricted),
    directOrderAllowed: checkedBoolean(row.direct_order_allowed),
    clinical: parsedObject(row.clinical_payload_json),
    sourceRefs: parsedStringArray(row.source_refs_json),
    reviewStatus: "approved",
  };
}

function toOffer(row: OfferRow): GovernedCommercialOffer {
  const destination = checkedText(row.destination_url, 2_048);
  try {
    const url = new URL(destination);
    if (url.protocol !== "https:" || url.username || url.password) invalidResponse();
  } catch {
    invalidResponse();
  }
  return {
    stableId: checkedId(row.offer_stable_id, "off_"),
    version: checkedVersion(row.version),
    productStableId: checkedId(row.product_stable_id, "prd_"),
    destinationUrl: destination,
    trackingMetadata: parsedObject(row.tracking_metadata_json),
    reviewStatus: "approved",
  };
}

function toTemplate(row: TemplateRow): GovernedProtocolTemplate {
  const items = parsedArray(row.items_json).map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalidResponse();
    const item = value as Record<string, unknown>;
    return {
      position: checkedVersion(item.position),
      productStableId: checkedId(item.productStableId, "prd_"),
      ...(item.instructions === null || item.instructions === undefined ? {} : { instructions: checkedText(item.instructions, 4_000) }),
      ...(item.dosageText === null || item.dosageText === undefined ? {} : { dosageText: checkedText(item.dosageText, 1_000) }),
      ...(item.doseSourceRef === null || item.doseSourceRef === undefined ? {} : { doseSourceRef: checkedText(item.doseSourceRef, 1_000) }),
      monitoringRequirements: checkedStringArray(item.monitoringRequirements),
      stoppingRules: checkedStringArray(item.stoppingRules),
      contraindications: checkedStringArray(item.contraindications),
    };
  });
  if (items.some((item) => item.dosageText && !item.doseSourceRef)) invalidResponse();
  return {
    stableId: checkedId(row.template_stable_id, "tpl_"),
    version: checkedVersion(row.version),
    title: checkedText(row.title, 200),
    ...(row.summary === null ? {} : { summary: checkedText(row.summary, 4_000) }),
    sourceRefs: parsedStringArray(row.source_refs_json),
    reviewStatus: "approved",
    items,
  };
}

function assertPage(input: { limit: number; cursor?: string }) {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new GovernedCatalogReadError("request_invalid");
  }
  if (input.cursor !== undefined && (!STABLE_ID.test(input.cursor) || input.cursor.length > 100)) {
    throw new GovernedCatalogReadError("request_invalid");
  }
}

function checkedId(value: unknown, prefix: "prd_" | "off_" | "tpl_"): string {
  if (typeof value !== "string" || !value.startsWith(prefix) || value.length > 100
    || !/^(prd|off|tpl)_[a-z0-9][a-z0-9_-]{2,95}$/.test(value)) invalidResponse();
  return value;
}

function checkedText(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) invalidResponse();
  return value;
}

function checkedVersion(value: unknown): number {
  const number = typeof value === "string" ? Number(value) : value;
  if (!Number.isInteger(number) || Number(number) < 1) invalidResponse();
  return Number(number);
}

function checkedBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") invalidResponse();
  return value;
}

function checkedEnum<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== "string" || !choices.includes(value as T)) invalidResponse();
  return value as T;
}

function parsedObject(value: unknown): Record<string, unknown> {
  const output = parseJson(value);
  if (!output || typeof output !== "object" || Array.isArray(output)) invalidResponse();
  return output as Record<string, unknown>;
}

function parsedArray(value: unknown): unknown[] {
  const output = parseJson(value);
  if (!Array.isArray(output)) invalidResponse();
  return output;
}

function parsedStringArray(value: unknown): string[] {
  const output = checkedStringArray(parsedArray(value));
  if (output.length === 0) invalidResponse();
  return output;
}

function checkedStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100
    || !value.every((item) => typeof item === "string" && item.trim() && item.length <= 1_000)) invalidResponse();
  return value as string[];
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string" || value.length > 1_000_000) invalidResponse();
  try {
    return JSON.parse(value);
  } catch {
    invalidResponse();
  }
}

function invalidResponse(): never {
  throw new GovernedCatalogReadError("catalog_response_invalid");
}
