import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
const { send, secretSend } = vi.hoisted(() => ({ send: vi.fn(), secretSend: vi.fn() }));
vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", () => ({ DynamoDBDocumentClient: { from: () => ({ send }) },
  GetCommand: class GetCommand { constructor(readonly input: unknown) {} }, PutCommand: class PutCommand { constructor(readonly input: unknown) {} },
  QueryCommand: class QueryCommand { constructor(readonly input: unknown) {} }, TransactWriteCommand: class TransactWriteCommand { constructor(readonly input: unknown) {} },
  UpdateCommand: class UpdateCommand { constructor(readonly input: unknown) {} } }));
vi.mock("@aws-sdk/client-secrets-manager", () => ({ SecretsManagerClient: class { send = secretSend; }, GetSecretValueCommand: class {} }));
import { createTelehealthHandler, type TelehealthConfiguration } from "./aws-telehealth-requests";
import { FictionalAppointmentStore } from "./appointment-operation-store.test-support";
import { appointmentOperationIdentity } from "./appointment-operation";

const owner = "11111111-1111-4111-8111-111111111111", org = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333", slotId = "44444444-4444-4444-8444-444444444444";
const operationId = "55555555-5555-4555-8555-555555555555", replacementId = "66666666-6666-4666-8666-666666666666";
const holdId = "77777777-7777-4777-8777-777777777777", appointmentId = "88888888-8888-4888-8888-888888888888";
const config: TelehealthConfiguration = { tableName: "fictional", consumerIssuer: "consumer", consumerAudience: "consumer-client", workforceIssuer: "workforce",
  workforceAudience: "staff-client", runtimeMode: "synthetic", phiAllowed: false, zoomEnabled: false, zoomBaaVerified: false, zoomSecretArn: "",
  remindersEnabled: false, reminderSender: "", reminderConfigurationSet: "", reminderScheduleGroup: "", reminderSchedulerRoleArn: "", reminderTargetArn: "",
  reminderEventsTopicArn: "", stripeTestEnabled: false, stripeSecretArn: "", stripeSuccessUrl: "", stripeCancelUrl: "",
  identityApiOrigin: "https://fictional.execute-api.us-east-2.amazonaws.com" };
const zoom = { ...config, zoomEnabled: true, zoomBaaVerified: true, zoomSecretArn: "arn:fictional" };
const stripe = { ...config, stripeTestEnabled: true, stripeSecretArn: "arn:fictional", stripeSuccessUrl: "https://example.test/ok", stripeCancelUrl: "https://example.test/cancel" };
const request = (patch: Record<string, unknown> = {}) => ({ pk: `ORG#${org}`, sk: `REQ#${requestId}`, requestId, organizationId: org, consumerPersonId: owner,
  status: "scheduled", visitType: "follow_up", preferredSlots: ["2026-11-10T17:00:00.000Z"], timeZone: "America/Los_Angeles", note: null,
  scheduledStart: "2026-11-10T17:00:00.000Z", scheduledEnd: "2026-11-10T17:30:00.000Z", joinUrl: null, providerMeetingId: null,
  version: 4, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", lastActionBy: "consumer", slotId, appointmentId: null,
  priceMinor: 15000, currency: "USD", cancellationPolicy: "Fictional policy", cancellationWindowHours: 24, cancellationFeeDueMinor: 0,
  consumerEmail: "fictional@example.test", reminderStatus: "disabled", paymentPolicyVersion: "telehealth-payments/1", paymentAuthorizationStatus: "authorized",
  paymentStatus: "not_due", paymentIntentId: null, paidMinor: 0, refundedMinor: 0, ...patch });
const slot = (patch: Record<string, unknown> = {}) => ({ pk: `ORG#${org}`, sk: `SLOT#2026-11-10#${slotId}`, organizationId: org, slotId,
  start: "2026-11-10T17:00:00.000Z", end: "2026-11-10T17:30:00.000Z", timeZone: "America/Los_Angeles", visitTypes: ["follow_up"],
  priceMinor: 15000, currency: "USD", cancellationPolicy: "Fictional policy", cancellationWindowHours: 24, status: "booked",
  heldBy: owner, holdId, holdExpiresAt: Math.floor(Date.now() / 1000) + 600, ...patch });
