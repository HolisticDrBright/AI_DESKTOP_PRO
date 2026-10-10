import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The telehealth day merge and the appointment resolution every visit action
 * goes through. The properties under test are honesty when one of the two
 * sources is missing — a calendar row must still render, and a consent the
 * boundary could not read must be reported as unknown, never as unsigned —
 * and that the boundary is only ever called with an appointment the
 * practitioner's own calendar access returned, with that appointment's
 * stored times, in the viewer's time zone.
 */

const { getCalendar } = vi.hoisted(() => ({ getCalendar: vi.fn() }));

vi.mock("./schedule.live", () => ({ scheduleLive: { getCalendar } }));
vi.mock("./session.server", () => ({ getClinicalAccessToken: async (token: string | null) => token ?? "fixture-token" }));
vi.mock("@/server/runtime/contractFixture", () => ({
  getContractFixtureTransport: () => ({ origin: "http://127.0.0.1:3999", credential: "stub" }),
}));

import { dayBounds, telehealthLive } from "./telehealth.live";
import { AdapterError } from "./errors";

const APPT = "abababab-1111-2222-3333-444444444408";
const LA = "America/Los_Angeles";
const calendar = {
  practitioners: [],
  patients: [],
  appointments: [
    { id: APPT, patientId: "p1", patientName: "Fixture Patient", practitionerUserId: "u1", practitionerName: "Demo Practitioner",
      title: null, appointmentType: "telehealth", location: "Telehealth", telehealthUrl: null, status: "confirmed",
      startsAt: "2026-10-11T18:00:00.000Z", endsAt: "2026-10-11T18:30:00.000Z", version: 1 },
    { id: "abababab-1111-2222-3333-444444444402", patientId: null, patientName: null, practitionerUserId: "u1", practitionerName: "Demo Practitioner",
      title: "Admin block", appointmentType: "break", location: "Admin", telehealthUrl: null, status: "scheduled",
      startsAt: "2026-10-11T19:00:00.000Z", endsAt: "2026-10-11T20:00:00.000Z", version: 1 },
  ],
};
const visitRow = { appointmentId: APPT, organizationId: "org", requestId: null, consumerPersonId: null, scheduledStart: null, scheduledEnd: null, timeZone: null, status: "scheduled",
  consents: [{ consentId: "c1", method: "staff_attested", status: "granted" }], consentSigned: true, providerMeetingId: null, joinUrl: null, startedAt: null, endedAt: null,
  providerShutdown: { status: "not_started", attemptedAt: null, confirmedAt: null, detail: null }, flags: [], quickNotes: "", note: null, noteHistory: [], version: 2, createdAt: "", updatedAt: "" };

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

describe("dayBounds", () => {
  it("computes a calendar day in the viewer's zone, not the process zone", () => {
    const la = dayBounds("2026-10-11", LA);
    expect(la).toEqual({ date: "2026-10-11", timeZone: LA, from: "2026-10-11T07:00:00.000Z", to: "2026-10-12T07:00:00.000Z" });
    const utc = dayBounds("2026-10-11", "UTC");
    expect(utc.from).toBe("2026-10-11T00:00:00.000Z");
    const tokyo = dayBounds("2026-10-11", "Asia/Tokyo");
    expect(tokyo.from).toBe("2026-10-10T15:00:00.000Z");
  });

  it("keeps DST transition days 23 or 25 hours long instead of shifting their boundaries", () => {
    const fallBack = dayBounds("2026-11-01", LA); // PDT → PST
    expect(fallBack.from).toBe("2026-11-01T07:00:00.000Z");
    expect(fallBack.to).toBe("2026-11-02T08:00:00.000Z");
    expect((Date.parse(fallBack.to) - Date.parse(fallBack.from)) / 3_600_000).toBe(25);
    const springForward = dayBounds("2026-03-08", LA); // PST → PDT
    expect((Date.parse(springForward.to) - Date.parse(springForward.from)) / 3_600_000).toBe(23);
  });

  it("refuses impossible dates and unknown zones instead of normalising them", () => {
    expect(() => dayBounds("2026-02-31", LA)).toThrow(AdapterError);
    expect(() => dayBounds("2026-13-01", LA)).toThrow(AdapterError);
    expect(() => dayBounds("2026-10-11", "Mars/Olympus")).toThrow(AdapterError);
    expect(() => dayBounds("yesterday", LA)).toThrow(AdapterError);
  });
});

