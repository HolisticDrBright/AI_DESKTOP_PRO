import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { send, schedulerSend, sesSend } = vi.hoisted(() => ({ send: vi.fn(), schedulerSend: vi.fn(), sesSend: vi.fn() }));
vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", () => ({ DynamoDBDocumentClient: { from: () => ({ send }) },
  GetCommand: class GetCommand { constructor(readonly input: unknown) {} }, PutCommand: class PutCommand { constructor(readonly input: unknown) {} },
  QueryCommand: class QueryCommand { constructor(readonly input: unknown) {} }, TransactWriteCommand: class TransactWriteCommand { constructor(readonly input: unknown) {} },
  UpdateCommand: class UpdateCommand { constructor(readonly input: unknown) {} } }));
vi.mock("@aws-sdk/client-scheduler", () => ({ SchedulerClient: class { send = schedulerSend; },
  CreateScheduleCommand: class CreateScheduleCommand { constructor(readonly input: unknown) {} },
  DeleteScheduleCommand: class DeleteScheduleCommand { constructor(readonly input: unknown) {} } }));
vi.mock("@aws-sdk/client-sesv2", () => ({ SESv2Client: class { send = sesSend; }, SendEmailCommand: class { constructor(readonly input: unknown) {} } }));
import { createTelehealthHandler, type TelehealthConfiguration } from "./aws-telehealth-requests";
import { FictionalAppointmentStore } from "./appointment-operation-store.test-support";

const owner = "11111111-1111-4111-8111-111111111111", org = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333", slotId = "44444444-4444-4444-8444-444444444444";
const operationId = "55555555-5555-4555-8555-555555555555", successorId = "66666666-6666-4666-8666-666666666666";
const start = "2030-11-10T17:00:00.000Z", end = "2030-11-10T17:30:00.000Z";
const config: TelehealthConfiguration = { tableName: "fictional", consumerIssuer: "consumer", consumerAudience: "consumer-client", workforceIssuer: "workforce",
  workforceAudience: "staff-client", runtimeMode: "synthetic", phiAllowed: false, zoomEnabled: false, zoomBaaVerified: false, zoomSecretArn: "",
  remindersEnabled: true, reminderSender: "fictional@example.test", reminderConfigurationSet: "fictional", reminderScheduleGroup: "fictional",
  reminderSchedulerRoleArn: "arn:aws:iam::111122223333:role/fictional", reminderTargetArn: "arn:aws:lambda:us-east-2:111122223333:function:fictional",
  reminderEventsTopicArn: "arn:aws:sns:us-east-2:111122223333:fictional", stripeTestEnabled: false, stripeSecretArn: "", stripeSuccessUrl: "", stripeCancelUrl: "",
  identityApiOrigin: "https://fictional.execute-api.us-east-2.amazonaws.com" };
const key = { pk: `ORG#${org}`, sk: `REQ#${requestId}` };
const request = (patch: Record<string, unknown> = {}) => ({ ...key, requestId, organizationId: org, consumerPersonId: owner,
  status: "requested", visitType: "follow_up", preferredSlots: [start], timeZone: "America/Los_Angeles", note: null,
  scheduledStart: start, scheduledEnd: end, joinUrl: null, providerMeetingId: null, version: 4,
  createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", lastActionBy: "consumer", slotId, appointmentId: null,
  priceMinor: 15000, currency: "USD", cancellationPolicy: "Fictional policy", cancellationWindowHours: 24, cancellationFeeDueMinor: 0,
  consumerEmail: "fictional@example.test", reminderStatus: "disabled", paymentPolicyVersion: "telehealth-payments/1", paymentAuthorizationStatus: "authorized",
  paymentStatus: "not_due", paymentIntentId: null, paidMinor: 0, refundedMinor: 0, ...patch });
function event(input: Record<string, unknown>, pool = "workforce", method = "POST", path = "actions") {
  return { routeKey: `${method} /clinical-core/${pool}/appointments/${path}`, headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    requestContext: { authorizer: { jwt: { claims: { iss: pool === "consumer" ? config.consumerIssuer : config.workforceIssuer,
      aud: pool === "consumer" ? config.consumerAudience : config.workforceAudience, token_use: "id", sub: `fictional-${pool}`,
      email: "fictional@example.test", "custom:person_id": owner, "custom:organization_id": org, "custom:synthetic_attested": "true" } } } } } as never;
}
type Schedule = { Name: string; ClientToken: string; Target: { Input: string }; [key: string]: unknown };
type ScheduleCommand = { constructor: { name: string }; input: Schedule };
let store: FictionalAppointmentStore;
let schedules: Map<string, Schedule>;
const current = () => store.get(key)!;
const commands = (kind: string) => schedulerSend.mock.calls.map(([command]) => command as ScheduleCommand).filter(command => command.constructor.name === kind);
const creates = () => commands("CreateScheduleCommand");
const names = () => [...schedules.keys()];
async function applySchedule(command: ScheduleCommand) {
  if (command.constructor.name === "CreateScheduleCommand") {
    if (schedules.has(command.input.Name)) throw Object.assign(new Error("fictional conflict"), { name: "ConflictException" });
    schedules.set(command.input.Name, structuredClone(command.input));
  } else schedules.delete(command.input.Name);
  return {};
}
const schedule = (patch: Record<string, unknown> = {}, cfg = config) => createTelehealthHandler(cfg)(event({ requestId, expectedVersion: 4,
  operationId, operationProtocol: "appointment-change/1", action: "schedule", scheduledStart: start, scheduledEnd: end, timeZone: "America/Los_Angeles", ...patch }));
