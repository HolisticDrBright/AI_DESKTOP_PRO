import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const { send, secretsSend } = vi.hoisted(() => ({ send: vi.fn(), secretsSend: vi.fn() }));
const secretSend = secretsSend;

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class DynamoDBClient {},
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send }) },
  GetCommand: class GetCommand { constructor(readonly input: unknown) {} },
  PutCommand: class PutCommand { constructor(readonly input: unknown) {} },
  QueryCommand: class QueryCommand { constructor(readonly input: unknown) {} },
  TransactWriteCommand: class TransactWriteCommand { constructor(readonly input: unknown) {} },
  UpdateCommand: class UpdateCommand { constructor(readonly input: unknown) {} },
}));

vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: class SecretsManagerClient { send = secretsSend; },
  GetSecretValueCommand: class GetSecretValueCommand { constructor(readonly input: unknown) {} },
}));

vi.mock("@aws-sdk/client-sesv2", () => ({
  SESv2Client: class SESv2Client { send = vi.fn(); },
  SendEmailCommand: class SendEmailCommand { constructor(readonly input: unknown) {} },
}));

vi.mock("@aws-sdk/client-scheduler", () => ({
  SchedulerClient: class SchedulerClient { send = vi.fn(); },
  CreateScheduleCommand: class CreateScheduleCommand { constructor(readonly input: unknown) {} },
  DeleteScheduleCommand: class DeleteScheduleCommand { constructor(readonly input: unknown) {} },
}));

import { createTelehealthHandler, signMeetingSdkJwt, type TelehealthConfiguration } from "./aws-telehealth-requests";

const config: TelehealthConfiguration = {
  tableName: "synthetic-appointments",
  consumerIssuer: "https://cognito-idp.us-east-2.amazonaws.com/us-east-2_consumer",
  consumerAudience: "consumer-client",
  workforceIssuer: "https://cognito-idp.us-east-2.amazonaws.com/us-east-2_workforce",
  workforceAudience: "workforce-client",
  runtimeMode: "synthetic",
  phiAllowed: false,
  zoomEnabled: false,
  zoomBaaVerified: false,
  zoomSecretArn: "",
  remindersEnabled: false,
  reminderSender: "",
  reminderConfigurationSet: "",
  reminderScheduleGroup: "",
  reminderSchedulerRoleArn: "",
  reminderTargetArn: "",
  reminderEventsTopicArn: "",
  stripeTestEnabled: false,
  stripeSecretArn: "",
  stripeSuccessUrl: "",
  stripeCancelUrl: "",
};

const claims = {
  iss: config.consumerIssuer,
  aud: config.consumerAudience,
  token_use: "id",
  sub: "synthetic-consumer-1234",
  email: "synthetic.consumer@example.test",
  "custom:person_id": "11111111-1111-4111-8111-111111111111",
  "custom:organization_id": "22222222-2222-4222-8222-222222222222",
  "custom:synthetic_attested": "true",
  "custom:production_bound": "false",
};

const workforceClaims = {
  ...claims,
  iss: config.workforceIssuer,
  aud: config.workforceAudience,
  sub: "synthetic-workforce-1234",
};

function event(routeKey: string, body?: Record<string, unknown>, suppliedClaims = claims) {
  return {
    routeKey,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    requestContext: { authorizer: { jwt: { claims: suppliedClaims } } },
  } as never;
}

const processingItem = () => ({
  pk: `ORG#${workforceClaims["custom:organization_id"]}`, sk: "REQ#2026-09-01T00:00:00.000Z#33333333-3333-4333-8333-333333333333",
  gsi1pk: `PERSON#${claims["custom:person_id"]}`, gsi1sk: "REQ#2026-09-01T00:00:00.000Z#33333333-3333-4333-8333-333333333333",
  requestId: "33333333-3333-4333-8333-333333333333", organizationId: workforceClaims["custom:organization_id"], consumerPersonId: claims["custom:person_id"],
  consumerEmail: claims.email, status: "scheduled", visitType: "follow_up", preferredSlots: ["2026-09-03T17:00:00.000Z"], timeZone: "America/Los_Angeles",
  note: null, scheduledStart: "2026-09-03T17:00:00.000Z", scheduledEnd: "2026-09-03T17:45:00.000Z", joinUrl: null, providerMeetingId: null, version: 4, createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z", lastActionBy: "workforce", slotId: "55555555-5555-4555-8555-555555555555", appointmentId: "66666666-6666-4666-8666-666666666666",
  priceMinor: 15000, currency: "USD", cancellationPolicy: "Cancel at least 24 hours before the visit.", cancellationWindowHours: 24, cancellationFeeDueMinor: 0,
  reminderStatus: "disabled", paymentPolicyVersion: "telehealth-payments/1", paymentAuthorizationStatus: "authorized", paymentStatus: "processing",
  paymentIntentId: "pi_synthetic_1", paidMinor: 0, refundedMinor: 0,
});
const stripeConfig: TelehealthConfiguration = { ...config, stripeTestEnabled: true, stripeSecretArn: "arn:aws:secretsmanager:us-east-2:111122223333:secret:synthetic-stripe",
  stripeSuccessUrl: "https://ailongevitypro.app/appointments/payment-complete", stripeCancelUrl: "https://ailongevitypro.app/appointments/payment-cancelled" };
