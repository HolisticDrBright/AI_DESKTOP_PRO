import type { CommandGroup } from "./types";
import { DEFAULT_PATIENT_ID, getPatient } from "./patients.mock";

/**
 * Command palette content. `patientId` scopes patient-contextual entries
 * (actions and "Go to" shortcuts) to the patient currently on screen.
 */
export function getCommandGroups(patientId?: string): CommandGroup[] {
  const pid = patientId ?? DEFAULT_PATIENT_ID;
  const patientName = getPatient(pid)?.name ?? "Alexandra Morgan";
  return [
    {
      label: "Actions",
      items: [
        { label: "Add note", sub: `For ${patientName}`, kbd: "N", icon: "note", tone: "action" },
        { label: "Upload lab report", sub: "PDF, HL7 or photo", kbd: "U", icon: "upload", tone: "action" },
        { label: "Start N-of-1 experiment", sub: "Opens the experiment builder", kbd: "E", icon: "tube", tone: "ai", href: `/patients/${pid}/nof1-lab` },
      ],
    },
    {
      label: "Patients",
      items: [
        { label: "Alexandra Morgan", sub: "34 F · Metabolic Reset — Phase 2", initials: "AM", tone: "teal", href: "/patients/p-78435/summary" },
        { label: "Michael Johnson", sub: "52 M · Cardiometabolic program", initials: "MJ", tone: "action", href: "/patients/p-64201/summary" },
        { label: "Priya Sharma", sub: "47 F · High risk — ferritin alert", initials: "PS", tone: "critical", href: "/patients/p-59318/summary" },
      ],
    },
    {
      label: "Go to",
      items: [
        { label: "Overview", sub: "Patient dashboard", kbd: "G O", icon: "home", tone: "slate", href: `/patients/${pid}/summary` },
        { label: "Practice dashboard", sub: "Clients & review queue", kbd: "G P", icon: "users", tone: "slate", href: "/practice" },
        { label: "Clinical Reasoning", sub: patientName, kbd: "G R", icon: "reasoning", tone: "slate", href: `/patients/${pid}/reasoning` },
      ],
    },
  ];
}
