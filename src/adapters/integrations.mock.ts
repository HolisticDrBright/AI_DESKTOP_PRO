"use client";

/**
 * Integrations (MOCK): Connections, Automations, Webhooks, Sync Log.
 *
 * Honest-state rule: NOTHING here is a real connection. The state enum
 * includes "connected" because the UI must be able to render it, but no
 * demo connector may claim it — demo connectors are "not_connected" or
 * "sandbox" (simulated), and one sandbox connector "needs_attention" so
 * failure surfaces are exercised. Every card carries a demo label.
 *
 * Automations are trigger → condition → action recipes with a hard
 * restriction: the ONLY patient-facing actions allowed are review-gated
 * drafts and review-task creation — nothing reaches a patient
 * automatically. Test mode simulates a run and records it as a test.
 */
import { createSessionStore, newSessionId } from "./session-kv";
import { recordAuditEntry } from "./session-store";
import type { Tone } from "./types";

/* ------------------------------------------------------------ connections */

export type ConnectionStatus = "not_connected" | "sandbox" | "connected" | "needs_attention";

export const CONNECTION_STATUS_META: Record<ConnectionStatus, { label: string; tone: Tone }> = {
  not_connected: { label: "Not connected", tone: "slate" },
  sandbox: { label: "Sandbox (simulated)", tone: "navy" },
  connected: { label: "Connected", tone: "positive" },
  needs_attention: { label: "Needs attention", tone: "warning" },
};

export interface Connection {
  id: string;
  name: string;
  category:
    | "Video"
    | "Dispensary"
    | "CRM"
    | "Nutrition"
    | "Payments"
    | "Labs"
    | "Wearables"
    | "EHR / FHIR"
    | "Calendar"
    | "Storage";
  blurb: string;
  capabilities: string[];
  scopes: string[];
  direction: "import" | "export" | "two-way";
  environment: "—" | "sandbox";
  status: ConnectionStatus;
  lastSyncLabel: string;
  statusDetail?: string;
}

export const CONNECTIONS: Connection[] = [
  {
    id: "zoom", name: "Zoom", category: "Video",
    blurb: "Telehealth rooms created per appointment; links delivered through the portal.",
    capabilities: ["Create meeting per telehealth visit", "Waiting room on", "No recordings by default"],
    scopes: ["meeting:write"], direction: "export", environment: "—",
    status: "not_connected", lastSyncLabel: "—",
  },
  {
    id: "fullscript", name: "Fullscript", category: "Dispensary",
    blurb: "Supplement catalog, patient carts, and refill status.",
    capabilities: ["Catalog import", "Refill request intake", "Order status"],
    scopes: ["catalog:read", "orders:read"], direction: "two-way", environment: "sandbox",
    status: "sandbox", lastSyncLabel: "Today 6:00 AM (simulated)",
  },
  {
    id: "gohighlevel", name: "GoHighLevel", category: "CRM",
    blurb: "Marketing funnels and prospect pipelines — kept OUTSIDE the clinical record.",
    capabilities: ["Prospect sync (non-PHI)", "Campaign attribution"],
    scopes: ["contacts:read"], direction: "import", environment: "—",
    status: "not_connected", lastSyncLabel: "—",
    statusDetail: "Deliberately unconnected until the PHI boundary review completes.",
  },
  {
    id: "passio", name: "Passio Nutrition-AI", category: "Nutrition",
    blurb: "Food recognition for photo/barcode/voice logging. API key lives SERVER-SIDE only — never in this client.",
    capabilities: ["Photo parse", "Barcode lookup", "Voice parse", "Label scan"],
    scopes: ["recognition:invoke"], direction: "import", environment: "sandbox",
    status: "sandbox", lastSyncLabel: "On demand (simulated)",
  },
  {
    id: "stripe", name: "Stripe", category: "Payments",
    blurb: "Checkout, invoices, payouts. Test-mode UI only — no processor call is made from the demo.",
    capabilities: ["Payments", "Invoices", "Payouts", "Subscriptions"],
    scopes: ["charges:write", "invoices:write"], direction: "two-way", environment: "sandbox",
    status: "sandbox", lastSyncLabel: "Today 7:00 AM (simulated)",
  },
  {
    id: "quest", name: "Quest Diagnostics", category: "Labs",
    blurb: "Lab orders out, results + PDFs in, with extraction review.",
    capabilities: ["Order transmit", "Results ingest", "PDF archive"],
    scopes: ["orders:write", "results:read"], direction: "two-way", environment: "sandbox",
    status: "sandbox", lastSyncLabel: "Yesterday 11:20 PM (simulated)",
  },
  {
    id: "terra", name: "Wearables bridge (Terra-style)", category: "Wearables",
    blurb: "Ring / CGM / watch streams into Tracking.",
    capabilities: ["Sleep", "HRV", "Glucose", "Activity"],
    scopes: ["metrics:read"], direction: "import", environment: "sandbox",
    status: "needs_attention", lastSyncLabel: "Failed today 5:00 AM (simulated)",
    statusDetail: "Simulated token expiry — 2 patient streams paused. Re-auth in the sandbox to resume.",
  },
  {
    id: "fhir", name: "EHR bridge (FHIR R4)", category: "EHR / FHIR",
    blurb: "Problem list, medications, allergies from an external EHR.",
    capabilities: ["Patient $everything import", "Medication reconciliation"],
    scopes: ["patient/*.read"], direction: "import", environment: "—",
    status: "not_connected", lastSyncLabel: "—",
  },
  {
    id: "gcal", name: "Google Calendar", category: "Calendar",
    blurb: "Two-way availability sync for practitioners.",
    capabilities: ["Busy-time import", "Appointment push"],
    scopes: ["calendar:read", "calendar:write"], direction: "two-way", environment: "—",
    status: "not_connected", lastSyncLabel: "—",
  },
  {
    id: "storage", name: "Cloud storage", category: "Storage",
    blurb: "Encrypted document archive for imports and generated reports.",
    capabilities: ["Archive", "Retention policy"],
    scopes: ["files:write"], direction: "export", environment: "—",
    status: "not_connected", lastSyncLabel: "—",
  },
];