const replacement = () => slot({ sk: `SLOT#2026-11-11#${replacementId}`, slotId: replacementId, status: "held", start: "2026-11-11T17:00:00.000Z", end: "2026-11-11T17:30:00.000Z" });
const cancel = (patch: Record<string, unknown> = {}) => ({ requestId, expectedVersion: 4, action: "cancel", operationId, operationProtocol: "appointment-change/1", ...patch });
function event(input: Record<string, unknown>, pool: "consumer" | "workforce" = "consumer", path = "actions", person = owner) {
  return { routeKey: `POST /clinical-core/${pool}/appointments/${path}`, headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    requestContext: { authorizer: { jwt: { claims: { iss: pool === "consumer" ? config.consumerIssuer : config.workforceIssuer,
      aud: pool === "consumer" ? config.consumerAudience : config.workforceAudience, token_use: "id", sub: `fictional-${pool}`,
      email: "fictional@example.test", "custom:person_id": person, "custom:organization_id": org, "custom:synthetic_attested": "true" } } } } } as never;
}
let store: FictionalAppointmentStore;
let provider: ReturnType<typeof vi.fn>;
beforeEach(() => {
  store = new FictionalAppointmentStore().seed(request(), slot(), replacement()); send.mockReset(); send.mockImplementation(store.send);
  secretSend.mockReset(); secretSend.mockResolvedValue({ SecretString: JSON.stringify({ accountId: "fictional", clientId: "fictional", clientSecret: "fictional",
    userId: "fictional", sdkKey: "fictional", sdkSecret: "fictional", secretKey: "sk_test_fictional", webhookSecret: "whsec_fictional" }) });
  provider = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("oauth/token") ? { access_token: "fictional" }
    : url.includes("payment_intents") ? { id: "pi_fictional", livemode: false } : {}), { status: 200 }));
  vi.stubGlobal("fetch", provider);
});
afterEach(() => vi.unstubAllGlobals());
const run = (input: Record<string, unknown> = cancel(), cfg = config, pool: "consumer" | "workforce" = "consumer", path = "actions", person = owner) => createTelehealthHandler(cfg)(event(input, pool, path, person));
const current = () => store.get({ pk: `ORG#${org}`, sk: `REQ#${requestId}` })!;
const operations = () => [...store.rows.values()].filter(row => String(row.sk).startsWith("REQOP#"));

