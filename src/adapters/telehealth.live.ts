if (typeof window !== "undefined") throw new Error("telehealth.live is server-only");

/**
 * Live `telehealth` namespace (server-only).
 *
 * Two real sources, merged per appointment:
 *
 *   1. The Desktop-owned clinical calendar (`get_desktop_calendar`) for
 *      appointments of type `telehealth` — the same RPC the Calendar reads,
 *      under the practitioner's own session and RLS. EVERY visit action
 *      resolves its appointment here first: a nonexistent appointment, one in
 *      another organization, or one the practitioner cannot see is refused
 *      before the visit boundary is called, and the appointment's STORED
 *      times are what the boundary receives — never times from the browser.
 *   2. The AWS telehealth boundary (workforce routes of the telehealth
 *      Lambda) for patient-app requests, consent receipts against the
 *      governed consent authority, the Zoom meeting, the embedded-meeting
 *      session, provider shutdown state, and the post-visit note.
 *
 * The visit service can be unreachable while the calendar is fine. That is
 * reported as `visitService.available = false` with the calendar rows still
 * present — never as "consent not signed", which would be a claim nobody made.
 */
import { AdapterError } from "./errors";
import { scheduleLive } from "./schedule.live";
import { getClinicalAccessToken } from "./session.server";
import type { LiveAppointment } from "./live-types";
import { getContractFixtureTransport } from "@/server/runtime/contractFixture";
import { clinicalRpc } from "./aws-clinical-data.server";
import { resolveOrgId } from "./config";
import type {
  TelehealthConsentArtifact,
  TelehealthConsentInput,
  TelehealthDay,
  TelehealthDayVisit,
  TelehealthEndInput,
  TelehealthImportResult,
  TelehealthSignInput,
  TelehealthTransferInput,
  TelehealthTransferResult,
  TelehealthChartRecord,
  TelehealthStartInput,
  TelehealthStartResult,
  TelehealthVisit,
  TelehealthWithdrawInput,
} from "./telehealth.types";

const HOST = /^[a-z0-9]{10}\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Appointment statuses under which nothing may start or be recorded against the visit. */
const CLOSED_APPOINTMENT_STATUSES = new Set(["cancelled", "no_show"]);

/**
 * Workforce API origin: the AWS clinical API, or — only when the local
 * contract-fixture boundary has independently accepted loopback + explicit
 * opt-in + non-deployment — the fixture backend that drives the browser suite.
 */
function origin(): string {
  const fixture = getContractFixtureTransport();
  if (fixture) return fixture.origin;
  let url: URL;
  try {
    url = new URL(String(process.env.CLINICAL_AWS_WORKFORCE_API_ORIGIN ?? ""));
  } catch {
    throw new AdapterError("unavailable", SERVICE_NOT_CONFIGURED, "CLINICAL_AWS_WORKFORCE_API_ORIGIN missing");
  }
  if (url.protocol !== "https:" || url.pathname !== "/" || !HOST.test(url.hostname)) {
    throw new AdapterError("unavailable", SERVICE_NOT_CONFIGURED, "CLINICAL_AWS_WORKFORCE_API_ORIGIN invalid");
  }
  return url.origin;
}

const SERVICE_NOT_CONFIGURED =
  "The telehealth visit service is not configured on this deployment. Consent and meeting state are unavailable.";

const ERROR_MESSAGES: Record<string, { code: AdapterError["code"]; message: string }> = {
  consent_required: {
    code: "conflict",
    message: "This visit has no current telehealth consent on record. Record the consent before starting the visit.",
  },
  consent_withdrawn: {
    code: "conflict",
    message: "The patient withdrew the telehealth and recording consent. The visit cannot start and its AI notes cannot be read.",
  },
  consent_superseded: {
    code: "conflict",
    message: "The consent on record is for a superseded version of the practice's telehealth consent. A current consent must be recorded before this visit starts.",
  },
  consent_version_refused: {
    code: "conflict",
    message: "That is not the practice's current approved telehealth consent. Reload and record the consent again.",
  },
  consent_artifact_unavailable: {
    code: "conflict",
    message: "The practice has no approved telehealth and recording consent yet. One must be approved in the consent registry before any visit can be consented or started.",
  },
  appointment_cancelled: {
    code: "conflict",
    message: "This appointment was cancelled. Its visit cannot be started.",
  },
  provider_unavailable: {
    code: "unavailable",
    message: "Video is not enabled for this practice yet. Zoom must be connected under a verified business associate agreement before a visit can start.",
  },
  conflict: {
    code: "conflict",
    message: "This visit changed in another tab or session. Reload to see the latest state.",
  },
  not_found: { code: "not_found", message: "This visit record isn't available." },
  identity_refused: { code: "forbidden", message: "You don't have access to this visit." },
  request_invalid: { code: "invalid", message: "That action couldn't be completed as requested." },
};