/* ------------------------------------------------------------ automations */

export type AutomationActionKind = "review-task" | "draft-message" | "internal-flag" | "front-desk-task";

/** The ONLY actions allowed to reference a patient — all internal/review-gated. */
export const AUTOMATION_ACTION_META: Record<
  AutomationActionKind,
  { label: string; patientFacing: boolean; note: string }
> = {
  "review-task": { label: "Create review task", patientFacing: false, note: "Queues work for a practitioner" },
  "draft-message": { label: "Draft message (review-gated)", patientFacing: true, note: "Creates a DRAFT only — a practitioner must review and send" },
  "internal-flag": { label: "Flag internally", patientFacing: false, note: "Raises priority on internal surfaces" },
  "front-desk-task": { label: "Front-desk task", patientFacing: false, note: "Operational follow-up, no clinical content" },
};

export interface AutomationRun {
  id: string;
  atLabel: string;
  mode: "test" | "simulated";
  outcome: "completed" | "skipped (condition false)" | "blocked (review gate)";
  steps: string[];
}

export interface AutomationRecipe {
  id: string;
  name: string;
  enabled: boolean;
  trigger: string;
  conditions: string[];
  actions: { kind: AutomationActionKind; detail: string }[];
  lastRunLabel: string;
  runs: AutomationRun[];
}

export const SEED_AUTOMATIONS: AutomationRecipe[] = [
  {
    id: "auto-lab",
    name: "Abnormal lab → review task",
    enabled: true,
    trigger: "Lab result imported with abnormal flag",
    conditions: ["Marker severity ≥ high", "Patient has active care plan"],
    actions: [{ kind: "review-task", detail: "Priority High, assigned to care team" }],
    lastRunLabel: "Yesterday 11:24 PM (simulated)",
    runs: [
      { id: "r1", atLabel: "Yesterday 11:24 PM", mode: "simulated", outcome: "completed", steps: ["Trigger matched: 1 abnormal marker", "Condition passed: severity high", "Created review task"] },
      { id: "r2", atLabel: "Jul 15", mode: "simulated", outcome: "skipped (condition false)", steps: ["Trigger matched", "Condition failed: severity below threshold"] },
    ],
  },
  {
    id: "auto-noshow",
    name: "No-show → follow-up",
    enabled: true,
    trigger: "Appointment marked no-show",
    conditions: ["First no-show in 90 days"],
    actions: [
      { kind: "front-desk-task", detail: "Call to rebook within 2 business days" },
      { kind: "draft-message", detail: "Rebooking DRAFT for practitioner review — never auto-sent" },
    ],
    lastRunLabel: "Jul 14 (simulated)",
    runs: [
      { id: "r3", atLabel: "Jul 14", mode: "simulated", outcome: "blocked (review gate)", steps: ["Trigger matched", "Front-desk task created", "Message draft created → waiting for practitioner review"] },
    ],
  },
  {
    id: "auto-highrisk",
    name: "High-risk patient message → priority",
    enabled: true,
    trigger: "Portal message received",
    conditions: ["Patient tagged high-risk"],
    actions: [{ kind: "internal-flag", detail: "Set thread priority High + notify assigned practitioner" }],
    lastRunLabel: "Today 6:58 AM (simulated)",
    runs: [
      { id: "r4", atLabel: "Today 6:58 AM", mode: "simulated", outcome: "completed", steps: ["Trigger matched: message from tagged patient", "Priority set High"] },
    ],
  },
  {
    id: "auto-visit-summary",
    name: "Signed note → visit summary draft",
    enabled: false,
    trigger: "Encounter note signed",
    conditions: ["Visit type is follow-up or initial"],
    actions: [{ kind: "draft-message", detail: "Summary DRAFT from the signed note — review-gated" }],
    lastRunLabel: "—",
    runs: [],
  },
  {
    id: "auto-program-week",
    name: "Program week complete → congratulations draft",
    enabled: false,
    trigger: "Learner completes a program module",
    conditions: ["Learner is an active patient"],
    actions: [{ kind: "draft-message", detail: "Encouragement DRAFT — review-gated, no health claims" }],
    lastRunLabel: "—",
    runs: [],
  },
];