const discover = (person = owner) => run({ requestId }, config, "consumer", "pending-change", person);
it("discovery preserves the supplied UUID casing and original request hash", async () => {
  const upper = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
  store.transactionLoss = "admission_after"; await run(cancel({ operationId: upper }));
  const data = JSON.parse((await discover()).body).data;
  expect(data.pending.input.operationId).toBe(upper);
  expect(JSON.parse((await outcome(cancel({ operationId: upper }))).body).data.disposition).toBe("pending");
});
it("only structured scheduling choices are captured, not invalid action text", async () => {
  store.transactionLoss = "admission_after"; await run(cancel({ action: "fictional free text" }));
  expect(operations()[0]).not.toHaveProperty("consumerRecoveryInput");
  expect(JSON.parse((await discover()).body).data.disposition).toBe("unrecoverable");
});
it.each([
  cancel(), cancel({ action: "request_reschedule", slotId: replacementId, holdId }),
  { requestId, expectedVersion: 4, operationId, operationProtocol: "appointment-change/1", policyVersion: "telehealth-payments/1", authorized: false },
])("a second consumer device discovers the exact pending identity without dispatch: %j", async input => {
  store.transactionLoss = "admission_after";
  const path = "authorized" in input ? "payment-authorizations" : "actions";
  expect((await run(input, config, "consumer", path)).statusCode).toBe(503);
  const before = JSON.stringify([...store.rows]); send.mockClear();
  const result = await discover(); expect(result.statusCode).toBe(200);
  const data = JSON.parse(result.body).data;
  expect(data).toMatchObject({ protocol: "appointment-pending-discovery/1", requestId, organizationId: org, observedVersion: 4, disposition: "recoverable" });
  expect(data.pending.input).toEqual("authorized" in input
    ? { requestId, expectedVersion: 4, operationId, operationProtocol: "appointment-change/1", kind: "payment_authorization", authorized: false }
    : { requestId, expectedVersion: 4, operationId, operationProtocol: "appointment-change/1", kind: input.action,
      ...(input.action === "request_reschedule" ? { slotId: replacementId, holdId } : {}) });
  expect(JSON.stringify([...store.rows])).toBe(before);
  expect(send.mock.calls.every(([command]) => /Get|Query/.test(command.constructor.name))).toBe(true);
  expect(provider).not.toHaveBeenCalled(); expect(secretSend).not.toHaveBeenCalled();
  for (const privateName of ["actorSubject", "inputSha256", "reservedSlotKey", "consumerRecoveryInput", "consumerEmail"])
    expect(result.body).not.toContain(privateName);
});
it("discovery never treats a missing current fence as failed admission", async () => {
  expect(JSON.parse((await discover()).body).data.disposition).toBe("none");
  await run(); expect(JSON.parse((await discover()).body).data.disposition).toBe("none");
});
it("legacy pending rows cannot fabricate the original input", async () => {
  store.transactionLoss = "admission_after"; await run();
  const { consumerRecoveryInput: omitted, ...legacy } = operations()[0]; void omitted; store.seed(legacy);
  expect(JSON.parse((await discover()).body).data.disposition).toBe("unrecoverable");
  expect(current().mutationOperationId).toBe(operationId);
});
it.each([{ pool: "workforce" }, { actorPersonId: replacementId }, { actorSubject: "fictional-other-subject" }])("another actor's pending input is never exposed: %j", async patch => {
  store.transactionLoss = "admission_after"; await run(); store.seed({ ...operations()[0], ...patch });
  const response = await discover(); expect(JSON.parse(response.body).data.disposition).toBe("other_action");
  expect(JSON.parse(response.body).data).not.toHaveProperty("pending");
});
it.each([{ inputSha256: "wrong" }, { expectedVersion: 3 }, { admittedAt: "invalid" }, { phase: "unknown" }, { organizationId: replacementId }])("corrupt discovery is refused without provider access: %j", async patch => {
  store.transactionLoss = "admission_after"; await run(); store.seed({ ...operations()[0], ...patch });
  expect((await discover()).statusCode).toBe(503); expect(provider).not.toHaveBeenCalled(); expect(secretSend).not.toHaveBeenCalled();
});
it.each(["committed", "refused"])("settlement between request and operation reads is reported as changed: %s", async phase => {
  store.transactionLoss = "admission_after"; await run(); store.seed({ ...operations()[0], phase });
  expect(JSON.parse((await discover()).body).data.disposition).toBe("changed");
});
it("discovery authorizes the current owner before reading any operation", async () => {
  store.transactionLoss = "admission_after"; await run(); send.mockClear();
  expect((await discover(replacementId)).statusCode).toBe(403);
  expect(send.mock.calls.every(([command]) => command.constructor.name !== "GetCommand")).toBe(true);
});
it("the discovery route requires consumer JWT and preserves blocked production", async () => {
  const template = JSON.parse(readFileSync("infra/aws-clinical-core/telehealth-requests-extension.json", "utf8"));
  expect(template.Resources.ConsumerPendingChangeRoute.Properties).toMatchObject({ RouteKey: "POST /clinical-core/consumer/appointments/pending-change",
    AuthorizationType: "JWT", AuthorizerId: { Ref: "ConsumerAuthorizer" } });
  expect((await run({ requestId }, { ...config, runtimeMode: "production" }, "consumer", "pending-change")).statusCode).toBe(503);
});