async function request<T>(
  path: string,
  token: string,
  init?: { method?: "GET" | "POST"; body?: Record<string, unknown> },
): Promise<T> {
  const method = init?.method ?? (init?.body ? "POST" : "GET");
  let response: Response;
  try {
    response = await fetch(`${origin()}${path}`, {
      method,
      redirect: "manual",
      cache: "no-store",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(init?.body ? { "content-type": "application/json" } : {}),
      },
      ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch (error) {
    throw new AdapterError("unavailable", undefined, `telehealth fetch: ${error instanceof Error ? error.message : "network"}`);
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new AdapterError("unknown", undefined, `telehealth service non-JSON ${response.status}`);
  }
  if (!response.ok || !parsed || typeof parsed !== "object" || !("data" in parsed)) {
    const serverError = parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string"
      ? (parsed as { error: string }).error
      : "";
    const mapped = ERROR_MESSAGES[serverError];
    if (mapped) throw new AdapterError(mapped.code, mapped.message, `telehealth service ${response.status} ${serverError}`);
    throw new AdapterError(
      response.status === 409 ? "conflict" : response.status === 403 ? "forbidden" : response.status === 404 ? "not_found" : "unavailable",
      undefined,
      `telehealth service ${response.status} ${serverError}`.trim(),
    );
  }
  return (parsed as { data: T }).data;
}

/** Patient-app request rows as the workforce queue returns them (only the fields the day view needs). */
interface WorkforceRequestRow {
  requestId: string;
  appointmentId: string | null;
  consumerPersonId: string;
  status: "requested" | "awaiting_provider" | "scheduled" | "reschedule_requested" | "cancelled";
  scheduledStart: string | null;
  scheduledEnd: string | null;
}

function isVisit(value: unknown): value is TelehealthVisit {
  return Boolean(value && typeof value === "object" && typeof (value as TelehealthVisit).appointmentId === "string"
    && Array.isArray((value as TelehealthVisit).consents));
}

function isRequestRow(value: unknown): value is WorkforceRequestRow {
  return Boolean(value && typeof value === "object" && typeof (value as WorkforceRequestRow).requestId === "string");
}

/* ------------------------------------------------------------ day bounds */

function isTimeZone(timeZone: string): boolean {
  if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,3}$/.test(timeZone)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of an instant in a zone. */
function zonedParts(instant: number, timeZone: string): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(instant));
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { y: read("year"), m: read("month"), d: read("day"), h: read("hour"), mi: read("minute"), s: read("second") };
}

/** The instant at which the zone's wall clock reads exactly Y-M-D 00:00:00 (DST-aware), or null if no such instant exists. */
function zonedMidnight(y: number, m: number, d: number, timeZone: string): number | null {
  const asIfUtc = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
  let guess = asIfUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = zonedParts(guess, timeZone);
    const wall = Date.UTC(parts.y, parts.m - 1, parts.d, parts.h, parts.mi, parts.s);
    const delta = wall - asIfUtc;
    if (delta === 0) return guess;
    guess -= delta;
  }
  const check = zonedParts(guess, timeZone);
  return check.y === y && check.m === m && check.d === d && check.h === 0 && check.mi === 0 ? guess : null;
}

/**
 * [from, to) instants of one calendar day in the VIEWER'S zone. An impossible
 * date (February 31) is refused rather than normalised, and a DST transition
 * makes the day 23 or 25 hours long instead of shifting its boundaries.
 */
