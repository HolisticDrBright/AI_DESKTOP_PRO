if (typeof window !== "undefined") throw new Error("telehealth.live is server-only");

/**
 * Live `telehealth` namespace (server-only).
 *
 * Two real sources, merged per appointment:
 *
 *   1. The Desktop-owned clinical calendar (`get_desktop_calendar`) for
 *      appointments of type `telehealth` — the same RPC the Calendar reads,
 *      so the day view and the calendar can never disagree about who is
 *      booked.
 *   2. The AWS telehealth boundary (workforce routes of the telehealth
 *      Lambda) for patient-app requests, consent, the Zoom meeting, the
 *      embedded-meeting session, and the post-visit note.
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
import type {
  TelehealthConsentInput,
  TelehealthDay,
  TelehealthDayVisit,
  TelehealthEndInput,
  TelehealthImportResult,
  TelehealthSignInput,
  TelehealthStartInput,
  TelehealthStartResult,
  TelehealthVisit,
} from "./telehealth.types";
import { TELEHEALTH_CONSENT_VERSION } from "./telehealth.types";

const HOST = /^[a-z0-9]{10}\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    message: "This visit has no signed telehealth consent on record. Record the consent before starting the visit.",
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
  token: string | null,
  init?: { method?: "GET" | "POST"; body?: Record<string, unknown> },
): Promise<T> {
  if (!token) throw new AdapterError("unauthenticated");
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

/** Local day → [from, to) instants. The day view is the viewer's calendar day, like the Today page. */
export function dayBounds(date: string, now: Date = new Date()): { date: string; from: string; to: string } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const base = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0)
    : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  if (Number.isNaN(base.getTime())) throw new AdapterError("invalid", "A valid date is required.");
  const next = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1, 0, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}`,
    from: base.toISOString(),
    to: next.toISOString(),
  };
}

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

async function visitBoundary(token: string | null): Promise<
  | { available: true; visits: Map<string, TelehealthVisit>; requests: WorkforceRequestRow[] }
  | { available: false; message: string }
> {
  try {
    const [visitRows, requestRows] = await Promise.all([
      request<unknown[]>("/clinical-core/workforce/appointments/visits", token),
      request<unknown[]>("/clinical-core/workforce/appointments/requests", token),
    ]);
    const visits = new Map<string, TelehealthVisit>();
    for (const row of Array.isArray(visitRows) ? visitRows : []) if (isVisit(row)) visits.set(row.appointmentId, row);
    const requests = (Array.isArray(requestRows) ? requestRows : []).filter(isRequestRow);
    return { available: true, visits, requests };
  } catch (error) {
    if (error instanceof AdapterError && error.code === "unauthenticated") throw error;
    return {
      available: false,
      message: error instanceof AdapterError && error.code === "unavailable" ? error.message : SERVICE_NOT_CONFIGURED,
    };
  }
}

export const telehealthLive = {
  /** Every telehealth appointment on one local day, with its visit record where the boundary has one. */
  async day(date: string, sessionToken: string | null, orgId: string | null): Promise<TelehealthDay> {
    const bounds = dayBounds(date);
    const token = await getClinicalAccessToken(sessionToken);
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
      from: bounds.from,
      to: bounds.to,
      visits: rows,
      visitService: boundary.available ? { available: true } : { available: false, message: boundary.message },
    };
  },

  /** One appointment's day row, located by the day it starts on (±14 days around `date` if it moved). */
  async visit(appointmentId: string, date: string, sessionToken: string | null, orgId: string | null): Promise<TelehealthDayVisit> {
    if (!UUID.test(appointmentId)) throw new AdapterError("invalid", "A valid appointment id is required.");
    const bounds = dayBounds(date);
    const token = await getClinicalAccessToken(sessionToken);
    const exact = await telehealthLive.day(bounds.date, token, orgId);
    const direct = exact.visits.find((row) => row.appointmentId === appointmentId);
    if (direct) return direct;
    const center = Date.parse(bounds.from);
    const from = new Date(center - 14 * 86_400_000).toISOString();
    const to = new Date(center + 14 * 86_400_000).toISOString();
    const [calendar, boundary] = await Promise.all([
      scheduleLive.getCalendar(from, to, token, orgId),
      visitBoundary(token),
    ]);
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
  },

  async recordConsent(input: TelehealthConsentInput, sessionToken: string | null): Promise<TelehealthVisit> {
    const token = await getClinicalAccessToken(sessionToken);
    if (input.agreed !== true) throw new AdapterError("invalid", "The consent must be attested before it is recorded.");
    const body: Record<string, unknown> = {
      appointmentId: input.appointmentId,
      consentVersion: TELEHEALTH_CONSENT_VERSION,
      signerName: input.signerName,
      agreed: true,
    };
    if (input.requestId) body.requestId = input.requestId;
    if (input.patientLocation) body.patientLocation = input.patientLocation;
    return request<TelehealthVisit>("/clinical-core/workforce/appointments/visits/consent", token, { body });
  },

  async start(input: TelehealthStartInput, sessionToken: string | null): Promise<TelehealthStartResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const body: Record<string, unknown> = {
      appointmentId: input.appointmentId,
      start: input.start,
      end: input.end,
      timeZone: input.timeZone,
      hostDisplayName: input.hostDisplayName,
    };
    if (input.requestId) body.requestId = input.requestId;
    return request<TelehealthStartResult>("/clinical-core/workforce/appointments/visits/start", token, { body });
  },

  async end(input: TelehealthEndInput, sessionToken: string | null): Promise<TelehealthVisit> {
    const token = await getClinicalAccessToken(sessionToken);
    return request<TelehealthVisit>("/clinical-core/workforce/appointments/visits/end", token, {
      body: { appointmentId: input.appointmentId, expectedVersion: input.expectedVersion, flags: input.flags, quickNotes: input.quickNotes },
    });
  },

  async note(appointmentId: string, sessionToken: string | null): Promise<TelehealthVisit> {
    const token = await getClinicalAccessToken(sessionToken);
    if (!UUID.test(appointmentId)) throw new AdapterError("invalid", "A valid appointment id is required.");
    return request<TelehealthVisit>(
      `/clinical-core/workforce/appointments/visits/notes?appointmentId=${encodeURIComponent(appointmentId)}`,
      token,
    );
  },

  async importNote(appointmentId: string, sessionToken: string | null): Promise<TelehealthImportResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return request<TelehealthImportResult>("/clinical-core/workforce/appointments/visits/notes/import", token, {
      body: { appointmentId },
    });
  },

  async signNote(input: TelehealthSignInput, sessionToken: string | null): Promise<TelehealthVisit> {
    const token = await getClinicalAccessToken(sessionToken);
    return request<TelehealthVisit>("/clinical-core/workforce/appointments/visits/notes/sign", token, {
      body: {
        appointmentId: input.appointmentId,
        expectedVersion: input.expectedVersion,
        practitionerNotes: input.practitionerNotes,
        aiSections: input.aiSections,
        actionItems: input.actionItems,
      },
    });
  },
};