describe("telehealthLive.day", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    getCalendar.mockReset();
    getCalendar.mockResolvedValue(calendar);
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps only telehealth appointments, attaches the boundary's visit record, and asks the calendar for the zoned day", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/visits") ? jsonResponse(200, { data: { visits: [visitRow], complete: true } }) : jsonResponse(200, { data: [] }),
    );
    const day = await telehealthLive.day("2026-10-11", LA, null, "org-fixture");
    expect(day.visitService).toEqual({ available: true, complete: true });
    expect(day.visits.map((row) => row.appointmentId)).toEqual([APPT]);
    expect(day.visits[0].visit?.consentSigned).toBe(true);
    expect(day.visits[0].source).toBe("clinical_calendar");
    const [from, to] = getCalendar.mock.calls[0] as [string, string];
    expect({ from, to }).toEqual({ from: "2026-10-11T07:00:00.000Z", to: "2026-10-12T07:00:00.000Z" });
  });

  it("reports the boundary as unavailable and still renders the calendar rows — consent is unknown, not unsigned", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const day = await telehealthLive.day("2026-10-11", LA, null, "org-fixture");
    expect(day.visitService.available).toBe(false);
    expect(day.visits).toHaveLength(1);
    expect(day.visits[0].visit).toBeNull();
  });

  it("surfaces an incomplete boundary list instead of presenting a truncated one as whole", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/visits") ? jsonResponse(200, { data: { visits: [], complete: false } }) : jsonResponse(200, { data: [] }),
    );
    const day = await telehealthLive.day("2026-10-11", LA, null, "org-fixture");
    expect(day.visitService).toEqual({ available: true, complete: false });
  });

  it("adds scheduled patient-app requests for the day without inventing a patient name", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/requests")
        ? jsonResponse(200, { data: [
            { requestId: "11111111-1111-4111-8111-111111111111", appointmentId: "22222222-2222-4222-8222-222222222222", consumerPersonId: "person", status: "scheduled", scheduledStart: "2026-10-11T20:00:00.000Z", scheduledEnd: "2026-10-11T20:45:00.000Z" },
            { requestId: "33333333-3333-4333-8333-333333333333", appointmentId: "44444444-4444-4444-8444-444444444444", consumerPersonId: "person", status: "cancelled", scheduledStart: "2026-10-11T21:00:00.000Z", scheduledEnd: "2026-10-11T21:45:00.000Z" },
          ] })
        : jsonResponse(200, { data: { visits: [], complete: true } }),
    );
    const day = await telehealthLive.day("2026-10-11", LA, null, "org-fixture");
    expect(day.visits).toHaveLength(2);
    const fromApp = day.visits.find((row) => row.source === "patient_app");
    expect(fromApp).toMatchObject({ patientName: null, patientId: null, requestId: "11111111-1111-4111-8111-111111111111", appointmentStatus: "confirmed" });
  });
});

describe("telehealthLive visit actions", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    getCalendar.mockReset();
    getCalendar.mockResolvedValue(calendar);
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const boundaryOk = (onStart?: (body: Record<string, unknown>) => void) =>
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/visits")) return jsonResponse(200, { data: { visits: [visitRow], complete: true } });
      if (url.endsWith("/requests")) return jsonResponse(200, { data: [] });
      if (url.endsWith("/visits/start")) {
        onStart?.(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return jsonResponse(200, { data: { visit: visitRow, session: { meetingNumber: "1", passcode: "", signature: "s", sdkKey: "k", zak: "z", hostDisplayName: "Dr", expiresAt: "" } } });
      }
      return jsonResponse(404, { error: "not_found" });
    });

  it("starts only an appointment the calendar returned, sending the calendar's stored times rather than any caller value", async () => {
    let sent: Record<string, unknown> | null = null;
    boundaryOk((body) => { sent = body; });
    await telehealthLive.start({ appointmentId: APPT, date: "2026-10-11", timeZone: LA }, null, "org-fixture");
    expect(sent).toEqual({ appointmentId: APPT, start: "2026-10-11T18:00:00.000Z", end: "2026-10-11T18:30:00.000Z", timeZone: LA, hostDisplayName: "Demo Practitioner" });
  });

  it("refuses a nonexistent or invisible appointment before the boundary is called", async () => {
    boundaryOk();
    const error = await telehealthLive
      .start({ appointmentId: "99999999-9999-4999-8999-999999999999", date: "2026-10-11", timeZone: LA }, null, "org-fixture")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).code).toBe("not_found");
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/visits/start"))).toBe(false);
  });

  it("refuses to start or consent a cancelled appointment", async () => {
    getCalendar.mockResolvedValue({ ...calendar, appointments: [{ ...calendar.appointments[0], status: "cancelled" }] });
    boundaryOk();
    const error = await telehealthLive.start({ appointmentId: APPT, date: "2026-10-11", timeZone: LA }, null, "org-fixture").catch((e: unknown) => e);
    expect((error as AdapterError).code).toBe("conflict");
    expect((error as AdapterError).message).toMatch(/cancelled/);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/visits/start"))).toBe(false);
  });

  it("maps the boundary's consent refusals to clinician-safe conflicts", async () => {
    for (const [serverError, pattern] of [
      ["consent_required", /no current telehealth consent/],
      ["consent_withdrawn", /withdrew/],
      ["consent_superseded", /superseded/],
      ["consent_artifact_unavailable", /no approved telehealth and recording consent/],
    ] as const) {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.endsWith("/visits")) return jsonResponse(200, { data: { visits: [visitRow], complete: true } });
        if (url.endsWith("/requests")) return jsonResponse(200, { data: [] });
        return jsonResponse(409, { error: serverError });
      });
      const error = await telehealthLive.start({ appointmentId: APPT, date: "2026-10-11", timeZone: LA }, null, "org-fixture").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AdapterError);
      expect((error as AdapterError).code).toBe("conflict");
      expect((error as AdapterError).message).toMatch(pattern);
    }
  });
});
