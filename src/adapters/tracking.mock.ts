"use client";

/**
 * Tracking & Experiments (MOCK): wearables, Mind & Cognition, assessments,
 * and the longitudinal systems model that makes Health Twin a trajectory
 * view rather than another overview. All synthetic; no device is connected.
 */
import { createSessionStore } from "./session-kv";
import type { Tone } from "./types";

/* -------------------------------------------------------------- wearables */

export interface WearableDevice {
  id: string;
  name: string;
  kind: "ring" | "cgm" | "watch";
  status: "demo data" | "not connected";
  lastSyncLabel: string;
  streams: string[];
}

export interface WearableSeries {
  id: string;
  label: string;
  unit: string;
  tone: Tone;
  baseline: string;
  current: string;
  direction: "up" | "down" | "flat";
  good: boolean;
  series: number[];
}

export interface WearableAlert {
  id: string;
  patientId: string;
  patientName: string;
  severity: "critical" | "warning";
  title: string;
  detail: string;
  atLabel: string;
}

const DEVICES: Record<string, WearableDevice[]> = {
  "p-78435": [
    { id: "d-oura", name: "Smart ring (demo)", kind: "ring", status: "demo data", lastSyncLabel: "Today 6:04 AM", streams: ["Sleep", "HRV", "Resting HR", "Temperature"] },
  ],
  "p-64201": [
    { id: "d-cgm", name: "CGM sensor (demo)", kind: "cgm", status: "demo data", lastSyncLabel: "Today 7:30 AM", streams: ["Glucose"] },
    { id: "d-watch", name: "Watch (demo)", kind: "watch", status: "demo data", lastSyncLabel: "Today 7:10 AM", streams: ["Steps", "Heart rate"] },
  ],
};

const SERIES: Record<string, WearableSeries[]> = {
  "p-78435": [
    { id: "hrv", label: "Overnight HRV", unit: "ms", tone: "critical", baseline: "41 (30-d)", current: "28", direction: "down", good: false, series: [42, 40, 41, 39, 38, 36, 33, 30, 28] },
    { id: "rhr", label: "Resting heart rate", unit: "bpm", tone: "warning", baseline: "58 (30-d)", current: "63", direction: "up", good: false, series: [58, 58, 59, 59, 60, 61, 62, 63, 63] },
    { id: "sleep", label: "Sleep duration", unit: "h", tone: "positive", baseline: "6.9 (30-d)", current: "7.4", direction: "up", good: true, series: [6.6, 6.8, 7.0, 6.9, 7.1, 7.2, 7.3, 7.4, 7.4] },
    { id: "temp", label: "Skin temp deviation", unit: "°C", tone: "slate", baseline: "0.0", current: "+0.3", direction: "up", good: true, series: [0, 0.1, 0, 0.1, 0.2, 0.1, 0.2, 0.3, 0.3] },
  ],
  "p-64201": [
    { id: "glucose", label: "Post-dinner glucose peak", unit: "mg/dL", tone: "warning", baseline: "142 (14-d)", current: "163", direction: "up", good: false, series: [138, 141, 149, 152, 148, 155, 160, 158, 163] },
    { id: "steps", label: "Daily steps", unit: "", tone: "positive", baseline: "6.2k (30-d)", current: "7.8k", direction: "up", good: true, series: [5800, 6100, 6400, 6900, 7000, 7200, 7500, 7700, 7800] },
  ],
};

export const WEARABLE_ALERTS: WearableAlert[] = [
  { id: "wa-1", patientId: "p-78435", patientName: "Alexandra Morgan", severity: "critical", title: "HRV low 3 nights running", detail: "Overnight HRV 28 ms vs baseline 41 ms, with rising resting HR.", atLabel: "Today 5:10 AM" },
  { id: "wa-2", patientId: "p-64201", patientName: "Michael Johnson", severity: "warning", title: "Post-dinner glucose >160 mg/dL", detail: "4 of the last 7 evenings — protocol adherence check suggested.", atLabel: "Yesterday" },
];

export function getWearables(patientId: string) {
  return {
    devices: DEVICES[patientId] ?? [],
    series: SERIES[patientId] ?? [],
    alerts: WEARABLE_ALERTS.filter((a) => a.patientId === patientId),
  };
}

/* ------------------------------------------------------- mind & cognition */

export interface MindSeries {
  id: string;
  label: string;
  tone: Tone;
  /** 0–100 weekly index, oldest → newest. */
  series: number[];
  current: string;
  note: string;
}

