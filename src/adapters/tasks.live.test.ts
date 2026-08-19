import { beforeEach, describe, expect, test, vi } from "vitest";
import { tasksLive } from "./tasks.live";

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

describe("tasksLive AWS clinical boundary", () => {
  test("maps the caller-scoped review queue", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response([{
      id: "queue-1",
      item_type: "lab_extraction",
      title: "Review extracted markers",
      priority: "high",
      status: "open",
      patient_id: "patient-1",
      patient_name: "Avery Morgan",
      assignee_name: "You",
      due_at: null,
      created_at: "2026-07-28T20:00:00Z",
    }]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(tasksLive.getQueue(TOKEN, ORG_ID)).resolves.toEqual([{
      id: "queue-1",
      itemType: "lab_extraction",
      title: "Review extracted markers",
      priority: "high",
      status: "open",
      patientId: "patient-1",
      patientName: "Avery Morgan",
      assigneeName: "You",
      dueAt: null,
      createdAt: "2026-07-28T20:00:00Z",
    }]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:3999/rest/v1/rpc/list_review_queue",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      _organization_id: ORG_ID,
    });
  });

  test("resolves queue items through the atomic idempotent RPC", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      id: "queue-1",
      status: "resolved",
      previous_status: "open",
      already_resolved: false,
      audit_event_id: "audit-1",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(tasksLive.resolveItem("queue-1", "Done", TOKEN)).resolves.toEqual({
      id: "queue-1",
      status: "resolved",
      previousStatus: "open",
      alreadyResolved: false,
      auditEventId: "audit-1",
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:3999/rest/v1/rpc/resolve_review_queue_item",
    );
  });

  test("refuses queue access without a practitioner session", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(tasksLive.getQueue(null, ORG_ID)).rejects.toMatchObject({
      code: "unauthenticated",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
