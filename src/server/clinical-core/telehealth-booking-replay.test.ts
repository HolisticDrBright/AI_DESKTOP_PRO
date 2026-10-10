import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { send, secretSend } = vi.hoisted(() => ({ send: vi.fn(), secretSend: vi.fn() }));
vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", () => ({ DynamoDBDocumentClient: { from: () => ({ send }) },
  GetCommand: class GetCommand { constructor(readonly input: unknown) {} },
  PutCommand: class PutCommand { constructor(readonly input: unknown) {} },
  QueryCommand: class QueryCommand { constructor(readonly input: unknown) {} },
  TransactWriteCommand: class TransactWriteCommand { constructor(readonly input: unknown) {} },
  UpdateCommand: class UpdateCommand { constructor(readonly input: unknown) {} } }));
vi.mock("@aws-sdk/client-secrets-manager", () => ({ SecretsManagerClient: class { send = secretSend; }, GetSecretValueCommand: class {} }));
import { createTelehealthHandler, type TelehealthConfiguration } from "./aws-telehealth-requests";
const owner = "11111111-1111-4111-8111-111111111111", org = "22222222-2222-4222-8222-222222222222";
const holdId = "44444444-4444-4444-8444-444444444444", slotId = "33333333-3333-4333-8333-333333333333";
const config: TelehealthConfiguration = { tableName: "fictional", consumerIssuer: "fictional-consumer", consumerAudience: "fictional-client",
  workforceIssuer: "fictional-workforce", workforceAudience: "fictional-staff", runtimeMode: "synthetic", phiAllowed: false,
  zoomEnabled: false, zoomBaaVerified: false, zoomSecretArn: "", remindersEnabled: false, reminderSender: "", reminderConfigurationSet: "",
  reminderScheduleGroup: "", reminderSchedulerRoleArn: "", reminderTargetArn: "", reminderEventsTopicArn: "", stripeTestEnabled: false,
  stripeSecretArn: "", stripeSuccessUrl: "", stripeCancelUrl: "", identityApiOrigin: "https://abcdefghij.execute-api.us-east-2.amazonaws.com", chartAdmissionSecretArn: "" };
const input = () => ({ visitType: "follow_up", slotId, holdId, note: "Fictional scheduling note", replayProtocol: "hold-booking/1" });
function event(body: Record<string, unknown>, person = owner) { return { routeKey: "POST /clinical-core/consumer/appointments/requests",
  headers: { "content-type": "application/json" }, body: JSON.stringify(body), requestContext: { authorizer: { jwt: { claims: {
    iss: config.consumerIssuer, aud: config.consumerAudience, token_use: "id", sub: "fictional-owner", email: "fictional@example.test",
    "custom:person_id": person, "custom:organization_id": org, "custom:synthetic_attested": "true", "custom:production_bound": "false" } } } } } as never; }
type RecordItem = Record<string, unknown>;
let saved: RecordItem | undefined, writes: number, loss: "none" | "committed" | "uncommitted";
const slot = () => ({ pk: `ORG#${org}`, sk: `SLOT#fictional#${slotId}`, organizationId: org, slotId, status: "held", heldBy: owner,
  holdId, holdExpiresAt: Math.floor(Date.now() / 1000) + 600, start: "2026-10-12T17:00:00.000Z", end: "2026-10-12T17:30:00.000Z",
  visitTypes: ["follow_up"], timeZone: "America/Los_Angeles", priceMinor: 15000, currency: "USD", cancellationPolicy: "Fictional policy", cancellationWindowHours: 24 });
