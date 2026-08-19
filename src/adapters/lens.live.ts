if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
import { trpcMutation, trpcQuery } from "./trpc.server";
import { getClinicalAccessToken } from "./session.server";
import { clinicalRpc } from "./aws-clinical-data.server";

/**
 * Live lens namespace (server-only): differential questions + clinical lens
 * engine (Milestone 2). QUESTION-FOCUSED by design — evaluations surface
 * questions, considerations, missing information, conflicts, and safety
 * observations; never diagnoses, treatment plans, dosing, or patient-facing
 * recommendations.
 *
 * Desktop-owned boundary: every read uses the bounded Desktop DTO functions
 * and every question-lifecycle mutation calls the caller-authorized SECURITY
 * DEFINER RPCs from migration 0024 directly under the practitioner JWT. The
 * invariant core, lifecycle map, versioned answers, stale/supersede semantics,
 * and safety blocks stay database-enforced.
 *
 * Transitional exception (by design): `evaluate` and `aiStatus` remain on the
 * provider worker — the rules/AI engine computes the invariant core and
 * questions under the caller's RLS view and persists them atomically through
 * `run_lens_evaluation`. That compute engine is not Desktop-owned database
 * logic; it migrates in its own slice.
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
  mode: "fixture" | "live" | "disabled";
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

  async paradigms(sessionToken?: string | null): Promise<LensParadigmInfo[]> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LensParadigmInfo[]>("list_desktop_lens_paradigms", {}, token);
  },

  async domains(sessionToken?: string | null): Promise<LensDomainInfo[]> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LensDomainInfo[]>("list_desktop_lens_domains", {}, token);
  },

  async knowledgeSources(sessionToken?: string | null): Promise<KnowledgeSourceInfo[]> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<KnowledgeSourceInfo[]>("list_desktop_lens_knowledge_sources", {}, token);
  },

  evaluate(
    input: { encounterId: string; paradigm: LensParadigm },
    sessionToken?: string | null,
  ): Promise<EvaluateResult> {
    return trpcMutation<EvaluateResult>("clinical.lens.evaluate", input, sessionToken);
  },

  async evaluation(
    input: { encounterId: string; paradigm: LensParadigm },
    sessionToken?: string | null,
  ): Promise<LensEvaluation | null> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LensEvaluation | null>("get_desktop_lens_evaluation", {
      _encounter_id: input.encounterId,
      _paradigm: input.paradigm,
    }, token);
  },

  async answers(questionId: string, sessionToken?: string | null): Promise<QuestionAnswerVersion[]> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<QuestionAnswerVersion[]>("list_desktop_question_answers", {
      _question_id: questionId,
    }, token);
  },

  async questionAction(
    input: { questionId: string; action: QuestionLifecycleAction; reason?: string },
    sessionToken?: string | null,
  ): Promise<{ ok: true }> {
    const token = await getClinicalAccessToken(sessionToken);
    await clinicalRpc<null>("set_question_status", {
      _question_id: input.questionId,
      _to: input.action,
      _reason: input.reason ?? null,
    }, token);
    return { ok: true };
  },

  async dismiss(
    input: { questionId: string; feedbackKind: QuestionFeedbackKind; comment?: string },
    sessionToken?: string | null,
  ): Promise<{ ok: true }> {
    const token = await getClinicalAccessToken(sessionToken);
    await clinicalRpc<null>("dismiss_question", {
      _question_id: input.questionId,
      _feedback_kind: input.feedbackKind,
      _comment: input.comment ?? null,
    }, token);
    return { ok: true };
  },

  async answer(
    input: { questionId: string; value: Record<string, unknown> },
    sessionToken?: string | null,
  ): Promise<{ version: number }> {
    const token = await getClinicalAccessToken(sessionToken);
    const version = await clinicalRpc<number>("answer_question", {
      _question_id: input.questionId,
      _answer: input.value,
    }, token);
    return { version };
  },

  async correctAnswer(
    input: { questionId: string; value: Record<string, unknown>; reason?: string },
    sessionToken?: string | null,
  ): Promise<{ version: number }> {
    const token = await getClinicalAccessToken(sessionToken);
    const version = await clinicalRpc<number>("correct_question_answer", {
      _question_id: input.questionId,
      _answer: input.value,
      _reason: input.reason ?? null,
    }, token);
    return { version };
  },

  async recordNoteUse(
    input: { questionId: string; noteId: string },
    sessionToken?: string | null,
  ): Promise<{ ok: true }> {
    const token = await getClinicalAccessToken(sessionToken);
    await clinicalRpc<null>("record_question_note_use", {
      _question_id: input.questionId,
      _note_id: input.noteId,
    }, token);
    return { ok: true };
  },

  async feedback(
    input: { questionId: string; kind: QuestionFeedbackKind; comment?: string },
    sessionToken?: string | null,
  ): Promise<{ ok: true }> {
    const token = await getClinicalAccessToken(sessionToken);
    await clinicalRpc<null>("submit_question_feedback", {
      _question_id: input.questionId,
      _kind: input.kind,
      _comment: input.comment ?? null,
    }, token);
    return { ok: true };
  },

  async reviewSafetyBlock(
    input: { blockId: string; resolution: string },
    sessionToken?: string | null,
  ): Promise<{ ok: true }> {
    const token = await getClinicalAccessToken(sessionToken);
    await clinicalRpc<null>("review_safety_block", {
      _block_id: input.blockId,
      _resolution: input.resolution,
    }, token);
    return { ok: true };
  },
};
