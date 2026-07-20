"use client";

import { useSyncExternalStore } from "react";
import {
  getProtocolTemplate,
  LAB_CATALOG,
  listDraftableProducts,
  partitionKnownProductIds,
  QUESTIONNAIRE,
  recommendLabs,
  REGISTRY_CONTENT_SHA256,
  REGISTRY,
  scoreSubmission,
  type CategoryScreeningScore,
  type LabRecommendation,
  type SubmittedAnswer,
} from "@/lib/registry";
import { addSessionQueueItem, recordAuditEntry } from "./session-store";
import { getPatient } from "./patients.mock";

/**
 * Assessments demo adapter — the synthetic, session-only mirror of the real
 * flow (invite → patient onboarding → immutable submission → practitioner
 * review → draft lab/protocol recommendations).
 *
 * Everything here is scored by the SAME registry engine the mobile app and
 * the database-backed API use (scoring.v2 over the sha256-pinned content),
 * so the demo shows real behavior — including the rules the live backend
 * enforces:
 *   - submissions are immutable once submitted (no edit paths exist here);
 *   - lab/protocol recommendations stay DRAFTS until a practitioner decides;
 *   - protocol drafts cannot be APPROVED while any product is unverified
 *     (today: all 15 are pending_verification, so approval is always
 *     blocked, exactly like the database trigger);
 *   - decisions are append-only.
 *
 * Backed by sessionStorage like the rest of the demo session — cleared when
 * the browser session ends, never a pretend backend.
 */

/* ------------------------------------------------------------------ types */

export type InvitationStatus = "sent" | "in_progress" | "submitted";

export interface AssessmentInvitation {
  id: string;
  patientId: string;
  patientName: string;
  moduleIds: string[];
  status: InvitationStatus;
  sentAt: string;
  /** Autosave progress while the patient works (answered count). */
  progressAnswered: number;
  progressTotal: number;
  lastSavedAt: string | null;
  submissionId: string | null;
}

export type LabDecisionKind =
  | "approve"
  | "modify"
  | "dismiss"
  | "request_data"
  | "create_order_draft";

export interface LabDecision {
  id: string;
  labId: string;
  decision: LabDecisionKind;
  note: string | null;
  at: string;
}

export interface AssessmentSubmission {
  id: string;
  invitationId: string;
  patientId: string;
  patientName: string;
  submittedAt: string;
  scenario: string;
  /** Version + integrity provenance — travels with every submission. */
  questionnaireVersion: string;
  scoringVersion: string;
  ruleVersion: string;
  registryVersion: string;
  contentHash: string;
  answered: number;
  special: number;
  unanswered: number;
  categories: CategoryScreeningScore[];
  elevatedCategoryIds: string[];
  moderateOrHigherCategoryIds: string[];
  labs: LabRecommendation[];
  reviewState: "pending_practitioner_review" | "reviewed";
  /** Append-only — mirrors recommendation_decisions. */
  decisions: LabDecision[];
}

export interface ProtocolDraftItem {
  productId: string;
  name: string;
  brand: string;
  approvalState: string;
  doseText: string;
  schedule: string;
  durationDays: number;
  monitoring: string;
}

export interface ProtocolDraft {
  id: string;
  patientId: string;
  patientName: string;
  submissionId: string | null;
  name: string;
  version: number;
  status: "draft" | "superseded";
  items: ProtocolDraftItem[];
  scheduleSummary: string;
  recheckPlan: string;
  startCriteria: string;
  stopCriteria: string;
  createdAt: string;
  /** Set when a newer version replaced this one (original preserved). */
  supersededByVersion: number | null;
  /** Result of the last approval attempt — mirrors the DB trigger message. */
  approvalBlockedReason: string | null;
}

interface AssessmentsState {
  invitations: AssessmentInvitation[];
  submissions: AssessmentSubmission[];
  drafts: ProtocolDraft[];
}

/* ------------------------------------------------------------------ store */

