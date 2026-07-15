if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
import { ACTIVE_ORG_ID } from "./config";
import { trpcQuery } from "./trpc.server";
import type { PatientDirectoryEntry } from "./types";

/**
 * Live `patients` namespace (Item 6) — the one swapped namespace.
 * Reads real `patient_profiles` rows from the clinical project through the
 * authenticated tRPC backend (RLS enforced server-side). Clinical fields
 * (name, DOB, sex, MRN, status) are real; presentation-only fields that have
 * no column yet (avatar gradient, goals, care team, visit dates) are given
 * neutral defaults and are clearly not DB-backed. `summary` is NOT swapped —
 * it synthesizes health scores/radars/series with no DB source, so it stays
 * on the mock adapter until that data exists (parity not yet proven).
 */

interface ClinicalPatientRow {
  id: string;
  organization_id?: string;
  mrn: string | null;
  first_name: string;
  last_name: string;
  date_of_birth: string | null;
  sex: string | null;
  status: string | null;
}

const GRADIENTS: [string, string][] = [
  ["#0E8388", "#3BA5A5"],
  ["#2563C7", "#5B8AD9"],
  ["#7461C9", "#9D8DE8"],
  ["#3D5A80", "#6483AC"],
  ["#0D5C63", "#1A7A82"],
  ["#B45309", "#D98E3B"],
];

function initials(first: string, last: string): string {
  return `${first[0] ?? ""}${last[0] ?? ""}`.toUpperCase() || "?";
}

function ageFrom(dob: string | null): number {
  if (!dob) return 0;
  const born = new Date(dob);
  const nowYear = new Date().getFullYear();
  let age = nowYear - born.getFullYear();
  const m = new Date().getMonth() - born.getMonth();
  if (m < 0 || (m === 0 && new Date().getDate() < born.getDate())) age -= 1;
  return age > 0 ? age : 0;
}

function formatDob(dob: string | null): string {
  if (!dob) return "—";
  const d = new Date(dob);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
}

function toDirectoryEntry(row: ClinicalPatientRow, i = 0): PatientDirectoryEntry {
  const sex: PatientDirectoryEntry["sex"] = row.sex === "male" ? "Male" : "Female";
  return {
    id: row.id,
    mrn: row.mrn ?? row.id.slice(0, 8),
    name: `${row.first_name} ${row.last_name}`.trim(),
    initials: initials(row.first_name, row.last_name),
    sex,
    age: ageFrom(row.date_of_birth),
    dob: formatDob(row.date_of_birth),
    avatarGradient: GRADIENTS[i % GRADIENTS.length],
    // Presentation-only fields with no column yet — neutral, clearly not DB data.
    primaryGoals: "—",
    careTeam: [],
    lastVisit: "—",
    nextVisit: "—",
  };
}

export const patientsLive = {
  async list(): Promise<PatientDirectoryEntry[]> {
    const rows = await trpcQuery<ClinicalPatientRow[]>("clinical.patients.list", {
      organizationId: ACTIVE_ORG_ID,
    });
    return rows.map((r, i) => toDirectoryEntry(r, i));
  },

  async get(id: string): Promise<PatientDirectoryEntry | undefined> {
    try {
      const row = await trpcQuery<ClinicalPatientRow>("clinical.patients.get", {
        patientId: id,
      });
      return toDirectoryEntry(row);
    } catch {
      // NOT_FOUND from the RLS gate ⇒ no access / no such patient.
      return undefined;
    }
  },
};
