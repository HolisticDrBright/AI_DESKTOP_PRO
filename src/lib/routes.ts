import type { PatientTabId } from "@/adapters/types";

/**
 * One patient-local tab system (practitioner-OS IA). Everything
 * patient-scoped lives in these tabs — the sidebar carries
 * practice-level destinations only.
 */
export const PATIENT_TABS: { id: PatientTabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "chart", label: "Chart & Timeline" },
  { id: "labs", label: "Labs & Reasoning" },
  { id: "protocol", label: "Protocol" },
  { id: "nutrition", label: "Nutrition" },
  { id: "supplements", label: "Supplements" },
  { id: "tracking", label: "Tracking & Experiments" },
  { id: "appointments", label: "Appointments" },
  { id: "messages", label: "Messages" },
  { id: "billing", label: "Billing" },
  { id: "plans", label: "Plans & Credits" },
  { id: "files", label: "Files" },
  { id: "app-sync", label: "Patient App" },
];

// `care-plan` remains routable only so old bookmarks can be redirected.
export const PATIENT_TAB_IDS: PatientTabId[] = [
  ...PATIENT_TABS.map((t) => t.id),
  "care-plan",
];

export function isPatientTabId(value: string): value is PatientTabId {
  return (PATIENT_TAB_IDS as string[]).includes(value);
}

/**
 * Pre-overhaul tab URLs → their new home (server-side redirect in the tab
 * router). Old bookmarks and deep links never dead-end.
 */
export const LEGACY_PATIENT_TABS: Record<string, { tab: PatientTabId; query?: string }> = {
  summary: { tab: "overview" },
  timeline: { tab: "chart" },
  "lab-orders": { tab: "labs", query: "view=orders" },
  reasoning: { tab: "labs", query: "view=reasoning" },
  protocols: { tab: "protocol" },
  twin: { tab: "tracking", query: "view=twin" },
  "nof1-lab": { tab: "tracking", query: "view=experiments" },
  reports: { tab: "files" },
};

export function patientPath(patientId: string, tab: PatientTabId = "overview") {
  return `/patients/${patientId}/${tab}`;
}

export function parsePatientPath(
  pathname: string,
): { patientId: string; tab: PatientTabId } | null {
  const m = pathname.match(/^\/patients\/([^/]+)\/([^/]+)\/?$/);
  if (!m) return null;
  const [, patientId, tab] = m;
  return isPatientTabId(tab) ? { patientId, tab } : null;
}
