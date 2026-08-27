import { beforeEach, describe, expect, test, vi } from "vitest";
import { scheduleLive } from "./schedule.live";

const TOKEN = "signed-practitioner-token";
const ORG_ID = "10000000-0000-4000-8000-000000000001";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  process.env.CLINICAL_CONTRACT_FIXTURE = "1";
  process.env.CLINICAL_SUPABASE_URL = "http://127.0.0.1:3999";
  process.env.CLINICAL_SUPABASE_ANON_KEY = "publishable-test-key";
  vi.restoreAllMocks();
});

describe("scheduleLive Desktop AWS clinical boundary", () => {
  test("maps the bounded calendar, practitioners, and scheduling-safe patients", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      appointments: [{
        id: "appointment-1",
        patient_id: "patient-1",
        patient_name: "Avery Morgan",
        practitioner_user_id: "user-1",
        practitioner_name: "Dr. Rivera",
        title: null,
        appointment_type: "follow-up",
        location: "Room 2",
        telehealth_url: null,
        status: "confirmed",
        version: 3,
        starts_at: "2026-09-07T16:00:00Z",
        ends_at: "2026-09-07T16:45:00Z",
      }],
      practitioners: [{
        user_id: "user-1",
        display_name: "Dr. Rivera",
        credentials: "ND",
        specialty: "Functional medicine",
      }],
      patients: [{ id: "patient-1", name: "Avery Morgan" }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(scheduleLive.getCalendar(
      "2026-09-07T00:00:00Z",
      "2026-09-14T00:00:00Z",
      TOKEN,
      ORG_ID,
    )).resolves.toEqual({
      appointments: [{
        id: "appointment-1",
        patientId: "patient-1",
        patientName: "Avery Morgan",
        practitionerUserId: "user-1",
        practitionerName: "Dr. Rivera",
        title: null,
        appointmentType: "follow-up",
        location: "Room 2",
        telehealthUrl: null,
        status: "confirmed",
        // The optimistic-concurrency token MUST survive the mapping: without it
        // the drawer sends a token it never rendered, and a transition either
        // clobbers a concurrent change or conflicts against nothing.
        version: 3,
        startsAt: "2026-09-07T16:00:00Z",
        endsAt: "2026-09-07T16:45:00Z",
      }],
      practitioners: [{
        userId: "user-1",
        displayName: "Dr. Rivera",
        credentials: "ND",
        specialty: "Functional medicine",
      }],
      patients: [{ id: "patient-1", name: "Avery Morgan" }],
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:3999/rest/v1/rpc/get_desktop_calendar",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      _organization_id: ORG_ID,
      _from: "2026-09-07T00:00:00Z",
      _to: "2026-09-14T00:00:00Z",
    });
  });

  test("books through the atomic appointment RPC", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      id: "appointment-2",
      status: "scheduled",
      starts_at: "2026-09-08T16:00:00Z",
      ends_at: "2026-09-08T16:45:00Z",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(scheduleLive.book({
      practitionerUserId: "user-1",
      appointmentType: "follow-up",
      startsAtIso: "2026-09-08T16:00:00Z",
      endsAtIso: "2026-09-08T16:45:00Z",
      patientId: "patient-1",
      location: "Room 3",
    }, TOKEN, ORG_ID)).resolves.toMatchObject({
      ok: true,
      id: "appointment-2",
      message: "Appointment booked.",
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:3999/rest/v1/rpc/book_appointment",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      _organization_id: ORG_ID,
      _practitioner_user_id: "user-1",
      _appointment_type: "follow-up",
      _starts_at: "2026-09-08T16:00:00Z",
      _ends_at: "2026-09-08T16:45:00Z",
      _patient_id: "patient-1",
      _location: "Room 3",
      _telehealth_url: null,
      _title: null,
    });
  });

  test("updates status with database idempotency fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      id: "appointment-2",
      status: "no_show",
      previous_status: "scheduled",
      already_set: false,
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      scheduleLive.updateStatus("appointment-2", "no_show", TOKEN),
    ).resolves.toEqual({
      ok: true,
      id: "appointment-2",
      status: "no_show",
      previousStatus: "scheduled",
      alreadySet: false,
      message: "Appointment no-show.",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      _appointment_id: "appointment-2",
      _status: "no_show",
    });
  });

  test("reschedules through the audited conflict-checked RPC", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      id: "appointment-2",
      status: "scheduled",
      starts_at: "2026-09-09T17:00:00Z",
      ends_at: "2026-09-09T17:45:00Z",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(scheduleLive.reschedule(
      "appointment-2",
      "2026-09-09T17:00:00Z",
      "2026-09-09T17:45:00Z",
      TOKEN,
    )).resolves.toEqual({
      ok: true,
      id: "appointment-2",
      status: "scheduled",
      startsAt: "2026-09-09T17:00:00Z",
      endsAt: "2026-09-09T17:45:00Z",
      message: "Appointment rescheduled.",
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:3999/rest/v1/rpc/reschedule_appointment",
    );
  });
});