function stripeIntent(patch: Record<string, unknown>) {
  return { id: "pi_synthetic_1", livemode: false, status: "processing", amount_received: 0,
    metadata: { organization_id: workforceClaims["custom:organization_id"], request_id: "33333333-3333-4333-8333-333333333333" }, ...patch };
}
describe("workforce payment failure reconciliation", () => {
  beforeEach(() => { send.mockReset(); secretSend.mockReset(); secretSend.mockResolvedValue({ SecretString: JSON.stringify({ secretKey: "sk_test_synthetic", webhookSecret: "whsec_synthetic" }) }); });
  const reconcile = (intent: Record<string, unknown>, expectedVersion = 4, ok = true) => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok, json: async () => intent })));
    return createTelehealthHandler(stripeConfig)(event("POST /clinical-core/workforce/appointments/payments", { requestId: "33333333-3333-4333-8333-333333333333", action: "reconcile", expectedVersion }, workforceClaims));
  };
  it("settles a processing charge from the official intent only when its metadata names this request", async () => {
    send.mockResolvedValueOnce({ Items: [processingItem()] }).mockResolvedValueOnce({});
    const paid = await reconcile(stripeIntent({ status: "succeeded", amount_received: 15000 }));
    expect(paid.statusCode).toBe(200);
    expect(JSON.parse(paid.body ?? "{}").data).toMatchObject({ reconciliation: "settled_paid", paymentStatus: "paid", paidMinor: 15000, version: 5 });
    send.mockReset(); send.mockResolvedValueOnce({ Items: [processingItem()] });
    const foreign = await reconcile(stripeIntent({ status: "succeeded", amount_received: 15000, metadata: { organization_id: workforceClaims["custom:organization_id"], request_id: "44444444-4444-4444-8444-444444444444" } }));
    expect(foreign.statusCode).toBe(503); expect(send).toHaveBeenCalledTimes(1);
  });
  it("records a terminal failure, leaves unfinished intents untouched and refuses stale versions or overpayment", async () => {
    send.mockResolvedValueOnce({ Items: [processingItem()] }).mockResolvedValueOnce({});
    expect(JSON.parse((await reconcile(stripeIntent({ status: "requires_payment_method", last_payment_error: { code: "card_declined" } }))).body ?? "{}").data).toMatchObject({ reconciliation: "settled_failed", paymentStatus: "failed" });
    send.mockReset(); send.mockResolvedValueOnce({ Items: [processingItem()] });
    expect(JSON.parse((await reconcile(stripeIntent({ status: "requires_action" }))).body ?? "{}").data).toMatchObject({ reconciliation: "still_processing", paymentStatus: "processing" });
    expect(send).toHaveBeenCalledTimes(1);
    send.mockReset(); send.mockResolvedValueOnce({ Items: [processingItem()] });
    expect((await reconcile(stripeIntent({ status: "succeeded", amount_received: 15000 }), 3)).statusCode).toBe(409);
    send.mockReset(); send.mockResolvedValueOnce({ Items: [processingItem()] });
    expect((await reconcile(stripeIntent({ status: "succeeded", amount_received: 99999 }))).statusCode).toBe(503);
  });
  it("does nothing for a request that is not processing and refuses without the Stripe test boundary", async () => {
    send.mockResolvedValueOnce({ Items: [{ ...processingItem(), paymentStatus: "paid", paidMinor: 15000 }] });
    expect(JSON.parse((await reconcile(stripeIntent({}))).body ?? "{}").data).toMatchObject({ reconciliation: "not_processing", paymentStatus: "paid" });
    send.mockReset(); send.mockResolvedValueOnce({ Items: [processingItem()] });
    const disabled = await createTelehealthHandler(config)(event("POST /clinical-core/workforce/appointments/payments", { requestId: "33333333-3333-4333-8333-333333333333", action: "reconcile", expectedVersion: 4 }, workforceClaims));
    expect(disabled.statusCode).toBe(503); expect(secretSend).not.toHaveBeenCalled();
  });
});