export interface NeurocogScore {
  name: string;
  score: string;
  atLabel: string;
  trend: "improving" | "stable" | "declining";
  note: string;
}

export interface MindIntervention {
  name: string;
  startedLabel: string;
  status: "active" | "completed";
  linkedExperiment?: string;
}

export function getMindCognition(patientId: string): {
  series: MindSeries[];
  scores: NeurocogScore[];
  interventions: MindIntervention[];
} {
  if (patientId !== "p-78435") {
    return {
      series: [
        { id: "mood", label: "Mood index", tone: "teal", series: [58, 60, 62, 61, 63, 64], current: "64", note: "Patient-reported weekly check-in" },
        { id: "stress", label: "Stress index", tone: "warning", series: [55, 54, 52, 53, 51, 50], current: "50", note: "Lower is better" },
      ],
      scores: [],
      interventions: [],
    };
  }
  return {
    series: [
      { id: "mood", label: "Mood index", tone: "teal", series: [52, 55, 58, 57, 61, 64, 66, 68], current: "68", note: "Patient-reported weekly check-in" },
      { id: "sleepq", label: "Sleep quality", tone: "navy", series: [48, 50, 55, 58, 62, 66, 69, 71], current: "71", note: "Ring sleep score, weekly average" },
      { id: "stress", label: "Stress index", tone: "warning", series: [72, 70, 66, 64, 60, 58, 55, 52], current: "52", note: "PSS-10-anchored; lower is better" },
      { id: "cog", label: "Cognition (self-report)", tone: "ai", series: [55, 56, 58, 60, 61, 63, 64, 66], current: "66", note: "Focus/clarity weekly rating" },
    ],
    scores: [
      { name: "Digit-symbol substitution (app)", score: "61 correct / 90 s", atLabel: "Jul 5", trend: "improving", note: "+6 vs April baseline" },
      { name: "PSS-10", score: "19 (moderate)", atLabel: "Jul 2", trend: "improving", note: "Down from 24 in April" },
      { name: "Reaction time (app)", score: "312 ms median", atLabel: "Jun 20", trend: "stable", note: "Within normal variability" },
    ],
    interventions: [
      { name: "Morning light + 10 min walk", startedLabel: "Jul 7", status: "active", linkedExperiment: "Morning Light + 10 min" },
      { name: "Magnesium glycinate (evening)", startedLabel: "Jun 24", status: "active", linkedExperiment: "Magnesium Glycinate" },
      { name: "Box-breathing before meetings", startedLabel: "May 12", status: "completed" },
    ],
  };
}

/* ------------------------------------------------------------ assessments */

export interface AssessmentRecord {
  id: string;
  name: string;
  kind: "intake" | "questionnaire" | "outcome";
  status: "complete" | "assigned" | "in-progress" | "overdue";
  lastLabel: string;
  dueLabel?: string;
  score?: string;
  /** Longitudinal scores, oldest → newest, for comparison charts. */
  series?: number[];
  seriesNote?: string;
}

const ASSESSMENTS: Record<string, AssessmentRecord[]> = {
  "p-78435": [
    { id: "as-1", name: "PSS-10 (stress)", kind: "questionnaire", status: "complete", lastLabel: "Jul 2", score: "19 — moderate", series: [26, 24, 22, 19], seriesNote: "Quarterly: Oct → Jul" },
    { id: "as-2", name: "Sleep quality diary", kind: "outcome", status: "assigned", lastLabel: "assigned Jul 12", dueLabel: "due Jul 25" },
    { id: "as-3", name: "Intake — health history", kind: "intake", status: "complete", lastLabel: "Aug 2024" },
    { id: "as-4", name: "Energy & fatigue scale", kind: "outcome", status: "complete", lastLabel: "Jun 15", score: "6.1 / 10", series: [4.2, 4.8, 5.5, 6.1], seriesNote: "Monthly: Mar → Jun" },
  ],
  "p-64201": [
    { id: "as-5", name: "Cardiometabolic questionnaire", kind: "questionnaire", status: "overdue", lastLabel: "assigned Jul 1", dueLabel: "was due Jul 10" },
    { id: "as-6", name: "Intake — health history", kind: "intake", status: "complete", lastLabel: "Jan 2025" },
  ],
  "p-59318": [
    { id: "as-7", name: "Fatigue severity scale", kind: "outcome", status: "assigned", lastLabel: "assigned Jul 15", dueLabel: "due Jul 22" },
    { id: "as-8", name: "Intake — health history", kind: "intake", status: "complete", lastLabel: "Jun 2025" },
  ],
};

