if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
import { trpcMutation, trpcQuery } from "./trpc.server";

/**
 * Live lens namespace (server-only): differential questions + clinical lens
 * engine (Milestone 2). QUESTION-FOCUSED by design — evaluations surface
 * questions, considerations, missing information, conflicts, and safety
 * observations; never diagnoses, treatment plans, dosing, or patient-facing
 * recommendations. Every mutation lands in a SECURITY DEFINER RPC (migration
 * 0024) via the backend's clinical.lens.* procedures: the invariant core,
 * lifecycle map, versioned answers, stale/supersede semantics, and safety
 * blocks are database-enforced. This module threads the caller's session and
 * shapes typed DTOs only.
 */

export type LensParadigm =
  | "western_conventional"
  | "functional"
  | "naturopathic"
  | "tcm"
  | "biohacking"
  | "synergistic";

export const LENS_PARADIGMS: LensParadigm[] = [
  "western_conventional",
  "functional",
  "naturopathic",
  "tcm",
  "biohacking",
  "synergistic",
];

export interface LensAiStatus {
  mode: "fixture" | "live";
  available: boolean;
  liveConfigured: boolean;
  reason: string | null;
}

export interface LensParadigmInfo {
  code: string;
  name: string;
  description: string;
  isComposite: boolean;
  composedOf: string[];
}

export interface LensDomainInfo {
  code: string;
  version: number;
  name: string;
  description: string;
}

/** Registry row — null attributes mean UNKNOWN and must render as "unknown". */
export interface KnowledgeSourceInfo {
  id: string;
  code: string;
  revision: number;
  citation: string;
  publisher: string | null;
  releaseDate: string | null;
  revisionDate: string | null;
  intendedPurpose: string | null;
  intendedPopulation: string | null;
  requiredInputs: string | null;
  dataQualityExpectations: string | null;
  logicSummary: string | null;
  knownLimitations: string | null;
  outOfScopeUses: string | null;
  validationStatus: string;
  fundingConflicts: string | null;
}

export interface LensQuestion {
  id: string;
  domainCode: string;
  questionText: string;
  rationale: string;
  distinguishes: unknown[];
  safetyRelation: string | null;
  priority: string;
  answerType: string;
  patientSources: unknown[];
  knowledgeSourceIds: string[];
  missingDataAssumptions: unknown[];
  generationMethod: string;
  generationVersion: string;
  status: string;
  statusReason: string | null;
  createdAt: string;
}

export interface LensSafetyBlock {
  id: string;
  ruleCode: string;
  detail: Record<string, unknown>;
  createdAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  resolution: string | null;
}

export interface LensEvaluation {
  evaluationId: string;
  paradigm: string;
  status: "complete" | "blocked";
  invariantCore: Record<string, unknown>;
  lensFraming: Record<string, unknown>;
  inputSnapshot: Record<string, unknown>;
  inputCutoffAt: string;
  ruleSetVersion: string;
  knowledgeVersions: unknown[];
  model: string | null;
  provider: string | null;
  promptTemplateVersion: string | null;
  outputSchemaVersion: string;
  outputSha256: string;
  validationResult: Record<string, unknown> | null;
  stale: boolean;
  staleReason: string | null;
  createdAt: string;
  questions: LensQuestion[];
  safetyBlocks: LensSafetyBlock[];
}

export interface EvaluateResult {
  evaluationId: string;
  status: "complete" | "blocked";
  questionsInserted?: number;
  questionsDeduped?: number;
  blockedRules?: number;
}

export interface QuestionAnswerVersion {
  version: number;
  value: Record<string, unknown>;
  correctsVersion: number | null;
  correctionReason: string | null;
  answeredAt: string;
}

export type QuestionLifecycleAction = "accepted" | "asked" | "deferred" | "skipped";
export type QuestionFeedbackKind =
  | "helpful"
  | "not_relevant"
  | "unsafe"
  | "incorrect"
  | "duplicate"
  | "other";

export const lensLive = {
  aiStatus(sessionToken?: string | null): Promise<LensAiStatus> {
    return trpcQuery<LensAiStatus>("clinical.lens.aiStatus", undefined, sessionToken);
  },

  paradigms(sessionToken?: string | null): Promise<LensParadigmInfo[]> {
    return trpcQuery<LensParadigmInfo[]>("clinical.lens.paradigms", undefined, sessionToken);
  },

  domains(sessionToken?: string | null): Promise<LensDomainInfo[]> {
    return trpcQuery<LensDomainInfo[]>("clinical.lens.domains", undefined, sessionToken);
  },

  knowledgeSources(sessionToken?: string | null): Promise<KnowledgeSourceInfo[]> {
    return trpcQuery<KnowledgeSourceInfo[]>("clinical.lens.knowledgeSources", undefined, sessionToken);
  },

  evaluate(
    input: { encounterId: string; paradigm: LensParadigm },
    sessionToken?: string | null,
  ): Promise<EvaluateResult> {
    return trpcMutation<EvaluateResult>("clinical.lens.evaluate", input, sessionToken);
  },

  evaluation(
    input: { encounterId: string; paradigm: LensParadigm },
    sessionToken?: string | null,
  ): Promise<LensEvaluation | null> {
    return trpcQuery<LensEvaluation | null>("clinical.lens.evaluation", input, sessionToken);
  },

  answers(questionId: string, sessionToken?: string | null): Promise<QuestionAnswerVersion[]> {
    return trpcQuery<QuestionAnswerVersion[]>("clinical.lens.answers", { questionId }, sessionToken);
  },

  questionAction(
    input: { questionId: string; action: QuestionLifecycleAction; reason?: string },
    sessionToken?: string | null,
  ): Promise<{ ok: true }> {
    return trpcMutation<{ ok: true }>("clinical.lens.questionAction", input, sessionToken);
  },

  dismiss(
    input: { questionId: string; feedbackKind: QuestionFeedbackKind; comment?: string },
    sessionToken?: string | null,
  ): Promise<{ ok: true }> {
    return trpcMutation<{ ok: true }>("clinical.lens.dismiss", input, sessionToken);
  },

  answer(
    input: { questionId: string; value: Record<string, unknown> },
    sessionToken?: string | null,
  ): Promise<{ version: number }> {
    return trpcMutation<{ version: number }>("clinical.lens.answer", input, sessionToken);
  },

  correctAnswer(
    input: { questionId: string; value: Record<string, unknown>; reason?: string },
    sessionToken?: string | null,
  ): Promise<{ version: number }> {
    return trpcMutation<{ version: number }>("clinical.lens.correctAnswer", input, sessionToken);
  },

  recordNoteUse(
    input: { questionId: string; noteId: string },
    sessionToken?: string | null,
  ): Promise<{ ok: true }> {
    return trpcMutation<{ ok: true }>("clinical.lens.recordNoteUse", input, sessionToken);
  },

  feedback(
    input: { questionId: string; kind: QuestionFeedbackKind; comment?: string },
    sessionToken?: string | null,
  ): Promise<{ ok: true }> {
    return trpcMutation<{ ok: true }>("clinical.lens.feedback", input, sessionToken);
  },

  reviewSafetyBlock(
    input: { blockId: string; resolution: string },
    sessionToken?: string | null,
  ): Promise<{ ok: true }> {
    return trpcMutation<{ ok: true }>("clinical.lens.reviewSafetyBlock", input, sessionToken);
  },
};
