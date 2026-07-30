import type { CommandGroup } from "./types";

/**
 * Command palette content — CLINICAL.
 *
 * Navigation shortcuts only. The palette must never carry patient identities
 * of its own: the demo version listed fixture patients here, which is exactly
 * the kind of fabricated row the clinical runtime forbids. Patient search
 * belongs to the live directory (/patients), which reads RLS-scoped rows.
 *
 * `patientId` scopes the "Go to" entries to the patient currently on screen;
 * without one, the palette offers practice-level destinations only.
 */
export function getCommandGroups(patientId?: string): CommandGroup[] {
  const groups: CommandGroup[] = [
    {
      label: "Go to",
      items: [
        { label: "Today", sub: "Daily work surface", kbd: "G T", icon: "home", tone: "slate", href: "/today" },
        { label: "Patients", sub: "Live directory (org-scoped)", kbd: "G P", icon: "users", tone: "slate", href: "/patients" },
        { label: "Review queue", sub: "Open review items", kbd: "G Q", icon: "reasoning", tone: "slate", href: "/tasks" },
        { label: "Calendar", sub: "Live schedule", kbd: "G C", icon: "home", tone: "slate", href: "/calendar" },
        { label: "Settings", sub: "Practice configuration", kbd: "G S", icon: "home", tone: "slate", href: "/settings" },
      ],
    },
  ];

  if (patientId) {
    groups.unshift({
      label: "This patient",
      items: [
        { label: "Overview", sub: "Patient chart", kbd: "G O", icon: "home", tone: "slate", href: `/patients/${patientId}/overview` },
        { label: "Labs & Reasoning", sub: "Live biomarkers", kbd: "G L", icon: "tube", tone: "action", href: `/patients/${patientId}/labs` },
        { label: "Chart & Timeline", sub: "Encounters and notes", kbd: "G R", icon: "note", tone: "slate", href: `/patients/${patientId}/chart` },
      ],
    });
  }

  return groups;
}
