import type { Tone } from "./types";

/**
 * MOCK program templates. Synthetic; shaped like a future `api.programs.*`
 * tRPC namespace. Steps added in the builder live in component/session state;
 * publishing records a demo audit event only.
 */

export type ProgramStepKind =
  | "Intake form"
  | "Assessment"
  | "Education"
  | "Nutrition plan"
  | "Supplements"
  | "Habit"
  | "Wearable target"
  | "Task"
  | "Appointment"
  | "Message"
  | "Quantum Mind session"
  | "Lab"
  | "Experiment";

export const STEP_KINDS: { kind: ProgramStepKind; patientFacing: boolean; tone: Tone }[] = [
  { kind: "Intake form", patientFacing: true, tone: "teal" },
  { kind: "Assessment", patientFacing: true, tone: "teal" },
  { kind: "Education", patientFacing: true, tone: "teal" },
  { kind: "Nutrition plan", patientFacing: true, tone: "teal" },
  { kind: "Supplements", patientFacing: true, tone: "action" },
  { kind: "Habit", patientFacing: true, tone: "positive" },
  { kind: "Wearable target", patientFacing: true, tone: "navy" },
  { kind: "Task", patientFacing: false, tone: "slate" },
  { kind: "Appointment", patientFacing: true, tone: "action" },
  { kind: "Message", patientFacing: true, tone: "teal" },
  { kind: "Quantum Mind session", patientFacing: true, tone: "ai" },
  { kind: "Lab", patientFacing: false, tone: "navy" },
  { kind: "Experiment", patientFacing: false, tone: "ai" },
];

export interface ProgramStep {
  id: string;
  week: number;
  kind: ProgramStepKind;
  title: string;
  patientFacing: boolean;
  reviewGated: boolean;
  release: "On enroll" | "Scheduled" | "On completion";
}

export interface ProgramTemplate {
  id: string;
  name: string;
  weeks: number;
  enrolled: number;
  description: string;
  milestones: { week: number; label: string }[];
  completionCriteria: string[];
  steps: ProgramStep[];
}

export function getProgramTemplates(): ProgramTemplate[] {
  return [
    {
      id: "foundations",
      name: "Foundations 12-week",
      weeks: 12,
      enrolled: 3,
      description: "Core longevity program: intake, baseline labs, sleep + nutrition foundations, first N-of-1.",
      milestones: [
        { week: 1, label: "Baseline complete" },
        { week: 4, label: "Habits anchored" },
        { week: 8, label: "Mid-point labs" },
        { week: 12, label: "Outcomes review" },
      ],
      completionCriteria: ["Baseline + midpoint labs reviewed", "≥70% habit adherence", "Outcomes visit completed"],
      steps: [
        { id: "f1", week: 1, kind: "Intake form", title: "Comprehensive intake", patientFacing: true, reviewGated: true, release: "On enroll" },
        { id: "f2", week: 1, kind: "Lab", title: "Baseline panel order", patientFacing: false, reviewGated: true, release: "On enroll" },
        { id: "f3", week: 2, kind: "Assessment", title: "PSS-10 stress assessment", patientFacing: true, reviewGated: true, release: "Scheduled" },
        { id: "f4", week: 2, kind: "Education", title: "Sleep foundations module", patientFacing: true, reviewGated: true, release: "Scheduled" },
        { id: "f5", week: 3, kind: "Habit", title: "Morning light 10 min", patientFacing: true, reviewGated: true, release: "Scheduled" },
        { id: "f6", week: 4, kind: "Appointment", title: "Progress visit", patientFacing: true, reviewGated: false, release: "Scheduled" },
        { id: "f7", week: 6, kind: "Experiment", title: "First N-of-1 (sleep)", patientFacing: false, reviewGated: true, release: "On completion" },
        { id: "f8", week: 8, kind: "Lab", title: "Mid-point panel", patientFacing: false, reviewGated: true, release: "Scheduled" },
      ],
    },
    {
      id: "metabolic",
      name: "Metabolic reset",
      weeks: 8,
      enrolled: 2,
      description: "Glycemic-focused program: CGM window, nutrition plan, movement targets, recheck.",
      milestones: [
        { week: 1, label: "CGM fitted" },
        { week: 4, label: "Nutrition plan stable" },
        { week: 8, label: "Recheck labs" },
      ],
      completionCriteria: ["CGM window completed", "Recheck HbA1c reviewed"],
      steps: [
        { id: "m1", week: 1, kind: "Wearable target", title: "CGM 14-day window", patientFacing: true, reviewGated: true, release: "On enroll" },
        { id: "m2", week: 2, kind: "Nutrition plan", title: "Mediterranean-pattern plan", patientFacing: true, reviewGated: true, release: "Scheduled" },
        { id: "m3", week: 3, kind: "Habit", title: "Post-dinner walk 20 min", patientFacing: true, reviewGated: true, release: "Scheduled" },
        { id: "m4", week: 8, kind: "Lab", title: "Recheck HbA1c + insulin", patientFacing: false, reviewGated: true, release: "Scheduled" },
      ],
    },
    {
      id: "performance",
      name: "Performance",
      weeks: 6,
      enrolled: 1,
      description: "Strength + recovery block with creatine N-of-1 and DEXA baseline.",
      milestones: [
        { week: 1, label: "DEXA baseline" },
        { week: 6, label: "Block review" },
      ],
      completionCriteria: ["DEXA reviewed", "Training block completed"],
      steps: [
        { id: "p1", week: 1, kind: "Appointment", title: "DEXA baseline", patientFacing: true, reviewGated: false, release: "On enroll" },
        { id: "p2", week: 2, kind: "Experiment", title: "Creatine 5 g/day N-of-1", patientFacing: false, reviewGated: true, release: "Scheduled" },
        { id: "p3", week: 3, kind: "Message", title: "Mid-block check-in", patientFacing: true, reviewGated: true, release: "Scheduled" },
      ],
    },
  ];
}
