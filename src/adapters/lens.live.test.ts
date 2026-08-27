import { beforeEach, describe, expect, test, vi } from "vitest";
import { lensLive } from "./lens.live";

const TOKEN = "signed-practitioner-token";
const ENCOUNTER_ID = "30000000-0000-4000-8000-000000000001";
const QUESTION_ID = "90000000-0000-4000-8000-000000000001";
const NOTE_ID = "40000000-0000-4000-8000-000000000001";
const BLOCK_ID = "a0000000-0000-4000-8000-000000000001";

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

describe("lensLive Desktop AWS clinical boundary", () => {
  test("reads reference data through the bounded Desktop RPCs", async () => {
    const paradigm = {
      code: "western_conventional",
      name: "Western / conventional",
      description: "Guideline-oriented biomedical framing.",
      isComposite: false,
      composedOf: [],
    };
    const domain = { code: "sleep", version: 1, name: "Sleep", description: "Sleep quality." };
    const source = {
      id: "b0000000-0000-4000-8000-000000000001",
      code: "aasm_sleep_questions",
      revision: 1,
      citation: "AASM guideline.",
      publisher: null,
      releaseDate: null,
      revisionDate: null,
      intendedPurpose: null,
      intendedPopulation: null,
      requiredInputs: null,
      dataQualityExpectations: null,
      logicSummary: null,
      knownLimitations: null,
      outOfScopeUses: null,
      validationStatus: "validated",
      fundingConflicts: null,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([paradigm]))
      .mockResolvedValueOnce(response([domain]))
      .mockResolvedValueOnce(response([source]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(lensLive.paradigms(TOKEN)).resolves.toEqual([paradigm]);
    await expect(lensLive.domains(TOKEN)).resolves.toEqual([domain]);
    await expect(lensLive.knowledgeSources(TOKEN)).resolves.toEqual([source]);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:3999/rest/v1/rpc/list_desktop_lens_paradigms",
      "http://127.0.0.1:3999/rest/v1/rpc/list_desktop_lens_domains",
      "http://127.0.0.1:3999/rest/v1/rpc/list_desktop_lens_knowledge_sources",
    ]);
  });

  test("maps the bounded evaluation read, including the no-evaluation null", async () => {
    const evaluation = {
      evaluationId: "c0000000-0000-4000-8000-000000000001",
      paradigm: "western_conventional",
      status: "complete",
      invariantCore: { redFlags: [] },
      lensFraming: {},
      inputSnapshot: {},
      inputCutoffAt: "2026-07-29T00:00:00Z",
      ruleSetVersion: "lens-rules-v1",
      knowledgeVersions: [],
      model: null,
      provider: null,
      promptTemplateVersion: null,
      outputSchemaVersion: "lens-output-v1",
      outputSha256: "0".repeat(64),
      validationResult: null,
      stale: false,
      staleReason: null,
      createdAt: "2026-07-29T00:00:00Z",
      questions: [{ id: QUESTION_ID, status: "suggested" }],
      safetyBlocks: [],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(evaluation))
      .mockResolvedValueOnce(response(null));
    vi.stubGlobal("fetch", fetchMock);

    await expect(lensLive.evaluation({
      encounterId: ENCOUNTER_ID,
      paradigm: "western_conventional",
    }, TOKEN)).resolves.toMatchObject({
      evaluationId: evaluation.evaluationId,
      questions: [{ id: QUESTION_ID }],
    });
    await expect(lensLive.evaluation({
      encounterId: ENCOUNTER_ID,
      paradigm: "tcm",
    }, TOKEN)).resolves.toBeNull();

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:3999/rest/v1/rpc/get_desktop_lens_evaluation",
    );
    expect(requestBody(fetchMock)).toEqual({
      _encounter_id: ENCOUNTER_ID,
      _paradigm: "western_conventional",
    });
  });

  test("routes the question lifecycle to the caller-authorized database RPCs", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(response(1))
      .mockResolvedValueOnce(response(2))
      .mockResolvedValueOnce(response([{
        version: 1,
        value: { text: "Yes" },
        correctsVersion: null,
        correctionReason: null,
        answeredAt: "2026-07-29T00:00:00Z",
      }]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(lensLive.questionAction({
      questionId: QUESTION_ID,
      action: "asked",
    }, TOKEN)).resolves.toEqual({ ok: true });
    await expect(lensLive.dismiss({
      questionId: QUESTION_ID,
      feedbackKind: "not_relevant",
      comment: "duplicate of intake",
    }, TOKEN)).resolves.toEqual({ ok: true });
    await expect(lensLive.answer({
      questionId: QUESTION_ID,
      value: { text: "Yes" },
    }, TOKEN)).resolves.toEqual({ version: 1 });
    await expect(lensLive.correctAnswer({
      questionId: QUESTION_ID,
      value: { text: "No — misheard" },
      reason: "patient corrected",
    }, TOKEN)).resolves.toEqual({ version: 2 });
    await expect(lensLive.answers(QUESTION_ID, TOKEN)).resolves.toEqual([
      expect.objectContaining({ version: 1, correctsVersion: null }),
    ]);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:3999/rest/v1/rpc/set_question_status",
      "http://127.0.0.1:3999/rest/v1/rpc/dismiss_question",
      "http://127.0.0.1:3999/rest/v1/rpc/answer_question",
      "http://127.0.0.1:3999/rest/v1/rpc/correct_question_answer",
      "http://127.0.0.1:3999/rest/v1/rpc/list_desktop_question_answers",
    ]);
    expect(requestBody(fetchMock, 0)).toEqual({
      _question_id: QUESTION_ID,
      _to: "asked",
      _reason: null,
    });
    expect(requestBody(fetchMock, 1)).toEqual({
      _question_id: QUESTION_ID,
      _feedback_kind: "not_relevant",
      _comment: "duplicate of intake",
    });
    expect(requestBody(fetchMock, 3)).toEqual({
      _question_id: QUESTION_ID,
      _answer: { text: "No — misheard" },
      _reason: "patient corrected",
    });
  });

  test("routes note-use, feedback, and safety-block review directly and maps transitions to conflicts", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(response({ code: "40003", message: "invalid question transition" }, 409))
      .mockResolvedValueOnce(response({ code: "55000", message: "only an asked question can be answered" }, 409));
    vi.stubGlobal("fetch", fetchMock);

    await expect(lensLive.recordNoteUse({
      questionId: QUESTION_ID,
      noteId: NOTE_ID,
    }, TOKEN)).resolves.toEqual({ ok: true });
    await expect(lensLive.feedback({
      questionId: QUESTION_ID,
      kind: "helpful",
    }, TOKEN)).resolves.toEqual({ ok: true });
    await expect(lensLive.reviewSafetyBlock({
      blockId: BLOCK_ID,
      resolution: "Reviewed with the care team.",
    }, TOKEN)).resolves.toEqual({ ok: true });
    await expect(lensLive.questionAction({
      questionId: QUESTION_ID,
      action: "accepted",
    }, TOKEN)).rejects.toMatchObject({ code: "conflict" });
    await expect(lensLive.answer({
      questionId: QUESTION_ID,
      value: { text: "Too early" },
    }, TOKEN)).rejects.toMatchObject({ code: "conflict" });

    expect(fetchMock.mock.calls.map(([url]) => url).slice(0, 3)).toEqual([
      "http://127.0.0.1:3999/rest/v1/rpc/record_question_note_use",
      "http://127.0.0.1:3999/rest/v1/rpc/submit_question_feedback",
      "http://127.0.0.1:3999/rest/v1/rpc/review_safety_block",
    ]);
    expect(requestBody(fetchMock, 2)).toEqual({
      _block_id: BLOCK_ID,
      _resolution: "Reviewed with the care team.",
    });
  });

  test("keeps only the worker compute legs (aiStatus, evaluate) on the transitional transport", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        result: { data: { json: { mode: "fixture", available: true, liveConfigured: false, reason: null } } },
      }))
      .mockResolvedValueOnce(response({
        result: { data: { json: { evaluationId: "c0", status: "complete", questionsInserted: 3, questionsDeduped: 0 } } },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(lensLive.aiStatus(TOKEN)).resolves.toMatchObject({ mode: "fixture" });
    await expect(lensLive.evaluate({
      encounterId: ENCOUNTER_ID,
      paradigm: "western_conventional",
    }, TOKEN)).resolves.toMatchObject({ status: "complete" });

    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls[0]).toContain("/api/trpc/clinical.lens.aiStatus");
    expect(urls[1]).toContain("/api/trpc/clinical.lens.evaluate");
    expect(urls.every((u) => !u.includes("/rest/v1/"))).toBe(true);
  });
});