const KEY = "aidp:demo:assessments";
const EMPTY: AssessmentsState = { invitations: [], submissions: [], drafts: [] };

let cache: AssessmentsState | null = null;
let snapshotCache: AssessmentsState | null = null;
const listeners = new Set<() => void>();

function emit() {
  snapshotCache = null;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function read(): AssessmentsState {
  if (cache) return cache;
  if (typeof window === "undefined") return (cache = { ...EMPTY });
  try {
    cache = JSON.parse(window.sessionStorage.getItem(KEY) ?? "null") ?? { ...EMPTY };
  } catch {
    cache = { ...EMPTY };
  }
  return cache!;
}

function persist(next: AssessmentsState) {
  cache = next;
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* session demo only */
    }
  }
  emit();
}

function newId(prefix: string): string {
  try {
    return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
  } catch {
    return `${prefix}_${Date.now()}_${Math.round(Math.random() * 1e6)}`;
  }
}

function getSnapshot(): AssessmentsState {
  if (!snapshotCache) snapshotCache = { ...read() };
  return snapshotCache;
}

export function useAssessmentsState(): AssessmentsState {
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
}

/* ------------------------------------------------------------ invitations */

export const TOTAL_QUESTIONS = QUESTIONNAIRE.categories.reduce(
  (n, c) => n + c.questions.length,
  0,
);

export function createInvitation(patientId: string, moduleIds: string[]): AssessmentInvitation {
  const patient = getPatient(patientId);
  if (!patient) throw new Error("Unknown patient");
  const invitation: AssessmentInvitation = {
    id: newId("inv"),
    patientId,
    patientName: patient.name,
    moduleIds,
    status: "sent",
    sentAt: new Date().toISOString(),
    progressAnswered: 0,
    progressTotal: TOTAL_QUESTIONS,
    lastSavedAt: null,
    submissionId: null,
  };
  const s = read();
  persist({ ...s, invitations: [invitation, ...s.invitations] });
  recordAuditEntry({
    kind: "assessment_invited",
    subjectType: "assessment invitation",
    subjectLabel: `Symptom-pattern screening (${QUESTIONNAIRE.version})`,
    patientName: patient.name,
    reviewed: false,
  });
  return invitation;
}

/* --------------------------------------------------- simulated patient side */

export type SimulationScenario = "elevated-mold-gut" | "moderate-thyroid" | "sparse-insufficient";

export const SCENARIO_LABELS: Record<SimulationScenario, string> = {
  "elevated-mold-gut": "Elevated mold + gut pattern (full answers)",
  "moderate-thyroid": "Moderate thyroid, uses NA/unsure options",
  "sparse-insufficient": "Sparse answers — insufficient data",
};

/**
 * Deterministic synthetic answer sets. No real patient data — these exist so
 * the review workspace can be demonstrated end-to-end, including the
 * completeness floor and special answers.
 */
