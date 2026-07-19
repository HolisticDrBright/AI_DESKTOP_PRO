"use client";

/**
 * Contextual, versioned template library (MOCK). Not a primary destination —
 * composers, Care Plan, Programs, Inbox, Billing, and Automations link in
 * with a kind filter. Session edits bump versions; publishing is audited.
 */
import { createSessionStore } from "./session-kv";
import { recordAuditEntry } from "./session-store";

export type TemplateKind =
  | "note"
  | "protocol"
  | "care-plan"
  | "message"
  | "assessment"
  | "program-lesson"
  | "email"
  | "invoice"
  | "automation-recipe";

export const TEMPLATE_KIND_LABEL: Record<TemplateKind, string> = {
  note: "Note",
  protocol: "Protocol",
  "care-plan": "Care plan",
  message: "Message",
  assessment: "Assessment",
  "program-lesson": "Program lesson",
  email: "Email",
  invoice: "Invoice",
  "automation-recipe": "Automation recipe",
};

export interface TemplateVersion {
  version: number;
  atLabel: string;
  author: string;
  note: string;
}

export interface TemplateItem {
  id: string;
  name: string;
  kind: TemplateKind;
  status: "draft" | "published";
  updatedLabel: string;
  author: string;
  summary: string;
  body: string;
  usedIn: { label: string; href: string }[];
  history: TemplateVersion[];
}

const T = (
  id: string,
  name: string,
  kind: TemplateKind,
  summary: string,
  body: string,
  usedIn: { label: string; href: string }[],
  versions = 2,
  status: "draft" | "published" = "published",
): TemplateItem => ({
  id,
  name,
  kind,
  status,
  updatedLabel: "Jul 10",
  author: "Dr. Sarah Mitchell",
  summary,
  body,
  usedIn,
  history: Array.from({ length: versions }, (_, i) => ({
    version: versions - i,
    atLabel: i === 0 ? "Jul 10" : "Jun 2",
    author: "Dr. Sarah Mitchell",
    note: i === 0 ? "Wording tightened after review" : "Initial version",
  })),
});

const SEED: TemplateItem[] = [
  T("tp-soap", "SOAP note — follow-up visit", "note",
    "Standard follow-up structure with review-gated assessment section.",
    "S: Patient-reported status since last visit…\nO: Vitals, labs reviewed…\nA: (practitioner assessment — required)\nP: Plan changes with rationale…",
    [{ label: "Note composer", href: "/patients/p-78435/chart" }]),
  T("tp-lab-note", "Lab-review note", "note",
    "Marker-by-marker read with provenance references.",
    "Panels reviewed:…\nKey changes:…\nActions:…",
    [{ label: "Labs & Reasoning", href: "/patients/p-78435/labs" }]),
  T("tp-iron", "Iron repletion protocol", "protocol",
    "Phased repletion with recheck gates. Practitioner approval required per phase.",
    "Phase 1 (weeks 1–4): …\nRecheck gate: ferritin + CBC before phase 2.\nPhase 2: …",
    [{ label: "Care Plan", href: "/patients/p-59318/care-plan" }], 3),
  T("tp-sleep", "Sleep & recovery care plan", "care-plan",
    "Light, timing, temperature, magnesium — the practice's standard base.",
    "Morning: 10 min outdoor light…\nEvening: cutoff schedule…\nSupplements: …",
    [{ label: "Care Plan", href: "/patients/p-78435/care-plan" }]),
  T("tp-welcome", "New-patient welcome message", "message",
    "Portal message sent after intake; review-gated before send.",
    "Welcome to the practice! Here's what happens next…",
    [{ label: "Inbox composer", href: "/inbox" }]),
  T("tp-recall", "Lab recall message", "message",
    "Asks the patient to book a recheck — never includes results in-message.",
    "Your practitioner has asked to repeat one of your labs…",
    [{ label: "Inbox composer", href: "/inbox" }]),
  T("tp-pss10", "PSS-10 (perceived stress)", "assessment",
    "10-item validated questionnaire; scored 0–40.",
    "Standard PSS-10 items, 5-point frequency scale.",
    [{ label: "Tracking → Assessments", href: "/patients/p-78435/tracking?view=assessments" }]),
  T("tp-intake", "Comprehensive intake — health history", "assessment",
    "Practice intake: history, medications, allergies, goals.",
    "Sections: history · medications · allergies · lifestyle · goals.",
    [{ label: "Tracking → Assessments", href: "/patients/p-78435/tracking?view=assessments" }]),
  T("tp-lesson-video", "Program lesson — video + worksheet", "program-lesson",
    "Standard lesson scaffold used by the Studio.",
    "Hook (30 s) → concept (3 min) → application (5 min) → worksheet handoff.",
    [{ label: "Programs Studio", href: "/programs" }]),
  T("tp-email-drip", "Program drip email", "email",
    "Unlock-day notification with reflection prompt. No claims.",
    "Subject: Week {n} unlocks tomorrow…",
    [{ label: "Programs Studio", href: "/programs" }]),
  T("tp-invoice-visit", "Visit invoice layout", "invoice",
    "Service + dispensed items + tax lines; Stripe test-mode footer.",
    "Lines: service · products · tax · payments. Footer: test-mode label.",
    [{ label: "Billing checkout", href: "/billing?tab=checkout" }]),
  T("tp-auto-lab", "Automation — abnormal lab → review task", "automation-recipe",
    "Trigger: abnormal result imported. Action: create review task (internal only).",
    "trigger: lab.imported[flag=abnormal] → action: review-task(priority=High)",
    [{ label: "Integrations → Automations", href: "/integrations?tab=automations" }]),
  T("tp-auto-noshow", "Automation — no-show follow-up", "automation-recipe",
    "Trigger: front desk marks no-show. Action: front-desk task + draft message for review.",
    "trigger: appointment.no_show → actions: task(front-desk), draft-message(review-gated)",
    [{ label: "Integrations → Automations", href: "/integrations?tab=automations" }]),
  T("tp-supp-rationale", "Supplement rationale snippet", "note",
    "Explains a recommendation with evidence slot left explicit.",
    "Recommendation: … Rationale: … Evidence: (add citations)",
    [{ label: "Care Plan → Supplements", href: "/patients/p-78435/care-plan?view=supplements" }],
    1, "draft"),
];

