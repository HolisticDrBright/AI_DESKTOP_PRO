"use client";

/**
 * Programs Studio (MOCK) — original "AI Longevity Pro" program catalog,
 * curriculum builder, offers, learners, analytics, and the AI Program
 * Copilot. Every copilot artifact is labeled an AI draft, versioned,
 * provenance-aware, and requires explicit practitioner approval before it
 * can be published. The generator NEVER fabricates citations, outcomes, or
 * individualized medical advice — evidence slots are emitted empty with an
 * explicit "add citations" instruction.
 */
import { createSessionStore, newSessionId } from "./session-kv";
import { recordAuditEntry } from "./session-store";

export type LessonType =
  | "video"
  | "audio"
  | "text"
  | "image"
  | "document"
  | "download"
  | "quiz"
  | "live-session"
  | "assignment";

export const LESSON_TYPE_LABEL: Record<LessonType, string> = {
  video: "Video",
  audio: "Audio",
  text: "Text",
  image: "Image",
  document: "Document",
  download: "Download",
  quiz: "Quiz",
  "live-session": "Live session",
  assignment: "Assignment",
};

export interface Lesson {
  id: string;
  title: string;
  type: LessonType;
  durationMin?: number;
  status: "draft" | "published";
  /** Drip / unlock rule, human-readable ("Day 7", "After previous lesson"). */
  drip?: string;
  prerequisite?: string;
  summary?: string;
  aiDraft?: boolean;
}

export interface ProgramModule {
  id: string;
  title: string;
  lessons: Lesson[];
}

export interface PriceOffer {
  id: string;
  kind: "one-time" | "subscription" | "payment-plan";
  label: string;
  amountMinor: number;
  detail: string;
}

export interface Program {
  id: string;
  title: string;
  tagline: string;
  audience: string;
  status: "draft" | "published";
  thumbSeed: string;
  updatedLabel: string;
  version: number;
  modules: ProgramModule[];
  offers: PriceOffer[];
  enrollment: { active: number; completed: number; avgProgressPct: number };
  revenueMinor: number;
  certificate: { enabled: boolean; title: string };
  disclaimers: string[];
  /** Whole program originated from the copilot and awaits approval. */
  aiDraft?: boolean;
  approved?: boolean;
}

export interface Learner {
  id: string;
  name: string;
  programId: string;
  progressPct: number;
  lastActiveLabel: string;
  completed?: boolean;
  certificateIssued?: boolean;
}

const l = (
  title: string,
  type: LessonType,
  extra?: Partial<Lesson>,
): Lesson => ({
  id: newSessionId().slice(0, 8),
  title,
  type,
  status: "published",
  ...extra,
});

export const STANDARD_DISCLAIMER =
  "Educational program — not medical advice, diagnosis, or treatment. Work with your practitioner before changing medications, supplements, or exercise.";

