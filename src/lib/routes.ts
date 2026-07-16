import type { PatientTabId } from "@/adapters/types";

export const PATIENT_TABS: { id: PatientTabId; label: string }[] = [
  { id: "summary", label: "Summary" },
  { id: "twin", label: "Health Twin" },
  { id: "timeline", label: "Timeline" },
  { id: "labs", label: "Labs" },
  { id: "lab-orders", label: "Lab Orders" },
  { id: "reasoning", label: "Clinical Reasoning" },
  { id: "supplements", label: "Supplements" },
  { id: "nof1-lab", label: "N-of-1 Lab" },
  { id: "protocols", label: "Protocols" },
  { id: "reports", label: "Reports" },
];

export const PATIENT_TAB_IDS = PATIENT_TABS.map((t) => t.id);

export function isPatientTabId(value: string): value is PatientTabId {
  return (PATIENT_TAB_IDS as string[]).includes(value);
}

export function patientPath(patientId: string, tab: PatientTabId = "summary") {
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
