if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}

import type {
  KnowledgeImportBatch,
  KnowledgeImportSourceItem,
} from "./clinical-import.types";
import type {
  KnowledgePathway,
  KnowledgePathwayContent,
  KnowledgePathwayVersion,
} from "./clinical-knowledge.mock";
import { clinicalRpc, clinicalSelect } from "./supabase-rest.server";

interface DatabasePathwayVersion {
  id: string;
  version: number;
  status: KnowledgePathwayVersion["status"];
  content: Record<string, unknown>;
  source_refs: unknown[];
  change_summary: string | null;
  created_at: string;
  approved_at: string | null;
}

interface DatabasePathway {
  id: string;
  organization_id: string;
  code: string;
  name: string;
  domain_code: string;
  description: string;
  retired_at: string | null;
  clinical_pathway_versions: DatabasePathwayVersion[];
}

interface DatabaseImportBatch {
  id: string;
  source_name: string;
  source_revision: string | null;
  schema_version: string;
  source_sha256: string;
  status: KnowledgeImportBatch["status"];
  item_count: number;
  no_phi_attested_at: string;
  created_at: string;
  completed_at: string | null;
}

interface DatabaseImportItem {
  id: string;
  batch_id: string;
  entity_type: "pathway" | "product_label";
  external_key: string;
  display_name: string;
  source_sheet: string | null;
  payload_sha256: string;
  warnings: string[];
  validation_errors: string[];
  status: "needs_review" | "applied" | "rejected";
  review_note: string | null;
  reviewed_at: string | null;
  applied_ref_type: string | null;
  applied_ref_id: string | null;
  created_at: string;
}

const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

function contentDto(value: Record<string, unknown>): KnowledgePathwayContent {
  const labs = Array.isArray(value.labStrategy) ? value.labStrategy : [];
  const products = Array.isArray(value.productCandidates) ? value.productCandidates : [];
  return {
    differentiatingQuestions: strings(value.differentiatingQuestions),
    labStrategy: labs.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      return [{
        panel: String(row.panel ?? "Unnamed panel"),
        vendor: String(row.vendor ?? "Vendor not finalized"),
        purpose: String(row.purpose ?? "Clinical purpose requires review"),
      }];
    }),
    productCandidates: products.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      return [{
        name: String(row.name ?? "Unnamed product"),
        brand: String(row.brand ?? "Brand not finalized"),
        role: String(row.role ?? "Candidate requiring review"),
      }];
    }),
    nutrition: strings(value.nutrition),
    lifestyle: strings(value.lifestyle),
    safetyStops: strings(value.safetyStops),
  };
}

function sourceLabel(value: unknown) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "Unlabeled source";
  const source = value as Record<string, unknown>;
  return String(source.label ?? source.code ?? source.url ?? "Unlabeled source");
}

function pathwayDto(row: DatabasePathway): KnowledgePathway {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    domain: row.domain_code,
    description: row.description,
    versions: [...(row.clinical_pathway_versions ?? [])]
      .sort((a, b) => b.version - a.version)
      .map((version) => ({
        id: version.id,
        version: version.version,
        status: version.status,
        changeSummary: version.change_summary ?? "",
        createdAt: version.created_at,
        createdBy: "Recorded practitioner",
        approvedAt: version.approved_at ?? undefined,
        approvedBy: version.approved_at ? "Recorded administrator" : undefined,
        sourceRefs: (version.source_refs ?? []).map(sourceLabel),
        content: contentDto(version.content),
      })),
  };
}

function pathwayParams(organizationId: string) {
  return new URLSearchParams({
    select: [
      "id",
      "organization_id",
      "code",
      "name",
      "domain_code",
      "description",
      "retired_at",
      "clinical_pathway_versions(id,version,status,content,source_refs,change_summary,created_at,approved_at)",
    ].join(","),
    organization_id: `eq.${organizationId}`,
    retired_at: "is.null",
    order: "name.asc",
  });
}

function importBatchParams(organizationId: string) {
  return new URLSearchParams({
    select: [
      "id",
      "source_name",
      "source_revision",
      "schema_version",
      "source_sha256",
      "status",
      "item_count",
      "no_phi_attested_at",
      "created_at",
      "completed_at",
    ].join(","),
    organization_id: `eq.${organizationId}`,
    order: "created_at.desc",
    limit: "20",
  });
}

function importItemParams(organizationId: string, batchIds: string[]) {
  return new URLSearchParams({
    select: [
      "id",
      "batch_id",
      "entity_type",
      "external_key",
      "display_name",
      "source_sheet",
      "payload_sha256",
      "warnings",
      "validation_errors",
      "status",
      "review_note",
      "reviewed_at",
      "applied_ref_type",
      "applied_ref_id",
      "created_at",
    ].join(","),
    organization_id: `eq.${organizationId}`,
    batch_id: `in.(${batchIds.join(",")})`,
    order: "created_at.asc",
  });
}

