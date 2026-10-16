/**
 * The explicit clinic choice after sign-in (/select-clinic), derived only from the server's answer to
 * `GET /api/auth/org`: the account's own active clinics (under `database_current`, its subject-only discovery, which
 * lists no suspended clinic) and, apart, its pending memberships, which are not choices.
 *
 * A failed read is `failed`, never `none`: nobody is in a position to say the account has no clinic. `several` never
 * pre-selects one; the practitioner chooses.
 */
export type ChooserClinic = { organizationId: string; name: string | null; role?: string };
export type ChooserPending = { organizationId: string; name: string };
export type ChooserRead =
  | { kind: "signed_out" }
  | { kind: "failed" }
  | { kind: "demo" }
  | { kind: "answered"; clinics: ChooserClinic[]; pending: ChooserPending[]; activeOrgId: string | null };
export type ChooserState =
  | { state: "signed_out" }
  | { state: "failed" }
  | { state: "demo" }
  | { state: "none"; pending: ChooserPending[] }
  | { state: "one"; clinic: ChooserClinic; current: boolean; pending: ChooserPending[] }
  | { state: "several"; clinics: ChooserClinic[]; activeOrgId: string | null; pending: ChooserPending[] };

const ID = /^[0-9a-z][0-9a-z-]{0,63}$/i;

export function chooserRead(status: number, body: unknown): ChooserRead {
  if (status === 401) return { kind: "signed_out" };
  const data = (body as { data?: Record<string, unknown> } | null)?.data;
  if (status !== 200 || !data || typeof data !== "object") return { kind: "failed" };
  if (data.mode === "mock") return { kind: "demo" };
  if (data.mode !== "live" || !Array.isArray(data.organizations)) return { kind: "failed" };
  const clinics: ChooserClinic[] = [];
  for (const row of data.organizations as Array<Record<string, unknown>>) {
    if (!row || typeof row.organizationId !== "string" || !ID.test(row.organizationId)) return { kind: "failed" };
    clinics.push({ organizationId: row.organizationId, name: typeof row.name === "string" ? row.name : null, role: typeof row.role === "string" ? row.role : undefined });
  }
  const pending = Array.isArray(data.pending)
    ? (data.pending as Array<Record<string, unknown>>).filter((row) => row && typeof row.organizationId === "string" && typeof row.name === "string")
      .map((row) => ({ organizationId: row.organizationId as string, name: row.name as string }))
    : [];
  const activeOrgId = typeof data.activeOrgId === "string" ? data.activeOrgId : null;
  return { kind: "answered", clinics, pending, activeOrgId };
}

export function chooserState(read: ChooserRead): ChooserState {
  if (read.kind !== "answered") return { state: read.kind };
  const pending = read.pending.filter((clinic) => !read.clinics.some((active) => active.organizationId === clinic.organizationId));
  if (read.clinics.length === 0) return { state: "none", pending };
  if (read.clinics.length === 1) return { state: "one", clinic: read.clinics[0]!, current: read.activeOrgId === read.clinics[0]!.organizationId, pending };
  // The active clinic is reported only while it is still among the account's own clinics.
  const activeOrgId = read.clinics.some((clinic) => clinic.organizationId === read.activeOrgId) ? read.activeOrgId : null;
  return { state: "several", clinics: read.clinics, activeOrgId, pending };
}
