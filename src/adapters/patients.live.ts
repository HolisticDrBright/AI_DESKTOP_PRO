if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
import { resolveOrgId } from "./config";
import { clinicalSelect } from "./supabase-rest.server";
import { getClinicalAccessToken } from "./session.server";
import type { PatientDirectoryEntry } from "./types";
import { calendarAge, displaySex, formatDateOnly } from "@/lib/dates";

/**
 * Live `patients` namespace (Item 6) — the one swapped namespace.
 * Reads real `patient_profiles` rows from the clinical project through the
 * Desktop-owned Supabase REST boundary (RLS enforced). Clinical fields
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

function patientParams(organizationId: string, patientId?: string) {
  const params = new URLSearchParams({
    select: "id,organization_id,mrn,first_name,last_name,date_of_birth,sex,status",
    organization_id: `eq.${organizationId}`,
    deleted_at: "is.null",
    order: "last_name.asc,first_name.asc,id.asc",
  });
  if (patientId) {
    params.set("id", `eq.${patientId}`);
    params.set("limit", "1");
  }
  return params;
}

export const patientsLive = {
  async list(sessionToken?: string | null, orgId?: string | null): Promise<PatientDirectoryEntry[]> {
    const token = await getClinicalAccessToken(sessionToken);
    const rows = await clinicalSelect<ClinicalPatientRow[]>(
      "patient_profiles",
      patientParams(resolveOrgId(orgId)),
      token,
    );
    return rows.map((r, i) => toDirectoryEntry(r, i));
  },

  async get(
    id: string,
    sessionToken?: string | null,
    orgId?: string | null,
  ): Promise<PatientDirectoryEntry | undefined> {
    const token = await getClinicalAccessToken(sessionToken);
    const rows = await clinicalSelect<ClinicalPatientRow[]>(
      "patient_profiles",
      patientParams(resolveOrgId(orgId), id),
      token,
    );
    return rows[0] ? toDirectoryEntry(rows[0]) : undefined;
  },
};
