import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const { send, secretsSend } = vi.hoisted(() => ({ send: vi.fn(), secretsSend: vi.fn() }));

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
  stripeTestEnabled: false,
  stripeSecretArn: "",
  stripeSuccessUrl: "",
  stripeCancelUrl: "",
  identityApiOrigin: "https://abcdefghij.execute-api.us-east-2.amazonaws.com",
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

describe("AWS telehealth visit boundary (consent authority, meeting lease, provider shutdown, AI notes)", () => {
  const APPOINTMENT = "77777777-7777-4777-8777-777777777777";
  const REQUEST = "33333333-3333-4333-8333-333333333333";
  const ORG = workforceClaims["custom:organization_id"];
  const ARTIFACT = { artifactId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", scope: "telehealth_recording", artifactVersion: "telehealth-recording/1", contentSha256: "b".repeat(64), jurisdiction: "US-CA", approvedAt: "2026-10-01T00:00:00.000Z" };
  const zoomConfig = { ...config, zoomEnabled: true, zoomBaaVerified: true, zoomSecretArn: "arn:secret" };
  const receipt = (overrides: Record<string, unknown> = {}) => ({ consentId: "88888888-8888-4888-8888-888888888888", consentType: "telehealth_recording_combined", scope: "telehealth_recording",
    artifactId: ARTIFACT.artifactId, artifactVersion: ARTIFACT.artifactVersion, contentSha256: ARTIFACT.contentSha256, signerName: "Synthetic Signer", method: "staff_attested", representativeAuthority: "self",
    signedAt: "2026-10-01T00:00:00.000Z", recordedBy: workforceClaims["custom:person_id"], patientLocation: "CA", grantId: null, connectionId: null, status: "granted", withdrawnAt: null, withdrawnBy: null, withdrawalReason: null, ...overrides });
  const visitRecord = (overrides: Record<string, unknown> = {}) => ({
    pk: `ORG#${ORG}`, sk: `VISIT#${APPOINTMENT}`, appointmentId: APPOINTMENT, organizationId: ORG, requestId: null, consumerPersonId: null,
    scheduledStart: "2026-10-09T17:00:00.000Z", scheduledEnd: "2026-10-09T17:30:00.000Z", timeZone: "America/Los_Angeles",
    status: "scheduled", consents: [receipt()], meetingLease: null, providerMeetingId: null, joinUrl: null, passcode: null, startedAt: null, endedAt: null,
    providerShutdown: { status: "not_started", attemptedAt: null, confirmedAt: null, detail: null }, flags: [], quickNotes: "", note: null, noteHistory: [],
    version: 1, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", ...overrides,
  });
  const requestRecord = (overrides: Record<string, unknown> = {}) => ({
    pk: `ORG#${ORG}`, sk: `REQ#2026-09-01T00:00:00.000Z#${REQUEST}`, requestId: REQUEST, organizationId: ORG, consumerPersonId: claims["custom:person_id"], consumerEmail: claims.email,
    status: "scheduled", visitType: "follow_up", preferredSlots: [], timeZone: "America/Los_Angeles", note: null, scheduledStart: "2026-10-09T17:00:00.000Z", scheduledEnd: "2026-10-09T17:30:00.000Z",
    joinUrl: null, providerMeetingId: null, version: 2, createdAt: "", updatedAt: "", lastActionBy: "workforce", slotId: "55555555-5555-4555-8555-555555555555", appointmentId: APPOINTMENT,
    priceMinor: 0, currency: "USD", cancellationPolicy: "", cancellationWindowHours: 24, cancellationFeeDueMinor: 0, reminderStatus: "disabled", paymentPolicyVersion: "telehealth-payments/1",
    paymentAuthorizationStatus: "not_authorized", paymentStatus: "not_due", paymentIntentId: null, paidMinor: 0, refundedMinor: 0, ...overrides,
  });
  const start = (handlerConfig = zoomConfig, extra: Record<string, unknown> = {}) => createTelehealthHandler(handlerConfig)(event("POST /clinical-core/workforce/appointments/visits/start", { appointmentId: APPOINTMENT, hostDisplayName: "Dr. Synthetic", ...extra }, workforceClaims));
  const jsonResponse = (status: number, body: unknown, text?: string) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => text ?? JSON.stringify(body) });
  /** fetch stand-in keyed by URL substring; records every call so tests can assert what was NOT called. */
  const fetchRouter = (routes: Array<[match: string | RegExp, respond: (url: string, init?: RequestInit) => unknown]>) => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const fn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      const route = routes.find(([match]) => typeof match === "string" ? url.includes(match) : match.test(url));
      if (!route) throw new Error(`unrouted fetch ${url}`);
      return route[1](url, init);
    });
    vi.stubGlobal("fetch", fn);
    return calls;
  };
  const identityRoutes = (grant: Record<string, unknown> | null = null): Array<[string | RegExp, (url: string, init?: RequestInit) => unknown]> => [
    ["/clinical-core/workforce/consent-artifact", () => jsonResponse(200, { data: ARTIFACT })],
    ["/clinical-core/workforce/consents/current", () => jsonResponse(200, { data: grant ?? { status: "none", patientRecordId: null, connectionId: null, consentId: null, artifactId: null, artifactVersion: null, contentSha256: null, artifactStatus: null } })],
    ["/clinical-core/workforce/consents/grant", () => jsonResponse(201, { data: { consentId: "99999999-9999-4999-8999-999999999999", connectionId: "44444444-4444-4444-8444-444444444444", status: "granted" } })],
    ["/clinical-core/workforce/consents/revoke", () => jsonResponse(201, { data: { status: "revoked" } })],
  ];
  const zoomRoutes = (overrides: Partial<Record<"token" | "list" | "create" | "zak" | "end" | "state" | "summary" | "delete", (url: string, init?: RequestInit) => unknown>> = {}): Array<[string | RegExp, (url: string, init?: RequestInit) => unknown]> => [
    ["zoom.us/oauth/token", overrides.token ?? (() => jsonResponse(200, { access_token: "zoom-access" }))],
    [/\/users\/[^/]+\/meetings\?/, overrides.list ?? (() => jsonResponse(200, { meetings: [] }))],
    [/\/users\/[^/]+\/meetings$/, overrides.create ?? (() => jsonResponse(201, { id: 900000001, join_url: "https://zoom.us/j/900000001?pwd=fixture" }))],
    ["/token?type=zak", overrides.zak ?? (() => jsonResponse(200, { token: "zak-token" }))],
    [/\/meetings\/[^/]+\/status$/, overrides.end ?? (() => jsonResponse(204, {}))],
    [/\/meetings\/[^/?]+\/meeting_summary$/, overrides.summary ?? (() => jsonResponse(404, {}))],
    [/\/meetings\/[^/?]+$/, (url, init) => (init?.method === "DELETE" ? (overrides.delete ?? (() => jsonResponse(204, {})))(url, init) : (overrides.state ?? (() => jsonResponse(200, { status: "waiting" })))(url, init))],
  ];
  const putCalls = () => send.mock.calls.map((call) => call[0] as { constructor: { name: string }; input: Record<string, unknown> }).filter((command) => command.constructor.name === "PutCommand");

  beforeEach(() => { send.mockReset(); secretsSend.mockReset(); secretsSend.mockResolvedValue({ SecretString: JSON.stringify({ accountId: "acct", clientId: "client-id", clientSecret: "client-secret", userId: "host@example.test", sdkKey: "sdk-key", sdkSecret: "sdk-secret" }) }); });
  afterEach(() => vi.unstubAllGlobals());

  it("registers every visit route behind the workforce authorizer and hands the Lambda the clinical API origin", () => {
    const template = JSON.parse(readFileSync("infra/aws-clinical-core/telehealth-requests-extension.json", "utf8")) as { Resources: Record<string, { Type: string; Properties: { RouteKey?: string; AuthorizerId?: { Ref: string }; Environment?: { Variables: Record<string, unknown> } } }> };
    const routes = Object.values(template.Resources).filter((resource) => resource.Type === "AWS::ApiGatewayV2::Route");
    for (const key of [
      "GET /clinical-core/workforce/appointments/visits", "GET /clinical-core/workforce/appointments/visits/consent-artifact",
      "POST /clinical-core/workforce/appointments/visits/consent", "POST /clinical-core/workforce/appointments/visits/consent/withdraw",
      "POST /clinical-core/workforce/appointments/visits/start", "POST /clinical-core/workforce/appointments/visits/end",
      "GET /clinical-core/workforce/appointments/visits/notes", "POST /clinical-core/workforce/appointments/visits/notes/import",
      "POST /clinical-core/workforce/appointments/visits/notes/sign",
    ]) {
      const route = routes.find((resource) => resource.Properties.RouteKey === key);
      expect(route, key).toBeDefined();
      expect(route?.Properties.AuthorizerId).toEqual({ Ref: "WorkforceAuthorizer" });
    }
    expect(template.Resources.TelehealthFunction.Properties.Environment?.Variables.CLINICAL_API_ORIGIN).toEqual({ "Fn::Sub": "https://${ClinicalApiId}.execute-api.${AWS::Region}.${AWS::URLSuffix}" });
  });

  it("refuses to start a visit with no consent on record before any authority read, secret or provider call", async () => {
    const calls = fetchRouter([...identityRoutes(), ...zoomRoutes()]);
    send.mockResolvedValueOnce({ Item: visitRecord({ consents: [] }) });
    const result = await start();
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body ?? "{}")).toEqual({ error: "consent_required" });
    expect(calls).toHaveLength(0);
    expect(secretsSend).not.toHaveBeenCalled();
    expect(putCalls()).toHaveLength(0);
  });

  it("refuses a start whose consent names a superseded artifact, and a withdrawn governed grant", async () => {
    fetchRouter([["/consent-artifact", () => jsonResponse(200, { data: { ...ARTIFACT, artifactId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", artifactVersion: "telehealth-recording/2", contentSha256: "c".repeat(64) } })]]);
    send.mockResolvedValueOnce({ Item: visitRecord() });
    const superseded = await start();
    expect(superseded.statusCode).toBe(409);
    expect(JSON.parse(superseded.body ?? "{}")).toEqual({ error: "consent_superseded" });

    fetchRouter(identityRoutes({ status: "revoked", connectionId: "44444444-4444-4444-8444-444444444444", artifactId: null, artifactStatus: null }));
    send.mockResolvedValueOnce({ Item: visitRecord({ requestId: REQUEST, consumerPersonId: claims["custom:person_id"] }) }).mockResolvedValueOnce({ Items: [requestRecord()] });
    const withdrawn = await start();
    expect(withdrawn.statusCode).toBe(409);
    expect(JSON.parse(withdrawn.body ?? "{}")).toEqual({ error: "consent_withdrawn" });
    expect(secretsSend).not.toHaveBeenCalled();
  });

  it("binds a patient-app visit to its request: cancelled, mismatched or missing requests refuse before consent or provider work", async () => {
    const calls = fetchRouter([...identityRoutes(), ...zoomRoutes()]);
    send.mockResolvedValueOnce({ Item: visitRecord({ requestId: REQUEST, consumerPersonId: claims["custom:person_id"] }) }).mockResolvedValueOnce({ Items: [requestRecord({ status: "cancelled" })] });
    const cancelled = await start();
    expect(cancelled.statusCode).toBe(409);
    expect(JSON.parse(cancelled.body ?? "{}")).toEqual({ error: "appointment_cancelled" });

    send.mockResolvedValueOnce({ Item: visitRecord({ requestId: REQUEST }) }).mockResolvedValueOnce({ Items: [requestRecord({ appointmentId: "66666666-6666-4666-8666-666666666666" })] });
    const mismatched = await start();
    expect(mismatched.statusCode).toBe(400);

    send.mockResolvedValueOnce({ Item: visitRecord({ requestId: REQUEST }) }).mockResolvedValueOnce({ Items: [] });
    const missing = await start();
    expect(missing.statusCode).toBe(404);
    expect(calls.filter((call) => call.url.includes("zoom.us"))).toHaveLength(0);
    expect(secretsSend).not.toHaveBeenCalled();
  });

  it("uses the request's stored times and consumer binding, never the caller's, and reports the video provider as off", async () => {
    fetchRouter(identityRoutes({ status: "granted", connectionId: "44444444-4444-4444-8444-444444444444", artifactId: ARTIFACT.artifactId, artifactStatus: "approved" }));
    send.mockResolvedValueOnce({ Item: visitRecord({ requestId: REQUEST, consumerPersonId: claims["custom:person_id"] }) }).mockResolvedValueOnce({ Items: [requestRecord()] });
    const result = await start(config, { start: "1999-01-01T00:00:00.000Z", end: "1999-01-01T00:30:00.000Z", timeZone: "America/Los_Angeles" });
    expect(result.statusCode).toBe(503);
    expect(JSON.parse(result.body ?? "{}")).toEqual({ error: "provider_unavailable" });
  });

  it("records a staff-attested consent only against the organization's current approved artifact, append-only, without the passcode", async () => {
    const calls = fetchRouter(identityRoutes());
    send.mockResolvedValueOnce({ Item: visitRecord({ consents: [receipt()], passcode: "secret-passcode" }) });
    const unknown = await createTelehealthHandler(config)(event("POST /clinical-core/workforce/appointments/visits/consent", {
      appointmentId: APPOINTMENT, artifactId: ARTIFACT.artifactId, artifactVersion: "never-reviewed", contentSha256: ARTIFACT.contentSha256, signerName: "Second Signer", agreed: true,
    }, workforceClaims));
    expect(unknown.statusCode).toBe(409);
    expect(JSON.parse(unknown.body ?? "{}")).toEqual({ error: "consent_version_refused" });
    expect(putCalls()).toHaveLength(0);

    send.mockResolvedValueOnce({ Item: visitRecord({ consents: [receipt()], passcode: "secret-passcode" }) }).mockResolvedValueOnce({});
    const result = await createTelehealthHandler(config)(event("POST /clinical-core/workforce/appointments/visits/consent", {
      appointmentId: APPOINTMENT, artifactId: ARTIFACT.artifactId, artifactVersion: ARTIFACT.artifactVersion, contentSha256: ARTIFACT.contentSha256, signerName: "Second Signer", agreed: true, patientLocation: "CA",
    }, workforceClaims));
    const payload = JSON.parse(result.body ?? "{}") as { data: Record<string, unknown> };
    expect(result.statusCode).toBe(200);
    expect(payload.data).toMatchObject({ consentSigned: true, version: 2 });
    expect((payload.data.consents as Array<Record<string, unknown>>).map((consent) => consent.status)).toEqual(["granted", "granted"]);
    expect((payload.data.consents as Array<Record<string, unknown>>)[1]).toMatchObject({ artifactId: ARTIFACT.artifactId, contentSha256: ARTIFACT.contentSha256, method: "staff_attested" });
    expect(payload.data).not.toHaveProperty("passcode");
    expect(calls.map((call) => call.url)).toEqual(expect.arrayContaining([expect.stringContaining("/consent-artifact")]));
    const put = putCalls()[0];
    expect(put.input.ConditionExpression).toBe("#version = :expected");
  });

  it("records the governed grant through the identity API when the patient has an app connection", async () => {
    const calls = fetchRouter(identityRoutes({ status: "none", connectionId: "44444444-4444-4444-8444-444444444444", artifactId: null, artifactStatus: null }));
    send.mockResolvedValueOnce({ Item: null }).mockResolvedValueOnce({ Items: [requestRecord()] }).mockResolvedValueOnce({});
    const result = await createTelehealthHandler(config)(event("POST /clinical-core/workforce/appointments/visits/consent", {
      appointmentId: APPOINTMENT, requestId: REQUEST, artifactId: ARTIFACT.artifactId, artifactVersion: ARTIFACT.artifactVersion, contentSha256: ARTIFACT.contentSha256, signerName: "Signer", agreed: true,
    }, workforceClaims));
    expect(result.statusCode).toBe(200);
    const grant = calls.find((call) => call.url.includes("/consents/grant"));
    expect(grant?.body).toMatchObject({ connectionId: "44444444-4444-4444-8444-444444444444", artifactId: ARTIFACT.artifactId, scope: "telehealth_recording", method: "in_person" });
    const payload = JSON.parse(result.body ?? "{}") as { data: { consents: Array<Record<string, unknown>> } };
    expect(payload.data.consents[0]).toMatchObject({ grantId: "99999999-9999-4999-8999-999999999999", method: "staff_attested" });
  });

  it("withdrawal marks receipts append-only, revokes the governed grant, and blocks a later start", async () => {
    const calls = fetchRouter([...identityRoutes()]);
    send.mockResolvedValueOnce({ Item: visitRecord({ consents: [receipt({ grantId: "g1", connectionId: "44444444-4444-4444-8444-444444444444" })] }) }).mockResolvedValueOnce({});
    const result = await createTelehealthHandler(config)(event("POST /clinical-core/workforce/appointments/visits/consent/withdraw", { appointmentId: APPOINTMENT, expectedVersion: 1 }, workforceClaims));
    const payload = JSON.parse(result.body ?? "{}") as { data: { consentSigned: boolean; consents: Array<Record<string, unknown>> } };
    expect(result.statusCode).toBe(200);
    expect(payload.data.consentSigned).toBe(false);
    expect(payload.data.consents[0]).toMatchObject({ status: "withdrawn", withdrawnBy: workforceClaims["custom:person_id"] });
    expect(calls.some((call) => call.url.includes("/consents/revoke"))).toBe(true);
    send.mockResolvedValueOnce({ Item: visitRecord({ consents: [receipt({ status: "withdrawn" })] }) });
    const later = await start();
    expect(later.statusCode).toBe(409);
    expect(JSON.parse(later.body ?? "{}")).toEqual({ error: "consent_required" });
  });

  it("creates the provider meeting only under a durable lease and binds it; a racing start is refused without a second meeting", async () => {
    const calls = fetchRouter([...identityRoutes(), ...zoomRoutes()]);
    // First start: read visit, lease write, list (no existing), create, bind write, session, final write.
    send.mockResolvedValueOnce({ Item: visitRecord() }).mockResolvedValueOnce({}).mockResolvedValueOnce({}).mockResolvedValueOnce({});
    const first = await start();
    expect(first.statusCode).toBe(200);
    const payload = JSON.parse(first.body ?? "{}") as { data: { visit: Record<string, unknown>; session: Record<string, unknown> } };
    expect(payload.data.visit).toMatchObject({ status: "in_visit", providerMeetingId: "900000001" });
    expect(payload.data.session).toMatchObject({ meetingNumber: "900000001", zak: "zak-token" });
    expect(calls.filter((call) => /\/users\/[^/]+\/meetings$/.test(call.url) && call.method === "POST")).toHaveLength(1);
    expect(calls.find((call) => call.method === "POST" && /\/meetings$/.test(call.url))?.body).toMatchObject({ agenda: expect.stringContaining(`alp-visit:${APPOINTMENT}`), settings: { waiting_room: true } });
    const lease = putCalls()[0].input.Item as Record<string, unknown>;
    expect(lease.meetingLease).toMatchObject({ leaseId: expect.any(String) });

    // Second start on the same version: the lease write loses the condition — no provider create happens.
    calls.length = 0;
    send.mockResolvedValueOnce({ Item: visitRecord() }).mockRejectedValueOnce(Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" }));
    const second = await start();
    expect(second.statusCode).toBe(409);
    expect(calls.filter((call) => call.method === "POST" && /\/meetings$/.test(call.url))).toHaveLength(0);
  });

  it("adopts a provider meeting found by its marker instead of repeating an ambiguous create, and cleans up when the receipt fails", async () => {
    const calls = fetchRouter([...identityRoutes(), ...zoomRoutes({ list: () => jsonResponse(200, { meetings: [{ id: 900000002, agenda: `alp-visit:${APPOINTMENT}`, join_url: "https://zoom.us/j/900000002?pwd=p" }] }) })]);
    send.mockResolvedValueOnce({ Item: visitRecord() }).mockResolvedValueOnce({}).mockResolvedValueOnce({}).mockResolvedValueOnce({});
    const adopted = await start();
    expect(adopted.statusCode).toBe(200);
    expect(JSON.parse(adopted.body ?? "{}").data.visit.providerMeetingId).toBe("900000002");
    expect(calls.filter((call) => call.method === "POST" && /\/meetings$/.test(call.url))).toHaveLength(0);

    calls.length = 0;
    fetchRouter([...identityRoutes(), ...zoomRoutes()]);
    // lease ok, create ok, bind write fails → the created meeting is deleted and the lease released.
    send.mockResolvedValueOnce({ Item: visitRecord() }).mockResolvedValueOnce({}).mockRejectedValueOnce(Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" })).mockResolvedValueOnce({});
    const failed = await start();
    expect(failed.statusCode).toBe(409);
    const deletes = (vi.mocked(fetch).mock.calls as Array<[string, RequestInit | undefined]>).filter(([url, init]) => init?.method === "DELETE" && url.includes("/meetings/900000001"));
    expect(deletes).toHaveLength(1);
  });

  it("ends a visit only when the provider confirms; a refused shutdown stays `ending` with the failure recorded and notes saved", async () => {
    fetchRouter([...zoomRoutes({ end: () => jsonResponse(500, {}) })]);
    send.mockResolvedValueOnce({ Item: visitRecord({ status: "in_visit", providerMeetingId: "900000001", joinUrl: "https://zoom.us/j/900000001", startedAt: "2026-10-09T17:00:00.000Z", version: 3 }) }).mockResolvedValueOnce({}).mockResolvedValueOnce({});
    const refused = await createTelehealthHandler(zoomConfig)(event("POST /clinical-core/workforce/appointments/visits/end", { appointmentId: APPOINTMENT, expectedVersion: 3, flags: [{ atSeconds: 10, label: "x" }], quickNotes: "notes" }, workforceClaims));
    const payload = JSON.parse(refused.body ?? "{}") as { data: Record<string, unknown> };
    expect(refused.statusCode).toBe(200);
    expect(payload.data).toMatchObject({ status: "ending", endedAt: null, quickNotes: "notes", providerShutdown: { status: "failed", detail: expect.stringContaining("refused") } });

    fetchRouter([...zoomRoutes({ state: () => jsonResponse(200, { status: "started" }) })]);
    send.mockResolvedValueOnce({ Item: visitRecord({ status: "ending", providerMeetingId: "900000001", version: 5 }) }).mockResolvedValueOnce({}).mockResolvedValueOnce({});
    const stillRunning = await createTelehealthHandler(zoomConfig)(event("POST /clinical-core/workforce/appointments/visits/end", { appointmentId: APPOINTMENT, expectedVersion: 5 }, workforceClaims));
    expect(JSON.parse(stillRunning.body ?? "{}").data).toMatchObject({ status: "ending", providerShutdown: { status: "failed" } });

    fetchRouter([...zoomRoutes()]);
    send.mockResolvedValueOnce({ Item: visitRecord({ status: "ending", providerMeetingId: "900000001", version: 7 }) }).mockResolvedValueOnce({}).mockResolvedValueOnce({});
    const ended = await createTelehealthHandler(zoomConfig)(event("POST /clinical-core/workforce/appointments/visits/end", { appointmentId: APPOINTMENT, expectedVersion: 7 }, workforceClaims));
    expect(JSON.parse(ended.body ?? "{}").data).toMatchObject({ status: "ended", providerShutdown: { status: "ended" } });

    // Duplicate end on an ended visit is idempotent and touches nothing.
    send.mockResolvedValueOnce({ Item: visitRecord({ status: "ended", version: 9 }) });
    const again = await createTelehealthHandler(zoomConfig)(event("POST /clinical-core/workforce/appointments/visits/end", { appointmentId: APPOINTMENT, expectedVersion: 9 }, workforceClaims));
    expect(JSON.parse(again.body ?? "{}").data).toMatchObject({ status: "ended", version: 9 });
    expect(putCalls().filter((put) => (put.input.Item as { version: number }).version === 10)).toHaveLength(0);
  });

  it("imports the current unified summary as unreviewed source text, refuses another meeting's summary, and reports empty summaries as not ready", async () => {
    fetchRouter([...identityRoutes(), ...zoomRoutes({ summary: () => jsonResponse(200, { meeting_id: 900000001, meeting_uuid: "uuid-1", summary_content: "# Visit\n\nPatient reports better afternoons." }) })]);
    send.mockResolvedValueOnce({ Item: visitRecord({ status: "ended", providerMeetingId: "900000001" }) }).mockResolvedValueOnce({});
    const unified = await createTelehealthHandler(zoomConfig)(event("POST /clinical-core/workforce/appointments/visits/notes/import", { appointmentId: APPOINTMENT }, workforceClaims));
    const payload = JSON.parse(unified.body ?? "{}") as { data: { summaryReady: boolean; visit: { note: Record<string, unknown> } } };
    expect(unified.statusCode).toBe(200);
    expect(payload.data.summaryReady).toBe(true);
    expect(payload.data.visit.note).toMatchObject({ status: "not_reviewed", aiSections: { summary: "# Visit\n\nPatient reports better afternoons.", patient_reported: "", results_reviewed: "", plan_discussed: "" }, actionItems: [] });
    expect((payload.data.visit.note.aiOriginal as { summary_content: string }).summary_content).toContain("# Visit");

    fetchRouter([...identityRoutes(), ...zoomRoutes({ summary: () => jsonResponse(200, { meeting_id: 123, summary_content: "someone else's meeting" }) })]);
    send.mockResolvedValueOnce({ Item: visitRecord({ status: "ended", providerMeetingId: "900000001" }) });
    const wrongMeeting = await createTelehealthHandler(zoomConfig)(event("POST /clinical-core/workforce/appointments/visits/notes/import", { appointmentId: APPOINTMENT }, workforceClaims));
    expect(wrongMeeting.statusCode).toBe(503);

    fetchRouter([...identityRoutes(), ...zoomRoutes({ summary: () => jsonResponse(200, { meeting_id: 900000001, summary_content: "   " }) })]);
    send.mockResolvedValueOnce({ Item: visitRecord({ status: "ended", providerMeetingId: "900000001" }) });
    const empty = await createTelehealthHandler(zoomConfig)(event("POST /clinical-core/workforce/appointments/visits/notes/import", { appointmentId: APPOINTMENT }, workforceClaims));
    expect(JSON.parse(empty.body ?? "{}").data).toMatchObject({ summaryReady: false });
    expect(putCalls()).toHaveLength(1);
  });

  it("re-import keeps practitioner notes and action-item decisions and retains the prior revision", async () => {
    const previous = { status: "not_reviewed", source: "zoom_ai_companion", zoomSummaryId: "uuid-1", aiSections: { summary: "old", patient_reported: "", results_reviewed: "", plan_discussed: "" }, aiOriginal: {}, practitionerNotes: "Keep me", actionItems: [{ id: "a1", text: "Order ferritin", status: "approved" }], revision: 1, importedAt: "2026-10-01T00:00:00.000Z", signedAt: null, signedBy: null };
    fetchRouter([...identityRoutes(), ...zoomRoutes({ summary: () => jsonResponse(200, { meeting_id: 900000001, summary_overview: "new overview", next_steps: ["Order ferritin", "Sleep log"] }) })]);
    send.mockResolvedValueOnce({ Item: visitRecord({ status: "ended", providerMeetingId: "900000001", note: previous, version: 4 }) }).mockResolvedValueOnce({});
    const result = await createTelehealthHandler(zoomConfig)(event("POST /clinical-core/workforce/appointments/visits/notes/import", { appointmentId: APPOINTMENT }, workforceClaims));
    const note = JSON.parse(result.body ?? "{}").data.visit.note as Record<string, unknown>;
    expect(note).toMatchObject({ revision: 2, practitionerNotes: "Keep me" });
    expect(note.actionItems).toEqual([{ id: "a1", text: "Order ferritin", status: "approved" }, { id: expect.any(String), text: "Sleep log", status: "suggested" }]);
    const stored = putCalls()[0].input.Item as { noteHistory: unknown[] };
    expect(stored.noteHistory).toEqual([previous]);
  });

  it("will not import over a signed note, will not sign twice, and signing keeps the prior revision", async () => {
    const signedNote = { status: "signed", source: "zoom_ai_companion", zoomSummaryId: null, aiSections: { summary: "", patient_reported: "", results_reviewed: "", plan_discussed: "" }, aiOriginal: {}, practitionerNotes: "x", actionItems: [], revision: 2, importedAt: "2026-10-01T00:00:00.000Z", signedAt: "2026-10-01T01:00:00.000Z", signedBy: workforceClaims["custom:person_id"] };
    send.mockResolvedValueOnce({ Item: visitRecord({ status: "ended", providerMeetingId: "123456789", note: signedNote, version: 3 }) });
    const handler = createTelehealthHandler(config);
    const imported = await handler(event("POST /clinical-core/workforce/appointments/visits/notes/import", { appointmentId: APPOINTMENT }, workforceClaims));
    expect(imported.statusCode).toBe(409);
    send.mockResolvedValueOnce({ Item: visitRecord({ status: "ended", providerMeetingId: "123456789", note: signedNote, version: 3 }) });
    const signed = await handler(event("POST /clinical-core/workforce/appointments/visits/notes/sign", { appointmentId: APPOINTMENT, expectedVersion: 3, practitionerNotes: "More", aiSections: signedNote.aiSections, actionItems: [] }, workforceClaims));
    expect(signed.statusCode).toBe(409);

    const draft = { ...signedNote, status: "not_reviewed", signedAt: null, signedBy: null, actionItems: [{ id: "a1", text: "Order ferritin", status: "suggested" }] };
    send.mockResolvedValueOnce({ Item: visitRecord({ status: "ended", providerMeetingId: "123456789", note: draft, version: 4 }) }).mockResolvedValueOnce({});
    const result = await handler(event("POST /clinical-core/workforce/appointments/visits/notes/sign", { appointmentId: APPOINTMENT, expectedVersion: 4, practitionerNotes: "Patient tolerating protocol.", aiSections: { ...draft.aiSections, summary: "edited" }, actionItems: [{ id: "a1", status: "approved" }] }, workforceClaims));
    const payload = JSON.parse(result.body ?? "{}") as { data: { note: Record<string, unknown>; version: number } };
    expect(result.statusCode).toBe(200);
    expect(payload.data.note).toMatchObject({ status: "signed", revision: 3, practitionerNotes: "Patient tolerating protocol.", signedBy: workforceClaims["custom:person_id"] });
    expect(payload.data.note.actionItems).toEqual([{ id: "a1", text: "Order ferritin", status: "approved" }]);
    expect((putCalls()[0].input.Item as { noteHistory: unknown[] }).noteHistory).toEqual([draft]);
  });

  it("lists visits across every page, says whether the list is complete, and never returns note bodies in a list", async () => {
    const page = (index: number, last?: Record<string, unknown>) => ({ Items: [visitRecord({ appointmentId: `7777777${index}-7777-4777-8777-777777777777`, sk: `VISIT#${index}`, note: { status: "signed", source: "zoom_ai_companion", zoomSummaryId: "u", revision: 2, importedAt: "", signedAt: "", signedBy: "" } })], ...(last ? { LastEvaluatedKey: last } : {}) });
    send.mockResolvedValueOnce(page(1, { pk: "x", sk: "1" })).mockResolvedValueOnce(page(2));
    const result = await createTelehealthHandler(config)(event("GET /clinical-core/workforce/appointments/visits", undefined, workforceClaims));
    const payload = JSON.parse(result.body ?? "{}") as { data: { visits: Array<Record<string, unknown>>; complete: boolean } };
    expect(payload.data.complete).toBe(true);
    expect(payload.data.visits).toHaveLength(2);
    expect(payload.data.visits[0].note).toEqual({ status: "signed", source: "zoom_ai_companion", zoomSummaryId: "u", revision: 2, importedAt: "", signedAt: "", signedBy: "" });
    expect(payload.data.visits[0]).not.toHaveProperty("passcode");
    const query = send.mock.calls[0][0] as { input: { ProjectionExpression: string; ExclusiveStartKey?: unknown } };
    expect(query.input.ProjectionExpression).not.toContain("aiOriginal");
    expect((send.mock.calls[1][0] as { input: { ExclusiveStartKey?: unknown } }).input.ExclusiveStartKey).toEqual({ pk: "x", sk: "1" });

    send.mockReset();
    for (let index = 0; index < 20; index += 1) send.mockResolvedValueOnce(page(index, { pk: "x", sk: String(index) }));
    const bounded = await createTelehealthHandler(config)(event("GET /clinical-core/workforce/appointments/visits", undefined, workforceClaims));
    expect(JSON.parse(bounded.body ?? "{}").data.complete).toBe(false);
  });

  it("closes a visit when its booking is cancelled, deleting a meeting the visit itself created", async () => {
    const calls = fetchRouter([...zoomRoutes()]);
    send.mockResolvedValueOnce({ Items: [requestRecord({ providerMeetingId: null })] }).mockResolvedValueOnce({ Items: [{ pk: `ORG#${ORG}`, sk: "SLOT#x", slotId: "55555555-5555-4555-8555-555555555555", start: "2026-10-09T17:00:00.000Z", cancellationWindowHours: 24, status: "booked" }] })
      .mockResolvedValueOnce({}).mockResolvedValueOnce({ Item: visitRecord({ status: "scheduled", providerMeetingId: "900000003", joinUrl: "https://zoom.us/j/900000003" }) }).mockResolvedValueOnce({});
    const result = await createTelehealthHandler(zoomConfig)(event("POST /clinical-core/workforce/appointments/actions", { requestId: REQUEST, action: "cancel", expectedVersion: 2 }, workforceClaims));
    expect(result.statusCode).toBe(200);
    expect(calls.some((call) => call.method === "DELETE" && call.url.includes("/meetings/900000003"))).toBe(true);
    const closed = putCalls().at(-1)?.input.Item as Record<string, unknown>;
    expect(closed).toMatchObject({ status: "cancelled", providerMeetingId: null });
  });

  it("signs a Meeting SDK JWT with the SDK key as appKey and HS256", () => {
    const token = signMeetingSdkJwt("sdk-key", "sdk-secret", { mn: "123456789", role: 1, iat: 1, exp: 2, tokenExp: 2 });
    const [header, payload, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "HS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toMatchObject({ appKey: "sdk-key", mn: "123456789", role: 1 });
    expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