export function dayBounds(date: string, timeZone: string): { date: string; timeZone: string; from: string; to: string } {
  if (!isTimeZone(timeZone)) throw new AdapterError("invalid", "A valid IANA time zone is required.");
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new AdapterError("invalid", "A valid date (YYYY-MM-DD) is required.");
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (m < 1 || m > 12 || d < 1 || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    throw new AdapterError("invalid", "That calendar date does not exist.");
  }
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const from = zonedMidnight(y, m, d, timeZone);
  const to = zonedMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timeZone);
  if (from === null || to === null || to <= from) throw new AdapterError("invalid", "That calendar day cannot be resolved in this time zone.");
  return { date, timeZone, from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

/* ------------------------------------------------------------- merging */

function calendarRow(appointment: LiveAppointment, visit: TelehealthVisit | null): TelehealthDayVisit | null {
  if (!appointment.startsAt || !appointment.endsAt) return null;
  return {
    appointmentId: appointment.id,
    source: "clinical_calendar",
    patientId: appointment.patientId,
    patientName: appointment.patientName,
    practitionerName: appointment.practitionerName,
    appointmentStatus: appointment.status,
    startsAt: appointment.startsAt,
    endsAt: appointment.endsAt,
    requestId: visit?.requestId ?? null,
    visit,
  };
}

type TelehealthTransferSource = {
  transferId: string; organizationId: string; patientRecordId: string; appointmentId: string; sourceRevision: number; sourceDigest: string;
  content: Record<string, string>; sourcePayload: Record<string, unknown>; provenance: Array<{ sectionKey: string; refType: string; refId: string | null; label: string }>;
};

/**
 * The chart's view of a COMPLETED visit's retained record, read through the
 * reviewed clinical-record authority (`get_telehealth_record_authority`) with
 * the caller's own token. A refusal is surfaced as the refusal it is; it is
 * never softened into "no chart record".
 */
async function chartRecord(visit: TelehealthVisit, token: string, orgId: string | null): Promise<TelehealthChartRecord | null> {
  if (!(visit.status === "ended" || visit.status === "cancelled") || !visit.patientRecordId) return null;
  const authority = await clinicalRpc<{ authorized?: boolean; legal_hold?: boolean; appointment?: Record<string, unknown> | null; transfer?: Record<string, unknown> | null } | null>(
    "get_telehealth_record_authority",
    { _organization_id: resolveOrgId(orgId), _patient_id: visit.patientRecordId, _appointment_id: visit.appointmentId },
    token,
  );
  if (!authority || authority.authorized !== true) throw new AdapterError("forbidden", "You don't have access to this patient's retained telehealth record.");
  const appointment = authority.appointment ?? null;
  const transfer = authority.transfer ?? null;
  return {
    legalHold: authority.legal_hold === true,
    appointment: appointment ? { id: String(appointment.id), status: String(appointment.status), deleted: appointment.deleted === true, patientMatches: appointment.patient_matches === true } : null,
    transfer: transfer ? {
      transferId: String(transfer.transfer_id), encounterId: String(transfer.encounter_id), noteId: String(transfer.note_id), noteVersion: Number(transfer.note_version),
      noteStatus: typeof transfer.note_status === "string" ? transfer.note_status : null, noteCurrentVersion: typeof transfer.note_current_version === "number" ? transfer.note_current_version : null,
      noteDeleted: transfer.note_deleted === true, transferredAt: String(transfer.transferred_at),
    } : null,
  };
}

type Boundary =
  | { available: true; complete: boolean; visits: Map<string, TelehealthVisit>; requests: WorkforceRequestRow[] }
  | { available: false; message: string };

async function visitBoundary(token: string): Promise<Boundary> {
  try {
    const [listed, requestRows] = await Promise.all([
      request<{ visits: unknown[]; complete: boolean }>("/clinical-core/workforce/appointments/visits", token),
      request<unknown[]>("/clinical-core/workforce/appointments/requests", token),
    ]);
    const visits = new Map<string, TelehealthVisit>();
    for (const row of Array.isArray(listed?.visits) ? listed.visits : []) if (isVisit(row)) visits.set(row.appointmentId, row);
    const requests = (Array.isArray(requestRows) ? requestRows : []).filter(isRequestRow);
    return { available: true, complete: listed?.complete === true, visits, requests };
  } catch (error) {
    if (error instanceof AdapterError && (error.code === "unauthenticated" || error.code === "forbidden")) throw error;
    return {
      available: false,
      message: error instanceof AdapterError && error.code === "unavailable" ? error.message : SERVICE_NOT_CONFIGURED,
    };
  }
}

async function buildDay(date: string, timeZone: string, token: string, orgId: string | null): Promise<TelehealthDay> {
  const bounds = dayBounds(date, timeZone);
  const [calendar, boundary] = await Promise.all([
    scheduleLive.getCalendar(bounds.from, bounds.to, token, orgId),
    visitBoundary(token),
  ]);
  const visits = boundary.available ? boundary.visits : new Map<string, TelehealthVisit>();
  const rows: TelehealthDayVisit[] = [];
  const seen = new Set<string>();
  for (const appointment of calendar.appointments) {
    if (appointment.appointmentType !== "telehealth") continue;
    const row = calendarRow(appointment, visits.get(appointment.id) ?? null);
    if (!row) continue;
    seen.add(row.appointmentId);
    rows.push(row);
  }
  if (boundary.available) {
    const from = Date.parse(bounds.from);
    const to = Date.parse(bounds.to);
    for (const req of boundary.requests) {
      if (!req.appointmentId || seen.has(req.appointmentId) || !req.scheduledStart || !req.scheduledEnd) continue;
      if (req.status === "cancelled") continue;
      const startsAt = Date.parse(req.scheduledStart);
      if (!(startsAt >= from && startsAt < to)) continue;
      seen.add(req.appointmentId);
      rows.push({
        appointmentId: req.appointmentId,
        source: "patient_app",
        patientId: null,
        // The patient app's person id is not a chart identity; the row says so instead of inventing a name.
        patientName: null,
        practitionerName: null,
        appointmentStatus: req.status === "scheduled" ? "confirmed" : "scheduled",
        startsAt: req.scheduledStart,
        endsAt: req.scheduledEnd,
        requestId: req.requestId,
        visit: visits.get(req.appointmentId) ?? null,
      });
    }
  }
  rows.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.appointmentId.localeCompare(b.appointmentId));
  return {
    date: bounds.date,
    timeZone: bounds.timeZone,
    from: bounds.from,
    to: bounds.to,
    visits: rows,
    visitService: boundary.available ? { available: true, complete: boundary.complete } : { available: false, message: boundary.message },
  };
}