interface IntegrationsSessionState {
  enabled: Record<string, boolean>;
  runs: Record<string, AutomationRun[]>;
  webhookActive: Record<string, boolean>;
}

const store = createSessionStore<IntegrationsSessionState>("aidp:demo:integrations", {
  enabled: {},
  runs: {},
  webhookActive: {},
});

export function useAutomations(): AutomationRecipe[] {
  const s = store.use();
  return SEED_AUTOMATIONS.map((a) => ({
    ...a,
    enabled: a.id in s.enabled ? s.enabled[a.id] : a.enabled,
    runs: [...(s.runs[a.id] ?? []), ...a.runs],
    lastRunLabel: s.runs[a.id]?.length ? "Just now (test)" : a.lastRunLabel,
  }));
}

export function setAutomationEnabled(id: string, enabled: boolean) {
  store.update((s) => ({ ...s, enabled: { ...s.enabled, [id]: enabled } }));
  const a = SEED_AUTOMATIONS.find((x) => x.id === id);
  recordAuditEntry({
    kind: "template_update",
    subjectType: "automation",
    subjectLabel: `${a?.name ?? id} → ${enabled ? "enabled" : "disabled"}`,
    reviewed: true,
  });
}

/** Dry-run: walks the recipe against synthetic context; recorded as a TEST. */
export function testAutomation(id: string): AutomationRun {
  const a = SEED_AUTOMATIONS.find((x) => x.id === id);
  const hasPatientFacing = a?.actions.some((x) => AUTOMATION_ACTION_META[x.kind].patientFacing);
  const run: AutomationRun = {
    id: newSessionId(),
    atLabel: "Just now",
    mode: "test",
    outcome: hasPatientFacing ? "blocked (review gate)" : "completed",
    steps: [
      "TEST MODE — no real trigger, synthetic context only",
      `Trigger simulated: ${a?.trigger ?? id}`,
      ...(a?.conditions.map((c) => `Condition passed: ${c}`) ?? []),
      ...(a?.actions.map((x) =>
        AUTOMATION_ACTION_META[x.kind].patientFacing
          ? `Action HELD at review gate: ${AUTOMATION_ACTION_META[x.kind].label}`
          : `Action simulated: ${AUTOMATION_ACTION_META[x.kind].label}`,
      ) ?? []),
      "Nothing was created or sent — test runs never have side effects",
    ],
  };
  store.update((s) => ({ ...s, runs: { ...s.runs, [id]: [run, ...(s.runs[id] ?? [])] } }));
  recordAuditEntry({
    kind: "automation_test",
    subjectType: "automation",
    subjectLabel: a?.name ?? id,
    reviewed: true,
  });
  return run;
}

/* --------------------------------------------------------------- webhooks */

export interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  secretSet: boolean;
  active: boolean;
}

export interface WebhookDelivery {
  id: string;
  atLabel: string;
  endpointId: string;
  event: string;
  status: "delivered (simulated)" | "failed (simulated)";
  attempts: number;
}

export const WEBHOOK_ENDPOINTS: WebhookEndpoint[] = [
  { id: "wh-1", url: "https://example.invalid/hooks/practice-events", events: ["appointment.updated", "invoice.paid"], secretSet: true, active: true },
  { id: "wh-2", url: "https://example.invalid/hooks/program-events", events: ["program.enrolled", "program.completed"], secretSet: false, active: false },
];