function scenarioAnswers(scenario: SimulationScenario): SubmittedAnswer[] {
  const byCategory = new Map(QUESTIONNAIRE.categories.map((c) => [c.id, c.questions]));
  const answers: SubmittedAnswer[] = [];
  const rate = (categoryId: string, values: (0 | 1 | 2 | 3 | 4 | "na" | "unsure" | "skip")[]) => {
    const questions = byCategory.get(categoryId) ?? [];
    values.forEach((v, i) => {
      const q = questions[i];
      if (!q || v === "skip") return;
      if (v === "na") answers.push({ questionId: q.id, value: "not_applicable" });
      else if (v === "unsure") answers.push({ questionId: q.id, value: "unsure" });
      else answers.push({ questionId: q.id, value: v });
    });
  };

  if (scenario === "elevated-mold-gut") {
    for (const c of QUESTIONNAIRE.categories) {
      if (c.id === "mold") rate(c.id, [4, 3, 4, 3, 4, 3, 4, 3, 4, 3]);
      else if (c.id === "gut_digestive") rate(c.id, [3, 3, 2, 3, 2, 3, 2, 3, 2, 3]);
      else if (c.id === "leaky_gut") rate(c.id, [2, 2, 1, 2, 1, 2, 1, 2, 1, 2]);
      else rate(c.id, [1, 0, 1, 0, 0, 1, 0, 0, 1, 0]);
    }
  } else if (scenario === "moderate-thyroid") {
    for (const c of QUESTIONNAIRE.categories) {
      if (c.id === "thyroid") rate(c.id, [2, 1, 2, 1, 1, 2, 1, "na", 1, 2]);
      else if (c.id === "adrenal") rate(c.id, [1, 1, 2, 1, "unsure", 1, 1, 1, 0, 1]);
      else if (c.id === "hormones") rate(c.id, ["na", "na", 1, 1, 0, 1, 0, 1, 0, 1]);
      else rate(c.id, [0, 1, 0, 0, 1, 0, 0, "unsure", 0, 0]);
    }
  } else {
    // Only a handful of answers anywhere — every category lands under the
    // completeness floor and must report insufficient data, never a score.
    rate("mold", [4, 4, "skip", "skip", "skip", "skip", "skip", "skip", "skip", "skip"]);
    rate("thyroid", [3, "skip", "skip", 2, "skip", "skip", "skip", "skip", "skip", "skip"]);
  }
  return answers;
}

/** Marks the invitation in progress with a partial autosave — resumable state. */
export function simulatePatientProgress(invitationId: string): void {
  const s = read();
  const invitations = s.invitations.map((inv) =>
    inv.id === invitationId && inv.status === "sent"
      ? {
          ...inv,
          status: "in_progress" as const,
          progressAnswered: Math.round(TOTAL_QUESTIONS * 0.4),
          lastSavedAt: new Date().toISOString(),
        }
      : inv,
  );
  persist({ ...s, invitations });
}

/**
 * Simulates the patient finishing onboarding: scores with the SAME registry
 * engine as mobile + the database path, freezes the result as an immutable
 * submission, and surfaces it to Tasks + the audit trail.
 */
export function simulatePatientSubmission(
  invitationId: string,
  scenario: SimulationScenario,
): AssessmentSubmission {
  const s = read();
  const invitation = s.invitations.find((i) => i.id === invitationId);
  if (!invitation) throw new Error("Unknown invitation");
  if (invitation.status === "submitted" && invitation.submissionId) {
    // Idempotent: a second submit replays the existing submission.
    const existing = s.submissions.find((x) => x.id === invitation.submissionId);
    if (existing) return existing;
  }

  const answers = scenarioAnswers(scenario);
  const screening = scoreSubmission(answers);
  const labs = recommendLabs(screening);
  const answered = screening.categories.reduce((n, c) => n + c.answered, 0);
  const special = screening.categories.reduce((n, c) => n + c.special, 0);

  const submission: AssessmentSubmission = {
    id: newId("sub"),
    invitationId,
    patientId: invitation.patientId,
    patientName: invitation.patientName,
    submittedAt: new Date().toISOString(),
    scenario: SCENARIO_LABELS[scenario],
    questionnaireVersion: screening.questionnaireVersion,
    scoringVersion: screening.scoringVersion,
    ruleVersion: labs.ruleVersion,
    registryVersion: screening.registryVersion,
    contentHash: REGISTRY_CONTENT_SHA256,
    answered,
    special,
    unanswered: TOTAL_QUESTIONS - answered - special,
    categories: screening.categories,
    elevatedCategoryIds: screening.elevatedCategoryIds,
    moderateOrHigherCategoryIds: screening.moderateOrHigherCategoryIds,
    labs: labs.recommendations,
    reviewState: "pending_practitioner_review",
    decisions: [],
  };

  const invitations = s.invitations.map((inv) =>
    inv.id === invitationId
      ? {
          ...inv,
          status: "submitted" as const,
          progressAnswered: answered + special,
          lastSavedAt: submission.submittedAt,
          submissionId: submission.id,
        }
      : inv,
  );
  persist({ ...s, invitations, submissions: [submission, ...s.submissions] });

  addSessionQueueItem({
    title: `Review symptom-pattern screening — ${invitation.patientName}`,
    patientName: invitation.patientName,
    patientId: invitation.patientId,
    category: "Assessments",
    priority: submission.elevatedCategoryIds.length > 0 ? "High" : "Medium",
    seeds: [
      `${submission.elevatedCategoryIds.length} elevated / ${submission.moderateOrHigherCategoryIds.length} moderate+ categories`,
      `Scoring ${submission.scoringVersion} · content ${submission.contentHash.slice(0, 8)}…`,
    ],
  });
  recordAuditEntry({
    kind: "assessment_submitted",
    subjectType: "assessment submission",
    subjectLabel: `Screening submitted (${submission.questionnaireVersion}/${submission.scoringVersion})`,
    patientName: invitation.patientName,
    reviewed: false,
  });
  return submission;
}

