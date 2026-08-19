import { beforeEach, describe, expect, test, vi } from "vitest";
import { actionsLive } from "./actions.live";

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

describe("actionsLive Desktop AWS clinical boundary", () => {
  test("records only the registered event payload through the audit RPC", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response("audit-3"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(actionsLive.recordAudit({
      organizationId: "org-1",
      eventType: "report.exported",
      resourceId: "report-1",
      metadata: { format: "pdf", report_type: "labs" },
    }, "signed-token")).resolves.toEqual({ id: "audit-3" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:3999/rest/v1/rpc/record_registered_audit_event",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      _organization_id: "org-1",
      _event_type: "report.exported",
      _resource_id: "report-1",
      _patient_id: null,
      _metadata: { format: "pdf", report_type: "labs" },
    });
  });

  test("reads and maps audit rows through the caller-authorized audit RPC", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response([{
      id: "audit-4",
      action: "marker.view",
      resource_type: "biomarker_observation",
      resource_id: "marker-1",
      safe_message: "Marker viewed",
      patient_id: "patient-1",
      actor_user_id: "user-1",
      occurred_at: "2026-07-28T20:00:00.000Z",
      metadata: null,
    }]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(actionsLive.listAuditEvents(
      "org-1",
      500,
      "signed-token",
    )).resolves.toEqual([{
      id: "audit-4",
      action: "marker.view",
      resourceType: "biomarker_observation",
      resourceId: "marker-1",
      safeMessage: "Marker viewed",
      patientId: "patient-1",
      actorUserId: "user-1",
      occurredAt: "2026-07-28T20:00:00.000Z",
      metadata: {},
    }]);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:3999/rest/v1/rpc/list_audit_events",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      _organization_id: "org-1",
      _limit: 200,
    });
  });

  test("creates a review task through the audited contract RPC", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      id: "queue-2",
      status: "open",
      audit_event_id: "audit-2",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(actionsLive.createReviewTask({
      patientId: "patient-1",
      title: "Review marker",
      itemType: "abnormal_result",
      priority: "high",
      refId: "marker-1",
    }, "signed-token")).resolves.toEqual({
      ok: true,
      id: "queue-2",
      status: "open",
      message: "Review task created.",
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:3999/rest/v1/rpc/create_review_task",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      _patient_id: "patient-1",
      _title: "Review marker",
      _item_type: "abnormal_result",
      _priority: "high",
      _ref_id: "marker-1",
    });
  });
});
