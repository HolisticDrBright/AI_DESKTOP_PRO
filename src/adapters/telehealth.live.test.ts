import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The telehealth day merge: calendar rows of type `telehealth` joined with
 * the AWS visit boundary. The property under test is honesty when one of the
 * two sources is missing — a calendar row must still render, and a consent
 * the boundary could not read must be reported as unknown, never as unsigned.
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

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

describe("telehealthLive.day", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    getCalendar.mockReset();
    getCalendar.mockResolvedValue(calendar);
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps only telehealth appointments and attaches the boundary's visit record", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/visits")
        ? jsonResponse(200, { data: [{ appointmentId: APPT, organizationId: "org", requestId: null, status: "scheduled", consents: [{ consentId: "c1", method: "staff_attested" }], consentSigned: true, providerMeetingId: null, joinUrl: null, startedAt: null, endedAt: null, flags: [], quickNotes: "", note: null, version: 2, createdAt: "", updatedAt: "" }] })
        : jsonResponse(200, { data: [] }),
    );
    const day = await telehealthLive.day("2026-10-11", null, "org-fixture");
    expect(day.visitService).toEqual({ available: true });
    expect(day.visits.map((row) => row.appointmentId)).toEqual([APPT]);
    expect(day.visits[0].visit?.consentSigned).toBe(true);
    expect(day.visits[0].source).toBe("clinical_calendar");
    const [from, to] = getCalendar.mock.calls[0] as [string, string];
    expect(dayBounds("2026-10-11")).toMatchObject({ from, to, date: "2026-10-11" });
  });

  it("reports the boundary as unavailable and still renders the calendar rows — consent is unknown, not unsigned", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const day = await telehealthLive.day("2026-10-11", null, "org-fixture");
    expect(day.visitService.available).toBe(false);
    expect(day.visits).toHaveLength(1);
    expect(day.visits[0].visit).toBeNull();
  });

  it("adds scheduled patient-app requests for the day without inventing a patient name", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/requests")
        ? jsonResponse(200, { data: [
            { requestId: "11111111-1111-4111-8111-111111111111", appointmentId: "22222222-2222-4222-8222-222222222222", consumerPersonId: "person", status: "scheduled", scheduledStart: "2026-10-11T20:00:00.000Z", scheduledEnd: "2026-10-11T20:45:00.000Z" },
            { requestId: "33333333-3333-4333-8333-333333333333", appointmentId: "44444444-4444-4444-8444-444444444444", consumerPersonId: "person", status: "cancelled", scheduledStart: "2026-10-11T21:00:00.000Z", scheduledEnd: "2026-10-11T21:45:00.000Z" },
          ] })
        : jsonResponse(200, { data: [] }),
    );
    const day = await telehealthLive.day("2026-10-11", null, "org-fixture");
    expect(day.visits).toHaveLength(2);
    const fromApp = day.visits.find((row) => row.source === "patient_app");
    expect(fromApp).toMatchObject({ patientName: null, patientId: null, requestId: "11111111-1111-4111-8111-111111111111", appointmentStatus: "confirmed" });
  });

  it("maps the boundary's consent refusal to a clinician-safe conflict", async () => {
    fetchMock.mockResolvedValue(jsonResponse(409, { error: "consent_required" }));
    const error = await telehealthLive
      .start({ appointmentId: APPT, start: "2026-10-11T18:00:00.000Z", end: "2026-10-11T18:30:00.000Z", timeZone: "America/Los_Angeles", hostDisplayName: "Dr" }, null)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).code).toBe("conflict");
    expect((error as AdapterError).message).toMatch(/no signed telehealth consent/);
  });
});