it("atomically settles cancellation with a durable historical receipt, and a restarted handler performs no second write", async () => {
  const first = await run(); expect(first.statusCode).toBe(200);
  expect(JSON.parse(first.body).data).toMatchObject({ status: "cancelled", version: 5, operationReceipt: { operationId, admittedVersion: 4, committedVersion: 5 } });
  expect(current()).not.toHaveProperty("mutationOperationId"); expect(operations()[0].phase).toBe("committed");
  const writes = store.commands.filter(cmd => /Write|Update|Put/.test(cmd.constructor.name)).length;
  const replay = await run(); expect(replay.statusCode).toBe(200); expect(JSON.parse(replay.body).data.operationReceipt).toEqual(JSON.parse(first.body).data.operationReceipt);
  expect(store.commands.filter(cmd => /Write|Update|Put/.test(cmd.constructor.name))).toHaveLength(writes);
});
it("recovers a lost committed database response without repeating provider work", async () => {
  store.seed(request({ providerMeetingId: "900000001" })); store.transactionLoss = "commit_after";
  expect((await run(cancel(), zoom)).statusCode).toBe(200);
  expect(provider.mock.calls.filter(([url]) => url.includes("/meetings/"))).toHaveLength(1);
  expect((await run(cancel(), zoom)).statusCode).toBe(200);
  expect(provider.mock.calls.filter(([url]) => url.includes("/meetings/"))).toHaveLength(1);
});
it.each(["admission_before", "admission_after"] as const)("an unknown %s receipt sends no provider call or blind second admission", async loss => {
  store.seed(request({ providerMeetingId: "900000001" })); store.transactionLoss = loss;
  expect((await run(cancel(), zoom)).statusCode).toBe(503); expect(provider).not.toHaveBeenCalled();
  if (loss === "admission_after") { expect((await run(cancel(), zoom)).statusCode).toBe(503); expect(provider).not.toHaveBeenCalled(); }
});
it("a provider outcome that is unknown remains fenced across restart and rejects competing workforce, authorization and payment writes", async () => {
  store.seed(request({ providerMeetingId: "900000001" })); provider.mockImplementation(async () => { throw new Error("fictional_unknown_provider_result"); });
  expect((await run(cancel(), zoom)).statusCode).toBe(503); const count = provider.mock.calls.length;
  expect((await run(cancel(), zoom)).statusCode).toBe(503); expect(provider).toHaveBeenCalledTimes(count);
  expect(current().mutationOperationId).toBe(operationId); expect(operations()[0].phase).toBe("effects_started");
  expect((await run(cancel({ operationId: holdId }), zoom, "workforce")).statusCode).toBe(409);
  expect((await run({ requestId, expectedVersion: 4, policyVersion: "telehealth-payments/1", authorized: false }, config, "consumer", "payment-authorizations")).statusCode).toBe(409);
  expect((await run({ requestId, expectedVersion: 4, action: "charge", amountMinor: 15000, serviceDelivered: true }, stripe, "workforce", "payments")).statusCode).toBe(409);
  expect(provider).toHaveBeenCalledTimes(count);
});
it("a lost final transaction that did not commit retains pending state instead of inferring success from provider cleanup", async () => {
  store.transactionLoss = "commit_before";
  expect((await run()).statusCode).toBe(503); expect(current().status).toBe("scheduled"); expect(current().mutationOperationId).toBe(operationId);
  expect((await run()).statusCode).toBe(503);
});
it("binds a supplied operation to its exact input, caller subject and role", async () => {
  expect((await run()).statusCode).toBe(200);
  expect((await run(cancel({ action: "request_reschedule", slotId: replacementId, holdId }))).statusCode).toBe(409);
  expect((await run(cancel(), config, "workforce")).statusCode).toBe(409);
  expect((await run(cancel(), config, "consumer", "actions", replacementId)).statusCode).toBe(409);
});
it.each([{}, { operationProtocol: "appointment-change/2" }, { operationId: "not-a-uuid" }])("refuses incomplete or unknown protocol before any database access", patch => {
  const input = cancel(patch); if (Object.keys(patch).length === 0) delete (input as Partial<typeof input>).operationProtocol;
  return run(input).then(result => { expect(result.statusCode).toBe(400); expect(send).not.toHaveBeenCalled(); expect(secretSend).not.toHaveBeenCalled(); });
});
it("canonical property order and a deterministic legacy identity do not change replay binding", async () => {
  const input = { requestId, expectedVersion: 4, action: "cancel" };
  const first = await run(input as ReturnType<typeof cancel>); expect(first.statusCode).toBe(200);
  expect(JSON.parse(first.body).data).not.toHaveProperty("operationReceipt");
  expect((await run({ action: "cancel", expectedVersion: 4, requestId } as ReturnType<typeof cancel>)).statusCode).toBe(200);
  expect(operations()).toHaveLength(1);
  expect(operations()[0].operationId).toBe(appointmentOperationIdentity("consumer", owner, "fictional-consumer", "consumer_action", input).operationId);
});
it("reserves the exact replacement before provider cleanup and commits it without depending on hold expiry", async () => {
  store.seed(request({ providerMeetingId: "900000001" }));
  provider.mockImplementation(async (url: string) => {
    if (url.includes("/meetings/")) {
      const reserved = store.get(replacement())!; expect(reserved).toMatchObject({ status: "booked", mutationOperationId: operationId });
      store.seed({ ...reserved, holdExpiresAt: 1 });
    }
    return new Response(JSON.stringify(url.includes("oauth/token") ? { access_token: "fictional" } : {}));
  });
  const result = await run(cancel({ action: "request_reschedule", slotId: replacementId, holdId }), zoom);
  expect(result.statusCode).toBe(200); expect(current()).toMatchObject({ status: "reschedule_requested", slotId: replacementId, version: 5 });
  expect(store.get(slot())!.status).toBe("available"); expect(store.get(replacement())).not.toHaveProperty("mutationOperationId");
});
it("unknown replacement admission keeps both request and replacement fenced and never deletes a meeting", async () => {
  store.seed(request({ providerMeetingId: "900000001" })); store.transactionLoss = "reservation_after";
  const result = await run(cancel({ action: "request_reschedule", slotId: replacementId, holdId }), zoom);
  expect(result.statusCode).toBe(503); expect(provider).not.toHaveBeenCalled();
  expect(current().mutationOperationId).toBe(operationId); expect(store.get(replacement())!.mutationOperationId).toBe(operationId);
});
it.each(["in_visit", "ending", "ended"])("does not cancel a %s visit or certify shutdown by deleting its provider meeting", async status => {
  store.seed(request({ appointmentId, providerMeetingId: "900000001" }), { pk: `ORG#${org}`, sk: `VISIT#${appointmentId}`, appointmentId, version: 2, status });
  expect((await run(cancel(), zoom)).statusCode).toBe(409); expect(provider).not.toHaveBeenCalled(); expect(operations()).toHaveLength(0);
});
it("read-only request data does not expose fences, immutable input hashes or provider credentials", async () => {
  const result = await run(); expect(result.statusCode).toBe(200);
  const value = JSON.parse(result.body).data;
  for (const key of ["mutationOperationId", "bookingInputSha256", "inputSha256", "actorSubject", "consumerEmail"]) expect(value).not.toHaveProperty(key);
});
it("known validation refusal is an atomic receipt and unlocks without provider work", async () => {
  const invalid = cancel({ action: "invented" });
  expect((await run(invalid)).statusCode).toBe(400); expect(operations()[0].phase).toBe("refused"); expect(current()).not.toHaveProperty("mutationOperationId");
  expect((await run(invalid)).statusCode).toBe(400); expect(provider).not.toHaveBeenCalled();
});
const outcome = (input: Record<string, unknown> = cancel(), kind = "consumer_action", person = owner, cfg = config) =>
  run({ kind, input }, cfg, "consumer", "change-outcome", person);
