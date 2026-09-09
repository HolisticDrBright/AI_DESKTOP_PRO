import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
const mock = vi.hoisted(() => ({ db: vi.fn(), s3: vi.fn(), sfn: vi.fn() }));
vi.mock("@aws-sdk/lib-dynamodb", () => {
  class Command { constructor(public input: Record<string, unknown>) {} }
  return { DynamoDBDocumentClient: { from: () => ({ send: mock.db }) },
    GetCommand: class extends Command {}, PutCommand: class extends Command {}, UpdateCommand: class extends Command {}, DeleteCommand: class extends Command {} };
});
vi.mock("@aws-sdk/client-s3", () => {
  class Command { constructor(public input: Record<string, unknown>) {} }
  return { S3Client: class { send = mock.s3; }, GetObjectCommand: class extends Command {}, PutObjectCommand: class extends Command {},
    HeadObjectCommand: class extends Command {}, DeleteObjectsCommand: class extends Command {}, ListObjectVersionsCommand: class extends Command {} };
});
vi.mock("@aws-sdk/client-sfn", () => ({ SFNClient: class { send = mock.sfn; }, StartExecutionCommand: class { constructor(public input: Record<string, unknown>) {} } }));
import { createAwsLabAnalysisApiHandler } from "./aws-lab-analysis-api";
import { createAwsLabAnalysisWorker } from "./aws-lab-analysis-worker";
const sub = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
function event(method: string, path: string, body?: unknown) {
  return { rawPath: `/clinical-core/consumer/labs/${path}`, ...(body ? { body: JSON.stringify(body) } : {}),
    requestContext: { http: { method }, authorizer: { jwt: { claims: { sub, "custom:person_id": sub, "custom:organization_id": sub, "custom:synthetic_attested": "true" } } } } };
}
const job = () => ({ pk: `job#${jobId}`, ownerSub: sub, organizationId: sub, personId: sub, state: "queued", passesCompleted: 0, documents: [], structuredBiomarkers: [] });
beforeEach(() => {
  vi.clearAllMocks(); mock.db.mockResolvedValue({}); mock.s3.mockResolvedValue({}); mock.sfn.mockResolvedValue({});
  vi.stubEnv("LAB_JOB_TABLE", "fictional-lab-jobs"); vi.stubEnv("LAB_DOCUMENT_BUCKET", "fictional-lab-documents");
  vi.stubEnv("LAB_KMS_KEY_ARN", "fictional-key"); vi.stubEnv("LAB_STATE_MACHINE_ARN", "fictional-machine"); vi.stubEnv("LAB_RANGE_MODE", "synthetic_fixture");
});
afterEach(() => vi.unstubAllEnvs());

describe("durable lab job lifecycle", () => {
  test("a misspelled reviewed range mode cannot fall back to synthetic ranges", async () => {
    vi.stubEnv("LAB_RANGE_MODE", "reviewed_releas");
    const response = await createAwsLabAnalysisApiHandler(event("POST", "plan-jobs", {
      panelId: "fixture-panel", panelName: "Fictional panel", testDate: "2026-09-01", dataClassification: "synthetic_only", attestsSyntheticOnly: true,
      biomarkers: [{ markerId: "fixture", canonicalName: "Fictional marker", value: 10, unit: "widgets", labMin: 1, labMax: 20 }],
    }));
    expect(response.statusCode).toBe(400);
    expect(mock.db).not.toHaveBeenCalled();
    expect(mock.sfn).not.toHaveBeenCalled();
  });
  test("queue failure still returns the durable ID and polling retries the identical execution", async () => {
    let persisted: Record<string, unknown> = {};
    mock.db.mockImplementation(async command => {
      if (command.constructor.name === "PutCommand") persisted = command.input.Item;
      return command.constructor.name === "GetCommand" ? { Item: persisted } : {};
    });
    mock.sfn.mockRejectedValueOnce(new Error("private infrastructure error")).mockResolvedValue({});
    const created = await createAwsLabAnalysisApiHandler(event("POST", "plan-jobs", {
      panelId: "fixture-panel", panelName: "Fictional panel", testDate: "2026-09-01", dataClassification: "synthetic_only", attestsSyntheticOnly: true,
      biomarkers: [{ markerId: "fixture", canonicalName: "Fictional marker", value: 10, unit: "widgets", labMin: 1, labMax: 20 }],
    }));
    expect(created.statusCode).toBe(200);
    const id = JSON.parse(created.body).data.jobId;
    expect((await createAwsLabAnalysisApiHandler(event("GET", `jobs/${id}`))).statusCode).toBe(200);
    expect(mock.sfn.mock.calls[1][0].input).toEqual(mock.sfn.mock.calls[0][0].input);
    expect(mock.db.mock.calls.filter(([command]) => command.constructor.name === "PutCommand")).toHaveLength(1);
  });
  test("cross-user polling cannot retry another person's job", async () => {
    mock.db.mockResolvedValue({ Item: { ...job(), ownerSub: jobId } });
    expect((await createAwsLabAnalysisApiHandler(event("GET", `jobs/${jobId}`))).statusCode).toBe(404);
    expect(mock.sfn).not.toHaveBeenCalled();
  });
  test("partial object deletion cannot remove the job or report success", async () => {
    mock.db.mockResolvedValue({ Item: { ...job(), state: "completed" } });
    mock.s3.mockImplementation(async command => command.constructor.name === "ListObjectVersionsCommand"
      ? { Versions: [{ Key: "fictional-key", VersionId: "fixture-version" }] } : { Errors: [{ Code: "AccessDenied" }] });
    const result = await createAwsLabAnalysisApiHandler(event("DELETE", `jobs/${jobId}`));
    expect(result.statusCode).toBe(400); expect(result.body).not.toContain('"deleted":true');
    expect(mock.db.mock.calls.some(([command]) => command.constructor.name === "DeleteCommand")).toBe(false);
  });
  test("completed worker passes are idempotent and cannot downgrade the result", async () => {
    mock.db.mockResolvedValue({ Item: { ...job(), state: "completed", passesCompleted: 5 } });
    expect(await createAwsLabAnalysisWorker({ jobId, pass: 4 })).toMatchObject({ completed: true });
    expect(mock.db).toHaveBeenCalledOnce(); expect(mock.s3).not.toHaveBeenCalled();
  });
  test("a later pass cannot jump ahead of extraction", async () => {
    mock.db.mockResolvedValue({ Item: job() });
    await expect(createAwsLabAnalysisWorker({ jobId, pass: 3 })).rejects.toThrow("job_pass_order_invalid");
    expect(mock.s3).not.toHaveBeenCalled();
  });
  test("late failure callbacks cannot recreate deleted jobs or overwrite completion", async () => {
    mock.db.mockRejectedValue(Object.assign(new Error("fixture"), { name: "ConditionalCheckFailedException" }));
    expect(await createAwsLabAnalysisWorker({ jobId, fail: true })).toMatchObject({ skipped: true });
    expect(mock.db.mock.calls[0][0].input.ConditionExpression).toContain("attribute_exists(pk)");
    expect(mock.db.mock.calls[0][0].input.ConditionExpression).toContain("#state <> :completed");
  });
});
