import type { KnowledgePathwayContent } from "./clinical-knowledge.mock";

export type KnowledgeImportEntityType = "pathway" | "product_label";
export type KnowledgeImportItemStatus = "needs_review" | "applied" | "rejected";
export type KnowledgeImportBatchStatus = "staged" | "in_review" | "completed" | "cancelled";

export interface KnowledgeImportSourceItem {
  entityType: KnowledgeImportEntityType;
  externalKey: string;
  displayName: string;
  sourceSheet?: string;
  warnings: string[];
  payload: Record<string, unknown>;
}

export interface KnowledgeImportBundle {
  schemaVersion: "clinical-knowledge-import-v1";
  sourceName: string;
  sourceRevision?: string;
  attestation?: string;
  summary?: { pathways: number; productLabels: number; totalItems: number };
  items: KnowledgeImportSourceItem[];
}

export interface KnowledgeImportItem {
  id: string;
  entityType: KnowledgeImportEntityType;
  externalKey: string;
  displayName: string;
  sourceSheet?: string | null;
  payloadSha256: string;
  warnings: string[];
  validationErrors: string[];
  status: KnowledgeImportItemStatus;
  reviewNote?: string | null;
  reviewedAt?: string | null;
  appliedRefType?: string | null;
  appliedRefId?: string | null;
  createdAt: string;
}

export interface KnowledgeImportBatch {
  id: string;
  sourceName: string;
  sourceRevision?: string | null;
  schemaVersion: string;
  sourceSha256: string;
  status: KnowledgeImportBatchStatus;
  itemCount: number;
  noPhiAttestedAt: string;
  createdAt: string;
  completedAt?: string | null;
  items: KnowledgeImportItem[];
}

export interface ImportedPathwayPayload {
  code: string;
  name: string;
  domainCode: string;
  description?: string;
  sourceRefs?: { code?: string; label?: string }[];
  content: KnowledgePathwayContent & { authoring?: Record<string, unknown> };
}