it("reads an exact committed outcome without provider calls or a second write after later changes", async () => {
  expect((await run()).statusCode).toBe(200);
  store.seed({ ...current(), version: 8 });
  const writes = store.commands.filter(cmd => /Write|Update|Put/.test(cmd.constructor.name)).length;
  const result = await outcome(); expect(result.statusCode).toBe(200);
  expect(JSON.parse(result.body).data).toMatchObject({ protocol: "appointment-disposition/1", disposition: "committed",
    requestId, organizationId: org, operationId, expectedVersion: 4, receipt: { admittedVersion: 4, committedVersion: 5 } });
  expect(store.commands.filter(cmd => /Write|Update|Put/.test(cmd.constructor.name))).toHaveLength(writes);
  expect(provider).not.toHaveBeenCalled(); expect(secretSend).not.toHaveBeenCalled();
});
it("issues a durable no-effects refusal and status never depends on the current appointment status", async () => {
  const input = cancel({ action: "invented" });
  expect((await run(input)).statusCode).toBe(400);
  expect(operations()[0]).toMatchObject({ phase: "refused", dispositionProtocol: "appointment-disposition/1", sideEffects: "none" });
  store.seed({ ...current(), status: "cancelled", version: 10 });
  const result = await outcome(input);
  expect(JSON.parse(result.body).data).toMatchObject({ disposition: "refused", refusal: { category: "request_invalid", sideEffects: "none", requestVersion: 4 } });
  expect(provider).not.toHaveBeenCalled(); expect(secretSend).not.toHaveBeenCalled();
});
it("supports exact authorization refusal without treating refusal as billing consent", async () => {
  const input = { requestId, expectedVersion: 4, policyVersion: "telehealth-payments/1", authorized: true, operationId, operationProtocol: "appointment-change/1" };
  expect((await run(input, config, "consumer", "payment-authorizations")).statusCode).toBe(503);
  expect(JSON.parse((await outcome(input, "authorize")).body).data).toMatchObject({ disposition: "refused", refusal: { category: "provider_unavailable" } });
  expect(current().paymentAuthorizationStatus).toBe("authorized");
  expect(provider).not.toHaveBeenCalled(); expect(secretSend).not.toHaveBeenCalled();
});
it("an absent row is unobserved, not refused or permission for a new identity", async () => {
  const result = await outcome(); expect(result.statusCode).toBe(200);
  expect(JSON.parse(result.body).data.disposition).toBe("unobserved"); expect(operations()).toHaveLength(0);
  expect(store.commands.every(cmd => /Get|Query/.test(cmd.constructor.name))).toBe(true);
});
it.each(["admission_after", "commit_before", "reservation_after"] as const)("%s remains pending with no observation writes", async loss => {
  store.transactionLoss = loss;
  const input = loss === "reservation_after" ? cancel({ action: "request_reschedule", slotId: replacementId, holdId }) : cancel();
  expect((await run(input)).statusCode).toBe(503);
  const before = JSON.stringify([...store.rows]);
  expect(JSON.parse((await outcome(input)).body).data.disposition).toBe("pending");
  expect(JSON.stringify([...store.rows])).toBe(before); expect(provider).not.toHaveBeenCalled();
});
it("unknown provider work stays pending regardless of elapsed time", async () => {
  store.seed(request({ providerMeetingId: "900000001" })); provider.mockRejectedValue(new Error("fictional_unknown"));
  expect((await run(cancel(), zoom)).statusCode).toBe(503);
  store.seed({ ...operations()[0], admittedAt: "2000-01-01T00:00:00.000Z" }); const count = provider.mock.calls.length;
  expect(JSON.parse((await outcome()).body).data.disposition).toBe("pending");
  expect(provider).toHaveBeenCalledTimes(count); expect(current().mutationOperationId).toBe(operationId);
});
it.each([{ dispositionProtocol: undefined }, { sideEffects: "unknown" }, { reservedSlotKey: { pk: `ORG#${org}`, sk: "SLOT#x" } },
  { committedVersion: 5 }, { committedAt: "invalid" }, { refusal: "service_unavailable" }])("a legacy or contradictory refused receipt cannot clear recovery: %j", async patch => {
  const input = cancel({ action: "invented" }); await run(input);
  store.seed({ ...operations()[0], ...patch });
  expect(JSON.parse((await outcome(input)).body).data.disposition).toBe("pending");
});
it.each([{ action: "request_reschedule", slotId: replacementId, holdId }, { expectedVersion: 3 }])("outcome refuses changed saved input: %j", async patch => {
  await run(); expect((await outcome(cancel(patch))).statusCode).toBe(409);
});
it("checks current owner before reading an operation and rejects caller subject or clinic substitution", async () => {
  await run(); send.mockClear();
  expect((await outcome(cancel(), "consumer_action", replacementId)).statusCode).toBe(403);
  expect(send.mock.calls.every(([cmd]) => cmd.constructor.name !== "GetCommand")).toBe(true);
  const altered = event({ kind: "consumer_action", input: cancel() }, "consumer", "change-outcome");
  const alteredClaims = (altered as unknown as { requestContext: { authorizer: { jwt: { claims: Record<string, string> } } } }).requestContext.authorizer.jwt.claims;
  alteredClaims.sub = "fictional-other-subject";
  expect((await createTelehealthHandler(config)(altered)).statusCode).toBe(409);
  alteredClaims.sub = "fictional-consumer";
  alteredClaims["custom:organization_id"] = replacementId;
  expect((await createTelehealthHandler(config)(altered)).statusCode).toBe(404);
});
it.each([{ kind: "payment", input: cancel() }, { kind: "consumer_action", input: { ...cancel(), operationProtocol: "wrong" } },
  { kind: "consumer_action", input: { ...cancel(), unexpected: true } }])("refuses invalid observation before database access: %j", async input => {
  expect((await run(input, config, "consumer", "change-outcome")).statusCode).toBe(400); expect(send).not.toHaveBeenCalled();
});
it("a lost refusal settlement response still exposes only the same no-effects receipt", async () => {
  store.transactionLoss = "commit_after"; const input = cancel({ action: "invented" });
  expect((await run(input)).statusCode).toBe(400);
  expect(JSON.parse((await outcome(input)).body).data.disposition).toBe("refused");
});
it("the published outcome route requires consumer JWT and does not open an unauthenticated status surface", () => {
  const template = JSON.parse(readFileSync("infra/aws-clinical-core/telehealth-requests-extension.json", "utf8"));
  expect(template.Resources.ConsumerChangeOutcomeRoute.Properties).toMatchObject({
    RouteKey: "POST /clinical-core/consumer/appointments/change-outcome", AuthorizationType: "JWT", AuthorizerId: { Ref: "ConsumerAuthorizer" } });
});
it.each(["effects_started", "reservedSlotKey"])("refusal settlement cannot certify no-effects after durable %s evidence appears", async state => {
  send.mockImplementation(async command => {
    if (command.constructor.name === "TransactWriteCommand" && command.input.TransactItems.some((part: { Update?: { UpdateExpression?: string } }) => part.Update?.UpdateExpression?.includes("refusal=:refusal"))) {
      const row = operations()[0]; store.seed({ ...row, ...(state === "effects_started" ? { phase: "effects_started" } : { reservedSlotKey: { pk: `ORG#${org}`, sk: "SLOT#x" } }) });
    }
    return store.send(command);
  });
  expect((await run(cancel({ action: "invented" }))).statusCode).toBe(503);
  expect(operations()[0].phase).not.toBe("refused"); expect(current().mutationOperationId).toBe(operationId);
  expect(JSON.parse((await outcome(cancel({ action: "invented" }))).body).data.disposition).toBe("pending");
});
it("the outcome cannot bypass production activation", async () => {
  expect((await outcome(cancel(), "consumer_action", owner, { ...config, runtimeMode: "production" })).statusCode).toBe(503);
  expect(send).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled();
});
it("historical receipts survive later versions without pretending to be current scheduling authority", async () => {
  expect((await run()).statusCode).toBe(200); store.seed({ ...current(), version: 8, paymentStatus: "paid" });
  const result = await run(); expect(JSON.parse(result.body).data).toMatchObject({ version: 8, paymentStatus: "paid", operationReceipt: { committedVersion: 5 } });
});
it("a charge is admitted before Stripe and its lost final receipt is recovered without a second charge", async () => {
  store.seed({ pk: `ORG#${org}`, sk: `PAYMENT_PROFILE#${owner}`, organizationId: org, consumerPersonId: owner,
    stripeCustomerId: "cus_fictional", stripePaymentMethodId: "pm_fictional", status: "active" });
  store.transactionLoss = "commit_after";
  const input = cancel({ action: "charge", amountMinor: 15000, serviceDelivered: true });
  expect((await run(input, stripe, "workforce", "payments")).statusCode).toBe(200);
  expect((await run(input, stripe, "workforce", "payments")).statusCode).toBe(200);
  expect(provider).toHaveBeenCalledTimes(1); expect(current()).toMatchObject({ paymentStatus: "processing", paymentIntentId: "pi_fictional" });
});
it("a concurrent staff change cannot reach Zoom while the consumer's admitted delete is running", async () => {
  store.seed(request({ providerMeetingId: "900000001" }));
  let release!: () => void; let entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  provider.mockImplementation(async (url: string) => {
    if (url.includes("/meetings/")) { entered(); await gate; }
    return new Response(JSON.stringify(url.includes("oauth/token") ? { access_token: "fictional" } : {}));
  });
  const first = run(cancel(), zoom); await enteredPromise;
  expect((await run(cancel({ action: "reschedule", operationId: holdId, scheduledStart: "2026-11-11T17:00:00.000Z",
    scheduledEnd: "2026-11-11T17:30:00.000Z", timeZone: "America/Los_Angeles" }), zoom, "workforce")).statusCode).toBe(409);
  release(); expect((await first).statusCode).toBe(200);
  expect(provider.mock.calls.filter(([url]) => url.includes("/meetings/"))).toHaveLength(1);
});
it("a withdrawn consent written during cleanup is preserved in the same settled visit", async () => {
  const key = { pk: `ORG#${org}`, sk: `VISIT#${appointmentId}` };
  store.seed(request({ appointmentId, providerMeetingId: "900000001" }), { ...key, appointmentId, requestId, organizationId: org,
    consumerPersonId: owner, status: "scheduled", version: 2, meetingLease: null, providerMeetingId: "900000001", providerMeetingUuid: "fictional-instance",
    joinUrl: "https://zoom.us/j/900000001", passcode: "fictional-passcode", consents: [{ consentId: "fictional", status: "granted" }],
    quickNotes: "Fictional retained note", noteHistory: [], note: null });
  provider.mockImplementation(async (url: string) => {
    if (url.includes("/meetings/")) {
      const fenced = store.get(key)!;
      expect(fenced.mutationOperationId).toBe(operationId);
      store.seed({ ...fenced, version: Number(fenced.version) + 1, consents: [{ consentId: "fictional", status: "withdrawn" }] });
    }
    return new Response(JSON.stringify(url.includes("oauth/token") ? { access_token: "fictional" } : {}));
  });
  expect((await run(cancel(), zoom)).statusCode).toBe(200);
  expect(store.get(key)).toMatchObject({ status: "cancelled", consents: [{ status: "withdrawn" }], quickNotes: "Fictional retained note" });
  expect(store.get(key)).not.toHaveProperty("mutationOperationId");
});
it("removing a non-calendar fence advances the visit version so a stale withdrawal cannot restore it", async () => {
  const key = { pk: `ORG#${org}`, sk: `VISIT#${appointmentId}` };
  store.seed(request({ appointmentId }), { ...key, appointmentId, requestId, organizationId: org, version: 2, status: "scheduled", meetingLease: null });
  const result = await run({ requestId, expectedVersion: 4, policyVersion: "telehealth-payments/1", authorized: false }, config, "consumer", "payment-authorizations");
  expect(result.statusCode).toBe(200); expect(store.get(key)).toMatchObject({ version: 4 });
  expect(store.get(key)).not.toHaveProperty("mutationOperationId");
  await expect(store.send({ constructor: { name: "PutCommand" }, input: { Item: { ...store.get(key), version: 4, mutationOperationId: operationId },
    ConditionExpression: "#version=:expected", ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: { ":expected": 3 } } }))
    .rejects.toMatchObject({ name: "ConditionalCheckFailedException" });
});
it("workforce meeting creation with an unknown result is never repeated by replay or elapsed time", async () => {
  store.seed(request({ status: "requested" }));
  provider.mockImplementation(async (url: string) => {
    if (url.includes("oauth/token")) return new Response(JSON.stringify({ access_token: "fictional" }));
    throw new Error("fictional_lost_create_response");
  });
  const input = cancel({ action: "schedule", scheduledStart: "2026-11-10T17:00:00.000Z", scheduledEnd: "2026-11-10T17:30:00.000Z", timeZone: "America/Los_Angeles" });
  expect((await run(input, zoom, "workforce")).statusCode).toBe(503); const calls = provider.mock.calls.length;
  expect((await run(input, zoom, "workforce")).statusCode).toBe(503); expect(provider).toHaveBeenCalledTimes(calls);
  expect(operations()[0]).toMatchObject({ phase: "effects_started" }); expect(current()).toHaveProperty("mutationOperationId", operationId);
});
