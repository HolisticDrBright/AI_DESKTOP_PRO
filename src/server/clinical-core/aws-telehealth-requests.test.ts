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

import { createTelehealthHandler, MAX_SUMMARY_BYTES, MEETING_SETTLEMENT_MS, readBoundedJson, signMeetingSdkJwt, type TelehealthConfiguration } from "./aws-telehealth-requests";

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
  const PATIENT = "66666666-6666-4666-8666-666666666666";
  const PRACTITIONER = "11111111-aaaa-4aaa-8aaa-111111111111";
  const HOST = "host@example.test";
  const LEASE = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
  const agendaFor = (leaseId: string, appointmentId = APPOINTMENT) => `Governed telehealth visit alp-visit:${appointmentId}:${leaseId}`;
  const ARTIFACT = { artifactId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", scope: "telehealth_recording", artifactVersion: "telehealth-recording/1", contentSha256: "b".repeat(64), jurisdiction: "US-CA", approvedAt: "2026-10-01T00:00:00.000Z" };
  const zoomConfig = { ...config, zoomEnabled: true, zoomBaaVerified: true, zoomSecretArn: "arn:secret" };
  const receipt = (overrides: Record<string, unknown> = {}) => ({ consentId: "88888888-8888-4888-8888-888888888888", consentType: "telehealth_recording_combined", scope: "telehealth_recording",
    artifactId: ARTIFACT.artifactId, artifactVersion: ARTIFACT.artifactVersion, contentSha256: ARTIFACT.contentSha256, signerName: "Synthetic Signer", method: "staff_attested", representativeAuthority: "self",
    signedAt: "2026-10-01T00:00:00.000Z", recordedBy: workforceClaims["custom:person_id"], patientLocation: "CA", grantId: null, connectionId: null, status: "granted", withdrawnAt: null, withdrawnBy: null, withdrawalReason: null, ...overrides });
  const visitRecord = (overrides: Record<string, unknown> = {}) => ({
    pk: `ORG#${ORG}`, sk: `VISIT#${APPOINTMENT}`, appointmentId: APPOINTMENT, organizationId: ORG, requestId: null, consumerPersonId: null, patientRecordId: PATIENT, practitionerUserId: PRACTITIONER,
    scheduledStart: "2026-10-09T17:00:00.000Z", scheduledEnd: "2026-10-09T17:30:00.000Z", timeZone: "America/Los_Angeles",
    status: "scheduled", consents: [receipt()], meetingLease: null, providerMeetingId: null, providerMeetingUuid: null, joinUrl: null, passcode: null, startedAt: null, endedAt: null,
    providerShutdown: { status: "not_started", attemptedAt: null, confirmedAt: null, detail: null }, flags: [], quickNotes: "", note: null, noteHistory: [],
    version: 1, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", ...overrides,
  });
  /** A patient-app visit: bound to its request, so it carries no calendar patient/practitioner identity. */
  const appVisit = (overrides: Record<string, unknown> = {}) => visitRecord({ requestId: REQUEST, consumerPersonId: claims["custom:person_id"], patientRecordId: null, practitionerUserId: null, ...overrides });
  const requestRecord = (overrides: Record<string, unknown> = {}) => ({
    pk: `ORG#${ORG}`, sk: `REQ#2026-09-01T00:00:00.000Z#${REQUEST}`, requestId: REQUEST, organizationId: ORG, consumerPersonId: claims["custom:person_id"], consumerEmail: claims.email,
    status: "scheduled", visitType: "follow_up", preferredSlots: [], timeZone: "America/Los_Angeles", note: null, scheduledStart: "2026-10-09T17:00:00.000Z", scheduledEnd: "2026-10-09T17:30:00.000Z",
    joinUrl: null, providerMeetingId: null, version: 2, createdAt: "", updatedAt: "", lastActionBy: "workforce", slotId: "55555555-5555-4555-8555-555555555555", appointmentId: APPOINTMENT,
    priceMinor: 0, currency: "USD", cancellationPolicy: "", cancellationWindowHours: 24, cancellationFeeDueMinor: 0, reminderStatus: "disabled", paymentPolicyVersion: "telehealth-payments/1",
    paymentAuthorizationStatus: "not_authorized", paymentStatus: "not_due", paymentIntentId: null, paidMinor: 0, refundedMinor: 0, ...overrides,
  });
  const calendarRow = (overrides: Record<string, unknown> = {}) => ({ id: APPOINTMENT, patient_id: PATIENT, patient_name: "Synthetic Patient", practitioner_user_id: PRACTITIONER, practitioner_name: "Dr",
    title: null, appointment_type: "telehealth", location: "Telehealth", telehealth_url: null, status: "confirmed", version: 1, starts_at: "2026-10-09T17:00:00.000Z", ends_at: "2026-10-09T17:30:00.000Z", ...overrides });
  const start = (handlerConfig = zoomConfig, extra: Record<string, unknown> = {}) => createTelehealthHandler(handlerConfig)(event("POST /clinical-core/workforce/appointments/visits/start", { appointmentId: APPOINTMENT, hostDisplayName: "Dr. Synthetic", ...extra }, workforceClaims));
  const jsonResponse = (status: number, body: unknown, text?: string) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => text ?? JSON.stringify(body) });
  /**
   * A REAL `Response` over a ReadableStream, so body bounds are exercised on
   * the wire, not on a prebuilt string: `chunks` arrive one per pull, the
   * stream records how many were pulled and whether it was cancelled.
   */
  const streamed = (status: number, chunks: Array<Uint8Array | string>, headers: Record<string, string> = {}) => {
    const probe = { pulled: 0, cancelled: false };
    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= chunks.length) { controller.close(); return; }
        probe.pulled += 1;
        const chunk = chunks[index]; index += 1;
        controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
      },
      cancel() { probe.cancelled = true; },
    });
    return Object.assign(new Response(stream, { status, headers }), { probe });
  };
  const streamedJson = (body: unknown, headers: Record<string, string> = {}) => streamed(200, [JSON.stringify(body)], headers);
  const SUMMARY = (extra: Record<string, unknown> = {}) => ({ meeting_id: 900000001, meeting_uuid: "uuid-900000001", meeting_host_email: HOST, summary_content: "# Visit\n\nPatient reports better afternoons.", ...extra });

  /**
   * DynamoDB stand-in: reads are queued per command kind (so interleaved
   * writes never consume a queued read), writes succeed unless a test
   * installs `failWrite`, and every write is recorded for assertions.
   */
  const reads = { get: [] as unknown[], query: [] as unknown[] };
  const writes: Array<Record<string, unknown>> = [];
  let failWrite: ((input: Record<string, unknown>, index: number) => Error | null) | null = null;
  const queueGet = (...items: unknown[]) => reads.get.push(...items.map((item) => ({ Item: item })));
  const queueQuery = (...pages: unknown[]) => reads.query.push(...pages);
  const installDynamo = () => send.mockImplementation(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    if (command.constructor.name === "GetCommand") return reads.get.shift() ?? { Item: undefined };
    if (command.constructor.name === "QueryCommand") return reads.query.shift() ?? { Items: [] };
    const index = writes.push(command.input) - 1;
    const error = failWrite?.(command.input, index);
    if (error) throw error;
    return {};
  });
  const putItems = () => writes.filter((write) => "Item" in write).map((write) => write.Item as Record<string, unknown>);
  const conditional = () => Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });

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
  const identityRoutes = (options: { grant?: Record<string, unknown> | null; calendar?: Array<Record<string, unknown>> | (() => unknown) } = {}): Array<[string | RegExp, (url: string, init?: RequestInit) => unknown]> => [
    ["/clinical-core/workforce/consent-artifact", () => jsonResponse(200, { data: ARTIFACT })],
    ["/clinical-core/workforce/consents/current", () => jsonResponse(200, { data: options.grant ?? { status: "none", patientRecordId: null, connectionId: null, consentId: null, artifactId: null, artifactVersion: null, contentSha256: null, artifactStatus: null } })],
    ["/clinical-core/workforce/consents/grant", () => jsonResponse(201, { data: { consentId: "99999999-9999-4999-8999-999999999999", connectionId: "44444444-4444-4444-8444-444444444444", status: "granted" } })],
    ["/clinical-core/workforce/consents/revoke", () => jsonResponse(201, { data: { status: "revoked" } })],
    ["/clinical-core/workforce/data-compatibility", typeof options.calendar === "function" ? options.calendar : () => jsonResponse(200, { data: { appointments: options.calendar ?? [calendarRow()], practitioners: [], patients: [] } })],
  ];
  const meetingBody = (id: number, extra: Record<string, unknown> = {}) => ({ id, uuid: `uuid-${id}`, host_email: HOST, join_url: `https://zoom.us/j/${id}?pwd=ENCRYPTED-URL-TOKEN`, password: `real-password-${id}`, status: "waiting", ...extra });
  const zoomRoutes = (overrides: Partial<Record<"token" | "list" | "create" | "zak" | "end" | "get" | "summary" | "instances" | "delete", (url: string, init?: RequestInit) => unknown>> = {}): Array<[string | RegExp, (url: string, init?: RequestInit) => unknown]> => [
    ["zoom.us/oauth/token", overrides.token ?? (() => jsonResponse(200, { access_token: "zoom-access" }))],
    [/\/users\/[^/]+\/meetings\?/, overrides.list ?? (() => jsonResponse(200, { meetings: [] }))],
    [/\/users\/[^/]+\/meetings$/, overrides.create ?? (() => jsonResponse(201, meetingBody(900000001)))],
    ["/token?type=zak", overrides.zak ?? (() => jsonResponse(200, { token: "zak-token" }))],
    [/\/meetings\/[^/]+\/status$/, overrides.end ?? (() => jsonResponse(204, {}))],
    [/\/past_meetings\/[^/]+\/instances$/, overrides.instances ?? (() => streamedJson({ meetings: [{ uuid: "uuid-900000001", start_time: "2026-10-09T17:00:00.000Z" }] }))],
    [/\/meetings\/[^/?]+\/meeting_summary$/, overrides.summary ?? (() => jsonResponse(404, {}))],
    [/\/meetings\/[^/?]+$/, (url, init) => (init?.method === "DELETE" ? (overrides.delete ?? (() => jsonResponse(204, {})))(url, init) : (overrides.get ?? ((u: string) => jsonResponse(200, meetingBody(Number(/\/meetings\/(\d+)/.exec(u)?.[1] ?? "0")))))(url, init))],
  ];
  const creates = (calls: Array<{ url: string; method: string; body?: unknown }>) => calls.filter((call) => call.method === "POST" && /\/meetings$/.test(call.url));
  const deletes = (calls: Array<{ url: string; method: string }>) => calls.filter((call) => call.method === "DELETE");

  beforeEach(() => {
    send.mockReset(); reads.get.length = 0; reads.query.length = 0; writes.length = 0; failWrite = null; installDynamo();
    secretsSend.mockReset(); secretsSend.mockResolvedValue({ SecretString: JSON.stringify({ accountId: "acct", clientId: "client-id", clientSecret: "client-secret", userId: "host@example.test", sdkKey: "sdk-key", sdkSecret: "sdk-secret" }) });
  });
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

  /* ---------------------------------------------------- appointment authority at the AWS boundary */

  it("refuses a direct AWS call for an appointment the caller's calendar does not return — no write, no secret, no provider call", async () => {
    const calls = fetchRouter([...identityRoutes({ calendar: [] }), ...zoomRoutes()]);
    const consent = await createTelehealthHandler(config)(event("POST /clinical-core/workforce/appointments/visits/consent", {
      appointmentId: "12121212-1212-4121-8121-121212121212", artifactId: ARTIFACT.artifactId, artifactVersion: ARTIFACT.artifactVersion, contentSha256: ARTIFACT.contentSha256,
      signerName: "Someone", agreed: true, start: "2026-10-09T17:00:00.000Z", end: "2026-10-09T17:30:00.000Z", timeZone: "America/Los_Angeles",
    }, workforceClaims));
    expect(consent.statusCode).toBe(404);
    expect(writes).toHaveLength(0);
    expect(calls.map((call) => call.url)).toEqual([expect.stringContaining("/data-compatibility")]);
    expect(calls[0].body).toMatchObject({ kind: "rpc", functionName: "get_desktop_calendar", args: { _organization_id: ORG } });
    expect(secretsSend).not.toHaveBeenCalled();
  });

  it("binds a desktop-booked consent to the calendar's appointment: its patient and stored times, not the caller's", async () => {
    fetchRouter([...identityRoutes({ calendar: [calendarRow({ starts_at: "2026-10-09T18:00:00.000Z", ends_at: "2026-10-09T18:45:00.000Z" })] })]);
    const result = await createTelehealthHandler(config)(event("POST /clinical-core/workforce/appointments/visits/consent", {
      appointmentId: APPOINTMENT, artifactId: ARTIFACT.artifactId, artifactVersion: ARTIFACT.artifactVersion, contentSha256: ARTIFACT.contentSha256,
      signerName: "Signer", agreed: true, start: "1999-01-01T00:00:00.000Z", end: "1999-01-01T00:30:00.000Z", timeZone: "America/Los_Angeles",
    }, workforceClaims));
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body ?? "{}").data).toMatchObject({ patientRecordId: PATIENT, scheduledStart: "2026-10-09T18:00:00.000Z", scheduledEnd: "2026-10-09T18:45:00.000Z" });
  });

  it("refuses to start, consent or import when the calendar says cancelled, when membership is revoked, or when the appointment is not telehealth", async () => {
    fetchRouter([...identityRoutes({ calendar: [calendarRow({ status: "cancelled" })] }), ...zoomRoutes()]);
    queueGet(visitRecord());
    const cancelled = await start();
    expect(cancelled.statusCode).toBe(409);
    expect(JSON.parse(cancelled.body ?? "{}")).toEqual({ error: "appointment_cancelled" });

    fetchRouter([...identityRoutes({ calendar: () => jsonResponse(403, { error: "identity_refused" }) }), ...zoomRoutes()]);
    queueGet(visitRecord());
    const revoked = await start();
    expect(revoked.statusCode).toBe(403);

    fetchRouter([...identityRoutes({ calendar: [calendarRow({ appointment_type: "follow-up" })] }), ...zoomRoutes()]);
    queueGet(visitRecord({ status: "ended", providerMeetingId: "900000001" }));
    const imported = await createTelehealthHandler(zoomConfig)(event("POST /clinical-core/workforce/appointments/visits/notes/import", { appointmentId: APPOINTMENT }, workforceClaims));
    expect(imported.statusCode).toBe(400);
    expect(writes).toHaveLength(0);
    expect(secretsSend).not.toHaveBeenCalled();
  });

  it("refuses to start a visit with no consent on record: the appointment is verified, then nothing else — no consent read, secret or provider call", async () => {
    const calls = fetchRouter([...identityRoutes(), ...zoomRoutes()]);
    queueGet(visitRecord({ consents: [] }));
    const result = await start();
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body ?? "{}")).toEqual({ error: "consent_required" });
    expect(calls.map((call) => call.url)).toEqual([expect.stringContaining("/data-compatibility")]);
    expect(secretsSend).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("refuses a superseded artifact, a withdrawn governed grant, and a patient-app visit whose connection is gone", async () => {
    fetchRouter([["/consent-artifact", () => jsonResponse(200, { data: { ...ARTIFACT, artifactId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", artifactVersion: "telehealth-recording/2", contentSha256: "c".repeat(64) } })], ...identityRoutes()]);
    queueGet(visitRecord());
    const superseded = await start();
    expect(superseded.statusCode).toBe(409);
    expect(JSON.parse(superseded.body ?? "{}")).toEqual({ error: "consent_superseded" });

    fetchRouter(identityRoutes({ grant: { status: "revoked", connectionId: "44444444-4444-4444-8444-444444444444", artifactId: null, artifactStatus: null } }));
    queueGet(appVisit()); queueQuery({ Items: [requestRecord()] });
    const withdrawn = await start();
    expect(withdrawn.statusCode).toBe(409);
    expect(JSON.parse(withdrawn.body ?? "{}")).toEqual({ error: "consent_withdrawn" });

    // No current connection for the consumer: lost authority, not a fallback to staff-only consent.
    fetchRouter(identityRoutes({ grant: { status: "none", connectionId: null, artifactId: null, artifactStatus: null } }));
    queueGet(appVisit({ consents: [receipt({ grantId: "g1", connectionId: "44444444-4444-4444-8444-444444444444" })] })); queueQuery({ Items: [requestRecord()] });
    const gone = await start();
    expect(gone.statusCode).toBe(409);
    expect(JSON.parse(gone.body ?? "{}")).toEqual({ error: "consent_required" });
    expect(secretsSend).not.toHaveBeenCalled();
  });

  it("binds a patient-app visit to its request: cancelled, mismatched or missing requests refuse before consent or provider work", async () => {
    const calls = fetchRouter([...identityRoutes(), ...zoomRoutes()]);
    queueGet(appVisit()); queueQuery({ Items: [requestRecord({ status: "cancelled" })] });
    const cancelled = await start();
    expect(cancelled.statusCode).toBe(409);
    expect(JSON.parse(cancelled.body ?? "{}")).toEqual({ error: "appointment_cancelled" });
    queueGet(appVisit()); queueQuery({ Items: [requestRecord({ appointmentId: "66666666-6666-4666-8666-666666666666" })] });
    expect((await start()).statusCode).toBe(400);
    queueGet(appVisit()); queueQuery({ Items: [] });
    expect((await start()).statusCode).toBe(404);
    expect(calls.filter((call) => call.url.includes("zoom.us"))).toHaveLength(0);
    expect(secretsSend).not.toHaveBeenCalled();
  });

  it("reports the video provider as off rather than inventing a meeting", async () => {
    fetchRouter(identityRoutes({ grant: { status: "granted", connectionId: "44444444-4444-4444-8444-444444444444", artifactId: ARTIFACT.artifactId, artifactStatus: "approved" } }));
    queueGet(appVisit()); queueQuery({ Items: [requestRecord()] });
    const result = await start(config);
    expect(result.statusCode).toBe(503);
    expect(JSON.parse(result.body ?? "{}")).toEqual({ error: "provider_unavailable" });
  });

  /* ---------------------------------------------------- consent receipts */

  it("records a staff-attested consent only against the organization's current approved artifact, append-only, without the passcode", async () => {
    fetchRouter(identityRoutes());
    queueGet(visitRecord({ consents: [receipt()], passcode: "secret-passcode" }));
    const unknown = await createTelehealthHandler(config)(event("POST /clinical-core/workforce/appointments/visits/consent", {
      appointmentId: APPOINTMENT, artifactId: ARTIFACT.artifactId, artifactVersion: "never-reviewed", contentSha256: ARTIFACT.contentSha256, signerName: "Second Signer", agreed: true,
    }, workforceClaims));
    expect(unknown.statusCode).toBe(409);
    expect(JSON.parse(unknown.body ?? "{}")).toEqual({ error: "consent_version_refused" });
    expect(writes).toHaveLength(0);

    queueGet(visitRecord({ consents: [receipt()], passcode: "secret-passcode" }));
    const result = await createTelehealthHandler(config)(event("POST /clinical-core/workforce/appointments/visits/consent", {
      appointmentId: APPOINTMENT, artifactId: ARTIFACT.artifactId, artifactVersion: ARTIFACT.artifactVersion, contentSha256: ARTIFACT.contentSha256, signerName: "Second Signer", agreed: true, patientLocation: "CA",
    }, workforceClaims));
    const payload = JSON.parse(result.body ?? "{}") as { data: Record<string, unknown> };
    expect(result.statusCode).toBe(200);
    expect(payload.data).toMatchObject({ consentSigned: true, version: 2 });
    expect((payload.data.consents as Array<Record<string, unknown>>).map((consent) => consent.status)).toEqual(["granted", "granted"]);
    expect(payload.data).not.toHaveProperty("passcode");
    expect(writes[0].ConditionExpression).toBe("#version = :expected");
  });

  it("records the governed grant through the identity API when the patient has an app connection", async () => {
    const calls = fetchRouter(identityRoutes({ grant: { status: "none", connectionId: "44444444-4444-4444-8444-444444444444", artifactId: null, artifactStatus: null } }));
    queueGet(undefined); queueQuery({ Items: [requestRecord()] });
    const result = await createTelehealthHandler(config)(event("POST /clinical-core/workforce/appointments/visits/consent", {
      appointmentId: APPOINTMENT, requestId: REQUEST, artifactId: ARTIFACT.artifactId, artifactVersion: ARTIFACT.artifactVersion, contentSha256: ARTIFACT.contentSha256, signerName: "Signer", agreed: true,
    }, workforceClaims));
    expect(result.statusCode).toBe(200);
    expect(calls.find((call) => call.url.includes("/consents/grant"))?.body).toMatchObject({ connectionId: "44444444-4444-4444-8444-444444444444", artifactId: ARTIFACT.artifactId, scope: "telehealth_recording", method: "in_person" });
    expect(JSON.parse(result.body ?? "{}").data.consents[0]).toMatchObject({ grantId: "99999999-9999-4999-8999-999999999999", method: "staff_attested" });
  });

  it("withdrawal marks receipts append-only, revokes the governed grant, and blocks a later start", async () => {
    const calls = fetchRouter(identityRoutes());
    queueGet(visitRecord({ consents: [receipt({ grantId: "g1", connectionId: "44444444-4444-4444-8444-444444444444" })] }));
    const result = await createTelehealthHandler(config)(event("POST /clinical-core/workforce/appointments/visits/consent/withdraw", { appointmentId: APPOINTMENT, expectedVersion: 1 }, workforceClaims));
    const payload = JSON.parse(result.body ?? "{}") as { data: { consentSigned: boolean; consents: Array<Record<string, unknown>> } };
    expect(result.statusCode).toBe(200);
    expect(payload.data.consentSigned).toBe(false);
    expect(payload.data.consents[0]).toMatchObject({ status: "withdrawn", withdrawnBy: workforceClaims["custom:person_id"] });
    expect(calls.some((call) => call.url.includes("/consents/revoke"))).toBe(true);
    queueGet(visitRecord({ consents: [receipt({ status: "withdrawn" })] }));
    const later = await start();
    expect(JSON.parse(later.body ?? "{}")).toEqual({ error: "consent_required" });
  });

  /* ---------------------------------------------------- one meeting per visit, with the real password */

  it("creates the provider meeting under a durable lease, binds it with Zoom's actual password (not the join-URL token), and refuses a racing start without a second meeting", async () => {
    const calls = fetchRouter([...identityRoutes(), ...zoomRoutes()]);
    queueGet(visitRecord());
    const first = await start();
    expect(first.statusCode).toBe(200);
    const payload = JSON.parse(first.body ?? "{}") as { data: { visit: Record<string, unknown>; session: Record<string, unknown> } };
    expect(payload.data.visit).toMatchObject({ status: "in_visit", providerMeetingId: "900000001", providerMeetingUuid: "uuid-900000001" });
    expect(payload.data.session).toMatchObject({ meetingNumber: "900000001", passcode: "real-password-900000001", zak: "zak-token" });
    expect(payload.data.session.passcode).not.toContain("ENCRYPTED");
    expect(creates(calls)).toHaveLength(1);
    expect(creates(calls)[0].body).toMatchObject({ agenda: expect.stringContaining(`alp-visit:${APPOINTMENT}`), settings: { waiting_room: true } });
    const leaseStates = putItems().map((item) => (item.meetingLease as { state?: string } | null)?.state ?? null);
    expect(leaseStates.slice(0, 3)).toEqual(["acquired", "dispatched", "dispatched"]);
    expect((putItems()[2].meetingLease as { createdMeetingId: string }).createdMeetingId).toBe("900000001");

    calls.length = 0;
    queueGet(visitRecord());
    failWrite = (input) => ((input.Item as { meetingLease?: unknown })?.meetingLease ? conditional() : null);
    const second = await start();
    expect(second.statusCode).toBe(409);
    expect(creates(calls)).toHaveLength(0);
  });

  it("a thrown create leaves the lease dispatched with its attempt id; the next start settles THAT attempt by exact marker, and an empty list alone never admits a second create", async () => {
    const lostCalls = fetchRouter([...identityRoutes(), ...zoomRoutes({ create: () => { throw new Error("socket hang up after dispatch"); } })]);
    queueGet(visitRecord());
    const lost = await start();
    expect(lost.statusCode).toBe(503);
    expect(creates(lostCalls)).toHaveLength(1);
    const lastLease = putItems().at(-1)?.meetingLease as { leaseId: string; state: string; dispatchedAt: string; createdMeetingId: string | null };
    expect(lastLease).toMatchObject({ state: "dispatched", createdMeetingId: null, dispatchedAt: expect.any(String) });
    expect(creates(lostCalls)[0].body).toMatchObject({ agenda: agendaFor(lastLease.leaseId) });

    // Retry 1: the provider listing cannot be completed → the fence stays and nothing is created.
    writes.length = 0;
    const fencedCalls = fetchRouter([...identityRoutes(), ...zoomRoutes({ list: () => jsonResponse(200, { meetings: [], next_page_token: "more" }) })]);
    queueGet(visitRecord({ meetingLease: lastLease, version: 4 }));
    const fenced = await start();
    expect(fenced.statusCode).toBe(503);
    expect(creates(fencedCalls)).toHaveLength(0);
    expect(putItems().some((item) => item.meetingLease === null)).toBe(false);

    // Retry 2: a complete listing finds the meeting of THIS attempt → adopted, no second create.
    writes.length = 0;
    const adoptedCalls = fetchRouter([...identityRoutes(), ...zoomRoutes({ list: () => jsonResponse(200, { meetings: [{ id: 900000007, agenda: agendaFor(lastLease.leaseId) }] }) })]);
    queueGet(visitRecord({ meetingLease: lastLease, version: 4 }));
    const adopted = await start();
    expect(adopted.statusCode).toBe(200);
    expect(JSON.parse(adopted.body ?? "{}").data.visit).toMatchObject({ providerMeetingId: "900000007" });
    expect(JSON.parse(adopted.body ?? "{}").data.session.passcode).toBe("real-password-900000007");
    expect(creates(adoptedCalls)).toHaveLength(0);

    // Retry 3: a complete, EMPTY listing while the dispatched create may still be executing
    // (inside the settlement window) is not proof of absence: refused, lease kept, no create.
    writes.length = 0;
    const unsettledCalls = fetchRouter([...identityRoutes(), ...zoomRoutes()]);
    queueGet(visitRecord({ meetingLease: lastLease, version: 4 }));
    const unsettled = await start();
    expect(unsettled.statusCode).toBe(409);
    expect(JSON.parse(unsettled.body ?? "{}")).toEqual({ error: "meeting_unsettled" });
    expect(creates(unsettledCalls)).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect(secretsSend.mock.calls.length).toBeGreaterThan(0); // the provider WAS consulted; the empty answer was just not enough

    // Retry 4: the settlement window has passed — the invocation that sent the create cannot be
    // running — and a complete exact listing is still empty: the attempt is settled as absent and
    // ONE new attempt (a new marker) is admitted.
    writes.length = 0;
    const settledLease = { ...lastLease, dispatchedAt: new Date(Date.now() - MEETING_SETTLEMENT_MS - 1000).toISOString() };
    const recreatedCalls = fetchRouter([...identityRoutes(), ...zoomRoutes()]);
    queueGet(visitRecord({ meetingLease: settledLease, version: 4 }));
    const recreated = await start();
    expect(recreated.statusCode).toBe(200);
    expect(creates(recreatedCalls)).toHaveLength(1);
    const newAgenda = (creates(recreatedCalls)[0].body as { agenda: string }).agenda;
    expect(newAgenda).not.toBe(agendaFor(lastLease.leaseId));
    expect(newAgenda).toMatch(new RegExp(`^Governed telehealth visit alp-visit:${APPOINTMENT}:[0-9a-f-]{36}$`));
    expect(putItems().every((item) => (item.settledLeaseIds as string[]).includes(lastLease.leaseId))).toBe(true);
    expect(JSON.parse(recreated.body ?? "{}").data).not.toHaveProperty("settledLeaseIds");
  });

  it("the settlement window is a platform fact: it exceeds the function timeout by a wide margin", () => {
    const template = JSON.parse(readFileSync("infra/aws-clinical-core/telehealth-requests-extension.json", "utf8")) as { Resources: { TelehealthFunction: { Properties: { Timeout: number } } } };
    expect(MEETING_SETTLEMENT_MS).toBeGreaterThanOrEqual(template.Resources.TelehealthFunction.Properties.Timeout * 1000 * 5);
  });

  it("a settled attempt's meeting that materialises late is an orphan: deleted on the next listing, never adopted; after the visit ends it is swept", async () => {
    // The visit settled attempt LEASE as absent; the next start finds its meeting after all.
    const calls = fetchRouter([...identityRoutes(), ...zoomRoutes({ list: () => jsonResponse(200, { meetings: [{ id: 900000055, agenda: agendaFor(LEASE) }] }) })]);
    queueGet(visitRecord({ settledLeaseIds: [LEASE] }));
    const result = await start();
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body ?? "{}").data.visit.providerMeetingId).toBe("900000001"); // the new attempt's meeting, not the orphan
    expect(deletes(calls).map((call) => call.url)).toEqual([expect.stringContaining("/meetings/900000055")]);
    expect(creates(calls)).toHaveLength(1);

    // Bound elsewhere and ended: the sweep removes a late orphan and leaves the bound meeting alone.
    const sweep = fetchRouter([...identityRoutes(), ...zoomRoutes({ list: () => jsonResponse(200, { meetings: [{ id: 900000055, agenda: agendaFor(LEASE) }, { id: 900000001, agenda: agendaFor("ffffffff-ffff-4fff-8fff-ffffffffffff") }] }) })]);
    queueGet(visitRecord({ status: "in_visit", providerMeetingId: "900000001", settledLeaseIds: [LEASE], version: 6 }));
    const ended = await createTelehealthHandler(zoomConfig)(event("POST /clinical-core/workforce/appointments/visits/end", { appointmentId: APPOINTMENT, expectedVersion: 6 }, workforceClaims));
    expect(JSON.parse(ended.body ?? "{}").data).toMatchObject({ status: "ended" });
    expect(deletes(sweep).map((call) => call.url)).toEqual([expect.stringContaining("/meetings/900000055")]);
  });

  it("ambiguity at the provider is refused, never resolved by picking a row: an unknown attempt, two meetings for one attempt, a substring match, another host", async () => {
    // A marker for this visit from no attempt this record knows → not ours to adopt or delete: refused, lease released, no create.
    const unknownCalls = fetchRouter([...identityRoutes(), ...zoomRoutes({ list: () => jsonResponse(200, { meetings: [{ id: 900000031, agenda: agendaFor("ffffffff-ffff-4fff-8fff-ffffffffffff") }] }) })]);
    queueGet(visitRecord());
    const unknown = await start();
    expect(unknown.statusCode).toBe(409);
    expect(JSON.parse(unknown.body ?? "{}")).toEqual({ error: "meeting_unsettled" });
    expect(creates(unknownCalls)).toHaveLength(0);
    expect(deletes(unknownCalls)).toHaveLength(0);
    expect(putItems().at(-1)?.meetingLease).toBeNull();

    // Two meetings for the attempt being settled → refused, nothing adopted.
    const dispatched = { leaseId: LEASE, acquiredAt: new Date().toISOString(), dispatchedAt: new Date().toISOString(), state: "dispatched", createdMeetingId: null };
    const twinCalls = fetchRouter([...identityRoutes(), ...zoomRoutes({ list: () => jsonResponse(200, { meetings: [{ id: 900000041, agenda: agendaFor(LEASE) }, { id: 900000042, agenda: agendaFor(LEASE) }] }) })]);
    queueGet(visitRecord({ meetingLease: dispatched }));
    const twins = await start();
    expect(twins.statusCode).toBe(409);
    expect(creates(twinCalls)).toHaveLength(0);
    expect(putItems().some((item) => item.providerMeetingId)).toBe(false);

    // A substring/prefix is not the marker: an agenda that merely contains it is not this attempt's meeting.
    const looseCalls = fetchRouter([...identityRoutes(), ...zoomRoutes({ list: () => jsonResponse(200, { meetings: [{ id: 900000043, agenda: `${agendaFor(LEASE)} (copy)` }, { id: 900000044, agenda: `alp-visit:${APPOINTMENT}` }] }) })]);
    queueGet(visitRecord({ meetingLease: dispatched }));
    const loose = await start();
    expect(loose.statusCode).toBe(409); // inside the window, nothing exact found → unsettled
    expect(creates(looseCalls)).toHaveLength(0);
    expect(putItems().some((item) => item.providerMeetingId)).toBe(false);

    // The attempt's meeting exists but under another host account → never bound.
    const hostCalls = fetchRouter([...identityRoutes(), ...zoomRoutes({ list: () => jsonResponse(200, { meetings: [{ id: 900000045, agenda: agendaFor(LEASE) }] }), get: (url) => jsonResponse(200, meetingBody(Number(/\/meetings\/(\d+)/.exec(url)?.[1] ?? "0"), { host_email: "someone-else@example.test" })) })]);
    queueGet(visitRecord({ meetingLease: dispatched }));
    const other = await start();
    expect(other.statusCode).toBe(503);
    expect(creates(hostCalls)).toHaveLength(0);
    expect(putItems().some((item) => item.providerMeetingId)).toBe(false);
  });

  it("an evidenced create is adopted by its exact id on retry, and a lost database receipt is confirmed by reread instead of deleting the meeting", async () => {
    const adoptedCalls = fetchRouter([...identityRoutes(), ...zoomRoutes()]);
    queueGet(visitRecord({ meetingLease: { leaseId: "L", acquiredAt: "2026-10-09T17:00:00.000Z", state: "dispatched", createdMeetingId: "900000009" } }));
    const adopted = await start();
    expect(adopted.statusCode).toBe(200);
    expect(JSON.parse(adopted.body ?? "{}").data.visit.providerMeetingId).toBe("900000009");
    expect(creates(adoptedCalls)).toHaveLength(0);
    expect(adoptedCalls.some((call) => call.url.includes("/meetings?"))).toBe(false);

    writes.length = 0;
    // The bind write throws after the row actually landed: the reread shows the meeting bound → success, no delete.
    const receiptCalls = fetchRouter([...identityRoutes(), ...zoomRoutes()]);
    let lostOnce = false;
    failWrite = (input) => {
      if (lostOnce || (input.Item as { providerMeetingId?: string })?.providerMeetingId !== "900000001") return null;
      lostOnce = true;
      return new Error("receipt lost");
    };
    queueGet(visitRecord(), visitRecord({ providerMeetingId: "900000001", providerMeetingUuid: "uuid-900000001", joinUrl: "https://zoom.us/j/900000001", passcode: "real-password-900000001", version: 4 }));
    const confirmed = await start();
    expect(confirmed.statusCode).toBe(200);
    expect(deletes(receiptCalls)).toHaveLength(0);
    expect(creates(receiptCalls)).toHaveLength(1);
  });

  it("cleans up a meeting this attempt created when the reread shows the visit was cancelled underneath it", async () => {
    const calls = fetchRouter([...identityRoutes(), ...zoomRoutes()]);
    failWrite = (input) => ((input.Item as { providerMeetingId?: string })?.providerMeetingId === "900000001" ? conditional() : null);
    queueGet(visitRecord(), visitRecord({ status: "cancelled", version: 9 }));
    const result = await start();
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body ?? "{}")).toEqual({ error: "appointment_cancelled" });
    expect(deletes(calls).some((call) => call.url.includes("/meetings/900000001"))).toBe(true);
  });

  /* ---------------------------------------------------- shutdown is a provider observation */

  it("never certifies shutdown without a valid provider observation: disabled provider, missing state, wrong meeting, 404 and refused end all stay `ending`", async () => {
    const end = (handlerConfig: TelehealthConfiguration, version: number) => createTelehealthHandler(handlerConfig)(event("POST /clinical-core/workforce/appointments/visits/end", { appointmentId: APPOINTMENT, expectedVersion: version, flags: [{ atSeconds: 10, label: "x" }], quickNotes: "notes" }, workforceClaims));
    const running = (version: number) => visitRecord({ status: "in_visit", providerMeetingId: "900000001", joinUrl: "https://zoom.us/j/900000001", startedAt: "2026-10-09T17:00:00.000Z", version });
    const outcome = async (handlerConfig: TelehealthConfiguration, version: number) => JSON.parse((await end(handlerConfig, version)).body ?? "{}").data as Record<string, unknown>;

    // Zoom disabled on this deployment but a meeting exists: no observation, no certification.
    const calls = fetchRouter([...identityRoutes()]);
    queueGet(running(3));
    expect(await outcome(config, 3)).toMatchObject({ status: "ending", endedAt: null, quickNotes: "notes", providerShutdown: { status: "failed", detail: expect.stringContaining("disabled") } });
    expect(calls.some((call) => call.url.includes("zoom.us"))).toBe(false);

    fetchRouter([...identityRoutes(), ...zoomRoutes({ get: () => jsonResponse(200, {}) })]);
    queueGet(running(5));
    expect(await outcome(zoomConfig, 5)).toMatchObject({ status: "ending", providerShutdown: { status: "failed", detail: expect.stringContaining("different meeting") } });

    fetchRouter([...identityRoutes(), ...zoomRoutes({ get: () => jsonResponse(200, { id: 900000001 }) })]);
    queueGet(running(5));
    expect(await outcome(zoomConfig, 5)).toMatchObject({ status: "ending", providerShutdown: { status: "failed", detail: expect.stringContaining("no recognised") } });

    fetchRouter([...identityRoutes(), ...zoomRoutes({ get: () => jsonResponse(404, {}) })]);
    queueGet(running(5));
    expect(await outcome(zoomConfig, 5)).toMatchObject({ status: "ending", providerShutdown: { status: "failed" } });

    fetchRouter([...identityRoutes(), ...zoomRoutes({ end: () => jsonResponse(500, {}) })]);
    queueGet(running(5));
    expect(await outcome(zoomConfig, 5)).toMatchObject({ status: "ending", providerShutdown: { status: "failed", detail: expect.stringContaining("refused") } });

    fetchRouter([...identityRoutes(), ...zoomRoutes({ get: () => jsonResponse(200, { id: 900000001, status: "started" }) })]);
    queueGet(running(5));
    expect(await outcome(zoomConfig, 5)).toMatchObject({ status: "ending", providerShutdown: { status: "failed", detail: expect.stringContaining("still running") } });

    // The documented terminal state for THIS meeting: ended.
    fetchRouter([...identityRoutes(), ...zoomRoutes()]);
    queueGet(visitRecord({ status: "ending", providerMeetingId: "900000001", version: 7 }));
    expect(await outcome(zoomConfig, 7)).toMatchObject({ status: "ended", providerShutdown: { status: "ended" } });

    // Duplicate end on an ended visit is idempotent and touches nothing.
    writes.length = 0;
    queueGet(visitRecord({ status: "ended", version: 9 }));
    expect(await outcome(zoomConfig, 9)).toMatchObject({ status: "ended", version: 9 });
    expect(writes).toHaveLength(0);
  });

  /* ---------------------------------------------------- the AI summary */

  const importNote = () => createTelehealthHandler(zoomConfig)(event("POST /clinical-core/workforce/appointments/visits/notes/import", { appointmentId: APPOINTMENT }, workforceClaims));

  it("imports the current unified summary as unreviewed source text only for the EXACT meeting instance and the configured host", async () => {
    fetchRouter([...identityRoutes(), ...zoomRoutes({ summary: () => streamedJson(SUMMARY()) })]);
    queueGet(visitRecord({ status: "ended", providerMeetingId: "900000001", providerMeetingUuid: "uuid-900000001" }));
    const unified = await importNote();
    const payload = JSON.parse(unified.body ?? "{}") as { data: { summaryReady: boolean; visit: { note: Record<string, unknown> } } };
    expect(unified.statusCode).toBe(200);
    expect(payload.data.summaryReady).toBe(true);
    expect(payload.data.visit.note).toMatchObject({ status: "not_reviewed", zoomSummaryId: "uuid-900000001", aiSections: { summary: "# Visit\n\nPatient reports better afternoons.", patient_reported: "", results_reviewed: "", plan_discussed: "" }, actionItems: [] });

    for (const [label, bad] of Object.entries({
      "another meeting number": SUMMARY({ meeting_id: 123 }),
      "no meeting id": { meeting_uuid: "uuid-900000001", meeting_host_email: HOST, summary_content: "no meeting id at all" },
      "another instance": SUMMARY({ meeting_uuid: "another-instance" }),
      "no instance uuid (a reusable number is not an instance)": { meeting_id: 900000001, meeting_host_email: HOST, summary_content: "number only" },
      "another host": SUMMARY({ meeting_host_email: "someone-else@example.test" }),
      "no host at all": { meeting_id: 900000001, meeting_uuid: "uuid-900000001", summary_content: "unattributed" },
    })) {
      writes.length = 0;
      fetchRouter([...identityRoutes(), ...zoomRoutes({ summary: () => streamedJson(bad) })]);
      queueGet(visitRecord({ status: "ended", providerMeetingId: "900000001", providerMeetingUuid: "uuid-900000001" }));
      const refused = await importNote();
      expect(refused.statusCode, label).toBe(503);
      expect(writes, label).toHaveLength(0);
    }

    // The host id form of the account is accepted too.
    fetchRouter([...identityRoutes(), ...zoomRoutes({ summary: () => streamedJson({ ...SUMMARY(), meeting_host_email: undefined, meeting_host_id: HOST }) })]);
    queueGet(visitRecord({ status: "ended", providerMeetingId: "900000001", providerMeetingUuid: "uuid-900000001" }));
    expect((await importNote()).statusCode).toBe(200);

    fetchRouter([...identityRoutes(), ...zoomRoutes({ summary: () => streamedJson(SUMMARY({ summary_content: "   " })) })]);
    queueGet(visitRecord({ status: "ended", providerMeetingId: "900000001", providerMeetingUuid: "uuid-900000001" }));
    const empty = await importNote();
    expect(JSON.parse(empty.body ?? "{}").data).toMatchObject({ summaryReady: false });
  });

  it("a visit bound without an instance uuid obtains it from the provider's instance list: one held instance verifies, none is not ready, several are ambiguous", async () => {
    const calls = fetchRouter([...identityRoutes(), ...zoomRoutes({ summary: () => streamedJson(SUMMARY()) })]);
    queueGet(visitRecord({ status: "ended", providerMeetingId: "900000001", providerMeetingUuid: null }));
    expect(JSON.parse((await importNote()).body ?? "{}").data).toMatchObject({ summaryReady: true });
    expect(calls.some((call) => call.url.includes("/past_meetings/900000001/instances"))).toBe(true);

    const none = fetchRouter([...identityRoutes(), ...zoomRoutes({ instances: () => streamedJson({ meetings: [] }), summary: () => streamedJson(SUMMARY()) })]);
    queueGet(visitRecord({ status: "ended", providerMeetingId: "900000001", providerMeetingUuid: null }));
    expect(JSON.parse((await importNote()).body ?? "{}").data).toMatchObject({ summaryReady: false });
    expect(none.some((call) => call.url.includes("/meeting_summary"))).toBe(false);

    fetchRouter([...identityRoutes(), ...zoomRoutes({ instances: () => streamedJson({ meetings: [{ uuid: "uuid-900000001" }, { uuid: "uuid-900000001-second-run" }] }), summary: () => streamedJson(SUMMARY()) })]);
    queueGet(visitRecord({ status: "ended", providerMeetingId: "900000001", providerMeetingUuid: null }));
    expect((await importNote()).statusCode).toBe(503);
  });

  it("the summary body is bounded on the wire: cancelled mid-stream on overrun, refused on dishonest, malformed or missing lengths and malformed UTF-8", async () => {
    const chunk = (size: number) => new Uint8Array(size).fill(0x20);
    const ended = () => queueGet(visitRecord({ status: "ended", providerMeetingId: "900000001", providerMeetingUuid: "uuid-900000001" }));

    // No Content-Length, chunked overrun: refused before the body is consumed, and the stream is cancelled.
    const overrun = streamed(200, Array.from({ length: 64 }, () => chunk(64 * 1024)));
    fetchRouter([...identityRoutes(), ...zoomRoutes({ summary: () => overrun })]);
    ended();
    expect((await importNote()).statusCode).toBe(503);
    expect(overrun.probe.cancelled).toBe(true);
    expect(overrun.probe.pulled).toBeLessThanOrEqual(MAX_SUMMARY_BYTES / (64 * 1024) + 2); // the bound, plus the stream's own read-ahead

    // A declared length over the bound is refused without reading a byte.
    const declaredTooBig = streamedJson(SUMMARY(), { "content-length": String(MAX_SUMMARY_BYTES + 1) });
    fetchRouter([...identityRoutes(), ...zoomRoutes({ summary: () => declaredTooBig })]);
    ended();
    expect((await importNote()).statusCode).toBe(503);
    expect(declaredTooBig.bodyUsed).toBe(false); // the stream was never taken (its read-ahead pull is the stream's, not ours)

    // A dishonest declared length (smaller than the bytes sent) and a truncated body (fewer bytes than declared) are both refused.
    const honest = JSON.stringify(SUMMARY());
    for (const declared of [String(Buffer.byteLength(honest) - 10), String(Buffer.byteLength(honest) + 10), "12abc", "-5", "1e3"]) {
      fetchRouter([...identityRoutes(), ...zoomRoutes({ summary: () => streamed(200, [honest], { "content-length": declared }) })]);
      ended();
      expect((await importNote()).statusCode, `content-length ${declared}`).toBe(503);
    }

    // Malformed UTF-8 is refused; a multi-byte character split across chunks is decoded whole.
    fetchRouter([...identityRoutes(), ...zoomRoutes({ summary: () => streamed(200, [new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])]) })]);
    ended();
    expect((await importNote()).statusCode).toBe(503);
    const bytes = new TextEncoder().encode(JSON.stringify(SUMMARY({ summary_content: "Patient says: café ✓" })));
    const cut = bytes.indexOf(0xe2) + 1; // inside the 3-byte check mark
    fetchRouter([...identityRoutes(), ...zoomRoutes({ summary: () => streamed(200, [bytes.slice(0, cut), bytes.slice(cut)]) })]);
    ended();
    const split = await importNote();
    expect(JSON.parse(split.body ?? "{}").data.visit.note.aiSections.summary).toBe("Patient says: café ✓");

    // A response with no readable stream is not trusted through text()/json().
    fetchRouter([...identityRoutes(), ...zoomRoutes({ summary: () => jsonResponse(200, SUMMARY()) })]);
    ended();
    expect((await importNote()).statusCode).toBe(503);
  });

  it("readBoundedJson rejects a stream that exceeds the bound even when the first chunk is small", async () => {
    const response = streamed(200, ["{\"a\":\"", "x".repeat(100), "\"}"]);
    await expect(readBoundedJson(response, 50)).rejects.toMatchObject({ category: "provider_unavailable" });
    expect(response.probe.cancelled).toBe(true);
    await expect(readBoundedJson(streamed(200, ["{\"a\":1}"]), 50)).resolves.toEqual({ a: 1 });
  });

  it("re-import keeps practitioner notes and action-item decisions and retains the prior revision", async () => {
    const previous = { status: "not_reviewed", source: "zoom_ai_companion", zoomSummaryId: "uuid-1", aiSections: { summary: "old", patient_reported: "", results_reviewed: "", plan_discussed: "" }, aiOriginal: {}, practitionerNotes: "Keep me", actionItems: [{ id: "a1", text: "Order ferritin", status: "approved" }], revision: 1, importedAt: "2026-10-01T00:00:00.000Z", signedAt: null, signedBy: null };
    fetchRouter([...identityRoutes(), ...zoomRoutes({ summary: () => streamedJson(SUMMARY({ summary_content: undefined, summary_overview: "new overview", next_steps: ["Order ferritin", "Sleep log"] })) })]);
    queueGet(visitRecord({ status: "ended", providerMeetingId: "900000001", providerMeetingUuid: "uuid-900000001", note: previous, version: 4 }));
    const result = await createTelehealthHandler(zoomConfig)(event("POST /clinical-core/workforce/appointments/visits/notes/import", { appointmentId: APPOINTMENT }, workforceClaims));
    const note = JSON.parse(result.body ?? "{}").data.visit.note as Record<string, unknown>;
    expect(note).toMatchObject({ revision: 2, practitionerNotes: "Keep me" });
    expect(note.actionItems).toEqual([{ id: "a1", text: "Order ferritin", status: "approved" }, { id: expect.any(String), text: "Sleep log", status: "suggested" }]);
    expect((putItems()[0] as { noteHistory: unknown[] }).noteHistory).toEqual([previous]);
  });

  it("will not import over a signed note, will not sign twice, and signing keeps the prior revision", async () => {
    fetchRouter([...identityRoutes()]);
    const signedNote = { status: "signed", source: "zoom_ai_companion", zoomSummaryId: null, aiSections: { summary: "", patient_reported: "", results_reviewed: "", plan_discussed: "" }, aiOriginal: {}, practitionerNotes: "x", actionItems: [], revision: 2, importedAt: "2026-10-01T00:00:00.000Z", signedAt: "2026-10-01T01:00:00.000Z", signedBy: workforceClaims["custom:person_id"] };
    const handler = createTelehealthHandler(config);
    queueGet(visitRecord({ status: "ended", providerMeetingId: "123456789", note: signedNote, version: 3 }));
    expect((await handler(event("POST /clinical-core/workforce/appointments/visits/notes/import", { appointmentId: APPOINTMENT }, workforceClaims))).statusCode).toBe(409);
    queueGet(visitRecord({ status: "ended", providerMeetingId: "123456789", note: signedNote, version: 3 }));
    expect((await handler(event("POST /clinical-core/workforce/appointments/visits/notes/sign", { appointmentId: APPOINTMENT, expectedVersion: 3, practitionerNotes: "More", aiSections: signedNote.aiSections, actionItems: [] }, workforceClaims))).statusCode).toBe(409);

    const draft = { ...signedNote, status: "not_reviewed", signedAt: null, signedBy: null, actionItems: [{ id: "a1", text: "Order ferritin", status: "suggested" }] };
    queueGet(visitRecord({ status: "ended", providerMeetingId: "123456789", note: draft, version: 4 }));
    const result = await handler(event("POST /clinical-core/workforce/appointments/visits/notes/sign", { appointmentId: APPOINTMENT, expectedVersion: 4, practitionerNotes: "Patient tolerating protocol.", aiSections: { ...draft.aiSections, summary: "edited" }, actionItems: [{ id: "a1", status: "approved" }] }, workforceClaims));
    const payload = JSON.parse(result.body ?? "{}") as { data: { note: Record<string, unknown>; version: number } };
    expect(result.statusCode).toBe(200);
    expect(payload.data.note).toMatchObject({ status: "signed", revision: 3, practitionerNotes: "Patient tolerating protocol.", signedBy: workforceClaims["custom:person_id"] });
    expect((putItems()[0] as { noteHistory: unknown[] }).noteHistory).toEqual([draft]);
  });

  /* ---------------------------------------------------- lists and cancellation */

  const listEvent = (query: Record<string, string | undefined> | null = { from: "2026-10-09T00:00:00.000Z", to: "2026-10-10T00:00:00.000Z" }) =>
    ({ ...(event("GET /clinical-core/workforce/appointments/visits", undefined, workforceClaims) as object), queryStringParameters: query ?? undefined }) as never;
  const apptId = (index: number) => `7777777${index}-7777-4777-8777-777777777777`;

  it("lists one window of visits across every page, says whether the list is complete, and never returns note bodies in a list", async () => {
    const page = (index: number, last?: Record<string, unknown>) => ({ Items: [visitRecord({ appointmentId: apptId(index), sk: `VISIT#${index}`, note: { status: "signed", source: "zoom_ai_companion", zoomSummaryId: "u", revision: 2, importedAt: "", signedAt: "", signedBy: "" } })], ...(last ? { LastEvaluatedKey: last } : {}) });
    const calls = fetchRouter(identityRoutes({ calendar: Array.from({ length: 20 }, (_, index) => calendarRow({ id: apptId(index) })) }));
    queueQuery(page(1, { pk: "x", sk: "1" }), page(2));
    const result = await createTelehealthHandler(config)(listEvent());
    const payload = JSON.parse(result.body ?? "{}") as { data: { visits: Array<Record<string, unknown>>; complete: boolean; from: string; to: string } };
    expect(result.statusCode).toBe(200);
    expect(payload.data).toMatchObject({ complete: true, from: "2026-10-09T00:00:00.000Z", to: "2026-10-10T00:00:00.000Z" });
    expect(payload.data.visits).toHaveLength(2);
    expect(payload.data.visits[0].note).toEqual({ status: "signed", source: "zoom_ai_companion", zoomSummaryId: "u", revision: 2, importedAt: "", signedAt: "", signedBy: "" });
    expect(payload.data.visits[0]).not.toHaveProperty("passcode");
    expect(calls[0].body).toMatchObject({ functionName: "get_desktop_calendar", args: { _from: "2026-10-09T00:00:00.000Z", _to: "2026-10-10T00:00:00.000Z" } });
    const query = send.mock.calls[0][0] as { input: { ProjectionExpression: string } };
    expect(query.input.ProjectionExpression).not.toContain("aiOriginal");
    expect((send.mock.calls[1][0] as { input: { ExclusiveStartKey?: unknown } }).input.ExclusiveStartKey).toEqual({ pk: "x", sk: "1" });

    for (let index = 0; index < 20; index += 1) queueQuery(page(index, { pk: "x", sk: String(index) }));
    const bounded = await createTelehealthHandler(config)(listEvent());
    expect(JSON.parse(bounded.body ?? "{}").data.complete).toBe(false);
  });

  /* ---------------------------------------------------- every read is authorized now */

  it("list reads are authorized through the caller's calendar for the window: no window, a window too wide, revoked membership, and records the calendar does not return", async () => {
    const handler = createTelehealthHandler(config);
    for (const query of [null, { from: "2026-10-09T00:00:00.000Z" }, { from: "2026-10-09T00:00:00.000Z", to: "2026-10-09T00:00:00.000Z" }, { from: "2026-10-09T00:00:00.000Z", to: "2026-11-10T00:00:00.000Z" }]) {
      const calls = fetchRouter(identityRoutes());
      expect((await handler(listEvent(query))).statusCode, JSON.stringify(query)).toBe(400);
      expect(calls).toHaveLength(0);
      expect(send).not.toHaveBeenCalled();
    }

    fetchRouter(identityRoutes({ calendar: () => jsonResponse(403, { error: "identity_refused" }) }));
    const revoked = await handler(listEvent());
    expect(revoked.statusCode).toBe(403);
    expect(send).not.toHaveBeenCalled(); // refused before the table is read

    // Same organization, but the calendar returns only one of three desktop-booked visits (the
    // others are records this caller may not see, or belong to another clinic's calendar); a
    // patient-app visit is returned only inside the window.
    fetchRouter(identityRoutes({ calendar: [calendarRow({ id: apptId(1) })] }));
    queueQuery({ Items: [
      visitRecord({ appointmentId: apptId(1), sk: "VISIT#1" }), visitRecord({ appointmentId: apptId(2), sk: "VISIT#2" }), visitRecord({ appointmentId: apptId(3), sk: "VISIT#3" }),
      visitRecord({ appointmentId: apptId(4), sk: "VISIT#4", requestId: REQUEST, consumerPersonId: claims["custom:person_id"], scheduledStart: "2026-10-09T17:00:00.000Z" }),
      visitRecord({ appointmentId: apptId(5), sk: "VISIT#5", requestId: REQUEST, consumerPersonId: claims["custom:person_id"], scheduledStart: "2026-10-12T17:00:00.000Z" }),
    ] });
    const filtered = await handler(listEvent());
    expect(JSON.parse(filtered.body ?? "{}").data.visits.map((visit: { appointmentId: string }) => visit.appointmentId)).toEqual([apptId(1), apptId(4)]);
  });

  it("a single note read needs current calendar access to that appointment, for the same patient and practitioner — a direct AWS read with none gets nothing", async () => {
    const read = () => createTelehealthHandler(config)({ ...(event("GET /clinical-core/workforce/appointments/visits/notes", undefined, workforceClaims) as object), queryStringParameters: { appointmentId: APPOINTMENT } } as never);
    const stored = visitRecord({ status: "ended", quickNotes: "Fictional quick note", note: { status: "not_reviewed", source: "zoom_ai_companion", zoomSummaryId: null, aiSections: { summary: "fictional", patient_reported: "", results_reviewed: "", plan_discussed: "" }, aiOriginal: {}, practitionerNotes: "", actionItems: [], revision: 1, importedAt: "", signedAt: null, signedBy: null } });

    // Revoked membership.
    fetchRouter(identityRoutes({ calendar: () => jsonResponse(403, { error: "identity_refused" }) }));
    queueGet(stored);
    const revoked = await read();
    expect(revoked.statusCode).toBe(403);
    expect(revoked.body).not.toContain("Fictional quick note");

    // Same organization, the calendar does not return this appointment (disallowed patient, wrong clinic).
    fetchRouter(identityRoutes({ calendar: [] }));
    queueGet(stored);
    const hidden = await read();
    expect(hidden.statusCode).toBe(404);
    expect(hidden.body).not.toContain("fictional");

    // The appointment now belongs to another practitioner, or names another patient.
    for (const row of [calendarRow({ practitioner_user_id: "22222222-bbbb-4bbb-8bbb-222222222222" }), calendarRow({ patient_id: "99999999-9999-4999-8999-999999999999" })]) {
      fetchRouter(identityRoutes({ calendar: [row] }));
      queueGet(stored);
      const reassigned = await read();
      expect(reassigned.statusCode).toBe(409);
      expect(JSON.parse(reassigned.body ?? "{}")).toEqual({ error: "appointment_reassigned" });
      expect(reassigned.body).not.toContain("fictional");
    }

    // A historical record is read through its own (even cancelled) appointment, looked up around the visit's stored time.
    const calls = fetchRouter(identityRoutes({ calendar: [calendarRow({ status: "cancelled" })] }));
    queueGet(stored);
    const historical = await read();
    expect(historical.statusCode).toBe(200);
    expect(JSON.parse(historical.body ?? "{}").data.quickNotes).toBe("Fictional quick note");
    expect(calls[0].body).toMatchObject({ args: { _from: "2026-09-25T17:00:00.000Z", _to: "2026-10-23T17:00:00.000Z" } });
  });

  it("consent and the visit follow the immutable subject: an appointment reassigned to another patient or practitioner is refused for consent, start and reads before any credential or provider call", async () => {
    const otherPatient = calendarRow({ patient_id: "99999999-9999-4999-8999-999999999999" });
    const calls = fetchRouter([...identityRoutes({ calendar: [otherPatient] }), ...zoomRoutes()]);
    queueGet(visitRecord()); // patient A's receipt on record
    const started = await start();
    expect(started.statusCode).toBe(409);
    expect(JSON.parse(started.body ?? "{}")).toEqual({ error: "appointment_reassigned" });
    expect(calls.map((call) => call.url)).toEqual([expect.stringContaining("/data-compatibility")]);
    expect(secretsSend).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);

    queueGet(visitRecord());
    const consented = await createTelehealthHandler(config)(event("POST /clinical-core/workforce/appointments/visits/consent", {
      appointmentId: APPOINTMENT, artifactId: ARTIFACT.artifactId, artifactVersion: ARTIFACT.artifactVersion, contentSha256: ARTIFACT.contentSha256, signerName: "Patient B", agreed: true,
    }, workforceClaims));
    expect(consented.statusCode).toBe(409);
    expect(JSON.parse(consented.body ?? "{}")).toEqual({ error: "appointment_reassigned" });
    expect(writes).toHaveLength(0);

    // A changed practitioner is refused the same way; a reschedule of the same subject reconciles the times.
    fetchRouter([...identityRoutes({ calendar: [calendarRow({ practitioner_user_id: "22222222-bbbb-4bbb-8bbb-222222222222" })] }), ...zoomRoutes()]);
    queueGet(visitRecord());
    expect(JSON.parse((await start()).body ?? "{}")).toEqual({ error: "appointment_reassigned" });
    fetchRouter([...identityRoutes({ calendar: [calendarRow({ starts_at: "2026-10-09T18:00:00.000Z", ends_at: "2026-10-09T18:30:00.000Z" })] }), ...zoomRoutes()]);
    queueGet(visitRecord());
    const moved = await start();
    expect(moved.statusCode).toBe(200);
    expect(JSON.parse(moved.body ?? "{}").data.visit).toMatchObject({ patientRecordId: PATIENT, practitionerUserId: PRACTITIONER, scheduledStart: "2026-10-09T18:00:00.000Z" });
  });

  it("authority is rechecked after provider work: a reassignment or withdrawal while the meeting was being created stops the session before any credential", async () => {
    // The calendar names patient A when the start is admitted and patient B once the meeting exists.
    let reads = 0;
    const calls = fetchRouter([...identityRoutes({ calendar: () => jsonResponse(200, { data: { appointments: [reads++ === 0 ? calendarRow() : calendarRow({ patient_id: "99999999-9999-4999-8999-999999999999" })], practitioners: [], patients: [] } }) }), ...zoomRoutes()]);
    queueGet(visitRecord());
    const reassigned = await start();
    expect(reassigned.statusCode).toBe(409);
    expect(JSON.parse(reassigned.body ?? "{}")).toEqual({ error: "appointment_reassigned" });
    expect(calls.some((call) => call.url.includes("type=zak"))).toBe(false);
    expect(putItems().at(-1)).toMatchObject({ providerMeetingId: "900000001", status: "scheduled" }); // bound, never started

    // Consent withdrawn while the create was in flight: the bind loses to the withdrawal's write,
    // the reread shows no active receipt, the created meeting is deleted and no session is issued.
    writes.length = 0;
    const withdrawnCalls = fetchRouter([...identityRoutes(), ...zoomRoutes()]);
    failWrite = (input) => ((input.Item as { providerMeetingId?: string })?.providerMeetingId === "900000001" ? conditional() : null);
    queueGet(visitRecord(), visitRecord({ consents: [receipt({ status: "withdrawn" })], version: 5 }));
    const withdrawn = await start();
    expect(withdrawn.statusCode).toBe(409);
    expect(JSON.parse(withdrawn.body ?? "{}")).toEqual({ error: "consent_withdrawn" });
    expect(deletes(withdrawnCalls).map((call) => call.url)).toEqual([expect.stringContaining("/meetings/900000001")]);
    expect(withdrawnCalls.some((call) => call.url.includes("type=zak"))).toBe(false);
  });

  it("closes a visit when its booking is cancelled, deleting a meeting the visit itself created", async () => {
    const calls = fetchRouter([...zoomRoutes()]);
    queueQuery({ Items: [requestRecord({ providerMeetingId: null })] }, { Items: [{ pk: `ORG#${ORG}`, sk: "SLOT#x", slotId: "55555555-5555-4555-8555-555555555555", start: "2026-10-09T17:00:00.000Z", cancellationWindowHours: 24, status: "booked" }] });
    queueGet(visitRecord({ status: "scheduled", providerMeetingId: "900000003", joinUrl: "https://zoom.us/j/900000003" }));
    const result = await createTelehealthHandler(zoomConfig)(event("POST /clinical-core/workforce/appointments/actions", { requestId: REQUEST, action: "cancel", expectedVersion: 2 }, workforceClaims));
    expect(result.statusCode).toBe(200);
    expect(deletes(calls).some((call) => call.url.includes("/meetings/900000003"))).toBe(true);
    expect(putItems().at(-1)).toMatchObject({ status: "cancelled", providerMeetingId: null, meetingLease: null });
  });

  it("signs a Meeting SDK JWT with the SDK key as appKey and HS256", () => {
    const token = signMeetingSdkJwt("sdk-key", "sdk-secret", { mn: "123456789", role: 1, iat: 1, exp: 2, tokenExp: 2 });
    const [header, payload, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "HS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toMatchObject({ appKey: "sdk-key", mn: "123456789", role: 1 });
    expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
