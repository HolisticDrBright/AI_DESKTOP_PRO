import { beforeEach, describe, expect, test, vi } from "vitest";
import { encountersLive } from "./encounters.live";

const TOKEN = "signed-practitioner-token";
const ORG_ID = "10000000-0000-4000-8000-000000000001";
const PATIENT_ID = "20000000-0000-4000-8000-000000000001";
const ENCOUNTER_ID = "30000000-0000-4000-8000-000000000001";
const NOTE_ID = "40000000-0000-4000-8000-000000000001";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>, index = 0) {
  return JSON.parse(String(fetchMock.mock.calls[index]?.[1]?.body));
}

beforeEach(() => {
  process.env.CLINICAL_CONTRACT_FIXTURE = "1";
  process.env.CLINICAL_SUPABASE_URL = "http://127.0.0.1:3999";
  process.env.CLINICAL_SUPABASE_ANON_KEY = "publishable-test-key";
  vi.restoreAllMocks();
});

describe("encountersLive Desktop AWS clinical boundary", () => {
  test("starts and transitions an encounter through the audited database state machine", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(ENCOUNTER_ID))
      .mockResolvedValueOnce(response(null));
    vi.stubGlobal("fetch", fetchMock);

    await expect(encountersLive.start({
      patientId: PATIENT_ID,
      visitType: "follow-up",
      appointmentId: "50000000-0000-4000-8000-000000000001",
    }, TOKEN, ORG_ID)).resolves.toEqual({ encounterId: ENCOUNTER_ID });
    await expect(encountersLive.setStatus({
      encounterId: ENCOUNTER_ID,
      status: "completed",
    }, TOKEN)).resolves.toEqual({ ok: true });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:3999/rest/v1/rpc/start_encounter",
    );
    expect(requestBody(fetchMock)).toEqual({
      _organization_id: ORG_ID,
      _patient_id: PATIENT_ID,
      _visit_type: "follow-up",
      _appointment_id: "50000000-0000-4000-8000-000000000001",
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "http://127.0.0.1:3999/rest/v1/rpc/set_encounter_status",
    );
  });

  test("maps the bounded encounter workspace and patient encounter list", async () => {
    const encounter = {
      encounter_id: ENCOUNTER_ID,
      organization_id: ORG_ID,
      patient_id: PATIENT_ID,
      appointment_id: null,
      visit_type: "initial",
      status: "in_progress",
      started_at: "2026-07-29T00:00:00Z",
      ended_at: null,
      status_reason: null,
      created_at: "2026-07-29T00:00:00Z",
    };
    const note = {
      note_id: NOTE_ID,
      encounter_id: ENCOUNTER_ID,
      patient_id: PATIENT_ID,
      note_type: "soap",
      status: "draft",
      current_version: 2,
      author_user_id: "60000000-0000-4000-8000-000000000001",
      status_reason: null,
      created_at: "2026-07-29T00:01:00Z",
      updated_at: "2026-07-29T00:02:00Z",
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ encounter, notes: [note] }))
      .mockResolvedValueOnce(response([encounter]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(encountersLive.get(ENCOUNTER_ID, TOKEN)).resolves.toMatchObject({
      encounter: {
        encounterId: ENCOUNTER_ID,
        patientId: PATIENT_ID,
        visitType: "initial",
      },
      notes: [{ noteId: NOTE_ID, currentVersion: 2 }],
    });
    await expect(encountersLive.forPatient(PATIENT_ID, TOKEN)).resolves.toEqual([
      expect.objectContaining({ encounterId: ENCOUNTER_ID }),
    ]);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:3999/rest/v1/rpc/get_desktop_encounter",
    );
    expect(requestBody(fetchMock, 1)).toEqual({
      _patient_id: PATIENT_ID,
      _limit: 100,
    });
  });

  test("saves a versioned note with explicit provenance and maps authoritative detail", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        note_id: NOTE_ID,
        version: 1,
        saved_at: "2026-07-29T00:05:00Z",
      }))
      .mockResolvedValueOnce(response({
        note: {
          note_id: NOTE_ID,
          encounter_id: ENCOUNTER_ID,
          patient_id: PATIENT_ID,
          note_type: "soap",
          status: "signed",
          current_version: 1,
          author_user_id: "60000000-0000-4000-8000-000000000001",
          status_reason: null,
          created_at: "2026-07-29T00:04:00Z",
          updated_at: "2026-07-29T00:06:00Z",
        },
        content: { S: "Fatigue", O: "", A: "", P: "" },
        content_version: 1,
        last_saved_at: "2026-07-29T00:05:00Z",
        signature: {
          signature_id: "70000000-0000-4000-8000-000000000001",
          version: 1,
          signed_by: "60000000-0000-4000-8000-000000000001",
          signed_at: "2026-07-29T00:06:00Z",
          attestation: "I attest this note is accurate and complete.",
        },
        addenda: [],
        provenance: [{
          section_key: "S",
          ref_type: "practitioner_entered",
          ref_id: null,
          label: "Practitioner-entered history",
        }],
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(encountersLive.saveNote({
      encounterId: ENCOUNTER_ID,
      noteType: "soap",
      content: { S: "Fatigue", O: "", A: "", P: "" },
      expectedVersion: 0,
      saveKind: "manual",
      provenance: [{
        sectionKey: "S",
        refType: "practitioner_entered",
        label: "Practitioner-entered history",
      }],
    }, TOKEN, ORG_ID)).resolves.toEqual({
      noteId: NOTE_ID,
      version: 1,
      savedAt: "2026-07-29T00:05:00Z",
    });
    await expect(encountersLive.getNote(NOTE_ID, TOKEN)).resolves.toMatchObject({
      note: { noteId: NOTE_ID, status: "signed" },
      signature: {
        signatureId: "70000000-0000-4000-8000-000000000001",
        version: 1,
      },
      provenance: [{ sectionKey: "S", refType: "practitioner_entered" }],
    });

    expect(requestBody(fetchMock)).toMatchObject({
      _organization_id: ORG_ID,
      _encounter_id: ENCOUNTER_ID,
      _expected_version: 0,
      _note_id: null,
      _save_kind: "manual",
    });
  });

  test("routes review, sign, addendum, and entered-in-error actions directly", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(response({
        signature_id: "70000000-0000-4000-8000-000000000001",
        already_signed: false,
        version: 3,
        signed_at: "2026-07-29T00:10:00Z",
      }))
      .mockResolvedValueOnce(response("80000000-0000-4000-8000-000000000001"))
      .mockResolvedValueOnce(response(null));
    vi.stubGlobal("fetch", fetchMock);

    await expect(encountersLive.markNoteReady(NOTE_ID, TOKEN)).resolves.toEqual({ ok: true });
    await expect(encountersLive.signNote({
      noteId: NOTE_ID,
      expectedVersion: 3,
    }, TOKEN)).resolves.toMatchObject({
      alreadySigned: false,
      version: 3,
    });
    await expect(encountersLive.addAddendum({
      noteId: NOTE_ID,
      reason: "Correction",
      content: "Corrected value.",
    }, TOKEN)).resolves.toEqual({
      addendumId: "80000000-0000-4000-8000-000000000001",
    });
    await expect(encountersLive.markNoteError({
      noteId: NOTE_ID,
      reason: "Wrong chart",
    }, TOKEN)).resolves.toEqual({ ok: true });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:3999/rest/v1/rpc/mark_note_ready",
      "http://127.0.0.1:3999/rest/v1/rpc/sign_note",
      "http://127.0.0.1:3999/rest/v1/rpc/add_note_addendum",
      "http://127.0.0.1:3999/rest/v1/rpc/mark_note_error",
    ]);
  });

  test("maps the bounded clinical timeline and preserves database conflicts", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([{
        event_at: "2026-07-29T00:00:00Z",
        event_type: "encounter.started",
        title: "Encounter started (follow-up)",
        ref_type: "encounter",
        ref_id: ENCOUNTER_ID,
        detail: { status: "in_progress" },
      }]))
      .mockResolvedValueOnce(response({ code: "40001", message: "version conflict" }, 409));
    vi.stubGlobal("fetch", fetchMock);

    await expect(encountersLive.timeline(PATIENT_ID, TOKEN)).resolves.toEqual([{
      eventAt: "2026-07-29T00:00:00Z",
      eventType: "encounter.started",
      title: "Encounter started (follow-up)",
      refType: "encounter",
      refId: ENCOUNTER_ID,
      detail: { status: "in_progress" },
    }]);
    await expect(encountersLive.saveNote({
      encounterId: ENCOUNTER_ID,
      noteType: "soap",
      content: { S: "Local edit" },
      expectedVersion: 1,
      noteId: NOTE_ID,
      saveKind: "manual",
      provenance: [],
    }, TOKEN, ORG_ID)).rejects.toMatchObject({ code: "conflict" });
  });
});
