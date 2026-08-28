if (typeof window !== "undefined") throw new Error("aws-daily-guidance is server-only");

import { createHash } from "node:crypto";
import {
  DAILY_GUIDANCE_EVIDENCE,
  DAILY_GUIDANCE_EVIDENCE_IDS,
  DAILY_GUIDANCE_EVIDENCE_VERSION,
  DAILY_GUIDANCE_REPRODUCTIVE_RULES,
  type DailyGuidanceEvidenceId,
} from "./daily-guidance-evidence";

export const DAILY_GUIDANCE_CONTRACT_VERSION = "daily-guidance/1";
export const REPRODUCTIVE_CONSENT_VERSION = "reproductive-health-consent/1";

export const MEASUREMENT_SPECS = {
  hrv_ms: { min: 1, max: 400, units: ["ms"] },
  resting_heart_rate_bpm: { min: 25, max: 240, units: ["bpm"] },
  sleep_duration_minutes: { min: 0, max: 1440, units: ["min"] },
  sleep_efficiency_percent: { min: 0, max: 100, units: ["percent"] },
  steps: { min: 0, max: 200000, units: ["count"] },
  respiratory_rate_bpm: { min: 3, max: 80, units: ["breaths/min"] },
  temperature_deviation_c: { min: -10, max: 10, units: ["c"] },
  active_minutes: { min: 0, max: 1440, units: ["min"] },
  energy_score: { min: 0, max: 10, units: ["score_0_10"] },
  stress_score: { min: 0, max: 10, units: ["score_0_10"] },
  soreness_score: { min: 0, max: 10, units: ["score_0_10"] },
  mood_score: { min: 0, max: 10, units: ["score_0_10"] },
  cravings_score: { min: 0, max: 10, units: ["score_0_10"] },
} as const;

export type DailyGuidanceMetric = keyof typeof MEASUREMENT_SPECS;
export type ReproductiveStage = "regular_cycle" | "irregular_cycle" | "hormonal_contraception"
  | "pregnant" | "postpartum" | "perimenopause" | "menopause" | "not_applicable" | "prefer_not_to_say";
export type CyclePhase = "menstrual" | "follicular" | "ovulatory" | "luteal" | "unknown";
export type GuidanceSymptom = "fatigue" | "cramps" | "bloating" | "headache" | "poor_sleep"
  | "low_mood" | "hot_flash" | "night_sweats" | "pelvic_pain" | "heavy_bleeding"
  | "dizziness" | "fainting" | "chest_pain" | "breathlessness_before_exertion"
  | "calf_pain_or_swelling" | "fluid_leakage" | "painful_contractions" | "severe_headache";

export type MeasuredInput = {
  metric: DailyGuidanceMetric;
  value: number;
  unit: string;
  observedAt: string;
  source: "apple_health" | "health_connect" | "manual_checkin";
  quality: "measured" | "user_reported";
};

export type BaselineInput = {
  metric: DailyGuidanceMetric;
  value: number;
  unit: string;
  windowDays: 7 | 14 | 30;
  sampleCount: number;
};

export type ReproductiveContext = {
  consent: { status: "granted"; artifactVersion: typeof REPRODUCTIVE_CONSENT_VERSION; acceptedAt: string };
  stage: ReproductiveStage;
  cycleDay?: number;
  estimatedPhase?: CyclePhase;
  postpartumWeeks?: number;
};

export type DailyGuidanceInput = {
  contractVersion: typeof DAILY_GUIDANCE_CONTRACT_VERSION;
  requestId: string;
  date: string;
  measurements: MeasuredInput[];
  baselines: BaselineInput[];
  symptoms: GuidanceSymptom[];
  reproductiveContext: ReproductiveContext | null;
};

export type DailyGuidanceAction = {
  category: "movement" | "nutrition" | "sleep" | "recovery";
  title: string;
  rationale: string;
  inputMetrics: DailyGuidanceMetric[];
  evidenceIds: DailyGuidanceEvidenceId[];
};

