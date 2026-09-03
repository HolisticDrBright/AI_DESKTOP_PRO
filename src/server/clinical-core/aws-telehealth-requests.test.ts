import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));

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
  SecretsManagerClient: class SecretsManagerClient { send = vi.fn(); },
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

import { createTelehealthHandler, type TelehealthConfiguration } from "./aws-telehealth-requests";

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

describe("AWS telehealth request boundary", () => {
  beforeEach(() => send.mockReset());

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
