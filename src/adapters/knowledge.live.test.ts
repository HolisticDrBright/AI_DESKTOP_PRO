import { beforeEach, describe, expect, test, vi } from "vitest";
import { knowledgeLive } from "./knowledge.live";

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

describe("knowledgeLive AWS clinical boundary", () => {
  test("loads and maps organization-scoped pathway versions under the caller token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response([{
      id: "pathway-1",
      organization_id: ORG_ID,
      code: "thyroid",
      name: "Thyroid classification",
      domain_code: "endocrine",
      description: "Governed pathway",
      retired_at: null,
      clinical_pathway_versions: [{
        id: "version-2",
        version: 2,
        status: "approved",
        content: {
          differentiatingQuestions: ["Antibodies documented?"],
          labStrategy: [],
          productCandidates: [],
          safetyStops: ["Urgent symptoms"],
        },
        source_refs: [{ label: "Practice source" }],
        change_summary: "Reviewed",
        created_at: "2026-07-28T00:00:00Z",
        approved_at: "2026-07-28T01:00:00Z",
      }],
    }]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await knowledgeLive.pathways(ORG_ID, TOKEN);

    expect(result[0]).toMatchObject({
      id: "pathway-1",
      code: "thyroid",
      domain: "endocrine",
      versions: [{ id: "version-2", status: "approved", sourceRefs: ["Practice source"] }],
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/rest/v1/clinical_pathways?");
    expect(decodeURIComponent(url)).toContain(`organization_id=eq.${ORG_ID}`);
    expect(init.headers).toMatchObject({
      apikey: "publishable-test-key",
      Authorization: `Bearer ${TOKEN}`,
    });
  });

  test("stages imports through the exact RLS-scoped database RPC", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({ batchId: "batch-1", itemCount: 1 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await knowledgeLive.stageImport(ORG_ID, {
      sourceName: "Authoring pack",
      sourceRevision: "v1",
      schemaVersion: "clinical-knowledge-import-v1",
      items: [{
        entityType: "pathway",
        externalKey: "thyroid",
        displayName: "Thyroid",
        warnings: [],
        payload: { code: "thyroid" },
      }],
      attestsNoPhi: true,
    }, TOKEN);

    expect(result).toEqual({ batchId: "batch-1", itemCount: 1 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "http://127.0.0.1:3999/rest/v1/rpc/stage_clinical_knowledge_import",
    );
    expect(JSON.parse(String(init.body))).toMatchObject({
      _organization_id: ORG_ID,
      _source_name: "Authoring pack",
      _attests_no_phi: true,
    });
  });

  test("import history omits immutable source payloads from list queries", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([{
        id: "batch-1",
        source_name: "Authoring pack",
        source_revision: "v1",
        schema_version: "clinical-knowledge-import-v1",
        source_sha256: "a".repeat(64),
        status: "in_review",
        item_count: 1,
        no_phi_attested_at: "2026-07-28T00:00:00Z",
        created_at: "2026-07-28T00:00:00Z",
        completed_at: null,
      }]))
      .mockResolvedValueOnce(response([{
        id: "item-1",
        batch_id: "batch-1",
        entity_type: "pathway",
        external_key: "thyroid",
        display_name: "Thyroid",
        source_sheet: "Conditions",
        payload_sha256: "b".repeat(64),
        warnings: [],
        validation_errors: [],
        status: "needs_review",
        review_note: null,
        reviewed_at: null,
        applied_ref_type: null,
        applied_ref_id: null,
        created_at: "2026-07-28T00:00:00Z",
      }]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await knowledgeLive.imports(ORG_ID, TOKEN);

    expect(result[0]?.items[0]).not.toHaveProperty("payload");
    const itemUrl = new URL(fetchMock.mock.calls[1]?.[0] as string);
    expect(itemUrl.searchParams.get("select")?.split(",")).not.toContain("payload");
  });

  test("normalizes database state conflicts without exposing server text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      response({ code: "55000", message: "sensitive internal detail" }, 400),
    ));

    await expect(
      knowledgeLive.approve(ORG_ID, "version-1", TOKEN),
    ).rejects.toMatchObject({
      code: "conflict",
      message: expect.not.stringContaining("sensitive internal detail"),
    });
  });

  test("refuses database access without a signed-in practitioner token", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(knowledgeLive.pathways(ORG_ID, null)).rejects.toMatchObject({
      code: "unauthenticated",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
