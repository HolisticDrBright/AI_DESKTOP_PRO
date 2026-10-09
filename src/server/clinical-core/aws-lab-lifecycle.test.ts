import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
const mock = vi.hoisted(() => ({ db: vi.fn(), s3: vi.fn(), sfn: vi.fn() }));
vi.mock("@aws-sdk/lib-dynamodb", () => {
  class Command { constructor(public input: Record<string, unknown>) {} }
  return { DynamoDBDocumentClient: { from: () => ({ send: mock.db }) },
    GetCommand: class extends Command {}, PutCommand: class extends Command {}, UpdateCommand: class extends Command {}, DeleteCommand: class extends Command {},
    TransactWriteCommand: class extends Command {}, QueryCommand: class extends Command {} };
});
vi.mock("@aws-sdk/client-s3", () => {
  class Command { constructor(public input: Record<string, unknown>) {} }
  return { S3Client: class { send = mock.s3; }, GetObjectCommand: class extends Command {}, PutObjectCommand: class extends Command {},
    HeadObjectCommand: class extends Command {}, DeleteObjectsCommand: class extends Command {}, ListObjectVersionsCommand: class extends Command {} };
});
vi.mock("@aws-sdk/client-sfn", () => ({ SFNClient: class { send = mock.sfn; }, StartExecutionCommand: class { constructor(public input: Record<string, unknown>) {} } }));
import { createAwsLabAnalysisApiHandler } from "./aws-lab-analysis-api";
import { createAwsLabAnalysisWorker, LAB_WORKER_LEASE_SECONDS } from "./aws-lab-analysis-worker";
import { readFileSync } from "node:fs";
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
  test("persists source panel dates and rejects contradictory collection dates before writing",async()=>{
    const body={panelId:"fixture-panel",panelName:"Fictional panel",testDate:"2026-01-01",dataClassification:"synthetic_only",attestsSyntheticOnly:true,
      biomarkers:[{markerId:"fixture",canonicalName:"Fictional marker",value:0,unit:"widgets",labMin:null,labMax:null}]};
    expect((await createAwsLabAnalysisApiHandler(event("POST","plan-jobs",body))).statusCode).toBe(200);
    expect(mock.db.mock.calls.find(([c])=>c.constructor.name==="PutCommand")![0].input.Item.sourcePanel)
      .toEqual({panelId:body.panelId,panelName:body.panelName,testDate:body.testDate});
    mock.db.mockClear();mock.sfn.mockClear();
    const context={dateOfBirth:"2000-01-01",observedOn:"2026-02-01",sex:null,pregnancyStatus:null,cyclePhase:null,reproductiveStage:null,contraception:null,pregnancyTrimester:null,assayId:null};
    expect((await createAwsLabAnalysisApiHandler(event("POST","plan-jobs",{...body,biomarkers:[{...body.biomarkers[0],collectionContext:context}]}))).statusCode).toBe(400);
    expect(mock.db).not.toHaveBeenCalled();expect(mock.sfn).not.toHaveBeenCalled();
  });
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
    const state={...job(),state:'completed'};
    const cleanup={pk:'cleanup#'+jobId,ownerSub:sub,organizationId:sub,personId:sub,contractVersion:'lab-deletion-cleanup/1',
      requestedAt:new Date().toISOString(),cleanupPartition:'pending',cleanupDue:new Date().toISOString()};
    mock.db.mockImplementation(async command=>{
      if(command.constructor.name==='TransactWriteCommand'){state.state='deleting';return {};}
      if(command.constructor.name==='GetCommand')return {Item:command.input.Key.pk.startsWith('cleanup#')?cleanup:state};
      return {};
    });
    mock.s3.mockImplementation(async command => command.constructor.name === "ListObjectVersionsCommand"
      ? { Versions: [{ Key: `synthetic-labs/${sub}/${sub}/${jobId}/document/fixture.pdf`, VersionId: "fixture-version" }] } : { Errors: [{ Code: "AccessDenied" }] });
    const result = await createAwsLabAnalysisApiHandler(event("DELETE", `jobs/${jobId}`));
    expect(result.statusCode).toBe(400); expect(result.body).not.toContain('"deleted":true');
    expect(mock.db.mock.calls.some(([command]) => command.constructor.name === "DeleteCommand")).toBe(false);
    expect(mock.s3.mock.calls.some(([command])=>command.constructor.name==='DeleteObjectsCommand')).toBe(true);
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
    expect(await createAwsLabAnalysisWorker({ jobId, pass: 0, fail: true })).toMatchObject({ skipped: true });
    expect(mock.db.mock.calls[0][0].input.ConditionExpression).toContain("attribute_exists(pk)");
    expect(mock.db.mock.calls[0][0].input.ConditionExpression).toContain("#state IN (:queued, :running, :previous, :failed)");
    expect(mock.db.mock.calls[0][0].input.ConditionExpression).toContain("passesCompleted = :pass");
    expect(mock.db.mock.calls[0][0].input.ConditionExpression).toContain("leaseUntil <= :epoch");
  });
  test.each(['deleting','awaiting_upload','completed','needs_review'])('failure callback cannot revive or alter %s',async state=>{
    mock.db.mockImplementation(async command=>{
      const v=command.input.ExpressionAttributeValues;
      const allowed=[v[':queued'],v[':running'],v[':previous'],v[':failed']];
      expect(allowed).not.toContain(state);
      throw Object.assign(new Error('fixture conditional refusal'),{name:'ConditionalCheckFailedException'});
    });
    expect(await createAwsLabAnalysisWorker({jobId,pass:0,fail:true})).toMatchObject({skipped:true});
    expect(mock.s3).not.toHaveBeenCalled();
  });
  test("failure callbacks without an originating pass are refused", async () => {
    await expect(createAwsLabAnalysisWorker({ jobId, fail: true })).rejects.toThrow("worker_failure_pass_required");
    expect(mock.db).not.toHaveBeenCalled();
  });
  test("a lease contention does not execute extraction or overwrite the active lease", async () => {
    mock.db.mockResolvedValueOnce({ Item: job() }).mockRejectedValueOnce(Object.assign(new Error("fixture"), { name: "ConditionalCheckFailedException" }));
    await expect(createAwsLabAnalysisWorker({ jobId, pass: 0 })).rejects.toMatchObject({ name: "lab_worker_busy" });
    expect(mock.s3).not.toHaveBeenCalled();
    expect(mock.db).toHaveBeenCalledTimes(2);
    const claim = mock.db.mock.calls[1][0].input;
    expect(claim.ConditionExpression).toContain("passesCompleted = :pass");
    expect(claim.ConditionExpression).toContain("leaseUntil <= :epoch");
    expect(claim.ExpressionAttributeValues[":until"] - claim.ExpressionAttributeValues[":epoch"]).toBe(LAB_WORKER_LEASE_SECONDS * 1000);
  });
  test("successful completion is fenced to the same unexpired lease and pass", async () => {
    mock.db.mockResolvedValueOnce({ Item: job() }).mockResolvedValue({});
    expect(await createAwsLabAnalysisWorker({ jobId, pass: 0 })).toMatchObject({ completed: true });
    const claim = mock.db.mock.calls[1][0].input;
    const complete = mock.db.mock.calls[2][0].input;
    expect(complete.ConditionExpression).toContain("leaseToken = :token AND leaseUntil > :epoch");
    expect(complete.ConditionExpression).toContain("passesCompleted = :pass");
    expect(complete.ExpressionAttributeValues[":token"]).toBe(claim.ExpressionAttributeValues[":token"]);
    expect(complete.UpdateExpression).toContain("REMOVE leaseToken, leaseUntil");
    expect(mock.s3).toHaveBeenCalledOnce();
  });
  test("provider failure only releases the failing worker's own lease", async () => {
    mock.db.mockResolvedValueOnce({ Item: job() }).mockResolvedValue({});
    mock.s3.mockRejectedValueOnce(new Error("fixture storage error"));
    await expect(createAwsLabAnalysisWorker({ jobId, pass: 0 })).rejects.toThrow("internal_failure");
    const claim = mock.db.mock.calls[1][0].input;
    const release = mock.db.mock.calls[2][0].input;
    expect(release.ConditionExpression).toBe("attribute_exists(pk) AND leaseToken = :token");
    expect(release.ExpressionAttributeValues[":token"]).toBe(claim.ExpressionAttributeValues[":token"]);
    expect(release.UpdateExpression).toBe("REMOVE leaseToken, leaseUntil");
  });
  test("a stale completion cannot report success or release a replacement owner's lease", async () => {
    const rejected = Object.assign(new Error("fixture"), { name: "ConditionalCheckFailedException" });
    mock.db.mockResolvedValueOnce({ Item: job() }).mockResolvedValueOnce({}).mockRejectedValue(rejected);
    await expect(createAwsLabAnalysisWorker({ jobId, pass: 0 })).rejects.toThrow("internal_failure");
    const complete = mock.db.mock.calls[2][0].input;
    const release = mock.db.mock.calls[3][0].input;
    expect(complete.ConditionExpression).toContain("leaseToken = :token");
    expect(release.ExpressionAttributeValues[":token"]).toBe(complete.ExpressionAttributeValues[":token"]);
  });
  test("workflow retry horizon outlasts leases and failure callbacks bind the originating pass", () => {
    const template = JSON.parse(readFileSync("infra/aws-clinical-core/lab-analysis-extension.json", "utf8"));
    expect(template.Resources.LabWorkerFunction.Properties.Timeout).toBeLessThan(LAB_WORKER_LEASE_SECONDS);
    const resource = Object.values(template.Resources).find((row) => (row as { Type: string }).Type === "AWS::StepFunctions::StateMachine") as { Properties: { DefinitionString: { "Fn::Sub": string } } };
    const states = JSON.parse(resource.Properties.DefinitionString["Fn::Sub"]).States;
    for (let pass = 0; pass < 5; pass++) {
      const retry = states[`Pass${pass}`].Retry[0];
      expect(retry.ErrorEquals).toEqual(["lab_worker_busy"]);
      expect(retry.IntervalSeconds * retry.MaxAttempts).toBeGreaterThan(LAB_WORKER_LEASE_SECONDS);
      expect(states[states[`Pass${pass}`].Catch[0].Next].Parameters.pass).toBe(pass);
    }
  });
});