const SEED_PROGRAMS: Program[] = [
  {
    id: "prog-metabolic",
    title: "Metabolic Reset — 12-Week Program",
    tagline: "Rebuild metabolic flexibility with labs-guided nutrition, movement, and sleep.",
    audience: "Adults with early insulin resistance working with a practitioner",
    status: "published",
    thumbSeed: "metabolic-reset",
    updatedLabel: "Jul 11",
    version: 6,
    modules: [
      {
        id: "m1",
        title: "Module 1 — Foundations & baseline",
        lessons: [
          l("Welcome + how this program works", "video", { durationMin: 8 }),
          l("Your baseline labs, explained", "video", { durationMin: 14 }),
          l("Baseline questionnaire", "quiz", { summary: "Establishes your starting scores" }),
          l("Program guide (PDF)", "download"),
        ],
      },
      {
        id: "m2",
        title: "Module 2 — Nutrition mechanics",
        lessons: [
          l("Protein anchoring in practice", "video", { durationMin: 12, drip: "Day 7" }),
          l("Build-a-plate worksheet", "document", { drip: "Day 7" }),
          l("Fiber & the glucose curve", "text", { drip: "Day 9" }),
          l("Week 2 check-in quiz", "quiz", { drip: "Day 13", prerequisite: "Protein anchoring in practice" }),
        ],
      },
      {
        id: "m3",
        title: "Module 3 — Movement as medicine",
        lessons: [
          l("Post-meal walks: the 20-minute rule", "video", { durationMin: 9, drip: "Day 14" }),
          l("Zone 2 basics (audio)", "audio", { durationMin: 18, drip: "Day 16" }),
          l("Movement plan assignment", "assignment", { drip: "Day 18" }),
        ],
      },
      {
        id: "m4",
        title: "Module 4 — Live cohort & consolidation",
        lessons: [
          l("Live Q&A — cohort session", "live-session", { drip: "Day 21" }),
          l("Sleep & cortisol connection", "video", { durationMin: 11, drip: "Day 23" }),
          l("Final reflection + next steps", "assignment", { drip: "Day 26" }),
        ],
      },
    ],
    offers: [
      { id: "of-1", kind: "one-time", label: "Pay in full", amountMinor: 74900, detail: "Lifetime access + cohort seat" },
      { id: "of-2", kind: "payment-plan", label: "3 × $259", amountMinor: 25900, detail: "Monthly, 3 installments" },
    ],
    enrollment: { active: 24, completed: 9, avgProgressPct: 61 },
    revenueMinor: 2842100,
    certificate: { enabled: true, title: "Metabolic Reset — Completion" },
    disclaimers: [STANDARD_DISCLAIMER],
  },
  {
    id: "prog-sleep",
    title: "Sleep Foundations Mini-Course",
    tagline: "Two weeks to a defensible sleep routine — light, timing, temperature.",
    audience: "Anyone with inconsistent sleep and a wearable",
    status: "published",
    thumbSeed: "sleep-foundations",
    updatedLabel: "Jun 20",
    version: 3,
    modules: [
      {
        id: "sm1",
        title: "Week 1 — Light & timing",
        lessons: [
          l("Morning light: dose and timing", "video", { durationMin: 7 }),
          l("Caffeine cutoff calculator", "download"),
          l("Evening wind-down (audio)", "audio", { durationMin: 12, drip: "Day 3" }),
        ],
      },
      {
        id: "sm2",
        title: "Week 2 — Environment & consolidation",
        lessons: [
          l("Bedroom environment checklist", "document", { drip: "Day 7" }),
          l("Reading your wearable's sleep data", "video", { durationMin: 10, drip: "Day 9" }),
          l("Final quiz + routine builder", "quiz", { drip: "Day 12" }),
        ],
      },
    ],
    offers: [{ id: "of-3", kind: "one-time", label: "Single purchase", amountMinor: 14900, detail: "Lifetime access" }],
    enrollment: { active: 41, completed: 28, avgProgressPct: 78 },
    revenueMinor: 1028100,
    certificate: { enabled: false, title: "" },
    disclaimers: [STANDARD_DISCLAIMER],
  },
  {
    id: "prog-hub",
    title: "Longevity Membership Content Hub",
    tagline: "Monthly deep-dives + protocol library for members.",
    audience: "Practice members (subscription)",
    status: "draft",
    thumbSeed: "membership-hub",
    updatedLabel: "Jul 2",
    version: 1,
    modules: [
      {
        id: "hm1",
        title: "July — Recovery month",
        lessons: [
          l("HRV deep-dive", "video", { durationMin: 16, status: "draft" }),
          l("Sauna & cold: what the practice actually recommends", "text", { status: "draft" }),
        ],
      },
    ],
    offers: [{ id: "of-4", kind: "subscription", label: "Membership", amountMinor: 9900, detail: "$99 / month, cancel anytime" }],
    enrollment: { active: 0, completed: 0, avgProgressPct: 0 },
    revenueMinor: 0,
    certificate: { enabled: false, title: "" },
    disclaimers: [STANDARD_DISCLAIMER],
  },
];

export const LEARNERS: Learner[] = [
  { id: "lr-1", name: "Alexandra Morgan", programId: "prog-metabolic", progressPct: 62, lastActiveLabel: "Today" },
  { id: "lr-2", name: "Dana Whitfield", programId: "prog-metabolic", progressPct: 34, lastActiveLabel: "Yesterday" },
  { id: "lr-3", name: "Sam Torres", programId: "prog-metabolic", progressPct: 100, lastActiveLabel: "Jul 12", completed: true, certificateIssued: true },
  { id: "lr-4", name: "Jules Andersen", programId: "prog-metabolic", progressPct: 88, lastActiveLabel: "Jul 16" },
  { id: "lr-5", name: "Marcus Webb", programId: "prog-sleep", progressPct: 100, lastActiveLabel: "Jul 8", completed: true },
  { id: "lr-6", name: "Robin Okada", programId: "prog-sleep", progressPct: 55, lastActiveLabel: "Jul 15" },
  { id: "lr-7", name: "Casey Lin", programId: "prog-sleep", progressPct: 12, lastActiveLabel: "Jul 17" },
];

export interface ProgramAnalytics {
  enrollmentsBySeries: number[];
  seriesLabels: string[];
  completionPct: number;
  lessonEngagement: { lesson: string; pct: number }[];
}