/* ------------------------------------------------------------- decisions */

/** Append-only, like recommendation_decisions — nothing is ever rewritten. */
export function recordLabDecision(
  submissionId: string,
  labId: string,
  decision: LabDecisionKind,
  note: string | null,
): void {
  const s = read();
  const submissions = s.submissions.map((sub) => {
    if (sub.id !== submissionId) return sub;
    const entry: LabDecision = {
      id: newId("dec"),
      labId,
      decision,
      note,
      at: new Date().toISOString(),
    };
    const decisions = [...sub.decisions, entry];
    const decidedLabIds = new Set(
      decisions.filter((d) => d.decision !== "request_data").map((d) => d.labId),
    );
    const allDecided = sub.labs.every((l) => decidedLabIds.has(l.labId));
    return {
      ...sub,
      decisions,
      reviewState: allDecided ? ("reviewed" as const) : sub.reviewState,
    };
  });
  persist({ ...s, submissions });

  const sub = submissions.find((x) => x.id === submissionId);
  const lab = LAB_CATALOG.find((l) => l.id === labId);
  recordAuditEntry({
    kind:
      decision === "dismiss"
        ? "reject"
        : decision === "create_order_draft"
          ? "order_prepared"
          : decision === "modify"
            ? "modify"
            : decision === "request_data"
              ? "request_data"
              : "approve",
    subjectType: "lab recommendation",
    subjectLabel: `${lab?.panelName ?? labId}: ${decision.replace(/_/g, " ")}`,
    patientName: sub?.patientName,
    reviewed: decision !== "request_data",
    outcome:
      decision === "approve" || decision === "create_order_draft"
        ? "approved"
        : decision === "dismiss"
          ? "rejected"
          : "reviewed",
  });
  if (decision === "create_order_draft" && sub && lab) {
    addSessionQueueItem({
      title: `Lab order draft — ${lab.panelName}`,
      patientName: sub.patientName,
      patientId: sub.patientId,
      category: "Lab orders",
      priority: "Medium",
      seeds: ["Draft only — requires practitioner signature in the ordering system"],
    });
  }
}

/* --------------------------------------------------------- protocol drafts */

export interface NewProtocolDraftInput {
  patientId: string;
  submissionId: string | null;
  name: string;
  templateId?: string;
  productIds: string[];
  scheduleSummary: string;
  recheckPlan: string;
  startCriteria: string;
  stopCriteria: string;
}

/**
 * Creates a protocol DRAFT. Unknown/invented product ids are rejected before
 * any state changes — the same check `create_protocol_draft` runs in SQL.
 */