/**
 * The authoritative appointment for a visit action, located through the
 * practitioner's own calendar access: on the named day first, then ±14 days
 * around it in case it was moved. Anything the calendar does not return
 * (nonexistent, another organization, no access) is `not_found` here and the
 * boundary is never called.
 */
async function resolveAppointment(appointmentId: string, date: string, timeZone: string, token: string, orgId: string | null): Promise<TelehealthDayVisit> {
  if (!UUID.test(appointmentId)) throw new AdapterError("invalid", "A valid appointment id is required.");
  const exact = await buildDay(date, timeZone, token, orgId);
  const direct = exact.visits.find((row) => row.appointmentId === appointmentId);
  if (direct) return direct;
  const center = Date.parse(exact.from);
  const from = new Date(center - 14 * 86_400_000).toISOString();
  const to = new Date(center + 14 * 86_400_000).toISOString();
  const [calendar, boundary] = await Promise.all([scheduleLive.getCalendar(from, to, token, orgId), visitBoundary(token)]);
  const visit = boundary.available ? boundary.visits.get(appointmentId) ?? null : null;
  const appointment = calendar.appointments.find((row) => row.id === appointmentId && row.appointmentType === "telehealth");
  if (appointment) {
    const row = calendarRow(appointment, visit);
    if (row) return row;
  }
  const req = boundary.available ? boundary.requests.find((row) => row.appointmentId === appointmentId) : undefined;
  if (req?.scheduledStart && req.scheduledEnd && req.status !== "cancelled") {
    return {
      appointmentId, source: "patient_app", patientId: null, patientName: null, practitionerName: null,
      appointmentStatus: req.status === "scheduled" ? "confirmed" : "scheduled",
      startsAt: req.scheduledStart, endsAt: req.scheduledEnd, requestId: req.requestId, visit,
    };
  }
  throw new AdapterError("not_found", "This telehealth visit isn't on the schedule you can see.");
}