interface TemplateSessionState {
  patched: Record<string, Partial<TemplateItem>>;
  bumped: Record<string, TemplateVersion[]>;
}

const store = createSessionStore<TemplateSessionState>("aidp:demo:templates", {
  patched: {},
  bumped: {},
});

export function useTemplates(): TemplateItem[] {
  const s = store.use();
  return SEED.map((t) => ({
    ...t,
    ...s.patched[t.id],
    history: [...(s.bumped[t.id] ?? []), ...t.history],
  }));
}

export function listTemplates(): TemplateItem[] {
  const s = store.get();
  return SEED.map((t) => ({
    ...t,
    ...s.patched[t.id],
    history: [...(s.bumped[t.id] ?? []), ...t.history],
  }));
}

export function updateTemplate(id: string, patch: { body?: string; summary?: string; name?: string }, note: string) {
  const current = listTemplates().find((t) => t.id === id);
  if (!current) return { ok: false, message: "Template not found." };
  const nextVersion = (current.history[0]?.version ?? 1) + 1;
  store.update((s) => ({
    patched: { ...s.patched, [id]: { ...s.patched[id], ...patch, updatedLabel: "Today" } },
    bumped: {
      ...s.bumped,
      [id]: [
        { version: nextVersion, atLabel: "Today", author: "Dr. Sarah Mitchell", note },
        ...(s.bumped[id] ?? []),
      ],
    },
  }));
  recordAuditEntry({
    kind: "template_update",
    subjectType: "template",
    subjectLabel: `${current.name} → v${nextVersion}`,
    reviewed: true,
  });
  return { ok: true, message: `Saved as version ${nextVersion}. (demo — this session only)` };
}

export function publishTemplate(id: string) {
  const current = listTemplates().find((t) => t.id === id);
  if (!current) return { ok: false, message: "Template not found." };
  store.update((s) => ({
    ...s,
    patched: { ...s.patched, [id]: { ...s.patched[id], status: "published" as const } },
  }));
  recordAuditEntry({
    kind: "publish",
    subjectType: "template",
    subjectLabel: current.name,
    reviewed: true,
  });
  return { ok: true, message: `Published "${current.name}" to the practice library. (demo)` };
}
