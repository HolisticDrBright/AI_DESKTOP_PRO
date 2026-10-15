if (typeof window !== "undefined") {
  throw new Error("clinical-core/aws-production-catalog-reference-reader is server-only.");
}

import { clinicalUuid, ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase } from "./database";
import { GovernedCatalogReadError, type CurrentCatalogWorkforce } from "./aws-governed-catalog-reader";

export type ProductionCatalogReferenceProduct = {
  productId: string;
  productVersion: number;
  displayName: string;
  brand: string | null;
  productType: "supplement" | "oral_peptide" | "practitioner_only" | "injectable_peptide" | "other";
  accessTier: "open" | "practitioner_gated" | "injectable" | "blocked";
  declaredRestricted: boolean;
  declaredDirectOrderAllowed: boolean;
  labelVersionId: string;
  labelSha256: string | null;
  productContentSha256: string;
  sourceRefs: string[];
  importManifestSha256: string;
  sourceVerified: boolean;
};

export type ProductionCatalogReferencePage = {
  contractVersion: "production-catalog-reference/1";
  audience: "workforce";
  products: ProductionCatalogReferenceProduct[];
  nextCursor: string | null;
};

export type ProductionCatalogReferenceReader = {
  list(input: { limit: number; cursor?: string; currentWorkforce: CurrentCatalogWorkforce }): Promise<ProductionCatalogReferencePage>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRODUCT = /^prd_[a-z0-9][a-z0-9_-]{2,95}$/;
const SHA = /^[0-9a-f]{64}$/;
const PRODUCT_TYPES = new Set(["supplement", "oral_peptide", "practitioner_only", "injectable_peptide", "other"]);
const ACCESS_TIERS = new Set(["open", "practitioner_gated", "injectable", "blocked"]);
const PAGE_KEYS = ["audience", "contractVersion", "nextCursor", "products"];
const PRODUCT_KEYS = ["accessTier", "brand", "declaredDirectOrderAllowed", "declaredRestricted", "displayName",
  "importManifestSha256", "labelSha256", "labelVersionId", "productContentSha256", "productId", "productType",
  "productVersion", "sourceRefs", "sourceVerified"];
const MAX_RESPONSE_BYTES = 1024 * 1024;

export function createAwsProductionCatalogReferenceReader(database: ClinicalCoreDatabase): ProductionCatalogReferenceReader {
  return {
    async list(input) {
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100
        || (input.cursor !== undefined && !PRODUCT.test(input.cursor))) {
        throw new GovernedCatalogReadError("request_invalid");
      }
      if (!UUID.test(input.currentWorkforce.subject) || !UUID.test(input.currentWorkforce.selectedOrganizationId)) {
        throw new GovernedCatalogReadError("identity_refused");
      }
      try {
        return await database.transaction(async (tx) => {
          await tx.query("select clinical_private.set_current_workforce_context($1,$2,$3)", [
            input.currentWorkforce.subject, clinicalUuid(input.currentWorkforce.selectedOrganizationId), "clinical_data",
          ]);
          const { rows } = await tx.query<{ result: unknown }>(
            "select clinical_core.list_current_catalog_reference($1,$2) as result",
            [input.cursor ?? null, input.limit],
          );
          return parseReferencePage(rows.length === 1 ? rows[0]?.result : undefined, input.limit, input.cursor);
        });
      } catch (error) {
        if (error instanceof GovernedCatalogReadError) throw error;
        if (error instanceof ClinicalCoreDatabaseRejection && error.category === "identity_refused") {
          throw new GovernedCatalogReadError("identity_refused");
        }
        throw new GovernedCatalogReadError("catalog_unavailable");
      }
    },
  };
}

export function parseReferencePage(raw: unknown, limit: number, cursor?: string): ProductionCatalogReferencePage {
  try {
    if (typeof raw === "string") {
      if (new TextEncoder().encode(raw).length > MAX_RESPONSE_BYTES) throw new Error("too_large");
      raw = JSON.parse(raw);
    } else if (new TextEncoder().encode(JSON.stringify(raw)).length > MAX_RESPONSE_BYTES) {
      throw new Error("too_large");
    }
    const page = object(raw, PAGE_KEYS);
    if (page.contractVersion !== "production-catalog-reference/1" || page.audience !== "workforce"
      || !Array.isArray(page.products) || page.products.length > limit
      || (page.nextCursor !== null && (typeof page.nextCursor !== "string" || !PRODUCT.test(page.nextCursor)))) {
      throw new Error("page_invalid");
    }
    const products = page.products.map((rawProduct) => {
      const product = object(rawProduct, PRODUCT_KEYS);
      if (typeof product.productId !== "string" || !PRODUCT.test(product.productId)
        || !Number.isInteger(product.productVersion) || Number(product.productVersion) < 1
        || typeof product.displayName !== "string" || !product.displayName.trim() || product.displayName.length > 200
        || (product.brand !== null && (typeof product.brand !== "string" || product.brand.length > 200))
        || !PRODUCT_TYPES.has(product.productType as string) || !ACCESS_TIERS.has(product.accessTier as string)
        || typeof product.declaredRestricted !== "boolean" || typeof product.declaredDirectOrderAllowed !== "boolean"
        || typeof product.labelVersionId !== "string" || !UUID.test(product.labelVersionId)
        || (product.labelSha256 !== null && (typeof product.labelSha256 !== "string" || !SHA.test(product.labelSha256)))
        || typeof product.productContentSha256 !== "string" || !SHA.test(product.productContentSha256)
        || typeof product.importManifestSha256 !== "string" || !SHA.test(product.importManifestSha256)
        || typeof product.sourceVerified !== "boolean" || (product.sourceVerified && product.labelSha256 === null)
        || !Array.isArray(product.sourceRefs) || product.sourceRefs.length < 1 || product.sourceRefs.length > 100
        || product.sourceRefs.some((value) => typeof value !== "string" || !value.trim() || value.length > 4000)
        || new Set(product.sourceRefs).size !== product.sourceRefs.length) throw new Error("product_invalid");
      return product as ProductionCatalogReferenceProduct;
    });
    if (products.some((product, index) => index > 0 && product.productId <= products[index - 1]!.productId)
      || (cursor && products.some((product) => product.productId <= cursor))
      || (page.nextCursor !== null && (products.length === 0 || page.nextCursor !== products.at(-1)?.productId))) {
      throw new Error("pagination_invalid");
    }
    return { contractVersion: "production-catalog-reference/1", audience: "workforce", products,
      nextCursor: page.nextCursor as string | null };
  } catch {
    throw new GovernedCatalogReadError("catalog_response_invalid");
  }
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object_invalid");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== keys.length || keys.some((key) => !Object.hasOwn(item, key))) {
    throw new Error("keys_invalid");
  }
  return item;
}