export type DailyGuidanceResult = {
  contractVersion: typeof DAILY_GUIDANCE_CONTRACT_VERSION;
  summary: string;
  actions: DailyGuidanceAction[];
  confidence: "low" | "moderate" | "high";
  missingCoreMetrics: DailyGuidanceMetric[];
  cycleContext: { stage: ReproductiveStage; phase: CyclePhase; phaseConfidence: "none" | "low" } | null;
  escalation: { level: "none" | "routine" | "urgent"; message: string };
  provenance: {
    generatedAt: string;
    provider: "openai";
    model: string;
    inputSha256: string;
    evidenceVersion: typeof DAILY_GUIDANCE_EVIDENCE_VERSION;
    evidence: Array<{ id: DailyGuidanceEvidenceId; title: string; url: string }>;
  };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SYMPTOMS = new Set<GuidanceSymptom>([
  "fatigue", "cramps", "bloating", "headache", "poor_sleep", "low_mood", "hot_flash", "night_sweats",
  "pelvic_pain", "heavy_bleeding", "dizziness", "fainting", "chest_pain", "breathlessness_before_exertion",
  "calf_pain_or_swelling", "fluid_leakage", "painful_contractions", "severe_headache",
]);
const STAGES = new Set<ReproductiveStage>([
  "regular_cycle", "irregular_cycle", "hormonal_contraception", "pregnant", "postpartum", "perimenopause",
  "menopause", "not_applicable", "prefer_not_to_say",
]);
const PHASES = new Set<CyclePhase>(["menstrual", "follicular", "ovulatory", "luteal", "unknown"]);
const CORE_METRICS = new Set<DailyGuidanceMetric>(["hrv_ms", "resting_heart_rate_bpm", "sleep_duration_minutes"]);

export class DailyGuidanceError extends Error {
  constructor(readonly category: "request_invalid" | "insufficient_measured_data" | "reproductive_consent_required" | "provider_unavailable" | "unsafe_output_refused") {
    super(category);
    this.name = "DailyGuidanceError";
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DailyGuidanceError("request_invalid");
  return value as Record<string, unknown>;
}

function exact(row: Record<string, unknown>, allowed: readonly string[], required: readonly string[]) {
  if (Object.keys(row).some((key) => !allowed.includes(key)) || required.some((key) => !(key in row))) {
    throw new DailyGuidanceError("request_invalid");
  }
}

function iso(value: unknown): string {
  if (typeof value !== "string" || !ISO.test(value) || !Number.isFinite(Date.parse(value))) throw new DailyGuidanceError("request_invalid");
  return value;
}

export function validateDailyGuidanceInput(value: unknown): DailyGuidanceInput {
  const row = object(value);
  exact(row, ["contractVersion", "requestId", "date", "measurements", "baselines", "symptoms", "reproductiveContext"],
    ["contractVersion", "requestId", "date", "measurements", "baselines", "symptoms", "reproductiveContext"]);
  if (row.contractVersion !== DAILY_GUIDANCE_CONTRACT_VERSION || typeof row.requestId !== "string" || !UUID.test(row.requestId)
    || typeof row.date !== "string" || !DATE.test(row.date) || !Array.isArray(row.measurements)
    || row.measurements.length < 2 || row.measurements.length > 24 || !Array.isArray(row.baselines)
    || row.baselines.length > 24 || !Array.isArray(row.symptoms) || row.symptoms.length > 20) {
    throw new DailyGuidanceError("request_invalid");
  }
  const seen = new Set<string>();
  const measurements = row.measurements.map((candidate): MeasuredInput => {
    const item = object(candidate);
    exact(item, ["metric", "value", "unit", "observedAt", "source", "quality"], ["metric", "value", "unit", "observedAt", "source", "quality"]);
    const metric = item.metric as DailyGuidanceMetric;
    const spec = MEASUREMENT_SPECS[metric];
    if (!spec || typeof item.value !== "number" || !Number.isFinite(item.value) || item.value < spec.min || item.value > spec.max
      || typeof item.unit !== "string" || !(spec.units as readonly string[]).includes(item.unit)
      || !["apple_health", "health_connect", "manual_checkin"].includes(String(item.source))
      || !["measured", "user_reported"].includes(String(item.quality)) || seen.has(metric)) throw new DailyGuidanceError("request_invalid");
    if ((item.source === "manual_checkin") !== (item.quality === "user_reported")) throw new DailyGuidanceError("request_invalid");
    seen.add(metric);
    return { metric, value: item.value, unit: item.unit, observedAt: iso(item.observedAt), source: item.source, quality: item.quality } as MeasuredInput;
  });
  const measuredCore = measurements.filter((item) => item.quality === "measured" && CORE_METRICS.has(item.metric));
  if (measuredCore.length < 2) throw new DailyGuidanceError("insufficient_measured_data");
  const baselines = row.baselines.map((candidate): BaselineInput => {
    const item = object(candidate);
    exact(item, ["metric", "value", "unit", "windowDays", "sampleCount"], ["metric", "value", "unit", "windowDays", "sampleCount"]);
    const metric = item.metric as DailyGuidanceMetric;
    const spec = MEASUREMENT_SPECS[metric];
    if (!spec || typeof item.value !== "number" || !Number.isFinite(item.value) || item.value < spec.min || item.value > spec.max
      || typeof item.unit !== "string" || !(spec.units as readonly string[]).includes(item.unit)
      || ![7, 14, 30].includes(Number(item.windowDays)) || !Number.isInteger(item.sampleCount)
      || Number(item.sampleCount) < 3 || Number(item.sampleCount) > Number(item.windowDays)) throw new DailyGuidanceError("request_invalid");
    return item as unknown as BaselineInput;
  });
  const symptoms = row.symptoms.map((item) => {
    if (typeof item !== "string" || !SYMPTOMS.has(item as GuidanceSymptom)) throw new DailyGuidanceError("request_invalid");
    return item as GuidanceSymptom;
  });
  if (new Set(symptoms).size !== symptoms.length) throw new DailyGuidanceError("request_invalid");
  const reproductiveContext = row.reproductiveContext === null ? null : validateReproductiveContext(row.reproductiveContext);
  return { contractVersion: DAILY_GUIDANCE_CONTRACT_VERSION, requestId: row.requestId, date: row.date, measurements, baselines, symptoms, reproductiveContext };
}

function validateReproductiveContext(value: unknown): ReproductiveContext {
  const row = object(value);
  exact(row, ["consent", "stage", "cycleDay", "estimatedPhase", "postpartumWeeks"], ["consent", "stage"]);
  const consent = object(row.consent);
  exact(consent, ["status", "artifactVersion", "acceptedAt"], ["status", "artifactVersion", "acceptedAt"]);
  if (consent.status !== "granted" || consent.artifactVersion !== REPRODUCTIVE_CONSENT_VERSION) throw new DailyGuidanceError("reproductive_consent_required");
  const stage = row.stage as ReproductiveStage;
  if (!STAGES.has(stage)) throw new DailyGuidanceError("request_invalid");
  const acceptedAt = iso(consent.acceptedAt);
  const cycleDay = row.cycleDay;
  const phase = row.estimatedPhase as CyclePhase | undefined;
  const postpartumWeeks = row.postpartumWeeks;
  if (cycleDay !== undefined && (!Number.isInteger(cycleDay) || Number(cycleDay) < 1 || Number(cycleDay) > 90)) throw new DailyGuidanceError("request_invalid");
  if (phase !== undefined && !PHASES.has(phase)) throw new DailyGuidanceError("request_invalid");
  if (postpartumWeeks !== undefined && (!Number.isInteger(postpartumWeeks) || Number(postpartumWeeks) < 0 || Number(postpartumWeeks) > 104)) throw new DailyGuidanceError("request_invalid");
  if (stage !== "regular_cycle" && (cycleDay !== undefined || (phase !== undefined && phase !== "unknown"))) throw new DailyGuidanceError("request_invalid");
  if (stage === "regular_cycle" && cycleDay === undefined) throw new DailyGuidanceError("request_invalid");
  if ((stage === "postpartum") !== (postpartumWeeks !== undefined)) throw new DailyGuidanceError("request_invalid");
  return {
    consent: { status: "granted", artifactVersion: REPRODUCTIVE_CONSENT_VERSION, acceptedAt }, stage,
    ...(cycleDay !== undefined ? { cycleDay: Number(cycleDay) } : {}),
    ...(phase !== undefined ? { estimatedPhase: phase } : {}),
    ...(postpartumWeeks !== undefined ? { postpartumWeeks: Number(postpartumWeeks) } : {}),
  };
}

export function deriveCycleContext(context: ReproductiveContext | null): DailyGuidanceResult["cycleContext"] {
  if (!context) return null;
  if (context.stage !== "regular_cycle") return { stage: context.stage, phase: "unknown", phaseConfidence: "none" };
  return { stage: context.stage, phase: context.estimatedPhase ?? "unknown", phaseConfidence: context.estimatedPhase && context.estimatedPhase !== "unknown" ? "low" : "none" };
}

export function safetyEscalation(input: DailyGuidanceInput): DailyGuidanceResult["escalation"] {
  const urgent = new Set<GuidanceSymptom>(["fainting", "chest_pain", "breathlessness_before_exertion", "calf_pain_or_swelling", "fluid_leakage", "painful_contractions"]);
  if (input.symptoms.some((symptom) => urgent.has(symptom))) return { level: "urgent", message: "Stop exercise and seek prompt medical care for the reported warning symptom." };
  if (input.symptoms.includes("heavy_bleeding") && (input.symptoms.includes("dizziness") || input.symptoms.includes("severe_headache"))) {
    return { level: "urgent", message: "Heavy bleeding with dizziness or severe symptoms needs urgent medical evaluation." };
  }
  if (input.symptoms.includes("heavy_bleeding") || input.symptoms.includes("pelvic_pain")
    || input.reproductiveContext?.stage === "irregular_cycle" || input.reproductiveContext?.stage === "perimenopause"
    || input.reproductiveContext?.stage === "menopause") {
    return { level: "routine", message: "Consider discussing the reported reproductive-health pattern with a qualified healthcare professional." };
  }
  return { level: "none", message: "" };
}

export function inputSha256(input: DailyGuidanceInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function evidenceFor(ids: DailyGuidanceEvidenceId[]) {
  return ids.map((id) => ({ id, title: DAILY_GUIDANCE_EVIDENCE[id].title, url: DAILY_GUIDANCE_EVIDENCE[id].url }));
}

export function validateDailyGuidanceResult(input: {
  value: unknown;
  request: DailyGuidanceInput;
  model: string;
  generatedAt?: string;
}): DailyGuidanceResult {
  const row = object(input.value);
  exact(row, ["summary", "actions", "confidence"], ["summary", "actions", "confidence"]);
  if (typeof row.summary !== "string" || row.summary.length < 1 || row.summary.length > 600
    || !Array.isArray(row.actions) || row.actions.length < 1 || row.actions.length > 5
    || !["low", "moderate", "high"].includes(String(row.confidence))) throw new DailyGuidanceError("unsafe_output_refused");
  const presentMetrics = new Set(input.request.measurements.map((measurement) => measurement.metric));
  const evidenceIds = new Set<DailyGuidanceEvidenceId>();
  const actions = row.actions.map((candidate): DailyGuidanceAction => {
    const action = object(candidate);
    exact(action, ["category", "title", "rationale", "inputMetrics", "evidenceIds"], ["category", "title", "rationale", "inputMetrics", "evidenceIds"]);
    if (!["movement", "nutrition", "sleep", "recovery"].includes(String(action.category))
      || typeof action.title !== "string" || action.title.length < 1 || action.title.length > 120
      || typeof action.rationale !== "string" || action.rationale.length < 1 || action.rationale.length > 400
      || !Array.isArray(action.inputMetrics) || action.inputMetrics.length < 1 || action.inputMetrics.length > 8
      || action.inputMetrics.some((metric) => typeof metric !== "string" || !presentMetrics.has(metric as DailyGuidanceMetric))
      || !Array.isArray(action.evidenceIds) || action.evidenceIds.length < 1 || action.evidenceIds.length > 4
      || action.evidenceIds.some((id) => typeof id !== "string" || !DAILY_GUIDANCE_EVIDENCE_IDS.includes(id as DailyGuidanceEvidenceId))) {
      throw new DailyGuidanceError("unsafe_output_refused");
    }
    for (const id of action.evidenceIds as DailyGuidanceEvidenceId[]) evidenceIds.add(id);
    return action as unknown as DailyGuidanceAction;
  });
  const combined = `${row.summary} ${actions.map((action) => `${action.title} ${action.rationale}`).join(" ")}`;
  if (/https?:\/\//i.test(combined) || /\b(?:diagnos|cure|treat|prescri|start|stop|increase|decrease|adjust)\w*\s+(?:medication|hormone|supplement|dose)/i.test(combined)
    || /\b\d+(?:\.\d+)?\s*(?:mg|mcg|iu)\b/i.test(combined) || /\b(?:buy|purchase|affiliate)\b/i.test(combined)) {
    throw new DailyGuidanceError("unsafe_output_refused");
  }
  if (input.request.reproductiveContext) {
    const required = DAILY_GUIDANCE_REPRODUCTIVE_RULES[input.request.reproductiveContext.stage].evidenceIds;
    if (!required.some((id) => evidenceIds.has(id))) throw new DailyGuidanceError("unsafe_output_refused");
  }
  const escalation = safetyEscalation(input.request);
  const missingCoreMetrics = [...CORE_METRICS].filter((metric) => !presentMetrics.has(metric));
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  return {
    contractVersion: DAILY_GUIDANCE_CONTRACT_VERSION,
    summary: row.summary,
    actions,
    confidence: row.confidence as DailyGuidanceResult["confidence"],
    missingCoreMetrics,
    cycleContext: deriveCycleContext(input.request.reproductiveContext),
    escalation,
    provenance: {
      generatedAt,
      provider: "openai",
      model: input.model,
      inputSha256: inputSha256(input.request),
      evidenceVersion: DAILY_GUIDANCE_EVIDENCE_VERSION,
      evidence: evidenceFor([...evidenceIds]),
    },
  };
}