beforeEach(() => {
  send.mockReset(); secretSend.mockReset(); saved = undefined; writes = 0; loss = "none";
  send.mockImplementation(async (command: { constructor: { name: string }; input: { Key?: { pk: string; sk: string }; ConsistentRead?: boolean;
    TransactItems?: Array<{ Put?: { Item: RecordItem; ConditionExpression: string }; Update?: unknown }> } }) => {
    if (command.constructor.name === "GetCommand") {
      expect(command.input).toMatchObject({ Key: { pk: `ORG#${org}`, sk: `REQ#${holdId}` }, ConsistentRead: true });
      return saved ? { Item: structuredClone(saved) } : {};
    }
    if (command.constructor.name === "QueryCommand") return { Items: [slot()] };
    if (command.constructor.name !== "TransactWriteCommand") throw new Error("unexpected_write");
    writes++; const item = command.input.TransactItems?.[0].Put;
    expect(item?.ConditionExpression).toBe("attribute_not_exists(pk) AND attribute_not_exists(sk)");
    expect(command.input.TransactItems).toHaveLength(2);
    if (saved || loss === "uncommitted") throw new Error("fictional_lost_receipt");
    saved = structuredClone(item!.Item);
    if (loss === "committed") throw new Error("fictional_lost_receipt");
    return {};
  });
});
const handler = () => createTelehealthHandler(config);
afterEach(() => vi.restoreAllMocks());
it("uses one conditional hold identity and replays the current booking without a second transaction", async () => {
  const run = handler(), first = await run(event(input())), second = await run(event(input()));
  expect(first.statusCode).toBe(201); expect(second.statusCode).toBe(201); expect(writes).toBe(1);
  expect(JSON.parse(first.body).data.requestId).toBe(holdId);
  expect(JSON.parse(second.body).data).toEqual(JSON.parse(first.body).data);
  expect(JSON.parse(second.body).data).not.toHaveProperty("bookingInputSha256"); expect(secretSend).not.toHaveBeenCalled();
});
it("recovers a committed transaction whose response was lost, with no second write", async () => {
  loss = "committed"; const result = await handler()(event(input()));
  expect(result.statusCode).toBe(201); expect(writes).toBe(1); expect(secretSend).not.toHaveBeenCalled();
});
it("keeps an unknown uncommitted response uncertain and does not automatically repeat it", async () => {
  loss = "uncommitted"; const result = await handler()(event(input()));
  expect(result.statusCode).toBe(503); expect(writes).toBe(1); expect(saved).toBeUndefined();
});
it.each(["note", "visitType", "slotId"])("rejects changing %s under the original hold identity", async key => {
  const run = handler(); expect((await run(event(input()))).statusCode).toBe(201);
  const changed = { ...input(), [key]: key === "note" ? "Changed fictional note" : key === "visitType" ? "initial" : "55555555-5555-4555-8555-555555555555" };
  expect((await run(event(changed))).statusCode).toBe(409); expect(writes).toBe(1);
});
it("does not confuse property order with changed immutable input", async () => {
  const run = handler(); await run(event(input()));
  const value = input(); const result = await run(event({ replayProtocol: value.replayProtocol, note: value.note, holdId, slotId, visitType: value.visitType }));
  expect(result.statusCode).toBe(201); expect(writes).toBe(1);
});
it("refuses another owner's replay without returning the booking", async () => {
  const run = handler(); await run(event(input()));
  const result = await run(event(input(), "55555555-5555-4555-8555-555555555555"));
  expect(result.statusCode).toBe(403); expect(result.body).not.toContain("Fictional scheduling note"); expect(writes).toBe(1);
});
it("a restarted handler and a second device read the same current cancellation rather than reserving again", async () => {
  await handler()(event(input())); saved = { ...saved!, status: "cancelled", version: 2, updatedAt: "2026-10-11T00:00:00.000Z" };
  const result = await handler()(event(input()));
  expect(result.statusCode).toBe(201); expect(JSON.parse(result.body).data).toMatchObject({ status: "cancelled", version: 2 }); expect(writes).toBe(1);
});
it("a race returns the winner's immutable booking, not the losing caller's generated row", async () => {
  const original = send.getMockImplementation()!;
  let reads = 0;
  send.mockImplementation(async command => {
    if (command.constructor.name === "GetCommand" && ++reads <= 2) return {};
    return original(command);
  });
  const results = await Promise.all([handler()(event(input())), handler()(event(input()))]);
  expect(results.map(result => result.statusCode)).toEqual([201, 201]); expect(writes).toBe(2);
  expect(JSON.parse(results[0].body).data).toEqual(JSON.parse(results[1].body).data);
  expect(saved?.requestId).toBe(holdId); // one store row despite two admitted transactions
});
it("replays the current rescheduled request using its original input binding", async () => {
  await handler()(event(input()));
  saved = { ...saved!, status: "reschedule_requested", version: 2, slotId: "55555555-5555-4555-8555-555555555555" };
  const result = await handler()(event(input()));
  expect(result.statusCode).toBe(201);
  expect(JSON.parse(result.body).data).toMatchObject({ status: "reschedule_requested", version: 2, slotId: saved.slotId });
  expect(writes).toBe(1);
});
it("logs fixed refusal labels without provider exception names, messages or request text", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const failure = new Error("Bearer fictional-secret fictional@example.test health-payload");
  failure.name = "credential_fictional-secret";
  send.mockRejectedValueOnce(failure);
  expect((await handler()(event(input()))).statusCode).toBe(503);
  expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: "telehealth_request_refused", category: "service_unavailable" }));
  expect(JSON.stringify(warn.mock.calls)).not.toMatch(/fictional-secret|fictional@example|health-payload|Scheduling|scheduling/);
});
it("refuses unsupported replay protocols before any read, write or provider request", async () => {
  expect((await handler()(event({ ...input(), replayProtocol: "unsupported/1" }))).statusCode).toBe(400);
  expect(send).not.toHaveBeenCalled(); expect(secretSend).not.toHaveBeenCalled();
});
