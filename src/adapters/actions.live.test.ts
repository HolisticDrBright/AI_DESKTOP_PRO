import { beforeEach, describe, expect, test, vi } from "vitest";
import { actionsLive } from "./actions.live";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  process.env.CLINICAL_SUPABASE_URL = "https://clinical.example.test";
  process.env.CLINICAL_SUPABASE_ANON_KEY = "publishable-test-key";
  vi.restoreAllMocks();
});

describe("actionsLive review-task boundary", () => {
  test("creates a review task through the audited Supabase RPC", async () => {
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
      "https://clinical.example.test/rest/v1/rpc/create_review_task",
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