describe("AWS telehealth request boundary", () => {
  beforeEach(() => { send.mockReset(); vi.unstubAllGlobals(); });

  it("refuses production traffic until the PHI activation gate is opened", async () => {
    const handler = createTelehealthHandler({ ...config, runtimeMode: "production" });
    const result = await handler(event("GET /clinical-core/consumer/appointments/requests"));
    expect(result.statusCode).toBe(503);
    expect(JSON.parse(result.body ?? "{}")).toEqual({ error: "production_not_activated", phiAllowed: false });
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects an identity without the synthetic attestation", async () => {
    const handler = createTelehealthHandler(config);
    const result = await handler(event("GET /clinical-core/consumer/appointments/requests", undefined, {
      ...claims,
      "custom:synthetic_attested": "false",
    }));
    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body ?? "{}")).toEqual({ error: "identity_refused" });
    expect(send).not.toHaveBeenCalled();
  });

  it("creates a synthetic request without inventing a meeting link", async () => {
    send.mockResolvedValueOnce({ Items: [{
      pk: `ORG#${claims["custom:organization_id"]}`,
      sk: "SLOT#2026-09-03T17:00:00.000Z#33333333-3333-4333-8333-333333333333",
      slotId: "33333333-3333-4333-8333-333333333333",
      organizationId: claims["custom:organization_id"],
      start: "2026-09-03T17:00:00.000Z", end: "2026-09-03T17:45:00.000Z", timeZone: "America/Los_Angeles",
      visitTypes: ["follow_up"], priceMinor: 15000, currency: "USD", cancellationPolicy: "Cancel at least 24 hours before the visit.", cancellationWindowHours: 24,
      status: "held", heldBy: claims["custom:person_id"], holdId: "44444444-4444-4444-8444-444444444444",
      holdExpiresAt: Math.floor(Date.now() / 1000) + 600, createdAt: "2026-09-01T00:00:00.000Z", createdBy: "synthetic-workforce-1234",
    }] }).mockResolvedValueOnce({});
    const handler = createTelehealthHandler(config);
    const result = await handler(event("POST /clinical-core/consumer/appointments/requests", {
      visitType: "follow_up",
      slotId: "33333333-3333-4333-8333-333333333333",
      holdId: "44444444-4444-4444-8444-444444444444",
      note: "Synthetic persona appointment request.",
    }));
    const payload = JSON.parse(result.body ?? "{}") as { data?: Record<string, unknown> };
    expect(result.statusCode).toBe(201);
    expect(payload.data).toMatchObject({ status: "requested", joinUrl: null, providerMeetingId: null });
    expect(payload.data).not.toHaveProperty("consumerPersonId");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("will not enable Zoom without an independently recorded BAA gate", () => {
    expect(() => createTelehealthHandler({ ...config, zoomEnabled: true, zoomSecretArn: "secret" }))
      .toThrow("telehealth_configuration_invalid");
  });

  it("will not enable Stripe without an exact test secret and hosted return URLs", () => {
    expect(() => createTelehealthHandler({ ...config, stripeTestEnabled: true }))
      .toThrow("telehealth_configuration_invalid");
  });

  it("will not enable reminders without the exact sender, scheduler group, role, and target", () => {
    expect(() => createTelehealthHandler({ ...config, remindersEnabled: true }))
      .toThrow("telehealth_configuration_invalid");
  });

  it("grants the runtime the exact table read needed for payment profiles", () => {
    const template = JSON.parse(readFileSync(
      "infra/aws-clinical-core/telehealth-requests-extension.json",
      "utf8",
    )) as { Resources: { TelehealthRole: { Properties: { Policies: Array<Record<string, unknown>> } } } };
    const appointmentPolicy = template.Resources.TelehealthRole.Properties.Policies.find(
      (policy) => policy.PolicyName === "AppointmentQueue",
    ) as { PolicyDocument?: { Statement?: Array<{ Action?: string[] }> } } | undefined;
    expect(appointmentPolicy?.PolicyDocument?.Statement?.[0]?.Action).toContain("dynamodb:GetItem");
  });

  it("reports card setup as unavailable rather than inventing a card", async () => {
    const result = await createTelehealthHandler(config)(event("POST /clinical-core/consumer/appointments/payment-methods/setup", {}));
    expect(result.statusCode).toBe(503);
    expect(JSON.parse(result.body ?? "{}")).toEqual({ error: "provider_unavailable" });
    expect(send).not.toHaveBeenCalled();
  });

  it("shows only real, unbooked staff-published openings", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const end = new Date(Date.now() + 86_400_000 + 2_700_000).toISOString();
    const base = { pk: `ORG#${claims["custom:organization_id"]}`, organizationId: claims["custom:organization_id"], start: future, end, timeZone: "America/Los_Angeles", visitTypes: ["follow_up"], priceMinor: 15000, currency: "USD", cancellationPolicy: "Cancel at least 24 hours before the visit.", cancellationWindowHours: 24, heldBy: null, holdId: null, createdAt: new Date().toISOString(), createdBy: workforceClaims.sub };
    send.mockResolvedValueOnce({ Items: [
      { ...base, sk: `SLOT#${future}#33333333-3333-4333-8333-333333333333`, slotId: "33333333-3333-4333-8333-333333333333", status: "available", holdExpiresAt: null },
      { ...base, sk: `SLOT#${future}#44444444-4444-4444-8444-444444444444`, slotId: "44444444-4444-4444-8444-444444444444", status: "booked", holdExpiresAt: null },
    ] });
    const result = await createTelehealthHandler(config)(event(CONSUMER_AVAILABILITY_TEST, { visitType: "follow_up" }));
    const payload = JSON.parse(result.body ?? "{}") as { data: Array<{ slotId: string }> };
    expect(result.statusCode).toBe(200);
    expect(payload.data.map((slot) => slot.slotId)).toEqual(["33333333-3333-4333-8333-333333333333"]);
  });

  it("creates a ten-minute ownership-bound slot hold", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    send.mockResolvedValueOnce({ Items: [{ pk: `ORG#${claims["custom:organization_id"]}`, sk: `SLOT#${future}#33333333-3333-4333-8333-333333333333`, slotId: "33333333-3333-4333-8333-333333333333", organizationId: claims["custom:organization_id"], start: future, end: new Date(Date.now()+90_000_000).toISOString(), timeZone: "America/Los_Angeles", visitTypes: ["follow_up"], priceMinor: 15000, currency: "USD", cancellationPolicy: "Cancel at least 24 hours before the visit.", cancellationWindowHours: 24, status: "available", heldBy: null, holdId: null, holdExpiresAt: null, createdAt: new Date().toISOString(), createdBy: workforceClaims.sub }] }).mockResolvedValueOnce({});
    const result = await createTelehealthHandler(config)(event("POST /clinical-core/consumer/appointments/holds", { slotId: "33333333-3333-4333-8333-333333333333", visitType: "follow_up" }));
    const payload = JSON.parse(result.body ?? "{}") as { data: { holdId: string; expiresAt: string } };
    expect(result.statusCode).toBe(201);
    expect(payload.data.holdId).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(payload.data.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("will not revive a cancelled request from the workforce queue", async () => {
    send.mockResolvedValueOnce({ Items: [{
      pk: `ORG#${workforceClaims["custom:organization_id"]}`,
      sk: "REQ#2026-09-01T00:00:00.000Z#33333333-3333-4333-8333-333333333333",
      gsi1pk: `PERSON#${claims["custom:person_id"]}`,
      gsi1sk: "REQ#2026-09-01T00:00:00.000Z#33333333-3333-4333-8333-333333333333",
      requestId: "33333333-3333-4333-8333-333333333333",
      organizationId: workforceClaims["custom:organization_id"],
      consumerPersonId: claims["custom:person_id"],
      status: "cancelled",
      visitType: "follow_up",
      preferredSlots: ["2026-09-03T17:00:00.000Z"],
      timeZone: "America/Los_Angeles",
      note: null,
      scheduledStart: null,
      scheduledEnd: null,
      joinUrl: null,
      providerMeetingId: null,
      version: 2,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      lastActionBy: "consumer",
    }] });
    const handler = createTelehealthHandler(config);
    const result = await handler(event("POST /clinical-core/workforce/appointments/actions", {
      requestId: "33333333-3333-4333-8333-333333333333",
      action: "schedule",
      expectedVersion: 2,
      scheduledStart: "2026-09-03T17:00:00.000Z",
      scheduledEnd: "2026-09-03T17:45:00.000Z",
      timeZone: "America/Los_Angeles",
    }, workforceClaims));
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body ?? "{}")).toEqual({ error: "conflict" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("aliases DynamoDB's reserved timeZone name when scheduling the canonical appointment", async () => {
    send.mockResolvedValueOnce({ Items: [{
      pk: `ORG#${workforceClaims["custom:organization_id"]}`, sk: "REQ#2026-09-01T00:00:00.000Z#33333333-3333-4333-8333-333333333333",
      gsi1pk: `PERSON#${claims["custom:person_id"]}`, gsi1sk: "REQ#2026-09-01T00:00:00.000Z#33333333-3333-4333-8333-333333333333",
      requestId: "33333333-3333-4333-8333-333333333333", organizationId: workforceClaims["custom:organization_id"], consumerPersonId: claims["custom:person_id"],
      consumerEmail: claims.email, status: "requested", visitType: "follow_up", preferredSlots: ["2026-09-03T17:00:00.000Z"], timeZone: "America/Los_Angeles",
      note: null, scheduledStart: null, scheduledEnd: null, joinUrl: null, providerMeetingId: null, version: 1, createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z", lastActionBy: "consumer", slotId: "55555555-5555-4555-8555-555555555555", appointmentId: null,
      priceMinor: 15000, currency: "USD", cancellationPolicy: "Cancel at least 24 hours before the visit.", cancellationWindowHours: 24, cancellationFeeDueMinor: 0,
      reminderStatus: "disabled", paymentPolicyVersion: "telehealth-payments/1", paymentAuthorizationStatus: "not_authorized", paymentStatus: "not_due",
      paymentIntentId: null, paidMinor: 0, refundedMinor: 0,
    }] }).mockResolvedValueOnce({});
    const result = await createTelehealthHandler(config)(event("POST /clinical-core/workforce/appointments/actions", {
      requestId: "33333333-3333-4333-8333-333333333333", action: "schedule", expectedVersion: 1,
      scheduledStart: "2026-09-03T17:00:00.000Z", scheduledEnd: "2026-09-03T17:45:00.000Z", timeZone: "America/Los_Angeles",
    }, workforceClaims));
    expect(result.statusCode).toBe(200);
    const command = send.mock.calls[1]?.[0] as { input?: { TransactItems?: Array<{ Update?: { UpdateExpression?: string; ExpressionAttributeNames?: Record<string,string> } }> } };
    expect(command.input?.TransactItems?.[0]?.Update?.UpdateExpression).toContain("#timeZone=:zone");
    expect(command.input?.TransactItems?.[0]?.Update?.ExpressionAttributeNames).toMatchObject({ "#timeZone": "timeZone" });
  });
});

const CONSUMER_AVAILABILITY_TEST = "POST /clinical-core/consumer/appointments/availability";

describe("SES bounce and complaint suppression for appointment reminders", () => {
  const reminders: TelehealthConfiguration = { ...config, remindersEnabled: true, reminderSender: "no-reply@ailongevitypro.app", reminderConfigurationSet: "alp-transactional",
    reminderScheduleGroup: "group", reminderSchedulerRoleArn: "arn:aws:iam::111122223333:role/reminders", reminderTargetArn: "arn:aws:lambda:us-east-2:111122223333:function:telehealth",
    reminderEventsTopicArn: "arn:aws:sns:us-east-2:111122223333:telehealth-reminder-events" };
  const sns = (message: unknown, topic = reminders.reminderEventsTopicArn) => ({ Records: [{ EventSource: "aws:sns", Sns: { TopicArn: topic, Message: JSON.stringify(message) } }] }) as never;
  beforeEach(() => { send.mockReset(); });
  it("records permanent bounces and complaints as hashed suppressions, ignores transient bounces, and never stores the address", async () => {
    send.mockResolvedValue({});
    const handler = createTelehealthHandler(reminders);
    const bounce = await handler(sns({ notificationType: "Bounce", bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "Gone@Example.test" }] } }));
    expect(bounce.statusCode).toBe(200); expect(JSON.parse(bounce.body ?? "{}").data).toEqual({ recorded: 1, ignored: 0 });
    const put = (send.mock.calls[0][0] as { input: { Item: Record<string, unknown> } }).input;
    expect(put.Item).toMatchObject({ pk: "EMAIL_SUPPRESSION", reason: "bounce" });
    expect(String(put.Item.sk)).toMatch(/^[a-f0-9]{64}$/); expect(JSON.stringify(put)).not.toMatch(/example\.test/i);
    const soft = await handler(sns({ notificationType: "Bounce", bounce: { bounceType: "Transient", bouncedRecipients: [{ emailAddress: "busy@example.test" }] } }));
    expect(JSON.parse(soft.body ?? "{}").data).toEqual({ recorded: 0, ignored: 1 });
    const complaint = await handler(sns({ notificationType: "Complaint", complaint: { complainedRecipients: [{ emailAddress: "annoyed@example.test" }] } }));
    expect(JSON.parse(complaint.body ?? "{}").data).toEqual({ recorded: 1, ignored: 0 });
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("refuses notifications from another topic or when reminders are disabled, without writing", async () => {
    const other = await createTelehealthHandler(reminders)(sns({ notificationType: "Complaint", complaint: { complainedRecipients: [{ emailAddress: "x@example.test" }] } }, "arn:aws:sns:us-east-2:111122223333:someone-else"));
    expect(other.statusCode).toBe(400);
    const disabled = await createTelehealthHandler(config)(sns({ notificationType: "Complaint", complaint: { complainedRecipients: [{ emailAddress: "x@example.test" }] } }));
    expect(disabled.statusCode).toBe(503);
    expect(send).not.toHaveBeenCalled();
  });
  it("skips the reminder for a suppressed address and says so; an unsuppressed address is still mailed", async () => {
    const item = { ...processingItem(), status: "scheduled", scheduledStart: "2026-09-03T17:00:00.000Z" };
    const reminder = { internalEvent: "send_appointment_reminder", organizationId: item.organizationId, requestId: item.requestId, scheduledStart: item.scheduledStart } as never;
    send.mockResolvedValueOnce({ Items: [item] }).mockResolvedValueOnce({ Item: { pk: "EMAIL_SUPPRESSION", sk: "hash", reason: "complaint" } });
    const suppressed = await createTelehealthHandler(reminders)(reminder);
    expect(JSON.parse(suppressed.body ?? "{}").data).toEqual({ sent: false, reason: "suppressed" });
    const lookup = (send.mock.calls[1][0] as { input: { Key: Record<string, unknown> } }).input;
    expect(lookup.Key).toEqual({ pk: "EMAIL_SUPPRESSION", sk: expect.stringMatching(/^[a-f0-9]{64}$/) });
    send.mockReset(); send.mockResolvedValueOnce({ Items: [item] }).mockResolvedValueOnce({});
    const mailed = await createTelehealthHandler(reminders)(reminder);
    expect(JSON.parse(mailed.body ?? "{}").data).toEqual({ sent: true });
  });
  it("will not enable reminders without the SNS topic that carries bounces and complaints", () => {
    expect(() => createTelehealthHandler({ ...reminders, reminderEventsTopicArn: "" })).toThrow("telehealth_configuration_invalid");
  });
});

describe("AWS telehealth visit boundary (embedded Zoom + AI Companion notes)", () => {
  beforeEach(() => send.mockReset());
  const APPOINTMENT = "77777777-7777-4777-8777-777777777777";
  const visitRecord = (overrides: Record<string, unknown> = {}) => ({
    pk: `ORG#${workforceClaims["custom:organization_id"]}`, sk: `VISIT#${APPOINTMENT}`, appointmentId: APPOINTMENT,
    organizationId: workforceClaims["custom:organization_id"], requestId: null, status: "scheduled", consents: [],
    providerMeetingId: null, joinUrl: null, passcode: null, startedAt: null, endedAt: null, flags: [], quickNotes: "",
    note: null, version: 1, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", ...overrides,
  });
  const consent = { consentId: "88888888-8888-4888-8888-888888888888", consentType: "telehealth_recording_combined", consentVersion: "2026-10", signerName: "Synthetic Signer", method: "staff_attested", signedAt: "2026-10-01T00:00:00.000Z", recordedBy: workforceClaims["custom:person_id"], patientLocation: "CA" };

  it("registers every visit route behind the workforce authorizer", () => {
    const template = JSON.parse(readFileSync("infra/aws-clinical-core/telehealth-requests-extension.json", "utf8")) as { Resources: Record<string, { Type: string; Properties: { RouteKey?: string; AuthorizerId?: { Ref: string } } }> };
    const routes = Object.values(template.Resources).filter((resource) => resource.Type === "AWS::ApiGatewayV2::Route");
    for (const key of [
      "GET /clinical-core/workforce/appointments/visits", "POST /clinical-core/workforce/appointments/visits/consent",
      "POST /clinical-core/workforce/appointments/visits/start", "POST /clinical-core/workforce/appointments/visits/end",
      "GET /clinical-core/workforce/appointments/visits/notes", "POST /clinical-core/workforce/appointments/visits/notes/import",
      "POST /clinical-core/workforce/appointments/visits/notes/sign",
    ]) {
      const route = routes.find((resource) => resource.Properties.RouteKey === key);
      expect(route, key).toBeDefined();
      expect(route?.Properties.AuthorizerId).toEqual({ Ref: "WorkforceAuthorizer" });
    }
  });

  it("refuses to start a visit without a recorded consent — the UI check is not the control", async () => {
    send.mockResolvedValueOnce({ Item: visitRecord() });
    const result = await createTelehealthHandler({ ...config, zoomEnabled: true, zoomBaaVerified: true, zoomSecretArn: "arn:secret" })(event("POST /clinical-core/workforce/appointments/visits/start", {
      appointmentId: APPOINTMENT, start: "2026-10-09T17:00:00.000Z", end: "2026-10-09T17:30:00.000Z", timeZone: "America/Los_Angeles", hostDisplayName: "Dr. Synthetic",
    }, workforceClaims));
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body ?? "{}")).toEqual({ error: "consent_required" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("reports the video provider as unavailable rather than inventing a meeting when Zoom is off", async () => {
    send.mockResolvedValueOnce({ Item: visitRecord({ consents: [consent] }) });
    const result = await createTelehealthHandler(config)(event("POST /clinical-core/workforce/appointments/visits/start", {
      appointmentId: APPOINTMENT, start: "2026-10-09T17:00:00.000Z", end: "2026-10-09T17:30:00.000Z", timeZone: "America/Los_Angeles", hostDisplayName: "Dr. Synthetic",
    }, workforceClaims));
    expect(result.statusCode).toBe(503);
    expect(JSON.parse(result.body ?? "{}")).toEqual({ error: "provider_unavailable" });
  });

  it("records a staff-attested consent append-only and never returns the passcode", async () => {
    send.mockResolvedValueOnce({ Item: visitRecord({ consents: [consent], passcode: "secret-passcode" }) }).mockResolvedValueOnce({});
    const result = await createTelehealthHandler(config)(event("POST /clinical-core/workforce/appointments/visits/consent", {
      appointmentId: APPOINTMENT, consentVersion: "2026-10", signerName: "Second Signer", agreed: true,
    }, workforceClaims));
    const payload = JSON.parse(result.body ?? "{}") as { data: Record<string, unknown> };
    expect(result.statusCode).toBe(200);
    expect(payload.data).toMatchObject({ consentSigned: true, version: 2 });
    expect((payload.data.consents as unknown[]).length).toBe(2);
    expect(payload.data).not.toHaveProperty("passcode");
    const put = send.mock.calls[1]?.[0] as { input?: { ConditionExpression?: string } };
    expect(put.input?.ConditionExpression).toBe("#version = :expected");
  });

  it("refuses a consent the staff member did not attest to", async () => {
    const result = await createTelehealthHandler(config)(event("POST /clinical-core/workforce/appointments/visits/consent", {
      appointmentId: APPOINTMENT, consentVersion: "2026-10", signerName: "Second Signer", agreed: false,
    }, workforceClaims));
    expect(result.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("imports the AI Companion summary verbatim as NOT reviewed, with next steps as suggestions only", async () => {
    secretsSend.mockResolvedValue({ SecretString: JSON.stringify({ accountId: "acct", clientId: "client-id", clientSecret: "client-secret", userId: "host@example.test", sdkKey: "sdk-key", sdkSecret: "sdk-secret" }) });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "zoom-access" }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ meeting_uuid: "uuid-1", summary_overview: "Overview text.", summary_details: [{ label: "Symptoms reported", summary: "Fatigue in the afternoons." }, { label: "Plan", summary: "Repeat ferritin in 8 weeks." }], next_steps: ["Order ferritin", " "] }) });
    vi.stubGlobal("fetch", fetchMock);
    try {
      send.mockResolvedValueOnce({ Item: visitRecord({ consents: [consent], status: "ended", providerMeetingId: "123456789" }) }).mockResolvedValueOnce({});
      const result = await createTelehealthHandler({ ...config, zoomEnabled: true, zoomBaaVerified: true, zoomSecretArn: "arn:secret" })(event("POST /clinical-core/workforce/appointments/visits/notes/import", { appointmentId: APPOINTMENT }, workforceClaims));
      const payload = JSON.parse(result.body ?? "{}") as { data: { summaryReady: boolean; visit: { note: Record<string, unknown> } } };
      expect(result.statusCode).toBe(200);
      expect(payload.data.summaryReady).toBe(true);
      expect(payload.data.visit.note).toMatchObject({ status: "not_reviewed", source: "zoom_ai_companion", zoomSummaryId: "uuid-1", revision: 1, signedAt: null });
      expect(payload.data.visit.note.aiSections).toEqual({ summary: "Overview text.", patient_reported: "Fatigue in the afternoons.", results_reviewed: "", plan_discussed: "Repeat ferritin in 8 weeks." });
      expect(payload.data.visit.note.actionItems).toEqual([{ id: expect.any(String), text: "Order ferritin", status: "suggested" }]);
      expect((payload.data.visit.note.aiOriginal as { summary_overview: string }).summary_overview).toBe("Overview text.");
    } finally {
      vi.unstubAllGlobals();
      secretsSend.mockReset();
    }
  });

  it("will not import over a signed note, and will not sign twice", async () => {
    const signedNote = { status: "signed", source: "zoom_ai_companion", zoomSummaryId: null, aiSections: { summary: "", patient_reported: "", results_reviewed: "", plan_discussed: "" }, aiOriginal: {}, practitionerNotes: "x", actionItems: [], revision: 2, importedAt: "2026-10-01T00:00:00.000Z", signedAt: "2026-10-01T01:00:00.000Z", signedBy: workforceClaims["custom:person_id"] };
    send.mockResolvedValueOnce({ Item: visitRecord({ consents: [consent], providerMeetingId: "123456789", note: signedNote, version: 3 }) });
    const handler = createTelehealthHandler(config);
    const imported = await handler(event("POST /clinical-core/workforce/appointments/visits/notes/import", { appointmentId: APPOINTMENT }, workforceClaims));
    expect(imported.statusCode).toBe(409);
    send.mockResolvedValueOnce({ Item: visitRecord({ consents: [consent], providerMeetingId: "123456789", note: signedNote, version: 3 }) });
    const signed = await handler(event("POST /clinical-core/workforce/appointments/visits/notes/sign", {
      appointmentId: APPOINTMENT, expectedVersion: 3, practitionerNotes: "More", aiSections: signedNote.aiSections, actionItems: [],
    }, workforceClaims));
    expect(signed.statusCode).toBe(409);
  });

  it("signs practitioner notes together with the reviewed AI sections and action-item decisions", async () => {
    const note = { status: "not_reviewed", source: "zoom_ai_companion", zoomSummaryId: "uuid-1", aiSections: { summary: "AI summary", patient_reported: "", results_reviewed: "", plan_discussed: "" }, aiOriginal: {}, practitionerNotes: "", actionItems: [{ id: "a1", text: "Order ferritin", status: "suggested" }], revision: 1, importedAt: "2026-10-01T00:00:00.000Z", signedAt: null, signedBy: null };
    send.mockResolvedValueOnce({ Item: visitRecord({ consents: [consent], status: "ended", providerMeetingId: "123456789", note, version: 4 }) }).mockResolvedValueOnce({});
    const result = await createTelehealthHandler(config)(event("POST /clinical-core/workforce/appointments/visits/notes/sign", {
      appointmentId: APPOINTMENT, expectedVersion: 4, practitionerNotes: "Patient tolerating protocol.",
      aiSections: { summary: "AI summary (edited)", patient_reported: "", results_reviewed: "", plan_discussed: "" },
      actionItems: [{ id: "a1", status: "approved" }],
    }, workforceClaims));
    const payload = JSON.parse(result.body ?? "{}") as { data: { note: Record<string, unknown>; version: number } };
    expect(result.statusCode).toBe(200);
    expect(payload.data.version).toBe(5);
    expect(payload.data.note).toMatchObject({ status: "signed", revision: 2, practitionerNotes: "Patient tolerating protocol.", signedBy: workforceClaims["custom:person_id"] });
    expect(payload.data.note.aiSections).toMatchObject({ summary: "AI summary (edited)" });
    expect(payload.data.note.actionItems).toEqual([{ id: "a1", text: "Order ferritin", status: "approved" }]);
  });

  it("signs a Meeting SDK JWT with the SDK key as appKey and HS256", () => {
    const token = signMeetingSdkJwt("sdk-key", "sdk-secret", { mn: "123456789", role: 1, iat: 1, exp: 2, tokenExp: 2 });
    const [header, payload, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "HS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toMatchObject({ appKey: "sdk-key", mn: "123456789", role: 1 });
    expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
