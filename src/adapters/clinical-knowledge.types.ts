/**
 * Clinical knowledge registry DTO vocabulary shared by the live adapter, API
 * routes, and UI. Extracted from the mock module so the clinical runtime never
 * imports fixtures; the seeded demo pathways stay there, test-only.
 */

export type KnowledgeConcern =
  | "thyroid"
  | "digestive"
  | "cardiometabolic"
  | "adrenal"
  | "autoimmune"
  | "environmental";

export type KnowledgeVersionStatus = "draft" | "approved" | "superseded" | "retired";

export interface KnowledgePathwayContent {
  differentiatingQuestions: string[];
  labStrategy: { panel: string; vendor: string; purpose: string }[];
  productCandidates: { name: string; brand: string; role: string }[];
  nutrition: string[];
  lifestyle: string[];
  safetyStops: string[];
}

export interface KnowledgePathwayVersion {
  id: string;
  version: number;
  status: KnowledgeVersionStatus;
  changeSummary: string;
  createdAt: string;
  createdBy: string;
  approvedAt?: string;
  approvedBy?: string;
  sourceRefs: string[];
  content: KnowledgePathwayContent;
}

export interface KnowledgePathway {
  id: string;
  code: string;
  name: string;
  domain: string;
  description: string;
  versions: KnowledgePathwayVersion[];
}