const deliver = (input: Record<string, unknown>) => createTelehealthHandler(config)(input as never);
const target = (generation = operationId, patch: Record<string, unknown> = {}) => ({ internalEvent: "send_appointment_reminder", organizationId: org,
  requestId, scheduledStart: start, reminderProtocol: "appointment-reminder/2", reminderGeneration: generation, ...patch });
const payload = (result: { body: string }) => JSON.parse(result.body).data;
beforeEach(() => {
  store = new FictionalAppointmentStore().seed(request(), { pk: key.pk, sk: `SLOT#2030-11-10#${slotId}`, slotId,
    organizationId: org, start, end, status: "booked", cancellationWindowHours: 24 });
  schedules = new Map(); send.mockReset(); send.mockImplementation(store.send);
  schedulerSend.mockReset(); schedulerSend.mockImplementation(applySchedule); sesSend.mockReset(); sesSend.mockResolvedValue({});
});
afterEach(() => vi.unstubAllGlobals());

it("schedules operation-bound reminders, persists the exact revision, and hides it from public replies", async () => {
  const result = await schedule(); expect(result.statusCode).toBe(200);
  expect(current()).toMatchObject({ version: 5, reminderStatus: "scheduled", reminderGeneration: operationId });
  expect(payload(result)).not.toHaveProperty("reminderGeneration");
  expect(commands("DeleteScheduleCommand").map(command => command.input.Name)).toEqual([
    `alp-${requestId.replaceAll("-", "")}-24h`, `alp-${requestId.replaceAll("-", "")}-1h`]);
  expect(creates()).toHaveLength(2);
  for (const command of creates()) {
    expect(command.input.Name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(command.input.Name.length).toBeLessThanOrEqual(64);
    expect(command.input.ClientToken).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(command.input.Target.Input)).toEqual(target());
    expect(command.input.Target.Input).not.toMatch(/fictional@example|consumerEmail|note|joinUrl/);
  }
  const list = await createTelehealthHandler(config)(event({}, "workforce", "GET", "requests"));
  expect(payload(list)[0]).not.toHaveProperty("reminderGeneration");
  expect(payload(await deliver(JSON.parse(creates()[0].input.Target.Input)))).toEqual({ sent: true });
  expect(sesSend).toHaveBeenCalledOnce();
});
it("an old delete cannot remove successor reminders, even when both revisions use the same appointment time", async () => {
  await schedule(); const olderTargets = creates().map(command => JSON.parse(command.input.Target.Input));
  schedulerSend.mockClear();
  const result = await schedule({ action: "reschedule", expectedVersion: 5, operationId: successorId }); expect(result.statusCode).toBe(200);
  const deletes = commands("DeleteScheduleCommand"); const successorNames = names();
  expect(deletes).toHaveLength(2); expect(successorNames).toHaveLength(2);
  expect(deletes.every(command => !successorNames.includes(command.input.Name))).toBe(true);
  // Re-deliver the exact older resource-deletion commands after the successor exists.
  for (const command of deletes) await applySchedule(command);
  expect(names()).toEqual(successorNames);
  for (const old of olderTargets) expect(payload(await deliver(old))).toEqual({ sent: false, reason: "stale" });
  expect(payload(await deliver(target(successorId)))).toEqual({ sent: true });
  expect(sesSend).toHaveBeenCalledOnce();
});
it("case-normalized operation UUIDs still identify one scheduler generation and fit the provider name bound", async () => {
  const uppercase = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
  expect((await schedule({ operationId: uppercase })).statusCode).toBe(200);
  expect(current().reminderGeneration).toBe(uppercase.toLowerCase());
  const encoded = Buffer.from(uppercase.replaceAll("-", ""), "hex").toString("base64url");
  expect(names()).toContain(`alp-${requestId.replaceAll("-", "")}-${encoded}-24h`);
  expect(names()[0]).toHaveLength(63);
});
it("legacy clients acquire deterministic new generations without changing the public response contract", async () => {
  const { operationId: omitted, operationProtocol: alsoOmitted, ...input } = { requestId, action: "schedule", expectedVersion: 4,
    scheduledStart: start, scheduledEnd: end, timeZone: "America/Los_Angeles", operationId, operationProtocol: "appointment-change/1" };
  void omitted; void alsoOmitted;
  const result = await createTelehealthHandler(config)(event(input));
  expect(result.statusCode).toBe(200); expect(current().reminderGeneration).toMatch(/^[a-f0-9-]{36}$/);
  expect(payload(result)).not.toHaveProperty("operationReceipt"); expect(payload(result)).not.toHaveProperty("reminderGeneration");
  expect(JSON.parse(creates()[0].input.Target.Input).reminderGeneration).toBe(current().reminderGeneration);
});
it("partial or uncertain schedule creation persists its private generation but refuses delivery", async () => {
  let count = 0;
  schedulerSend.mockImplementation(async command => {
    const result = await applySchedule(command);
    if (command.constructor.name === "CreateScheduleCommand" && ++count === 2) throw new Error("fictional lost create response");
    return result;
  });
  expect((await schedule()).statusCode).toBe(200);
  expect(current()).toMatchObject({ reminderStatus: "failed", reminderGeneration: operationId }); expect(schedules.size).toBe(2);
  for (const value of schedules.values()) expect(payload(await deliver(JSON.parse(value.Target.Input)))).toEqual({ sent: false, reason: "stale" });
  expect(sesSend).not.toHaveBeenCalled();
  schedulerSend.mockImplementation(applySchedule); schedulerSend.mockClear();
  expect((await schedule({ action: "reschedule", expectedVersion: 5, operationId: successorId })).statusCode).toBe(200);
  expect(schedules.size).toBe(2); expect(current().reminderGeneration).toBe(successorId);
});
it("a lost database commit leaves the admitted fence and forbids both mailing and redispatch", async () => {
  store.transactionLoss = "commit_before";
  expect((await schedule()).statusCode).toBe(503);
  expect(current()).toMatchObject({ version: 4, mutationOperationId: operationId }); expect(creates()).toHaveLength(2);
  expect(payload(await deliver(target()))).toEqual({ sent: false, reason: "change_pending" });
  expect((await schedule()).statusCode).toBe(503); expect(creates()).toHaveLength(2); expect(sesSend).not.toHaveBeenCalled();
});
it("a lost completed transaction receipt recovers the generation and never creates again on replay", async () => {
  store.transactionLoss = "commit_after";
  expect((await schedule()).statusCode).toBe(200); expect(current()).toMatchObject({ version: 5, reminderGeneration: operationId });
  const first = names(); expect((await schedule()).statusCode).toBe(200);
  expect(names()).toEqual(first); expect(creates()).toHaveLength(2);
});
it("a reminders-disabled revision invalidates old scheduled events without pretending to have deleted them", async () => {
  await schedule(); const original = names(); schedulerSend.mockClear();
  expect((await schedule({ action: "reschedule", expectedVersion: 5, operationId: successorId }, { ...config, remindersEnabled: false })).statusCode).toBe(200);
  expect(current()).toMatchObject({ reminderStatus: "disabled", reminderGeneration: successorId });
  expect(schedulerSend).not.toHaveBeenCalled(); expect(names()).toEqual(original);
  expect(payload(await deliver(target()))).toEqual({ sent: false, reason: "stale" }); expect(sesSend).not.toHaveBeenCalled();
});
it("cancellation deletes only the saved generation, disables delivery, and cannot make a late create current", async () => {
  await schedule(); const late = creates()[0]; schedulerSend.mockClear();
  const result = await createTelehealthHandler(config)(event({ requestId, action: "cancel", expectedVersion: 5,
    operationId: successorId, operationProtocol: "appointment-change/1" }, "consumer"));
  expect(result.statusCode).toBe(200); expect(current()).toMatchObject({ status: "cancelled", reminderStatus: "disabled" }); expect(schedules.size).toBe(0);
  expect(commands("DeleteScheduleCommand").map(command => command.input.Name)).toContain(late.input.Name);
  await applySchedule(late); expect(schedules.size).toBe(1); // An orphan is not a deletion certificate.
  expect(payload(await deliver(JSON.parse(late.input.Target.Input)))).toEqual({ sent: false, reason: "stale" }); expect(sesSend).not.toHaveBeenCalled();
});
it("unknown deletion during cancellation remains pending, never a terminal no-effects refusal", async () => {
  await schedule(); schedulerSend.mockImplementation(async command => { await applySchedule(command); throw new Error("fictional lost delete response"); });
  const result = await createTelehealthHandler(config)(event({ requestId, action: "cancel", expectedVersion: 5,
    operationId: successorId, operationProtocol: "appointment-change/1" }, "consumer"));
  expect(result.statusCode).toBe(503); expect(current()).toMatchObject({ version: 5, mutationOperationId: successorId });
  expect(store.get({ pk: key.pk, sk: `REQOP#${requestId}#${successorId}` })).toMatchObject({ phase: "effects_started" });
  expect(payload(await deliver(target()))).toEqual({ sent: false, reason: "change_pending" });
});
it("malformed generation metadata never falls back to deleting legacy names", async () => {
  store.seed(request({ status: "scheduled", reminderGeneration: "invalid" }));
  expect((await schedule({ action: "reschedule" })).statusCode).toBe(200);
  expect(current()).toMatchObject({ reminderGeneration: operationId, reminderStatus: "failed" });
  expect(schedulerSend).not.toHaveBeenCalled(); expect(sesSend).not.toHaveBeenCalled();
});
it("legacy rows accept only legacy events and new rows refuse an old event even at the same time", async () => {
  store.seed(request({ status: "scheduled", reminderStatus: "scheduled" }));
  const legacy = { internalEvent: "send_appointment_reminder", organizationId: org, requestId, scheduledStart: start };
  expect(payload(await deliver(legacy))).toEqual({ sent: true }); sesSend.mockClear();
  expect(payload(await deliver(target()))).toEqual({ sent: false, reason: "stale" });
  store.seed(request({ status: "scheduled", reminderStatus: "scheduled", reminderGeneration: operationId }));
  expect(payload(await deliver(legacy))).toEqual({ sent: false, reason: "stale" }); expect(sesSend).not.toHaveBeenCalled();
});
it.each([undefined, "appointment-reminder/1", "future/3"])("new generation refuses missing or different protocol %s", async reminderProtocol => {
  store.seed(request({ status: "scheduled", reminderStatus: "scheduled", reminderGeneration: operationId }));
  expect(payload(await deliver(target(operationId, { reminderProtocol })))).toEqual({ sent: false, reason: "stale" }); expect(sesSend).not.toHaveBeenCalled();
});
it.each(["requested", "reschedule_requested", "cancelled"])("non-deliverable appointment status %s refuses a matching event", async status => {
  store.seed(request({ status, reminderStatus: "scheduled", reminderGeneration: operationId }));
  expect(payload(await deliver(target()))).toEqual({ sent: false, reason: "stale" }); expect(sesSend).not.toHaveBeenCalled();
});
it.each(["disabled", "failed"])("reminder status %s refuses a matching generation", async reminderStatus => {
  store.seed(request({ status: "scheduled", reminderStatus, reminderGeneration: operationId }));
  expect(payload(await deliver(target()))).toEqual({ sent: false, reason: "stale" }); expect(sesSend).not.toHaveBeenCalled();
});
it.each([
  { mutationOperationId: successorId }, { status: "cancelled" }, { reminderGeneration: successorId },
  { version: 5 }, { consumerEmail: "other@example.test" }, { consumerPersonId: "99999999-9999-4999-8999-999999999999" },
  { joinUrl: "https://example.test/changed" }, { scheduledStart: "2030-11-11T17:00:00.000Z" },
])("a change during suppression lookup refuses delivery: %j", async patch => {
  store.seed(request({ status: "scheduled", reminderStatus: "scheduled", reminderGeneration: operationId }));
  send.mockImplementation(async command => {
    const result = await store.send(command);
    if (command.constructor.name === "GetCommand" && command.input.Key.pk === "EMAIL_SUPPRESSION") store.seed({ ...current(), ...patch });
    return result;
  });
  const result = await deliver(target()); expect(result.statusCode).toBe(200);
  expect(payload(result)).toMatchObject({ sent: false }); expect(sesSend).not.toHaveBeenCalled();
  const reads = store.commands.filter(command => command.constructor.name === "QueryCommand"); expect(reads).toHaveLength(2);
  expect(reads.every(command => command.input.ConsistentRead === true)).toBe(true);
});
it("suppression still wins without a second request read or SES send", async () => {
  store.seed(request({ status: "scheduled", reminderStatus: "scheduled", reminderGeneration: operationId }));
  send.mockImplementation(async command => command.constructor.name === "GetCommand" && command.input.Key.pk === "EMAIL_SUPPRESSION"
    ? { Item: { reason: "complaint" } } : store.send(command));
  expect(payload(await deliver(target()))).toEqual({ sent: false, reason: "suppressed" }); expect(sesSend).not.toHaveBeenCalled();
});