export const WEBHOOK_DELIVERIES: WebhookDelivery[] = [
  { id: "wd-1", atLabel: "Today 7:02 AM", endpointId: "wh-1", event: "invoice.paid", status: "delivered (simulated)", attempts: 1 },
  { id: "wd-2", atLabel: "Yesterday 4:31 PM", endpointId: "wh-1", event: "appointment.updated", status: "delivered (simulated)", attempts: 1 },
  { id: "wd-3", atLabel: "Yesterday 5:00 AM", endpointId: "wh-1", event: "appointment.updated", status: "failed (simulated)", attempts: 3 },
];

export function useWebhookEndpoints(): WebhookEndpoint[] {
  const s = store.use();
  return WEBHOOK_ENDPOINTS.map((w) => ({
    ...w,
    active: w.id in s.webhookActive ? s.webhookActive[w.id] : w.active,
  }));
}

export function setWebhookActive(id: string, active: boolean) {
  store.update((s) => ({ ...s, webhookActive: { ...s.webhookActive, [id]: active } }));
}

/* ---------------------------------------------------------------- synclog */

export interface SyncLogEntry {
  id: string;
  atLabel: string;
  connector: string;
  direction: "import" | "export";
  summary: string;
  status: "ok" | "failed";
  counts: string;
}

export const SYNC_LOG: SyncLogEntry[] = [
  { id: "sl-1", atLabel: "Today 7:00 AM", connector: "Stripe (sandbox)", direction: "import", summary: "Payout + balance snapshot", status: "ok", counts: "1 payout, 4 charges" },
  { id: "sl-2", atLabel: "Today 6:00 AM", connector: "Fullscript (sandbox)", direction: "import", summary: "Refill request intake", status: "ok", counts: "1 refill request" },
  { id: "sl-3", atLabel: "Today 5:00 AM", connector: "Wearables bridge (sandbox)", direction: "import", summary: "Nightly metrics pull", status: "failed", counts: "0 of 2 streams — token expired" },
  { id: "sl-4", atLabel: "Yesterday 11:20 PM", connector: "Quest (sandbox)", direction: "import", summary: "Results + PDF ingest", status: "ok", counts: "1 panel, 12 markers" },
  { id: "sl-5", atLabel: "Yesterday 11:24 PM", connector: "Automations", direction: "import", summary: "Abnormal lab → review task", status: "ok", counts: "1 task created" },
  { id: "sl-6", atLabel: "Yesterday 6:00 AM", connector: "Fullscript (sandbox)", direction: "import", summary: "Catalog delta", status: "ok", counts: "12 products updated" },
  { id: "sl-7", atLabel: "Jul 16", connector: "Stripe (sandbox)", direction: "import", summary: "Charge events", status: "ok", counts: "6 charges" },
  { id: "sl-8", atLabel: "Jul 15", connector: "Wearables bridge (sandbox)", direction: "import", summary: "Nightly metrics pull", status: "ok", counts: "2 streams" },
];

export function getFailedSyncs(): SyncLogEntry[] {
  return SYNC_LOG.filter((s) => s.status === "failed");
}

/* -------------------------------------------- legacy compat (settings card) */

export type ConnectorStatus = "Connected" | "Degraded" | "Error" | "Not configured";

export const CONNECTOR_STATUS_TONE: Record<ConnectorStatus, Tone> = {
  Connected: "positive",
  Degraded: "warning",
  Error: "critical",
  "Not configured": "slate",
};

export interface ConnectorCard {
  id: string;
  name: string;
  purpose: string;
  status: ConnectorStatus;
  lastSync: string;
  nextSync: string;
  scopes: string[];
  safeError?: string;
}

/** Legacy shape consumed by the Settings data-source card. Honest states only. */
export function getConnectors(): ConnectorCard[] {
  return [
    { id: "alp-mobile", name: "ALP mobile app", purpose: "Patient check-ins, symptoms, habits", status: "Not configured", lastSync: "—", nextSync: "After identity cutover (ADR 0002)", scopes: ["check-ins:read", "habits:read"] },
    { id: "labs", name: "Labs provider (sandbox)", purpose: "Lab orders + results ingestion", status: "Degraded", lastSync: "Yesterday 11:20 PM (simulated)", nextSync: "Hourly (simulated)", scopes: ["results:read", "orders:write"], safeError: "Simulated: 2 documents pending OCR retry. No data loss." },
    { id: "wearables", name: "Wearables bridge (sandbox)", purpose: "Ring / CGM / watch streams", status: "Error", lastSync: "Jul 15 (simulated)", nextSync: "Paused", scopes: ["metrics:read"], safeError: "Simulated token expiry — re-auth in sandbox." },
    { id: "stripe", name: "Stripe (test mode)", purpose: "Payments + invoices", status: "Not configured", lastSync: "—", nextSync: "—", scopes: ["charges:write", "invoices:write"] },
  ];
}