function requireOpenAppointment(row: TelehealthDayVisit) {
  if (CLOSED_APPOINTMENT_STATUSES.has(row.appointmentStatus)) {
    throw new AdapterError("conflict", `This appointment is ${row.appointmentStatus.replace("_", "-")}; its visit cannot proceed.`);
  }
}

/** The boundary's binding fields for a desktop-booked appointment: the calendar's stored times, never the browser's. */
function bindingFields(row: TelehealthDayVisit) {
  return row.requestId
    ? { requestId: row.requestId }
    : { start: row.startsAt, end: row.endsAt };
}

export const telehealthLive = {
  /** Every telehealth appointment on one calendar day in the viewer's zone, with its visit record where the boundary has one. */
  async day(date: string, timeZone: string, sessionToken: string | null, orgId: string | null): Promise<TelehealthDay> {
    const token = await getClinicalAccessToken(sessionToken);
    return buildDay(date, timeZone, token, orgId);
  },

  async visit(appointmentId: string, date: string, timeZone: string, sessionToken: string | null, orgId: string | null): Promise<TelehealthDayVisit> {
    const token = await getClinicalAccessToken(sessionToken);
    return resolveAppointment(appointmentId, date, timeZone, token, orgId);
  },

  /** The organization's current approved consent artifact (version + hash), read through the boundary from the governed authority. */
  async consentArtifact(sessionToken: string | null): Promise<TelehealthConsentArtifact> {
    const token = await getClinicalAccessToken(sessionToken);
    return request<TelehealthConsentArtifact>("/clinical-core/workforce/appointments/visits/consent-artifact", token);
  },

  async recordConsent(input: TelehealthConsentInput, sessionToken: string | null, orgId: string | null): Promise<TelehealthVisit> {
    if (input.agreed !== true) throw new AdapterError("invalid", "The consent must be attested before it is recorded.");
    const token = await getClinicalAccessToken(sessionToken);
    const row = await resolveAppointment(input.appointmentId, input.date, input.timeZone, token, orgId);
    requireOpenAppointment(row);
    const body: Record<string, unknown> = {
      appointmentId: row.appointmentId,
      ...bindingFields(row),
      artifactId: input.artifactId,
      artifactVersion: input.artifactVersion,
      contentSha256: input.contentSha256,
      signerName: input.signerName,
      representativeAuthority: input.representativeAuthority ?? "self",
      agreed: true,
    };
    if (!row.requestId) body.timeZone = input.timeZone;
    if (input.patientLocation) body.patientLocation = input.patientLocation;
    return request<TelehealthVisit>("/clinical-core/workforce/appointments/visits/consent", token, { body });
  },

  async withdrawConsent(input: TelehealthWithdrawInput, sessionToken: string | null, orgId: string | null): Promise<TelehealthVisit> {
    const token = await getClinicalAccessToken(sessionToken);
    const row = await resolveAppointment(input.appointmentId, input.date, input.timeZone, token, orgId);
    return request<TelehealthVisit>("/clinical-core/workforce/appointments/visits/consent/withdraw", token, {
      body: { appointmentId: row.appointmentId, expectedVersion: input.expectedVersion, ...(input.reason ? { reason: input.reason } : {}) },
    });
  },

  async start(input: TelehealthStartInput, sessionToken: string | null, orgId: string | null): Promise<TelehealthStartResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const row = await resolveAppointment(input.appointmentId, input.date, input.timeZone, token, orgId);
    requireOpenAppointment(row);
    const body: Record<string, unknown> = {
      appointmentId: row.appointmentId,
      ...bindingFields(row),
      hostDisplayName: (input.hostDisplayName ?? "").trim() || row.practitionerName || "Practitioner",
    };
    if (!row.requestId) body.timeZone = input.timeZone;
    return request<TelehealthStartResult>("/clinical-core/workforce/appointments/visits/start", token, { body });
  },

  async end(input: TelehealthEndInput, sessionToken: string | null, orgId: string | null): Promise<TelehealthVisit> {
    const token = await getClinicalAccessToken(sessionToken);
    const row = await resolveAppointment(input.appointmentId, input.date, input.timeZone, token, orgId);
    return request<TelehealthVisit>("/clinical-core/workforce/appointments/visits/end", token, {
      body: { appointmentId: row.appointmentId, expectedVersion: input.expectedVersion, flags: input.flags, quickNotes: input.quickNotes },
    });
  },

  async note(appointmentId: string, sessionToken: string | null, orgId: string | null = null): Promise<TelehealthVisit> {
    if (!UUID.test(appointmentId)) throw new AdapterError("invalid", "A valid appointment id is required.");
    const token = await getClinicalAccessToken(sessionToken);
    const visit = await request<TelehealthVisit>(
      `/clinical-core/workforce/appointments/visits/notes?appointmentId=${encodeURIComponent(appointmentId)}`,
      token,
    );
    return { ...visit, chartRecord: await chartRecord(visit, token, orgId) };
  },

  /**
   * Place a SIGNED telehealth visit record into the chart as an UNSIGNED draft.
   * Three bound steps, each safe to repeat: the boundary admits the exact
   * source the practitioner reviewed (revision + digest) and returns the
   * canonical content; the chart's own `transfer_telehealth_note` creates the
   * draft idempotently under the clinical-record authority; the boundary reads
   * the chart's receipt back. A lost response anywhere is settled by calling
   * this again — the chart never gets a second note for the same source.
   */
  async transferToChart(input: TelehealthTransferInput, sessionToken: string | null, orgId: string | null): Promise<TelehealthTransferResult> {
    if (!UUID.test(input.appointmentId)) throw new AdapterError("invalid", "A valid appointment id is required.");
    const token = await getClinicalAccessToken(sessionToken);
    const admitted = await request<TelehealthTransferResult & { source: TelehealthTransferSource | null }>(
      "/clinical-core/workforce/appointments/visits/notes/transfer", token,
      { body: { appointmentId: input.appointmentId, sourceRevision: input.sourceRevision, sourceDigest: input.sourceDigest } },
    );
    if (admitted.transfer?.state === "completed" || !admitted.source) return { visit: admitted.visit, transfer: admitted.transfer };
    const source = admitted.source;
    await clinicalRpc<Record<string, unknown>>("transfer_telehealth_note", {
      _organization_id: resolveOrgId(orgId),
      _transfer_id: source.transferId,
      _appointment_id: source.appointmentId,
      _patient_id: source.patientRecordId,
      _source_revision: source.sourceRevision,
      _source_digest: source.sourceDigest,
      _content: source.content,
      _source_payload: source.sourcePayload,
      _provenance: source.provenance,
    }, token);
    return request<TelehealthTransferResult>("/clinical-core/workforce/appointments/visits/notes/transfer/complete", token, { body: { appointmentId: input.appointmentId } });
  },

  /** Inspect/reconcile a transfer: reads the chart's receipt back without writing the chart. */
  async inspectTransfer(appointmentId: string, sessionToken: string | null): Promise<TelehealthTransferResult> {
    if (!UUID.test(appointmentId)) throw new AdapterError("invalid", "A valid appointment id is required.");
    const token = await getClinicalAccessToken(sessionToken);
    return request<TelehealthTransferResult>("/clinical-core/workforce/appointments/visits/notes/transfer/complete", token, { body: { appointmentId } });
  },

  async importNote(appointmentId: string, date: string, timeZone: string, sessionToken: string | null, orgId: string | null): Promise<TelehealthImportResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const row = await resolveAppointment(appointmentId, date, timeZone, token, orgId);
    return request<TelehealthImportResult>("/clinical-core/workforce/appointments/visits/notes/import", token, {
      body: { appointmentId: row.appointmentId },
    });
  },

  async signNote(input: TelehealthSignInput, sessionToken: string | null, orgId: string | null): Promise<TelehealthVisit> {
    const token = await getClinicalAccessToken(sessionToken);
    const row = await resolveAppointment(input.appointmentId, input.date, input.timeZone, token, orgId);
    return request<TelehealthVisit>("/clinical-core/workforce/appointments/visits/notes/sign", token, {
      body: {
        appointmentId: row.appointmentId,
        expectedVersion: input.expectedVersion,
        practitionerNotes: input.practitionerNotes,
        aiSections: input.aiSections,
        actionItems: input.actionItems,
      },
    });
  },
};