export function createProtocolDraft(input: NewProtocolDraftInput): ProtocolDraft {
  const patient = getPatient(input.patientId);
  if (!patient) throw new Error("Unknown patient");
  const { unknown } = partitionKnownProductIds(input.productIds);
  if (unknown.length > 0) {
    throw new Error(`Unknown products rejected: ${unknown.join(", ")}`);
  }
  if (input.productIds.length === 0) throw new Error("A protocol draft needs at least one product");

  const products = new Map(listDraftableProducts().map((p) => [p.id, p]));
  const template = input.templateId ? getProtocolTemplate(input.templateId) : null;
  const items: ProtocolDraftItem[] = input.productIds.map((id) => {
    const p = products.get(id)!;
    const t = template?.items.find((i) => i.supplementId === id);
    return {
      productId: p.id,
      name: p.name,
      brand: p.brand,
      approvalState: p.approvalState,
      doseText: t?.doseText ?? p.doseText,
      schedule: t?.schedule ?? "daily",
      durationDays: t?.durationDays ?? 90,
      monitoring: (t?.monitoring ?? p.monitoring ?? []).join("; ") || "Symptom diary weekly",
    };
  });

  const s = read();
  const priorVersions = s.drafts.filter(
    (d) => d.patientId === input.patientId && d.name === input.name,
  );
  const version = priorVersions.length + 1;
  // A new version supersedes prior drafts of the same protocol — the
  // originals are preserved verbatim, never edited in place.
  const drafts = s.drafts.map((d) =>
    d.patientId === input.patientId && d.name === input.name && d.status === "draft"
      ? { ...d, status: "superseded" as const, supersededByVersion: version }
      : d,
  );

  const draft: ProtocolDraft = {
    id: newId("pd"),
    patientId: input.patientId,
    patientName: patient.name,
    submissionId: input.submissionId,
    name: input.name,
    version,
    status: "draft",
    items,
    scheduleSummary: input.scheduleSummary,
    recheckPlan: input.recheckPlan,
    startCriteria: input.startCriteria,
    stopCriteria: input.stopCriteria,
    createdAt: new Date().toISOString(),
    supersededByVersion: null,
    approvalBlockedReason: null,
  };
  persist({ ...s, drafts: [draft, ...drafts] });
  recordAuditEntry({
    kind: "protocol_draft_created",
    subjectType: "protocol draft",
    subjectLabel: `${draft.name} v${draft.version} (${items.length} items)`,
    patientName: patient.name,
    reviewed: false,
  });
  return draft;
}

/**
 * Attempts approval and records the blocked reason. Mirrors the database
 * trigger exactly: while ANY item's product is not `approved`, the draft
 * cannot become an approved protocol. Today every registry product is
 * pending_verification, so this ALWAYS blocks — by design, until the
 * owner's authoritative list is reconciled.
 */
export function attemptApproveProtocolDraft(draftId: string): { approved: boolean; reason: string } {
  const s = read();
  const draft = s.drafts.find((d) => d.id === draftId);
  if (!draft) throw new Error("Unknown draft");
  const unapproved = draft.items.filter((i) => i.approvalState !== "approved");
  const reason =
    unapproved.length > 0
      ? `Approval blocked (as in the database): ${unapproved.length} of ${draft.items.length} products are pending verification — see docs/supplement-reconciliation.md. No unapproved product can enter an approved protocol.`
      : "";
  if (unapproved.length > 0) {
    const drafts = s.drafts.map((d) =>
      d.id === draftId ? { ...d, approvalBlockedReason: reason } : d,
    );
    persist({ ...s, drafts });
    return { approved: false, reason };
  }
  // Unreachable today (no approved products exist); kept for completeness.
  return { approved: true, reason: "" };
}

/* ------------------------------------------------------------ read helpers */

export function listSubmissionsForPatient(patientId: string): AssessmentSubmission[] {
  return read().submissions.filter((s) => s.patientId === patientId);
}

export const REGISTRY_META = {
  registryVersion: REGISTRY.registryVersion,
  questionnaireVersion: QUESTIONNAIRE.version,
  scoringVersion: QUESTIONNAIRE.scoringVersion,
  contentHash: REGISTRY_CONTENT_SHA256,
};