export function getAssessments(patientId: string): AssessmentRecord[] {
  return ASSESSMENTS[patientId] ?? [];
}

/* ------------------------------------------- longitudinal systems (twin) */

export interface SystemTrajectory {
  system: string;
  tone: Tone;
  /** 0–100 composite, one point per snapshot. */
  series: number[];
  current: number;
  note: string;
  drivers: string[];
}

export interface TwinInterventionMarker {
  atIndex: number;
  label: string;
}

export interface TwinLongitudinal {
  snapshotLabels: string[];
  trajectories: SystemTrajectory[];
  markers: TwinInterventionMarker[];
  connections: { from: string; to: string; note: string }[];
}

export function getTwinLongitudinal(patientId: string): TwinLongitudinal {
  if (patientId === "p-64201") {
    return {
      snapshotLabels: ["Feb", "Mar", "Apr", "May", "Jun", "Jul"],
      trajectories: [
        { system: "Metabolic", tone: "warning", series: [42, 43, 45, 47, 50, 53], current: 53, note: "Improving with post-dinner walks", drivers: ["Fasting insulin", "CGM peaks", "HbA1c"] },
        { system: "Cardiovascular", tone: "critical", series: [40, 41, 41, 43, 45, 47], current: 47, note: "ApoB still high, trending down", drivers: ["ApoB", "Blood pressure"] },
        { system: "Inflammation", tone: "warning", series: [45, 44, 46, 48, 50, 51], current: 51, note: "hs-CRP drifting up", drivers: ["hs-CRP"] },
        { system: "Recovery", tone: "positive", series: [50, 52, 55, 57, 60, 62], current: 62, note: "Steps + sleep consistency up", drivers: ["Steps", "Sleep duration"] },
      ],
      markers: [
        { atIndex: 3, label: "Omega-3 3 g/d started" },
        { atIndex: 4, label: "Post-dinner walk protocol" },
      ],
      connections: [
        { from: "Metabolic", to: "Cardiovascular", note: "Insulin resistance → lipid pattern" },
        { from: "Recovery", to: "Metabolic", note: "Activity blunts evening glucose" },
      ],
    };
  }
  return {
    snapshotLabels: ["Feb", "Mar", "Apr", "May", "Jun", "Jul"],
    trajectories: [
      { system: "Inflammation", tone: "warning", series: [38, 40, 43, 47, 52, 56], current: 56, note: "hs-CRP improving on protocol", drivers: ["hs-CRP", "Omega-3 index"] },
      { system: "Stress axis", tone: "critical", series: [35, 36, 38, 41, 44, 46], current: 46, note: "AM cortisol still high; PSS-10 improving", drivers: ["AM cortisol", "PSS-10", "HRV"] },
      { system: "Sleep & recovery", tone: "positive", series: [42, 45, 50, 56, 62, 68], current: 68, note: "Strongest responder — light + magnesium", drivers: ["Sleep score", "Deep sleep", "HRV"] },
      { system: "Metabolic", tone: "positive", series: [58, 59, 60, 62, 63, 65], current: 65, note: "Stable, protective", drivers: ["Fasting glucose", "Triglycerides"] },
      { system: "Micronutrients", tone: "warning", series: [40, 42, 45, 48, 52, 55], current: 55, note: "Vitamin D repleting; ferritin adequate", drivers: ["Vitamin D", "Ferritin", "B12"] },
    ],
    markers: [
      { atIndex: 2, label: "Vitamin D 5000 IU started" },
      { atIndex: 3, label: "Sleep protocol phase 1" },
      { atIndex: 4, label: "Magnesium timing shift" },
      { atIndex: 5, label: "Morning-light experiment" },
    ],
    connections: [
      { from: "Stress axis", to: "Sleep & recovery", note: "Cortisol load disturbs deep sleep" },
      { from: "Sleep & recovery", to: "Inflammation", note: "Recovery debt sustains hs-CRP" },
      { from: "Micronutrients", to: "Stress axis", note: "Repletion supports HPA recovery" },
    ],
  };
}

/* -------------------------------------------------- biohacker nav preview */

export type NavMode = "practitioner" | "biohacker";

const navModeStore = createSessionStore<NavMode>("aidp:demo:navmode", "practitioner");

export function useNavMode(): NavMode {
  return navModeStore.use();
}

export function setNavMode(mode: NavMode) {
  navModeStore.set(mode);
}
