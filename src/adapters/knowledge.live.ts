if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}

import type { KnowledgeImportBatch, KnowledgeImportSourceItem } from "./clinical-import.types";
import type {
  KnowledgePathway,
  KnowledgePathwayContent,
  KnowledgePathwayVersion,
} from "./clinical-knowledge.mock";
import { trpcMutation, trpcQuery } from "./trpc.server";

interface BackendPathway {
  id: string;
  organizationId: string;
  code: string;
  name: string;
  domainCode: string;
  description: string;
  versions: {
    id: string;
    version: number;
    status: KnowledgePathwayVersion["status"];
    content: Record<string, unknown>;
    sourceRefs: unknown[];
    changeSummary: string | null;
    createdAt: string;
    approvedAt: string | null;
  }[];
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

function pathwayDto(row: BackendPathway): KnowledgePathway {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    domain: row.domainCode,
    description: row.description,
    versions: row.versions.map((version) => ({
      id: version.id,
      version: version.version,
      status: version.status,
      changeSummary: version.changeSummary ?? "",
      createdAt: version.createdAt,
      createdBy: "Recorded practitioner",
      approvedAt: version.approvedAt ?? undefined,
      approvedBy: version.approvedAt ? "Recorded administrator" : undefined,
      sourceRefs: version.sourceRefs.map(sourceLabel),
      content: contentDto(version.content),
    })),
  };
}

export const knowledgeLive = {
  async pathways(organizationId: string, sessionToken?: string | null) {
    const rows = await trpcQuery<BackendPathway[]>(
      "clinical.knowledge.pathways",
      { organizationId },
      sessionToken,
    );
    return rows.map(pathwayDto);
  },

  createDraft(
    organizationId: string,
    pathwayId: string,
    content: KnowledgePathwayContent,
    sourceRefs: string[],
    changeSummary: string,
    sessionToken?: string | null,
  ) {
    return trpcMutation<{ versionId: string; version: number }>(
      "clinical.knowledge.createDraft",
      {
        organizationId,
        pathwayId,
        content,
        sourceRefs: sourceRefs.map((label) => ({ label })),
        changeSummary,
      },
      sessionToken,
    );
  },

  updateDraft(
    organizationId: string,
    versionId: string,
    content: KnowledgePathwayContent,
    sourceRefs: string[],
    changeSummary: string,
    sessionToken?: string | null,
  ) {
    return trpcMutation<{ ok: true }>(
      "clinical.knowledge.updateDraft",
      {
        organizationId,
        versionId,
        content,
        sourceRefs: sourceRefs.map((label) => ({ label })),
        changeSummary,
      },
      sessionToken,
    );
  },

  approve(
    organizationId: string,
    versionId: string,
    sessionToken?: string | null,
  ) {
    return trpcMutation<{ ok: true }>(
      "clinical.knowledge.approve",
      { organizationId, versionId },
      sessionToken,
    );
  },

  imports(organizationId: string, sessionToken?: string | null) {
    return trpcQuery<KnowledgeImportBatch[]>(
      "clinical.knowledge.imports",
      { organizationId },
      sessionToken,
    );
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
    return trpcMutation<{ batchId: string; itemCount: number }>(
      "clinical.knowledge.stageImport",
      { organizationId, ...input },
      sessionToken,
    );
  },

  reviewImportItem(
    organizationId: string,
    itemId: string,
    decision: "accept" | "reject",
    reviewNote: string | undefined,
    sessionToken?: string | null,
  ) {
    return trpcMutation<{
      status: "applied" | "rejected";
      appliedRefType: string | null;
      appliedRefId: string | null;
    }>(
      "clinical.knowledge.reviewImportItem",
      { organizationId, itemId, decision, reviewNote },
      sessionToken,
    );
  },
};