export function getProgramAnalytics(programId: string): ProgramAnalytics {
  if (programId === "prog-sleep") {
    return {
      seriesLabels: ["Feb", "Mar", "Apr", "May", "Jun", "Jul"],
      enrollmentsBySeries: [4, 7, 9, 12, 16, 21],
      completionPct: 68,
      lessonEngagement: [
        { lesson: "Morning light: dose and timing", pct: 96 },
        { lesson: "Evening wind-down (audio)", pct: 81 },
        { lesson: "Reading your wearable's sleep data", pct: 74 },
        { lesson: "Final quiz + routine builder", pct: 68 },
      ],
    };
  }
  return {
    seriesLabels: ["Feb", "Mar", "Apr", "May", "Jun", "Jul"],
    enrollmentsBySeries: [2, 5, 8, 11, 14, 18],
    completionPct: 38,
    lessonEngagement: [
      { lesson: "Welcome + how this program works", pct: 98 },
      { lesson: "Your baseline labs, explained", pct: 92 },
      { lesson: "Protein anchoring in practice", pct: 77 },
      { lesson: "Post-meal walks: the 20-minute rule", pct: 64 },
      { lesson: "Live Q&A — cohort session", pct: 51 },
    ],
  };
}

/* ------------------------------------------------------ session overrides */

interface StudioSessionState {
  /** Full program overrides once edited this session (keyed by id). */
  programs: Record<string, Program>;
  /** Copilot-created programs (drafts until approved + published). */
  created: Program[];
  copilotVersions: CopilotVersion[];
}

const store = createSessionStore<StudioSessionState>("aidp:demo:studio", {
  programs: {},
  created: [],
  copilotVersions: [],
});

export function useStudioState(): StudioSessionState {
  return store.use();
}

export function listPrograms(state?: StudioSessionState): Program[] {
  const s = state ?? store.get();
  return [
    ...s.created.map((p) => s.programs[p.id] ?? p),
    ...SEED_PROGRAMS.map((p) => s.programs[p.id] ?? p),
  ];
}

export function getProgram(id: string, state?: StudioSessionState): Program | undefined {
  return listPrograms(state).find((p) => p.id === id);
}

export function saveProgram(next: Program, auditLabel: string) {
  store.update((s) => ({
    ...s,
    programs: { ...s.programs, [next.id]: { ...next, version: next.version + 1, updatedLabel: "Today" } },
  }));
  recordAuditEntry({
    kind: "template_update",
    subjectType: "program",
    subjectLabel: `${auditLabel} · ${next.title}`,
    reviewed: true,
  });
}

export function publishProgram(id: string) {
  const p = getProgram(id);
  if (!p) return { ok: false, message: "Program not found." };
  if (p.aiDraft && !p.approved) {
    return { ok: false, message: "AI-drafted content must be practitioner-approved before publishing." };
  }
  store.update((s) => ({
    ...s,
    programs: { ...s.programs, [id]: { ...(s.programs[id] ?? p), status: "published", updatedLabel: "Today" } },
  }));
  recordAuditEntry({ kind: "publish", subjectType: "program", subjectLabel: p.title, reviewed: true });
  return { ok: true, message: `Published "${p.title}". (demo catalog — this session only)` };
}

export function approveProgramDraft(id: string) {
  const p = getProgram(id);
  if (!p) return { ok: false, message: "Program not found." };
  store.update((s) => ({
    ...s,
    programs: { ...s.programs, [id]: { ...(s.programs[id] ?? p), approved: true } },
  }));
  recordAuditEntry({
    kind: "approve",
    subjectType: "AI program draft",
    subjectLabel: p.title,
    reviewed: true,
    outcome: "approved",
  });
  return { ok: true, message: "AI draft approved — you own this content now. (demo)" };
}

/* ---------------------------------------------------------------- copilot */

export interface CopilotInput {
  audience: string;
  transformation: string;
  scope: "mini" | "flagship" | "membership";
  durationWeeks: number;
  lens: string;
  evidence: "citations-required" | "practitioner-experience";
  format: string[];
  assessments: boolean;
  pricingIntent: "one-time" | "subscription" | "payment-plan";
  disclaimers: boolean;
}

export interface CopilotVersion {
  id: string;
  atLabel: string;
  input: CopilotInput;
  programId: string;
  salesCopy: string;
  emailSequence: { day: number; subject: string; preview: string }[];
}

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * Deterministic outline generator. Structure comes from the practitioner's
 * answers; anything evidential is emitted as an EMPTY slot the practitioner
 * must fill — never a fabricated citation or outcome claim.
 */
