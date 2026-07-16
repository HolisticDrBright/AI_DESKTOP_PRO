if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
import { ACTIVE_ORG_ID } from "./config";
import { trpcQuery } from "./trpc.server";
import { isAdapterError } from "./errors";
import type { PatientDirectoryEntry } from "./types";
import { calendarAge, displaySex, formatDateOnly } from "@/lib/dates";

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

function toDirectoryEntry(row: ClinicalPatientRow, i = 0): PatientDirectoryEntry {
  return {
    id: row.id,
    mrn: row.mrn ?? row.id.slice(0, 8),
    name: `${row.first_name} ${row.last_name}`.trim(),
    initials: initials(row.first_name, row.last_name),
    // Calendar-date parsing (no UTC shift) + no guessing: unknown stays unknown.
    sex: displaySex(row.sex),
    age: calendarAge(row.date_of_birth),
    dob: formatDateOnly(row.date_of_birth),
    avatarGradient: GRADIENTS[i % GRADIENTS.length],
    // Presentation-only fields with no column yet — neutral, clearly not DB data.
    primaryGoals: "—",
    careTeam: [],
    lastVisit: "—",
    nextVisit: "—",
  };
}

export const patientsLive = {
  async list(sessionToken?: string | null): Promise<PatientDirectoryEntry[]> {
    const rows = await trpcQuery<ClinicalPatientRow[]>("clinical.patients.list", {
      organizationId: ACTIVE_ORG_ID,
    }, sessionToken);
    return rows.map((r, i) => toDirectoryEntry(r, i));
  },

  async get(id: string, sessionToken?: string | null): Promise<PatientDirectoryEntry | undefined> {
    try {
      const row = await trpcQuery<ClinicalPatientRow>("clinical.patients.get", {
        patientId: id,
      }, sessionToken);
      return toDirectoryEntry(row);
    } catch (e) {
      // "No such patient / no access" is a legitimate undefined (caller renders
      // not-found). But a backend outage or expired session must NOT be
      // silently reported as "not found" — propagate it so the error boundary
      // shows a retryable "unavailable" state instead of a misleading 404.
      if (isAdapterError(e) && (e.code === "not_found" || e.code === "forbidden")) {
        return undefined;
      }
      throw e;
    }
  },
};