export const knowledgeLive = {
  async pathways(organizationId: string, sessionToken?: string | null) {
    const rows = await clinicalSelect<DatabasePathway[]>(
      "clinical_pathways",
      pathwayParams(organizationId),
      sessionToken,
    );
    return rows.map(pathwayDto);
  },

  createDraft(
    _organizationId: string,
    pathwayId: string,
    content: KnowledgePathwayContent,
    sourceRefs: string[],
    changeSummary: string,
    sessionToken?: string | null,
  ) {
    return clinicalRpc<{ versionId: string; version: number }>(
      "create_clinical_pathway_draft",
      {
        _pathway_id: pathwayId,
        _content: content,
        _source_refs: sourceRefs.map((label) => ({ label })),
        _change_summary: changeSummary || null,
      },
      sessionToken,
    );
  },

  async updateDraft(
    _organizationId: string,
    versionId: string,
    content: KnowledgePathwayContent,
    sourceRefs: string[],
    changeSummary: string,
    sessionToken?: string | null,
  ) {
    await clinicalRpc<null>(
      "update_clinical_pathway_draft",
      {
        _version_id: versionId,
        _content: content,
        _source_refs: sourceRefs.map((label) => ({ label })),
        _change_summary: changeSummary || null,
      },
      sessionToken,
    );
    return { ok: true as const };
  },

  async approve(
    _organizationId: string,
    versionId: string,
    sessionToken?: string | null,
  ) {
    await clinicalRpc<null>(
      "approve_clinical_pathway_version",
      { _version_id: versionId },
      sessionToken,
    );
    return { ok: true as const };
  },

  async imports(organizationId: string, sessionToken?: string | null) {
    const batches = await clinicalSelect<DatabaseImportBatch[]>(
      "clinical_knowledge_import_batches",
      importBatchParams(organizationId),
      sessionToken,
    );
    if (batches.length === 0) return [];

    const items = await clinicalSelect<DatabaseImportItem[]>(
      "clinical_knowledge_import_items",
      importItemParams(organizationId, batches.map((batch) => batch.id)),
      sessionToken,
    );

    return batches.map((batch): KnowledgeImportBatch => ({
      id: batch.id,
      sourceName: batch.source_name,
      sourceRevision: batch.source_revision,
      schemaVersion: batch.schema_version,
      sourceSha256: batch.source_sha256,
      status: batch.status,
      itemCount: batch.item_count,
      noPhiAttestedAt: batch.no_phi_attested_at,
      createdAt: batch.created_at,
      completedAt: batch.completed_at,
      items: items
        .filter((item) => item.batch_id === batch.id)
        .map((item) => ({
          id: item.id,
          entityType: item.entity_type,
          externalKey: item.external_key,
          displayName: item.display_name,
          sourceSheet: item.source_sheet,
          payloadSha256: item.payload_sha256,
          warnings: item.warnings ?? [],
          validationErrors: item.validation_errors ?? [],
          status: item.status,
          reviewNote: item.review_note,
          reviewedAt: item.reviewed_at,
          appliedRefType: item.applied_ref_type,
          appliedRefId: item.applied_ref_id,
          createdAt: item.created_at,
        })),
    }));
  },

  stageImport(
    organizationId: string,
    input: {
      sourceName: string;
      sourceRevision?: string;
      schemaVersion: string;
      items: KnowledgeImportSourceItem[];
      attestsNoPhi: true;
    },
    sessionToken?: string | null,
  ) {
    return clinicalRpc<{ batchId: string; itemCount: number }>(
      "stage_clinical_knowledge_import",
      {
        _organization_id: organizationId,
        _source_name: input.sourceName,
        _source_revision: input.sourceRevision ?? null,
        _schema_version: input.schemaVersion,
        _items: input.items,
        _attests_no_phi: input.attestsNoPhi,
      },
      sessionToken,
    );
  },

  reviewImportItem(
    _organizationId: string,
    itemId: string,
    decision: "accept" | "reject",
    reviewNote: string | undefined,
    sessionToken?: string | null,
  ) {
    return clinicalRpc<{
      status: "applied" | "rejected";
      appliedRefType: string | null;
      appliedRefId: string | null;
    }>(
      "review_clinical_knowledge_import_item",
      {
        _item_id: itemId,
        _decision: decision,
        _review_note: reviewNote ?? null,
      },
      sessionToken,
    );
  },
};