export function generateProgramDraft(input: CopilotInput): CopilotVersion {
  const weeks = Math.max(2, Math.min(16, input.durationWeeks));
  const moduleCount = input.scope === "mini" ? 2 : input.scope === "flagship" ? Math.min(6, Math.ceil(weeks / 2)) : 3;
  const themes = [
    "Foundations & baseline",
    "Core mechanics",
    "Daily practice",
    "Obstacles & troubleshooting",
    "Consolidation",
    "Beyond the program",
  ];
  const wantsQuiz = input.assessments;
  const modules: ProgramModule[] = Array.from({ length: moduleCount }, (_, i) => {
    const lessons: Lesson[] = [
      l(`${themes[i]}: core lesson`, input.format.includes("video") ? "video" : "text", {
        durationMin: 10, status: "draft", aiDraft: true, drip: i === 0 ? undefined : `Day ${i * 7}`,
        summary: `AI draft — outline only. Practitioner writes the substance for "${input.transformation}".`,
      }),
      l(`${themes[i]}: worksheet`, "document", {
        status: "draft", aiDraft: true, drip: i === 0 ? undefined : `Day ${i * 7}`,
        summary: "AI draft worksheet skeleton — fields only, no clinical content.",
      }),
    ];
    if (input.format.includes("audio")) {
      lessons.push(l(`${themes[i]}: audio companion`, "audio", { durationMin: 12, status: "draft", aiDraft: true, drip: `Day ${i * 7 + 2}` }));
    }
    if (wantsQuiz) {
      lessons.push(l(`${themes[i]}: check-in quiz`, "quiz", {
        status: "draft", aiDraft: true, drip: `Day ${i * 7 + 5}`,
        summary: "AI draft — 5 recall questions on this module's practitioner-approved content.",
      }));
    }
    return { id: newSessionId().slice(0, 8), title: `Module ${i + 1} — ${themes[i]}`, lessons };
  });

  const offer: PriceOffer =
    input.pricingIntent === "subscription"
      ? { id: newSessionId().slice(0, 8), kind: "subscription", label: "Membership", amountMinor: 9900, detail: "$99 / month (draft price)" }
      : input.pricingIntent === "payment-plan"
        ? { id: newSessionId().slice(0, 8), kind: "payment-plan", label: "3 installments", amountMinor: 19900, detail: "3 × $199 (draft price)" }
        : { id: newSessionId().slice(0, 8), kind: "one-time", label: "Pay in full", amountMinor: 49900, detail: "$499 (draft price)" };

  const title = `${cap(input.transformation)} — ${weeks}-Week ${input.scope === "mini" ? "Mini-Course" : "Program"}`;
  const program: Program = {
    id: `prog-ai-${newSessionId().slice(0, 6)}`,
    title,
    tagline: `A ${weeks}-week, ${input.lens}-informed path to ${input.transformation.toLowerCase()} for ${input.audience.toLowerCase()}.`,
    audience: input.audience,
    status: "draft",
    thumbSeed: title,
    updatedLabel: "Today",
    version: 1,
    modules,
    offers: [offer],
    enrollment: { active: 0, completed: 0, avgProgressPct: 0 },
    revenueMinor: 0,
    certificate: { enabled: input.scope !== "mini", title: `${title} — Completion` },
    disclaimers: [
      ...(input.disclaimers ? [STANDARD_DISCLAIMER] : []),
      input.evidence === "citations-required"
        ? "Evidence slots are EMPTY by design: add citations before publishing — the copilot does not generate references."
        : "Framed as practitioner experience; no outcome claims are drafted.",
    ],
    aiDraft: true,
    approved: false,
  };

  const version: CopilotVersion = {
    id: newSessionId(),
    atLabel: "Today",
    input,
    programId: program.id,
    salesCopy: [
      `AI DRAFT — review before use. No outcomes are promised below.`,
      ``,
      `${title}`,
      `For ${input.audience.toLowerCase()} who want ${input.transformation.toLowerCase()} without guesswork.`,
      `Over ${weeks} weeks you'll work through ${moduleCount} modules built on your practitioner's ${input.lens} approach — with ${wantsQuiz ? "check-ins that show your progress" : "a clear weekly rhythm"}.`,
      `What's inside: ${modules.length} modules · ${modules.reduce((n, m) => n + m.lessons.length, 0)} lessons · ${input.format.join(", ")}.`,
    ].join("\n"),
    emailSequence: [
      { day: 0, subject: `Welcome to ${title}`, preview: "AI draft — what to expect + your first step today." },
      { day: 2, subject: "The one habit that carries week 1", preview: "AI draft — anchor lesson recap, no claims." },
      { day: 7, subject: "Week 2 unlocks tomorrow", preview: "AI draft — drip reminder + reflection prompt." },
      { day: Math.max(10, weeks * 7 - 7), subject: "Finishing strong", preview: "AI draft — completion checklist + certificate note." },
    ],
  };

  store.update((s) => ({
    ...s,
    created: [program, ...s.created],
    copilotVersions: [version, ...s.copilotVersions],
  }));
  recordAuditEntry({
    kind: "template_update",
    subjectType: "AI program draft",
    subjectLabel: `${title} (v${store.get().copilotVersions.length})`,
    reviewed: false,
  });
  return version;
}
