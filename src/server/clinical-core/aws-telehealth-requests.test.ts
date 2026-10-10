import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";

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
import { FictionalAppointmentStore } from "./appointment-operation-store.test-support";

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
  identityApiOrigin: "https://abcdefghij.execute-api.us-east-2.amazonaws.com",
  chartAdmissionSecretArn: "arn:aws:secretsmanager:us-east-2:000000000000:secret:fictional-chart-admission",
};
/** The fictional admission key the boundary signs with; the chart fixture holds the same bytes. Never a real secret. */
const ADMISSION_KEY = { keyId: "fictional-admission-key-1", secret: "ab".repeat(32) };
const admissionSecretAnswer = (command: { input?: { SecretId?: string } }) => {
  if (command?.input?.SecretId === config.chartAdmissionSecretArn) return Promise.resolve({ SecretString: JSON.stringify(ADMISSION_KEY) });
  return Promise.reject(new Error("fictional secret not found"));
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
const patientConsentFixture = () => {
  const content = "Fictional reviewed recording consent. No real health information.";
  const artifact = { artifactId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", artifactVersion: "fictional/1", content,
    contentSha256: createHash("sha256").update(content).digest("hex"), jurisdiction: "US-CA", approvedAt: "2026-10-01T00:00:00.000Z" };
  const connection = { connectionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", patientRecordId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    state: "verified", verifiedAt: "2026-10-01T00:00:00.000Z", version: 1 };
  const review = { connectionId: connection.connectionId, connectionState: "verified", scope: "telehealth_recording",
    status: "granted", version: 1, currentArtifactId: artifact.artifactId, artifact };
  const consent = { artifactId: artifact.artifactId, artifactVersion: artifact.artifactVersion, contentSha256: artifact.contentSha256,
    signerName: "Fictional Signer", representativeAuthority: "self", agreed: true };
  return { artifact, connection, review, consent };
};
const patientBookingEvent = (consent: Record<string, unknown>) => {
  const input = event("POST /clinical-core/consumer/appointments/requests", { visitType: "follow_up",
    slotId: "33333333-3333-4333-8333-333333333333", holdId: "44444444-4444-4444-8444-444444444444", consent });
  (input as unknown as { headers: Record<string, string> }).headers.authorization = "Bearer fictional-consumer-token";
  return input;
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
  const resetRequest = (patch: Record<string, unknown> = {}) => {
    send.mockReset(); const store = new FictionalAppointmentStore().seed({ ...processingItem(), ...patch }); send.mockImplementation(store.send); return store;
  };
  beforeEach(() => { resetRequest(); secretSend.mockReset(); secretSend.mockResolvedValue({ SecretString: JSON.stringify({ secretKey: "sk_test_synthetic", webhookSecret: "whsec_synthetic" }) }); });
  const reconcile = (intent: Record<string, unknown>, expectedVersion = 4, ok = true) => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok, json: async () => intent })));
    return createTelehealthHandler(stripeConfig)(event("POST /clinical-core/workforce/appointments/payments", { requestId: "33333333-3333-4333-8333-333333333333", action: "reconcile", expectedVersion }, workforceClaims));
  };
  it("settles a processing charge from the official intent only when its metadata names this request", async () => {
    const paid = await reconcile(stripeIntent({ status: "succeeded", amount_received: 15000 }));
    expect(paid.statusCode).toBe(200);
    expect(JSON.parse(paid.body ?? "{}").data).toMatchObject({ reconciliation: "settled_paid", paymentStatus: "paid", paidMinor: 15000, version: 5 });
    const foreignStore = resetRequest();
    const foreign = await reconcile(stripeIntent({ status: "succeeded", amount_received: 15000, metadata: { organization_id: workforceClaims["custom:organization_id"], request_id: "44444444-4444-4444-8444-444444444444" } }));
    expect(foreign.statusCode).toBe(503);
    // Closing the private invocation is allowed; a foreign provider intent
    // must still leave every financial field and request version untouched.
    const updates = send.mock.calls.filter(([cmd]) => cmd.constructor.name === "UpdateCommand");
    expect(updates).toHaveLength(1);
    expect(updates[0][0].input).toMatchObject({ UpdateExpression: "SET writerStatus=:closed,writerClosedAt=:at" });
    expect(updates[0][0].input.Key.sk).toMatch(/^REQOP#/);
    expect(foreignStore.get(processingItem())).toMatchObject({ version: 4, paymentStatus: "processing", paidMinor: 0, paymentIntentId: "pi_synthetic_1" });
    expect([...foreignStore.rows.values()].filter(row => String(row.sk).startsWith("REQOP#"))[0].phase).not.toBe("committed");
  });
  it("records a terminal failure, leaves unfinished intents untouched and refuses stale versions or overpayment", async () => {
    expect(JSON.parse((await reconcile(stripeIntent({ status: "requires_payment_method", last_payment_error: { code: "card_declined" } }))).body ?? "{}").data).toMatchObject({ reconciliation: "settled_failed", paymentStatus: "failed" });
    resetRequest();
    expect(JSON.parse((await reconcile(stripeIntent({ status: "requires_action" }))).body ?? "{}").data).toMatchObject({ reconciliation: "still_processing", paymentStatus: "processing" });
    expect(send.mock.calls.filter(([cmd]) => cmd.constructor.name === "TransactWriteCommand")).toHaveLength(2);
    resetRequest();
    expect((await reconcile(stripeIntent({ status: "succeeded", amount_received: 15000 }), 3)).statusCode).toBe(409);
    resetRequest();
    expect((await reconcile(stripeIntent({ status: "succeeded", amount_received: 99999 }))).statusCode).toBe(503);
  });
  it("does nothing for a request that is not processing and refuses without the Stripe test boundary", async () => {
    resetRequest({ paymentStatus: "paid", paidMinor: 15000 });
    expect(JSON.parse((await reconcile(stripeIntent({}))).body ?? "{}").data).toMatchObject({ reconciliation: "not_processing", paymentStatus: "paid" });
    resetRequest();
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
    send.mockResolvedValueOnce({});
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
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("will not enable Zoom without an independently recorded BAA gate", () => {
    expect(() => createTelehealthHandler({ ...config, zoomEnabled: true, zoomSecretArn: "secret" }))
      .toThrow("telehealth_configuration_invalid");
  });

  it("binds new patient booking to exact copy and the current governed grant through the patient's own port", async () => {
    const { connection, review, consent } = patientConsentFixture();
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(config.identityApiOrigin + "/clinical-core/consumer/telehealth-consent");
      expect(init?.headers).toMatchObject({ authorization: "Bearer fictional-consumer-token" });
      expect(init).toMatchObject({ method: "POST", redirect: "manual" });
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual(body.action === "connection" ? { action: "connection" }
        : { action: "consent", connectionId: connection.connectionId, scope: "telehealth_recording" });
      return new Response(JSON.stringify({ data: body.action === "connection" ? { connection } : review }), { headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetch);
    send.mockResolvedValueOnce({}); // Exact-key booking recovery has no existing request.
    send.mockResolvedValueOnce({ Items: [{
      pk: `ORG#${claims["custom:organization_id"]}`, sk: "SLOT#fictional", slotId: "33333333-3333-4333-8333-333333333333",
      organizationId: claims["custom:organization_id"], start: "2026-10-11T17:00:00.000Z", end: "2026-10-11T17:45:00.000Z",
      timeZone: "America/Los_Angeles", visitTypes: ["follow_up"], priceMinor: 15000, currency: "USD", cancellationPolicy: "Fictional policy",
      cancellationWindowHours: 24, status: "held", heldBy: claims["custom:person_id"], holdId: "44444444-4444-4444-8444-444444444444",
      holdExpiresAt: Math.floor(Date.now() / 1000) + 600,
    }] }).mockResolvedValueOnce({});
    const result = await createTelehealthHandler(config)(patientBookingEvent(consent));
    expect(result.statusCode).toBe(201); expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(result.body).data.consent).toMatchObject({ method: "patient_app", status: "granted", recordedBy: claims["custom:person_id"], connectionId: connection.connectionId });
    // A booking receipt is not a governed sharing grant or provider activation.
    expect(JSON.parse(result.body).data.consent.grantId).toBeNull();
    expect(secretSend).not.toHaveBeenCalled();
  });

  it.each(["guardian", "healthcare_proxy", "legal_representative", "missing_authority", "false_ack", "coerced_signer"])("refuses %s patient consent before reading the authority", async mode => {
    const { consent } = patientConsentFixture(); const value: Record<string, unknown> = { ...consent };
    if (mode === "missing_authority") delete value.representativeAuthority;
    else if (mode === "false_ack") value.agreed = false;
    else if (mode === "coerced_signer") value.signerName = 123;
    else value.representativeAuthority = mode;
    send.mockResolvedValueOnce({}); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const result = await createTelehealthHandler(config)(patientBookingEvent(value));
    expect(result.statusCode).toBe(400); expect(fetch).not.toHaveBeenCalled(); expect(send).toHaveBeenCalledOnce();
  });

  it.each(["no_connection", "paused_connection", "paused_review", "revoked", "not_granted", "zero_version", "no_copy", "superseded", "different_connection", "bad_hash", "missing_content", "changed_version", "html", "redirect", "oversized", "deadline", "legacy_metadata"])("refuses %s consent authority without booking or renewing", async mode => {
    const { consent, connection, review } = patientConsentFixture();
    const own: Record<string, unknown> = { connection }; const current: Record<string, unknown> = structuredClone(review);
    if (mode === "no_connection") own.connection = null;
    if (mode === "paused_connection") own.connection = { ...connection, state: "paused" };
    if (mode === "paused_review") current.connectionState = "paused";
    if (mode === "revoked" || mode === "not_granted") current.status = mode;
    if (mode === "zero_version") current.version = 0;
    if (mode === "no_copy") current.artifact = null;
    if (mode === "superseded") current.currentArtifactId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    if (mode === "different_connection") current.connectionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    if (mode === "bad_hash") (current.artifact as Record<string, unknown>).content += " changed";
    if (mode === "missing_content") delete (current.artifact as Record<string, unknown>).content;
    if (mode === "changed_version") (current.artifact as Record<string, unknown>).artifactVersion = "fictional/2";
    if (mode === "legacy_metadata") delete (current.artifact as Record<string, unknown>).content;
    const controller = new AbortController();
    if (mode === "deadline") vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(controller.signal);
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)); expect(["connection", "consent"]).toContain(request.action);
      if (mode === "deadline") controller.abort();
      if (mode === "redirect") return new Response("", { status: 302, headers: { location: "https://example.test" } });
      return new Response(mode === "oversized" ? "x".repeat(33_000) : JSON.stringify({ data: request.action === "connection" ? own : current }),
        { headers: { "content-type": mode === "html" ? "text/html" : "application/json" } });
    });
    vi.stubGlobal("fetch", fetch); send.mockResolvedValueOnce({});
    const result = await createTelehealthHandler(config)(patientBookingEvent(consent));
    expect([409, 503]).toContain(result.statusCode); expect(send).toHaveBeenCalledOnce(); expect(secretSend).not.toHaveBeenCalled();
  });

  it("returns the original recovered booking without signing again or treating its receipt as current authority", async () => {
    const { consent } = patientConsentFixture(); const input = patientBookingEvent(consent);
    const value = JSON.parse((input as { body: string }).body);
    const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v).sort().map(key => [key, canonical((v as Record<string, unknown>)[key])])) : v;
    const requestId = value.holdId;
    send.mockResolvedValueOnce({ Item: { ...processingItem(), requestId, pk: `ORG#${claims["custom:organization_id"]}`, sk: `REQ#${requestId}`,
      bookingInputSha256: createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"), status: "cancelled", consent: null } });
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const result = await createTelehealthHandler(config)(input);
    expect(result.statusCode).toBe(201); expect(JSON.parse(result.body).data.status).toBe("cancelled");
    expect(fetch).not.toHaveBeenCalled(); expect(send).toHaveBeenCalledOnce();
  });

  it("continues an empty filtered request page and pins a strongly consistent same-clinic lookup", async () => {
    const row = { ...processingItem(), status: "cancelled" }, cursor = { pk: row.pk, sk: "REQ#fictional-page-1" };
    send.mockResolvedValueOnce({}).mockResolvedValueOnce({ Items: [], LastEvaluatedKey: cursor }).mockResolvedValueOnce({ Items: [row] });
    const result = await createTelehealthHandler(config)(event("POST /clinical-core/consumer/appointments/actions", {
      requestId: row.requestId, expectedVersion: row.version, action: "cancel" }));
    expect(result.statusCode).toBe(409); expect(JSON.parse(result.body).error).toBe("conflict");
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[0][0].input).toMatchObject({ ConsistentRead: true, Key: { sk: expect.stringMatching(/^REQOP#/) } });
    expect(send.mock.calls[1][0].input).toMatchObject({ ConsistentRead: true, Limit: 200 });
    expect(send.mock.calls[2][0].input).toMatchObject({ ConsistentRead: true, ExclusiveStartKey: cursor });
    expect(secretSend).not.toHaveBeenCalled();
  });

  it("reports missing only after the final filtered request page", async () => {
    const row = processingItem();
    send.mockResolvedValueOnce({}).mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { pk: row.pk, sk: "REQ#fictional-page-1" } }).mockResolvedValueOnce({ Items: [] });
    const result = await createTelehealthHandler(config)(event("POST /clinical-core/consumer/appointments/actions", {
      requestId: row.requestId, expectedVersion: row.version, action: "cancel" }));
    expect(result.statusCode).toBe(404); expect(send).toHaveBeenCalledTimes(3); expect(secretSend).not.toHaveBeenCalled();
  });

  it.each(["cycle", "foreign-cursor", "invalid-cursor", "budget", "duplicate", "foreign-row"])("refuses %s request lookup without a write or provider call", async mode => {
    const row = { ...processingItem(), status: "cancelled" }, cursor = { pk: row.pk, sk: "REQ#fictional-page-1" };
    send.mockResolvedValueOnce({});
    if (mode === "cycle") send.mockResolvedValue({ Items: [], LastEvaluatedKey: cursor });
    if (mode === "foreign-cursor") send.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { ...cursor, pk: "ORG#other" } });
    if (mode === "invalid-cursor") send.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { ...cursor, sk: "VISIT#foreign-domain" } });
    if (mode === "budget") for (let i = 0; i < 20; i++) send.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { ...cursor, sk: `REQ#fictional-page-${i}` } });
    if (mode === "duplicate") send.mockResolvedValueOnce({ Items: [row], LastEvaluatedKey: cursor }).mockResolvedValueOnce({ Items: [row] });
    if (mode === "foreign-row") send.mockResolvedValueOnce({ Items: [{ ...row, organizationId: "other" }] });
    const result = await createTelehealthHandler(config)(event("POST /clinical-core/consumer/appointments/actions", {
      requestId: row.requestId, expectedVersion: row.version, action: "cancel" }));
    expect(result.statusCode).toBe(503); expect(JSON.parse(result.body).error).toBe("service_unavailable");
    expect(send.mock.calls[0][0].constructor.name).toBe("GetCommand");
    expect(send.mock.calls.slice(1).every(([command]) => command.constructor.name === "QueryCommand")).toBe(true);
    expect(send.mock.calls.length).toBeLessThanOrEqual(21); expect(secretSend).not.toHaveBeenCalled();
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
    // Transactions authorize their underlying Put/Update operations; there
    // is no IAM action named dynamodb:TransactWriteItems. No delete or scan
    // permission is needed by these transactions.
    expect(appointmentPolicy?.PolicyDocument?.Statement?.[0]?.Action).toEqual([
      "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:UpdateItem",
    ]);
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
    send.mockResolvedValueOnce({}).mockResolvedValueOnce({ Items: [{
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
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("aliases DynamoDB's reserved timeZone name when scheduling the canonical appointment", async () => {
    const store = new FictionalAppointmentStore().seed({
      pk: `ORG#${workforceClaims["custom:organization_id"]}`, sk: "REQ#2026-09-01T00:00:00.000Z#33333333-3333-4333-8333-333333333333",
      gsi1pk: `PERSON#${claims["custom:person_id"]}`, gsi1sk: "REQ#2026-09-01T00:00:00.000Z#33333333-3333-4333-8333-333333333333",
      requestId: "33333333-3333-4333-8333-333333333333", organizationId: workforceClaims["custom:organization_id"], consumerPersonId: claims["custom:person_id"],
      consumerEmail: claims.email, status: "requested", visitType: "follow_up", preferredSlots: ["2026-09-03T17:00:00.000Z"], timeZone: "America/Los_Angeles",
      note: null, scheduledStart: null, scheduledEnd: null, joinUrl: null, providerMeetingId: null, version: 1, createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z", lastActionBy: "consumer", slotId: "55555555-5555-4555-8555-555555555555", appointmentId: null,
      priceMinor: 15000, currency: "USD", cancellationPolicy: "Cancel at least 24 hours before the visit.", cancellationWindowHours: 24, cancellationFeeDueMinor: 0,
      reminderStatus: "disabled", paymentPolicyVersion: "telehealth-payments/1", paymentAuthorizationStatus: "not_authorized", paymentStatus: "not_due",
      paymentIntentId: null, paidMinor: 0, refundedMinor: 0,
    }); send.mockImplementation(store.send);
    const result = await createTelehealthHandler(config)(event("POST /clinical-core/workforce/appointments/actions", {
      requestId: "33333333-3333-4333-8333-333333333333", action: "schedule", expectedVersion: 1,
      scheduledStart: "2026-09-03T17:00:00.000Z", scheduledEnd: "2026-09-03T17:45:00.000Z", timeZone: "America/Los_Angeles",
    }, workforceClaims));
    expect(result.statusCode).toBe(200);
    const command = send.mock.calls.map(([cmd]) => cmd).find(cmd => cmd.input.TransactItems?.[0]?.Update?.UpdateExpression?.includes("#timeZone=:zone")) as { input?: { TransactItems?: Array<{ Update?: { UpdateExpression?: string; ExpressionAttributeNames?: Record<string,string> } }> } };
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
    const item = { ...processingItem(), status: "scheduled", reminderStatus: "scheduled", scheduledStart: "2026-09-03T17:00:00.000Z" };
    const reminder = { internalEvent: "send_appointment_reminder", organizationId: item.organizationId, requestId: item.requestId, scheduledStart: item.scheduledStart } as never;
    send.mockResolvedValueOnce({ Items: [item] }).mockResolvedValueOnce({ Item: { pk: "EMAIL_SUPPRESSION", sk: "hash", reason: "complaint" } });
    const suppressed = await createTelehealthHandler(reminders)(reminder);
    expect(JSON.parse(suppressed.body ?? "{}").data).toEqual({ sent: false, reason: "suppressed" });
    const lookup = (send.mock.calls[1][0] as { input: { Key: Record<string, unknown> } }).input;
    expect(lookup.Key).toEqual({ pk: "EMAIL_SUPPRESSION", sk: expect.stringMatching(/^[a-f0-9]{64}$/) });
    send.mockReset(); send.mockResolvedValueOnce({ Items: [item] }).mockResolvedValueOnce({}).mockResolvedValueOnce({ Items: [item] });
    const mailed = await createTelehealthHandler(reminders)(reminder);
    expect(JSON.parse(mailed.body ?? "{}").data).toEqual({ sent: true });
  });
  it("will not enable reminders without the SNS topic that carries bounces and complaints", () => {
    expect(() => createTelehealthHandler({ ...reminders, reminderEventsTopicArn: "" })).toThrow("telehealth_configuration_invalid");
  });
});

describe("AWS telehealth visit boundary (consent authority, meeting lease, provider shutdown, AI notes)", () => {
  const APPOINTMENT = "77777777-7777-4777-8777-777777777777";
  const REQUEST = "33333333-3333-4333-8333-333333333333";
  const ORG = workforceClaims["custom:organization_id"];
  const PATIENT = "66666666-6666-4666-8666-666666666666";
  const ARTIFACT = { artifactId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", scope: "telehealth_recording", artifactVersion: "telehealth-recording/1", contentSha256: "b".repeat(64), jurisdiction: "US-CA", approvedAt: "2026-10-01T00:00:00.000Z" };
  const zoomConfig = { ...config, zoomEnabled: true, zoomBaaVerified: true, zoomSecretArn: "arn:secret" };
  const receipt = (overrides: Record<string, unknown> = {}) => ({ consentId: "88888888-8888-4888-8888-888888888888", consentType: "telehealth_recording_combined", scope: "telehealth_recording",
    artifactId: ARTIFACT.artifactId, artifactVersion: ARTIFACT.artifactVersion, contentSha256: ARTIFACT.contentSha256, signerName: "Synthetic Signer", method: "staff_attested", representativeAuthority: "self",
    signedAt: "2026-10-01T00:00:00.000Z", recordedBy: workforceClaims["custom:person_id"], patientLocation: "CA", grantId: null, connectionId: null, status: "granted", withdrawnAt: null, withdrawnBy: null, withdrawalReason: null, ...overrides });
  const visitRecord = (overrides: Record<string, unknown> = {}) => ({
    pk: `ORG#${ORG}`, sk: `VISIT#${APPOINTMENT}`, appointmentId: APPOINTMENT, organizationId: ORG, requestId: null, consumerPersonId: null, patientRecordId: PATIENT, practitionerUserId: null,
    scheduledStart: "2026-10-09T17:00:00.000Z", scheduledEnd: "2026-10-09T17:30:00.000Z", timeZone: "America/Los_Angeles",
    status: "scheduled", consents: [receipt()], meetingLease: null, providerMeetingId: null, providerMeetingUuid: null, joinUrl: null, passcode: null, startedAt: null, endedAt: null,
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
  const calendarRow = (overrides: Record<string, unknown> = {}) => ({ id: APPOINTMENT, patient_id: PATIENT, patient_name: "Synthetic Patient", practitioner_user_id: "11111111-aaaa-4aaa-8aaa-111111111111", practitioner_name: "Dr",
    title: null, appointment_type: "telehealth", location: "Telehealth", telehealth_url: null, status: "confirmed", version: 1, starts_at: "2026-10-09T17:00:00.000Z", ends_at: "2026-10-09T17:30:00.000Z", ...overrides });
  const start = (handlerConfig = zoomConfig, extra: Record<string, unknown> = {}) => createTelehealthHandler(handlerConfig)(event("POST /clinical-core/workforce/appointments/visits/start", { appointmentId: APPOINTMENT, hostDisplayName: "Dr. Synthetic", ...extra }, workforceClaims));
  const jsonResponse = (status: number, body: unknown, text?: string) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, body: new Response(text ?? JSON.stringify(body)).body, json: async () => body, text: async () => text ?? JSON.stringify(body) });

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
    if (command.constructor.name === "TransactWriteCommand") {
      const parts = command.input.TransactItems as Array<{ Put?: Record<string, unknown>; ConditionCheck?: Record<string, unknown> }>;
      for (const part of parts) if (part.Put) writes.push(part.Put);
      if (parts.some(part => part.Put)) expect(parts.some(part => part.ConditionCheck?.ConditionExpression === "#version=:expected AND attribute_not_exists(mutationOperationId)")).toBe(true);
    }
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
  const PRACTITIONER_ID = "11111111-aaaa-4aaa-8aaa-111111111111";
  const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
  /** The chart's answer to `get_telehealth_record_authority` (the retained-record read path). */
  const recordAuthority = (overrides: Record<string, unknown> = {}) => ({ authorized: true, actor_person_id: workforceClaims["custom:person_id"], patient_record_id: PATIENT, legal_hold: false,
    appointment: { id: APPOINTMENT, status: "completed", deleted: false, appointment_type: "telehealth", patient_matches: true, practitioner_person_id: PRACTITIONER_ID }, transfer: null, ...overrides });
  const compatibilityRoute = (options: { calendar?: Array<Record<string, unknown>> | (() => unknown); authority?: Record<string, unknown> | null | (() => unknown) }) =>
    (url: string, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as { functionName?: string } : {};
      if (body.functionName === "get_telehealth_record_authority") {
        if (typeof options.authority === "function") return options.authority();
        if (options.authority === null) return jsonResponse(403, { error: "operation_refused" });
        return jsonResponse(200, { data: options.authority ?? recordAuthority() });
      }
      if (typeof options.calendar === "function") return options.calendar();
      return jsonResponse(200, { data: { appointments: options.calendar ?? [calendarRow()], practitioners: [], patients: [] } });
    };
  const identityRoutes = (options: { grant?: Record<string, unknown> | null; calendar?: Array<Record<string, unknown>> | (() => unknown); authority?: Record<string, unknown> | null | (() => unknown) } = {}): Array<[string | RegExp, (url: string, init?: RequestInit) => unknown]> => [
    ["/clinical-core/workforce/consent-artifact", () => jsonResponse(200, { data: ARTIFACT })],
    ["/clinical-core/workforce/consents/current", () => jsonResponse(200, { data: options.grant ? { patientRecordId: PATIENT, ...options.grant } : { status: "none", patientRecordId: null, connectionId: null, consentId: null, artifactId: null, artifactVersion: null, contentSha256: null, artifactStatus: null } })],
    ["/clinical-core/workforce/consents/grant", () => jsonResponse(201, { data: { consentId: "99999999-9999-4999-8999-999999999999", connectionId: "44444444-4444-4444-8444-444444444444", status: "granted" } })],
    ["/clinical-core/workforce/consents/revoke", () => jsonResponse(201, { data: { status: "revoked" } })],
    ["/clinical-core/workforce/data-compatibility", compatibilityRoute(options)],
  ];
  const meetingBody = (id: number, extra: Record<string, unknown> = {}) => ({ id, uuid: `uuid-${id}`, join_url: `https://zoom.us/j/${id}?pwd=ENCRYPTED-URL-TOKEN`, password: `real-password-${id}`, status: "waiting", ...extra });
  const zoomRoutes = (overrides: Partial<Record<"token" | "list" | "create" | "zak" | "end" | "get" | "summary" | "delete", (url: string, init?: RequestInit) => unknown>> = {}): Array<[string | RegExp, (url: string, init?: RequestInit) => unknown]> => [
    ["zoom.us/oauth/token", overrides.token ?? (() => jsonResponse(200, { access_token: "zoom-access" }))],
    [/\/users\/[^/]+\/meetings\?/, overrides.list ?? (() => jsonResponse(200, { meetings: [] }))],
    [/\/users\/[^/]+\/meetings$/, overrides.create ?? (() => jsonResponse(201, meetingBody(900000001)))],
    ["/token?type=zak", overrides.zak ?? (() => jsonResponse(200, { token: "zak-token" }))],
    [/\/meetings\/[^/]+\/status$/, overrides.end ?? (() => jsonResponse(204, {}))],
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
      "POST /clinical-core/workforce/appointments/visits/notes/transfer", "POST /clinical-core/workforce/appointments/visits/notes/transfer/complete",
      "GET /clinical-core/workforce/appointments/visits/notes/inventory",
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
    queueGet(visitRecord({ requestId: REQUEST, consumerPersonId: claims["custom:person_id"] })); queueQuery({ Items: [requestRecord()] });
    const withdrawn = await start();
    expect(withdrawn.statusCode).toBe(409);
    expect(JSON.parse(withdrawn.body ?? "{}")).toEqual({ error: "consent_withdrawn" });

    // No current connection for the consumer: lost authority, not a fallback to staff-only consent.
    fetchRouter(identityRoutes({ grant: { status: "none", connectionId: null, artifactId: null, artifactStatus: null } }));
    queueGet(visitRecord({ requestId: REQUEST, consumerPersonId: claims["custom:person_id"], consents: [receipt({ grantId: "g1", connectionId: "44444444-4444-4444-8444-444444444444" })] })); queueQuery({ Items: [requestRecord()] });
    const gone = await start();
    expect(gone.statusCode).toBe(409);
    expect(JSON.parse(gone.body ?? "{}")).toEqual({ error: "consent_required" });
    expect(secretsSend).not.toHaveBeenCalled();
  });

  it("binds a patient-app visit to its request: cancelled, mismatched or missing requests refuse before consent or provider work", async () => {
    const calls = fetchRouter([...identityRoutes(), ...zoomRoutes()]);
    queueGet(visitRecord({ requestId: REQUEST, consumerPersonId: claims["custom:person_id"] })); queueQuery({ Items: [requestRecord({ status: "cancelled" })] });
    const cancelled = await start();
    expect(cancelled.statusCode).toBe(409);
    expect(JSON.parse(cancelled.body ?? "{}")).toEqual({ error: "appointment_cancelled" });
    queueGet(visitRecord({ requestId: REQUEST })); queueQuery({ Items: [requestRecord({ appointmentId: "66666666-6666-4666-8666-666666666666" })] });
    expect((await start()).statusCode).toBe(400);
    queueGet(visitRecord({ requestId: REQUEST })); queueQuery({ Items: [] });
    expect((await start()).statusCode).toBe(404);
    expect(calls.filter((call) => call.url.includes("zoom.us"))).toHaveLength(0);
    expect(secretsSend).not.toHaveBeenCalled();
  });

  it("reports the video provider as off rather than inventing a meeting", async () => {
    fetchRouter(identityRoutes({ grant: { status: "granted", connectionId: "44444444-4444-4444-8444-444444444444", artifactId: ARTIFACT.artifactId, artifactStatus: "approved" } }));
    queueGet(visitRecord({ requestId: REQUEST, consumerPersonId: claims["custom:person_id"] })); queueQuery({ Items: [requestRecord()] });
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
    expect(writes[0].ConditionExpression).toBe("#version = :expected AND attribute_not_exists(mutationOperationId)");
  });

  it("records the governed grant through the identity API when the patient has an app connection", async () => {
    const calls = fetchRouter(identityRoutes({ grant: { status: "none", connectionId: "44444444-4444-4444-8444-444444444444", artifactId: null, artifactStatus: null } }));
    queueGet(undefined); queueQuery({ Items: [requestRecord()] }, { Items: [requestRecord()] });
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

  it("a thrown create leaves the lease dispatched; the next start reconciles with a COMPLETE listing before any second create, and refuses on an incomplete one", async () => {
    const lostCalls = fetchRouter([...identityRoutes(), ...zoomRoutes({ create: () => { throw new Error("socket hang up after dispatch"); } })]);
    queueGet(visitRecord());
    const lost = await start();
    expect(lost.statusCode).toBe(503);
    expect(creates(lostCalls)).toHaveLength(1);
    const lastLease = putItems().at(-1)?.meetingLease as { state: string; createdMeetingId: string | null };
    expect(lastLease).toMatchObject({ state: "dispatched", createdMeetingId: null });

    // Retry 1: the provider listing cannot be completed → the fence stays and nothing is created.
    writes.length = 0;
    const fencedCalls = fetchRouter([...identityRoutes(), ...zoomRoutes({ list: () => jsonResponse(200, { meetings: [], next_page_token: "more" }) })]);
    queueGet(visitRecord({ meetingLease: lastLease, version: 4 }));
    const fenced = await start();
    expect(fenced.statusCode).toBe(503);
    expect(creates(fencedCalls)).toHaveLength(0);
    expect(putItems().some((item) => item.meetingLease === null)).toBe(false);

    // Retry 2: a complete listing finds the meeting the lost create made → adopted, no second create.
    writes.length = 0;
    const adoptedCalls = fetchRouter([...identityRoutes(), ...zoomRoutes({ list: () => jsonResponse(200, { meetings: [{ id: 900000007, agenda: `alp-visit:${APPOINTMENT}` }] }) })]);
    queueGet(visitRecord({ meetingLease: lastLease, version: 4 }));
    const adopted = await start();
    expect(adopted.statusCode).toBe(200);
    expect(JSON.parse(adopted.body ?? "{}").data.visit).toMatchObject({ providerMeetingId: "900000007" });
    expect(JSON.parse(adopted.body ?? "{}").data.session.passcode).toBe("real-password-900000007");
    expect(creates(adoptedCalls)).toHaveLength(0);

    // Retry 3: complete absence is not settlement of the original dispatched writer.
    writes.length = 0;
    const recreatedCalls = fetchRouter([...identityRoutes(), ...zoomRoutes()]);
    queueGet(visitRecord({ meetingLease: lastLease, version: 4 }));
    const recreated = await start();
    expect(recreated.statusCode).toBe(503);
    expect(creates(recreatedCalls)).toHaveLength(0);
    expect(putItems()).toHaveLength(0);
  });

  it("does not adopt an ambiguous later-page marker or a substring marker", async () => {
    let page = 0;
    const calls = fetchRouter([...identityRoutes(), ...zoomRoutes({ list: () => jsonResponse(200, ++page === 1
      ? { meetings: [{ id: 900000001, agenda: `alp-visit:${APPOINTMENT}` }], next_page_token: "next" }
      : { meetings: [{ id: 900000002, agenda: `alp-visit:${APPOINTMENT}` }] }) })]);
    queueGet(visitRecord({ meetingLease: { leaseId: "original", acquiredAt: new Date().toISOString(), state: "dispatched", createdMeetingId: null } }));
    expect((await start()).statusCode).toBe(503);
    expect(page).toBe(2);
    expect(creates(calls)).toHaveLength(0);
    expect(putItems()).toHaveLength(0);

    const substringCalls = fetchRouter([...identityRoutes(), ...zoomRoutes({ list: () => jsonResponse(200, { meetings: [{ id: 900000001, agenda: `alp-visit:${APPOINTMENT}-unrelated` }] }) })]);
    queueGet(visitRecord({ meetingLease: { leaseId: "original", acquiredAt: new Date().toISOString(), state: "dispatched", createdMeetingId: null } }));
    expect((await start()).statusCode).toBe(503);
    expect(creates(substringCalls)).toHaveLength(0);
    expect(putItems()).toHaveLength(0);
  });

  it("does not clear a known dispatched result merely because its read is temporarily absent", async () => {
    const calls = fetchRouter([...identityRoutes(), ...zoomRoutes({ get: () => jsonResponse(404, {}) })]);
    queueGet(visitRecord({ meetingLease: { leaseId: "L", acquiredAt: "2026-01-01T00:00:00.000Z", state: "dispatched", createdMeetingId: "900000001" } }));
    expect((await start()).statusCode).toBe(503);
    expect(creates(calls)).toHaveLength(0);
    expect(putItems()).toHaveLength(0);
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

  it("does not delete a meeting a concurrent reconciler already bound when the original writer loses its lease receipt", async () => {
    const calls = fetchRouter([...identityRoutes(), ...zoomRoutes()]);
    failWrite = input => (input.Item as { meetingLease?: { createdMeetingId?: string } })?.meetingLease?.createdMeetingId === "900000001" ? conditional() : null;
    queueGet(visitRecord(), visitRecord({ providerMeetingId: "900000001", providerMeetingUuid: "uuid-900000001", joinUrl: "https://zoom.us/j/900000001", passcode: "real-password-900000001", version: 9 }));
    expect((await start()).statusCode).toBe(200);
    expect(creates(calls)).toHaveLength(1);
    expect(deletes(calls)).toHaveLength(0);
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

  it("an unresolved payment fence cannot prevent a practitioner from ending a running call", async () => {
    const mutationOperationId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
    const calls = fetchRouter([...identityRoutes(), ...zoomRoutes()]);
    queueGet(visitRecord({ status: "in_visit", providerMeetingId: "900000001", version: 3, mutationOperationId }));
    const result = await createTelehealthHandler(zoomConfig)(event("POST /clinical-core/workforce/appointments/visits/end", { appointmentId: APPOINTMENT, expectedVersion: 3 }, workforceClaims));
    expect(result.statusCode).toBe(200); expect(JSON.parse(result.body).data.status).toBe("ended");
    expect(JSON.parse(result.body).data).not.toHaveProperty("mutationOperationId");
    expect(putItems().at(-1)).toMatchObject({ status: "ended", mutationOperationId });
    expect(calls.some(call => call.method === "PUT" && call.url.endsWith("/status"))).toBe(true);
    // The unresolved PAYMENT operation stays fenced; ending the call does not
    // settle the charge or clear its provider uncertainty.
    expect(writes.every(write => String(write.ConditionExpression).includes("#version"))).toBe(true);
  });

  /* ---------------------------------------------------- the AI summary */

  it("imports the current unified summary as unreviewed source text and refuses summaries that do not name this meeting instance", async () => {
    fetchRouter([...identityRoutes(), ...zoomRoutes({ summary: () => jsonResponse(200, { meeting_id: 900000001, meeting_uuid: "uuid-900000001", summary_content: "# Visit\n\nPatient reports better afternoons." }) })]);
    queueGet(visitRecord({ status: "ended", providerMeetingId: "900000001", providerMeetingUuid: "uuid-900000001" }));
    const unified = await createTelehealthHandler(zoomConfig)(event("POST /clinical-core/workforce/appointments/visits/notes/import", { appointmentId: APPOINTMENT }, workforceClaims));
    const payload = JSON.parse(unified.body ?? "{}") as { data: { summaryReady: boolean; visit: { note: Record<string, unknown> } } };
    expect(unified.statusCode).toBe(200);
    expect(payload.data.summaryReady).toBe(true);
    expect(payload.data.visit.note).toMatchObject({ status: "not_reviewed", aiSections: { summary: "# Visit\n\nPatient reports better afternoons.", patient_reported: "", results_reviewed: "", plan_discussed: "" }, actionItems: [] });

    for (const bad of [
      { meeting_id: 123, summary_content: "someone else's meeting" },
      { summary_content: "no meeting id at all" },
      { meeting_id: 900000001, meeting_uuid: "another-instance", summary_content: "same number, other instance" },
      { meeting_id: 900000001, summary_content: "missing exact instance identity" },
    ]) {
      fetchRouter([...identityRoutes(), ...zoomRoutes({ summary: () => jsonResponse(200, bad) })]);
      queueGet(visitRecord({ status: "ended", providerMeetingId: "900000001", providerMeetingUuid: "uuid-900000001" }));
      const refused = await createTelehealthHandler(zoomConfig)(event("POST /clinical-core/workforce/appointments/visits/notes/import", { appointmentId: APPOINTMENT }, workforceClaims));
      expect(refused.statusCode, JSON.stringify(bad)).toBe(503);
    }

    fetchRouter([...identityRoutes(), ...zoomRoutes({ summary: () => ({ ...jsonResponse(200, {}), headers: { get: (name: string) => (name === "content-length" ? String(10 * 1024 * 1024) : null) } }) })]);
    queueGet(visitRecord({ status: "ended", providerMeetingId: "900000001" }));
    const oversized = await createTelehealthHandler(zoomConfig)(event("POST /clinical-core/workforce/appointments/visits/notes/import", { appointmentId: APPOINTMENT }, workforceClaims));
    expect(oversized.statusCode).toBe(503);

    fetchRouter([...identityRoutes(), ...zoomRoutes({ summary: () => jsonResponse(200, { meeting_id: 900000001, meeting_uuid: "uuid-900000001", summary_content: "   " }) })]);
    queueGet(visitRecord({ status: "ended", providerMeetingId: "900000001", providerMeetingUuid: "uuid-900000001" }));
    const empty = await createTelehealthHandler(zoomConfig)(event("POST /clinical-core/workforce/appointments/visits/notes/import", { appointmentId: APPOINTMENT }, workforceClaims));
    expect(JSON.parse(empty.body ?? "{}").data).toMatchObject({ summaryReady: false });
    expect(putItems().filter((item) => item.note)).toHaveLength(1);
  });

  it("refuses a summary when the visit has no verified instance UUID", async () => {
    fetchRouter([...identityRoutes(), ...zoomRoutes({ summary: () => jsonResponse(200, { meeting_id: 900000001, meeting_uuid: "uuid-900000001", summary_content: "unbound source" }) })]);
    queueGet(visitRecord({ status: "ended", providerMeetingId: "900000001", providerMeetingUuid: null }));
    const result = await createTelehealthHandler(zoomConfig)(event("POST /clinical-core/workforce/appointments/visits/notes/import", { appointmentId: APPOINTMENT }, workforceClaims));
    expect(result.statusCode).toBe(503);
    expect(putItems()).toHaveLength(0);
  });

  it("cancels an undeclared oversized summary stream before later chunks and never saves a note", async () => {
    let reads = 0, cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++;
        controller.enqueue(new Uint8Array(1536 * 1024));
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }));
    response.text = async () => { throw Error("unbounded materialization forbidden"); };
    fetchRouter([...identityRoutes(), ...zoomRoutes({ summary: () => response })]);
    queueGet(visitRecord({ status: "ended", providerMeetingId: "900000001", providerMeetingUuid: "uuid-900000001" }));
    const result = await createTelehealthHandler(zoomConfig)(event("POST /clinical-core/workforce/appointments/visits/notes/import", { appointmentId: APPOINTMENT }, workforceClaims));
    expect(result.statusCode).toBe(503);
    expect(reads).toBeLessThanOrEqual(2);
    expect(cancelled).toBe(true);
    expect(putItems()).toHaveLength(0);
  });

  it("re-import keeps practitioner notes and action-item decisions and retains the prior revision", async () => {
    const previous = { status: "not_reviewed", source: "zoom_ai_companion", zoomSummaryId: "uuid-1", aiSections: { summary: "old", patient_reported: "", results_reviewed: "", plan_discussed: "" }, aiOriginal: {}, practitionerNotes: "Keep me", actionItems: [{ id: "a1", text: "Order ferritin", status: "approved" }], revision: 1, importedAt: "2026-10-01T00:00:00.000Z", signedAt: null, signedBy: null };
    fetchRouter([...identityRoutes(), ...zoomRoutes({ summary: () => jsonResponse(200, { meeting_id: 900000001, meeting_uuid: "uuid-900000001", summary_overview: "new overview", next_steps: ["Order ferritin", "Sleep log"] }) })]);
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

  it("lists visits across every page, says whether the list is complete, and never returns note bodies in a list", async () => {
    const idFor = (index: number) => `${(0x77777770 + index).toString(16)}-7777-4777-8777-777777777777`;
    fetchRouter(identityRoutes({ calendar: Array.from({ length: 20 }, (_, index) => calendarRow({ id: idFor(index) })) }));
    const page = (index: number, last?: Record<string, unknown>) => ({ Items: [visitRecord({ appointmentId: idFor(index), sk: `VISIT#${index}`, note: { status: "signed", source: "zoom_ai_companion", zoomSummaryId: "u", revision: 2, importedAt: "", signedAt: "", signedBy: "" } })], ...(last ? { LastEvaluatedKey: last } : {}) });
    queueQuery(page(1, { pk: "x", sk: "1" }), page(2));
    const result = await createTelehealthHandler(config)(event("GET /clinical-core/workforce/appointments/visits", undefined, workforceClaims));
    const payload = JSON.parse(result.body ?? "{}") as { data: { visits: Array<Record<string, unknown>>; complete: boolean } };
    expect(payload.data.complete).toBe(true);
    expect(payload.data.visits).toHaveLength(2);
    expect(payload.data.visits[0].note).toEqual({ status: "signed", source: "zoom_ai_companion", zoomSummaryId: "u", revision: 2, importedAt: "", signedAt: "", signedBy: "" });
    expect(payload.data.visits[0]).not.toHaveProperty("passcode");
    const query = send.mock.calls[0][0] as { input: { ProjectionExpression: string } };
    expect(query.input.ProjectionExpression).not.toContain("aiOriginal");
    expect((send.mock.calls[1][0] as { input: { ExclusiveStartKey?: unknown } }).input.ExclusiveStartKey).toEqual({ pk: "x", sk: "1" });

    for (let index = 0; index < 20; index += 1) queueQuery(page(index, { pk: "x", sk: String(index) }));
    const bounded = await createTelehealthHandler(config)(event("GET /clinical-core/workforce/appointments/visits", undefined, workforceClaims));
    expect(JSON.parse(bounded.body ?? "{}").data.complete).toBe(false);
  });

  it("does not read note text or list consent/links after clinical access is refused", async () => {
    fetchRouter(identityRoutes({ calendar: () => jsonResponse(403, { error: "identity_refused" }) }));
    queueGet(visitRecord({ quickNotes: "Fictional private text" }));
    const handler = createTelehealthHandler(config);
    const note = await handler({ ...(event("GET /clinical-core/workforce/appointments/visits/notes", undefined, workforceClaims) as unknown as Record<string, unknown>), queryStringParameters: { appointmentId: APPOINTMENT } } as never);
    expect(note.statusCode).toBe(403);
    expect(note.body).not.toContain("Fictional private text");
    queueQuery({ Items: [visitRecord({ joinUrl: "https://zoom.us/j/900000001" })] });
    const list = await handler(event("GET /clinical-core/workforce/appointments/visits", undefined, workforceClaims));
    expect(list.statusCode).toBe(403);
    expect(list.body).not.toContain("Synthetic Signer");
    expect(list.body).not.toContain("zoom.us");
  });

  it("marks a list incomplete rather than exposing an appointment with no current clinical authorization", async () => {
    fetchRouter(identityRoutes({ calendar: [] }));
    queueQuery({ Items: [visitRecord()] });
    const result = await createTelehealthHandler(config)(event("GET /clinical-core/workforce/appointments/visits", undefined, workforceClaims));
    expect(JSON.parse(result.body ?? "{}").data).toEqual({ visits: [], complete: false, withheld: 1 });
  });

  it("refuses patient substitution before secrets or meeting creation and rechecks after provider work", async () => {
    const replacement = "99999999-9999-4999-8999-999999999999";
    const calls = fetchRouter([...identityRoutes({ calendar: [calendarRow({ patient_id: replacement })] }), ...zoomRoutes()]);
    queueGet(visitRecord());
    expect((await start()).statusCode).toBe(400);
    expect(secretsSend).not.toHaveBeenCalled();
    expect(creates(calls)).toHaveLength(0);
    expect(putItems()).toHaveLength(0);

    let authorityReads = 0;
    const delayedCalls = fetchRouter([...identityRoutes({ calendar: () => jsonResponse(200, { data: { appointments: [calendarRow({ patient_id: ++authorityReads === 1 ? PATIENT : replacement })] } }) }), ...zoomRoutes()]);
    queueGet(visitRecord());
    const delayed = await start();
    expect(delayed.statusCode).toBe(400);
    expect(creates(delayedCalls)).toHaveLength(1);
    expect(delayedCalls.some(c => c.url.includes("type=zak"))).toBe(false);
    expect(delayed.body).not.toContain("signature");
    expect(putItems().some(item => item.patientRecordId === replacement)).toBe(false);
  });

  it("starts a connected patient-app visit only when its request, live patient mapping and calendar agree", async () => {
    const grant = { status: "granted", patientRecordId: PATIENT, connectionId: "44444444-4444-4444-8444-444444444444", artifactId: ARTIFACT.artifactId, artifactStatus: "approved" };
    const calls = fetchRouter([...identityRoutes({ grant }), ...zoomRoutes()]);
    queueGet(visitRecord({ requestId: REQUEST, consumerPersonId: claims["custom:person_id"], patientRecordId: null }));
    queueQuery(...Array.from({ length: 8 }, () => ({ Items: [requestRecord()] })));
    const result = await start();
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body ?? "{}").data.visit.patientRecordId).toBe(PATIENT);
    expect(creates(calls)).toHaveLength(1);

    const wrongCalls = fetchRouter([...identityRoutes({ grant, calendar: [calendarRow({ patient_id: "99999999-9999-4999-8999-999999999999" })] }), ...zoomRoutes()]);
    queueGet(visitRecord({ requestId: REQUEST, consumerPersonId: claims["custom:person_id"], patientRecordId: null }));
    queueQuery({ Items: [requestRecord()] });
    expect((await start()).statusCode).toBe(400);
    expect(creates(wrongCalls)).toHaveLength(0);
  });

  it("does not return an already-ended visit through the idempotent end route after access revocation", async () => {
    fetchRouter(identityRoutes({ calendar: () => jsonResponse(403, { error: "identity_refused" }) }));
    queueGet(visitRecord({ status: "ended", quickNotes: "Fictional retained note" }));
    const result = await createTelehealthHandler(config)(event("POST /clinical-core/workforce/appointments/visits/end", { appointmentId: APPOINTMENT, expectedVersion: 1 }, workforceClaims));
    expect(result.statusCode).toBe(403);
    expect(result.body).not.toContain("Fictional retained note");
  });

  it("closes a visit when its booking is cancelled, deleting a meeting the visit itself created", async () => {
    const calls = fetchRouter([...zoomRoutes()]);
    const store = new FictionalAppointmentStore().seed(requestRecord({ providerMeetingId: null }),
      { pk: `ORG#${ORG}`, sk: "SLOT#x", slotId: "55555555-5555-4555-8555-555555555555", start: "2026-10-09T17:00:00.000Z", cancellationWindowHours: 24, status: "booked" },
      visitRecord({ status: "scheduled", providerMeetingId: "900000003", joinUrl: "https://zoom.us/j/900000003" }));
    send.mockImplementation(store.send);
    const result = await createTelehealthHandler(zoomConfig)(event("POST /clinical-core/workforce/appointments/actions", { requestId: REQUEST, action: "cancel", expectedVersion: 2 }, workforceClaims));
    expect(result.statusCode).toBe(200);
    expect(deletes(calls).some((call) => call.url.includes("/meetings/900000003"))).toBe(true);
    expect(store.get({ pk: `ORG#${ORG}`, sk: `VISIT#${APPOINTMENT}` })).toMatchObject({ status: "cancelled", providerMeetingId: null, meetingLease: null });
  });

  /* ---------------------------------------------------- retained-record authority and the chart transfer */

  const signedNote = (overrides: Record<string, unknown> = {}) => ({ status: "signed", source: "zoom_ai_companion", zoomSummaryId: "uuid-900000001",
    aiSections: { summary: "Fictional summary.", patient_reported: "Fictional report.", results_reviewed: "", plan_discussed: "Fictional plan." }, aiOriginal: { meeting_id: 900000001, summary_content: "Fictional provider summary" },
    practitionerNotes: "Fictional practitioner text.", actionItems: [{ id: "a1", text: "Order ferritin", status: "approved" }], revision: 2, importedAt: "2026-10-09T18:00:00.000Z", signedAt: "2026-10-09T18:30:00.000Z", signedBy: workforceClaims["custom:person_id"], ...overrides });
  const completedVisit = (overrides: Record<string, unknown> = {}) => visitRecord({ status: "ended", providerMeetingId: "900000001", providerMeetingUuid: "uuid-900000001", endedAt: "2026-10-09T17:30:00.000Z", note: signedNote(), version: 6, ...overrides });
  const readNote = (handlerConfig = config) => createTelehealthHandler(handlerConfig)({ ...(event("GET /clinical-core/workforce/appointments/visits/notes", undefined, workforceClaims) as unknown as Record<string, unknown>), queryStringParameters: { appointmentId: APPOINTMENT } } as never);
  const transfer = (body: Record<string, unknown>) => createTelehealthHandler(config)(event("POST /clinical-core/workforce/appointments/visits/notes/transfer", { appointmentId: APPOINTMENT, ...body }, workforceClaims));
  const complete = () => createTelehealthHandler(config)(event("POST /clinical-core/workforce/appointments/visits/notes/transfer/complete", { appointmentId: APPOINTMENT }, workforceClaims));
  const authorityCalls = (calls: Array<{ url: string; body?: unknown }>) => calls.filter((call) => (call.body as { functionName?: string } | undefined)?.functionName === "get_telehealth_record_authority");
  const calendarCalls = (calls: Array<{ url: string; body?: unknown }>) => calls.filter((call) => (call.body as { functionName?: string } | undefined)?.functionName === "get_desktop_calendar");

  it("reads a COMPLETED visit under the retained-record authority, not the calendar: a deleted or moved appointment does not erase access; membership, role and patient refusals return no text", async () => {
    const calls = fetchRouter(identityRoutes({ calendar: [], authority: recordAuthority({ appointment: null }) }));
    queueGet(completedVisit({ quickNotes: "Fictional retained text" }));
    const retained = await readNote();
    expect(retained.statusCode).toBe(200);
    expect(JSON.parse(retained.body ?? "{}").data).toMatchObject({ quickNotes: "Fictional retained text", chartTransferSource: { sourceRevision: 2, sourceDigest: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    expect(authorityCalls(calls)).toHaveLength(1);
    expect(calendarCalls(calls)).toHaveLength(0);
    expect(authorityCalls(calls)[0].body).toMatchObject({ kind: "rpc", functionName: "get_telehealth_record_authority", args: { _organization_id: ORG, _patient_id: PATIENT, _appointment_id: APPOINTMENT } });

    for (const [label, authority] of Object.entries({
      "refused by the clinical core (revoked membership, wrong clinic, staff-only role, archived patient)": null,
      "not an authorized answer": recordAuthority({ authorized: false }),
      "an answer about another patient": recordAuthority({ patient_record_id: "99999999-9999-4999-8999-999999999999" }),
    })) {
      fetchRouter(identityRoutes({ authority: authority as Record<string, unknown> | null }));
      queueGet(completedVisit({ quickNotes: "Fictional retained text" }));
      const refused = await readNote();
      expect(refused.statusCode, label).toBe(403);
      expect(refused.body, label).not.toContain("Fictional");
    }
    // No authority answer at all is a refusal, never organization-membership access.
    fetchRouter(identityRoutes({ authority: () => jsonResponse(503, { error: "database_unavailable" }) }));
    queueGet(completedVisit({ quickNotes: "Fictional retained text" }));
    const silent = await readNote();
    expect(silent.statusCode).toBe(503);
    expect(silent.body).not.toContain("Fictional");
    // A completed visit with no patient record has no retained-record subject: refused without any authority call.
    const none = fetchRouter(identityRoutes());
    queueGet(completedVisit({ patientRecordId: null, requestId: REQUEST, consumerPersonId: claims["custom:person_id"], quickNotes: "Fictional retained text" }));
    const subjectless = await readNote();
    expect(subjectless.statusCode).toBe(403);
    expect(authorityCalls(none)).toHaveLength(0);
  });

  it("a visit that is still scheduled or running keeps the current appointment binding for reads; start and import are untouched by the retained path", async () => {
    const calls = fetchRouter(identityRoutes({ calendar: [] }));
    queueGet(visitRecord({ status: "in_visit", providerMeetingId: "900000001", quickNotes: "Fictional live text" }));
    const running = await readNote();
    expect(running.statusCode).toBe(404);
    expect(running.body).not.toContain("Fictional");
    expect(calendarCalls(calls)).toHaveLength(1);
    expect(authorityCalls(calls)).toHaveLength(0);
  });

  const canonicalJson = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonicalJson).join(",")}]`
    : value && typeof value === "object" ? `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}` : JSON.stringify(value === undefined ? null : value);
  type SignedSource = { transferId: string; organizationId: string; patientRecordId: string; appointmentId: string; sourceRevision: number; sourceDigest: string; contentText: string; sourcePayloadText: string; provenanceText: string; admission: string; admissionSignature: string; admissionExpiresAt: string };
  it("transfer: admits the exact signed source under the boundary's key, returns the exact bytes and a verifiable admission once, and is idempotent across a lost response", async () => {
    // The chart resolves the caller to ITS person id; the admission binds that, not the JWT claim (which the record's admittedBy keeps).
    const calls = fetchRouter(identityRoutes({ authority: recordAuthority({ actor_person_id: PRACTITIONER_ID }) }));
    secretsSend.mockReset(); secretsSend.mockImplementation(admissionSecretAnswer);
    queueGet(completedVisit());
    const read = JSON.parse((await readNote()).body ?? "{}").data as { chartTransferSource: { sourceRevision: number; sourceDigest: string } };
    const source = read.chartTransferSource;
    queueGet(completedVisit());
    const before = Date.now();
    const admitted = await transfer({ sourceRevision: source.sourceRevision, sourceDigest: source.sourceDigest });
    expect(admitted.statusCode).toBe(200);
    const payload = JSON.parse(admitted.body ?? "{}").data as { transfer: Record<string, unknown>; source: SignedSource };
    expect(payload.transfer).toMatchObject({ state: "admitted", sourceRevision: 2, sourceDigest: source.sourceDigest, admittedBy: workforceClaims["custom:person_id"], encounterId: null, noteId: null, admissionKeyId: ADMISSION_KEY.keyId, admissionSha256: sha256(payload.source.admission) });
    expect(payload.source).toMatchObject({ transferId: payload.transfer.transferId, organizationId: ORG, patientRecordId: PATIENT, appointmentId: APPOINTMENT, sourceRevision: 2, sourceDigest: source.sourceDigest });
    // The exact bytes the chart will hash: canonical JSON, the narrative note's single `text` section.
    const content = JSON.parse(payload.source.contentText) as Record<string, string>;
    expect(Object.keys(content)).toEqual(["text"]);
    expect(payload.source.contentText).toBe(canonicalJson(content));
    for (const expected of ["## Telehealth visit — AI Companion summary (reviewed)\nFictional summary.", "## What the patient reported\nFictional report.", "## Plan discussed\nFictional plan.", "## Practitioner notes\nFictional practitioner text.", "- Order ferritin (approved)", "no order, task or protocol change was created", "Transferred UNSIGNED for chart review"]) expect(content.text).toContain(expected);
    expect(content.text).not.toContain("## Results reviewed"); // an empty section is not invented
    expect(JSON.parse(payload.source.sourcePayloadText)).toMatchObject({ aiOriginal: { meeting_id: 900000001 }, revision: 2, signedBy: workforceClaims["custom:person_id"], providerMeetingUuid: "uuid-900000001" });
    expect((JSON.parse(payload.source.provenanceText) as Array<Record<string, unknown>>).every((entry) => ["telehealth_visit", "practitioner_entered"].includes(String(entry.refType)))).toBe(true);
    // The admission: the contract's members exactly, bound to the chart-resolved practitioner, the exact bytes, a short window — and it verifies under the key, which never appears in the response.
    const admission = JSON.parse(payload.source.admission) as Record<string, unknown>;
    expect(Object.keys(admission).sort()).toEqual(["appointment_id", "content_sha256", "contract", "expires_at", "intent", "issued_at", "key_id", "organization_id", "patient_record_id", "payload_sha256", "practitioner_person_id", "provenance_sha256", "source_custody", "source_digest", "source_record_version", "source_revision", "transfer_id"]);
    expect(admission).toMatchObject({ contract: "telehealth-chart-admission/1", intent: "chart_draft", key_id: ADMISSION_KEY.keyId, transfer_id: payload.transfer.transferId, organization_id: ORG, patient_record_id: PATIENT, appointment_id: APPOINTMENT,
      practitioner_person_id: PRACTITIONER_ID, source_custody: "telehealth-visit-record", source_record_version: 6, source_revision: 2, source_digest: source.sourceDigest,
      content_sha256: sha256(payload.source.contentText), payload_sha256: sha256(payload.source.sourcePayloadText), provenance_sha256: sha256(payload.source.provenanceText) });
    const window = Date.parse(String(admission.expires_at)) - Date.parse(String(admission.issued_at));
    expect(window).toBe(15 * 60_000); expect(Date.parse(String(admission.issued_at))).toBeGreaterThanOrEqual(before - 1000);
    expect(payload.source.admissionSignature).toBe(createHmac("sha256", Buffer.from(ADMISSION_KEY.secret, "hex")).update(payload.source.admission, "utf8").digest("hex"));
    expect(admitted.body).not.toContain(ADMISSION_KEY.secret);
    expect(putItems().at(-1)).toMatchObject({ chartTransfer: { state: "admitted", transferId: payload.transfer.transferId, admissionKeyId: ADMISSION_KEY.keyId } });
    expect(JSON.stringify(putItems().at(-1))).not.toContain(payload.source.admissionSignature);
    expect(secretsSend).toHaveBeenCalledTimes(1);
    expect((secretsSend.mock.calls[0][0] as { input: { SecretId: string } }).input.SecretId).toBe(config.chartAdmissionSecretArn);
    expect(calls.filter((call) => call.url.includes("zoom.us"))).toHaveLength(0);

    // The same attempt again (the desktop lost its response before the chart write): the SAME transfer id under a fresh admission, the record rewritten only with the new admission digest.
    writes.length = 0; secretsSend.mockClear();
    const first = putItems().at(-1)?.chartTransfer ?? (JSON.parse(admitted.body ?? "{}").data.transfer as Record<string, unknown>);
    queueGet(completedVisit({ chartTransfer: first, version: 7 }));
    const again = await transfer({ sourceRevision: 2, sourceDigest: source.sourceDigest });
    const againSource = JSON.parse(again.body ?? "{}").data.source as SignedSource;
    expect(againSource.transferId).toBe(payload.transfer.transferId);
    expect(JSON.parse(againSource.admission)).toMatchObject({ transfer_id: payload.transfer.transferId, content_sha256: sha256(payload.source.contentText) });
    expect(againSource.admissionSignature).toBe(createHmac("sha256", Buffer.from(ADMISSION_KEY.secret, "hex")).update(againSource.admission, "utf8").digest("hex"));
    expect(JSON.parse(again.body ?? "{}").data.transfer).toMatchObject({ transferId: payload.transfer.transferId, admittedAt: (first as Record<string, unknown>).admittedAt, admittedBy: workforceClaims["custom:person_id"] });
    expect(secretsSend).toHaveBeenCalledTimes(1);

    // The chart now holds the receipt (the chart write landed; its response was lost): complete reads it back and records it; no admission is minted for a read.
    const admissionRecord = putItems().at(-1)?.chartTransfer as Record<string, unknown>;
    secretsSend.mockClear();
    fetchRouter(identityRoutes({ authority: recordAuthority({ transfer: { transfer_id: payload.transfer.transferId, encounter_id: "eeeeeeee-1111-4111-8111-111111111111", note_id: "aaaaaaaa-2222-4222-8222-222222222222", note_version: 1,
      source_note_revision: 2, source_digest: source.sourceDigest, content_sha256: "c".repeat(64), transferred_at: "2026-10-10T01:00:00.000Z", transferred_by_person_id: workforceClaims["custom:person_id"], note_status: "draft", note_current_version: 1, note_deleted: false } }) }));
    queueGet(completedVisit({ chartTransfer: admissionRecord, version: 8 }));
    const completed = await complete();
    expect(completed.statusCode).toBe(200);
    expect(JSON.parse(completed.body ?? "{}").data.transfer).toMatchObject({ state: "completed", transferId: payload.transfer.transferId, encounterId: "eeeeeeee-1111-4111-8111-111111111111", noteId: "aaaaaaaa-2222-4222-8222-222222222222", noteVersion: 1 });
    // Completed is terminal and idempotent: transfer and complete both return the receipt without any further admission or secret read.
    writes.length = 0;
    const receipt = JSON.parse(completed.body ?? "{}").data.transfer as Record<string, unknown>;
    queueGet(completedVisit({ chartTransfer: receipt, version: 9 }));
    expect(JSON.parse((await transfer({ sourceRevision: 2, sourceDigest: source.sourceDigest })).body ?? "{}").data).toMatchObject({ transfer: { state: "completed" }, source: null });
    queueGet(completedVisit({ chartTransfer: receipt, version: 9 }));
    expect(JSON.parse((await complete()).body ?? "{}").data.transfer).toMatchObject({ state: "completed" });
    expect(writes).toHaveLength(0);
    expect(secretsSend).not.toHaveBeenCalled();
  });

  it("transfer is unavailable, with nothing written and nothing minted, when the boundary holds no admission key, cannot read it, or the secret is malformed; a refused authority or stale source never reads the secret", async () => {
    fetchRouter(identityRoutes());
    queueGet(completedVisit());
    const source = (JSON.parse((await readNote()).body ?? "{}").data as { chartTransferSource: { sourceDigest: string } }).chartTransferSource;
    const attempt = (handlerConfig: TelehealthConfiguration) => createTelehealthHandler(handlerConfig)(event("POST /clinical-core/workforce/appointments/visits/notes/transfer", { appointmentId: APPOINTMENT, sourceRevision: 2, sourceDigest: source.sourceDigest }, workforceClaims));
    secretsSend.mockReset(); secretsSend.mockImplementation(admissionSecretAnswer);
    queueGet(completedVisit());
    const unprovisioned = await attempt({ ...config, chartAdmissionSecretArn: "" });
    expect(unprovisioned.statusCode).toBe(503);
    expect(JSON.parse(unprovisioned.body ?? "{}")).toEqual({ error: "transfer_unavailable" });
    expect(secretsSend).not.toHaveBeenCalled();
    for (const answer of [Promise.reject(new Error("fictional secrets outage")), Promise.resolve({ SecretString: "{not json" }), Promise.resolve({ SecretString: JSON.stringify({ keyId: "fictional-admission-key-1", secret: "too-short" }) }),
      Promise.resolve({ SecretString: JSON.stringify({ keyId: "Bad Key", secret: "ab".repeat(32) }) }), Promise.resolve({ SecretBinary: new Uint8Array(4) })]) {
      secretsSend.mockReset(); secretsSend.mockImplementation(() => answer);
      queueGet(completedVisit());
      const result = await attempt(config);
      expect(result.statusCode).toBe(503);
      expect(JSON.parse(result.body ?? "{}")).toEqual({ error: "transfer_unavailable" });
      expect(result.body).not.toContain("fictional secrets outage");
    }
    expect(writes).toHaveLength(0);
    // Refusals that come first never touch the secret.
    secretsSend.mockReset(); secretsSend.mockImplementation(admissionSecretAnswer);
    queueGet(completedVisit());
    expect((await transfer({ sourceRevision: 1, sourceDigest: "a".repeat(64) })).statusCode).toBe(409);
    fetchRouter(identityRoutes({ authority: null }));
    queueGet(completedVisit());
    expect((await transfer({ sourceRevision: 2, sourceDigest: source.sourceDigest })).statusCode).toBe(403);
    expect(secretsSend).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("transfer refuses a stale screen, an unsigned or unfinished visit, a lost subject and a chart receipt for a different source — and complete without a receipt leaves the admission standing", async () => {
    fetchRouter(identityRoutes());
    queueGet(completedVisit());
    const stale = await transfer({ sourceRevision: 1, sourceDigest: "a".repeat(64) });
    expect(stale.statusCode).toBe(409);
    expect(JSON.parse(stale.body ?? "{}")).toEqual({ error: "transfer_source_stale" });
    expect(writes).toHaveLength(0);

    queueGet(completedVisit({ note: signedNote({ status: "not_reviewed", signedAt: null, signedBy: null }) }));
    expect((await transfer({ sourceRevision: 2, sourceDigest: "a".repeat(64) })).statusCode).toBe(409);
    queueGet(visitRecord({ status: "in_visit", note: signedNote() }));
    expect((await transfer({ sourceRevision: 2, sourceDigest: "a".repeat(64) })).statusCode).toBe(409);
    queueGet(completedVisit({ status: "cancelled" }));
    expect((await transfer({ sourceRevision: 2, sourceDigest: "a".repeat(64) })).statusCode).toBe(409);
    expect(writes).toHaveLength(0);

    // The exact source digest, then the chart answers with a receipt for ANOTHER source: needs review, never a second write.
    queueGet(completedVisit());
    const source = (JSON.parse((await readNote()).body ?? "{}").data as { chartTransferSource: { sourceDigest: string } }).chartTransferSource;
    fetchRouter(identityRoutes({ authority: recordAuthority({ transfer: { transfer_id: "dddddddd-1111-4111-8111-111111111111", encounter_id: "e", note_id: "n", note_version: 1, source_note_revision: 1, source_digest: "b".repeat(64),
      content_sha256: "c".repeat(64), transferred_at: "2026-10-10T01:00:00.000Z", transferred_by_person_id: "p", note_status: "draft", note_current_version: 1, note_deleted: false } }) }));
    queueGet(completedVisit());
    const mismatch = await transfer({ sourceRevision: 2, sourceDigest: source.sourceDigest });
    expect(mismatch.statusCode).toBe(409);
    expect(JSON.parse(mismatch.body ?? "{}")).toEqual({ error: "transfer_mismatch" });
    expect(writes).toHaveLength(0);

    // Complete with an admission but no chart receipt yet: the admission stands (state admitted), nothing invented.
    fetchRouter(identityRoutes());
    const admission = { transferId: "22222222-2222-4222-8222-222222222222", state: "admitted", sourceRevision: 2, sourceDigest: source.sourceDigest, admittedAt: "2026-10-10T00:00:00.000Z", admittedBy: workforceClaims["custom:person_id"], encounterId: null, noteId: null, noteVersion: null, contentSha256: null, transferredAt: null, completedAt: null };
    queueGet(completedVisit({ chartTransfer: admission }));
    const pending = await complete();
    expect(pending.statusCode).toBe(200);
    expect(JSON.parse(pending.body ?? "{}").data.transfer).toMatchObject({ state: "admitted", transferId: admission.transferId });
    expect(writes).toHaveLength(0);
    // Complete with neither an admission nor a receipt: nothing to complete.
    queueGet(completedVisit());
    expect((await complete()).statusCode).toBe(409);
    // Refused authority refuses the transfer before any admission is written.
    fetchRouter(identityRoutes({ authority: null }));
    queueGet(completedVisit());
    expect((await transfer({ sourceRevision: 2, sourceDigest: source.sourceDigest })).statusCode).toBe(403);
    expect(writes).toHaveLength(0);
  });

  it("a list withholds a completed visit the retained-record authority refuses, keeps the others, and says the list is not complete", async () => {
    const calls = fetchRouter(identityRoutes({ authority: null }));
    queueQuery({ Items: [visitRecord({ appointmentId: APPOINTMENT, sk: "VISIT#1" }), completedVisit({ appointmentId: "66666666-7777-4777-8777-777777777777", sk: "VISIT#2", quickNotes: "Fictional retained text" })] });
    const result = await createTelehealthHandler(config)(event("GET /clinical-core/workforce/appointments/visits", undefined, workforceClaims));
    const payload = JSON.parse(result.body ?? "{}") as { data: { visits: Array<{ appointmentId: string }>; complete: boolean; withheld: number } };
    expect(result.statusCode).toBe(200);
    expect(payload.data.visits.map((visit) => visit.appointmentId)).toEqual([APPOINTMENT]);
    expect(payload.data).toMatchObject({ complete: false, withheld: 1 });
    expect(result.body).not.toContain("Fictional");
    expect(authorityCalls(calls)).toHaveLength(1);
  });

  /* ---------------------------------------------------- record lifecycle: inventory, never deletion */

  const inventoryOf = () => createTelehealthHandler(config)({ ...(event("GET /clinical-core/workforce/appointments/visits/notes/inventory", undefined, workforceClaims) as unknown as Record<string, unknown>), queryStringParameters: { appointmentId: APPOINTMENT } } as never);

  it("inventories every telehealth text location with digests and never the text, under the retained-record authority, and reports the chart's hold", async () => {
    const calls = fetchRouter(identityRoutes({ authority: recordAuthority({ legal_hold: true }) }));
    const visit = completedVisit({ quickNotes: "Fictional quick note", flags: [{ atSeconds: 5, label: "Fictional flagged moment" }],
      noteHistory: [signedNote({ status: "not_reviewed", revision: 1, signedAt: null, signedBy: null, practitionerNotes: "Fictional earlier text" })],
      chartTransfer: { transferId: "22222222-2222-4222-8222-222222222222", state: "completed", sourceRevision: 2, sourceDigest: "a".repeat(64), admittedAt: "2026-10-10T00:00:00.000Z", admittedBy: "p", encounterId: "e1", noteId: "n1", noteVersion: 1, contentSha256: "c".repeat(64), transferredAt: "2026-10-10T00:01:00.000Z", completedAt: "2026-10-10T00:02:00.000Z" } });
    queueGet(visit);
    const result = await inventoryOf();
    expect(result.statusCode).toBe(200);
    const inventory = JSON.parse(result.body ?? "{}").data as { legalHold: boolean; consent: Record<string, unknown>; processing: Record<string, unknown>; locations: Array<Record<string, unknown>>; notCertifiable: string[] };
    expect(inventory).toMatchObject({ contract: "telehealth-record-inventory/1", legalHold: true, consent: { granted: true, withdrawn: false }, processing: { aiImportAllowed: true } });
    expect(authorityCalls(calls)).toHaveLength(1);
    // Every text-bearing field of the record is represented as present with a digest; the text itself never leaves.
    const byId = Object.fromEntries(inventory.locations.map((location) => [String(location.id), location]));
    for (const id of ["visit.quickNotes", "visit.flags", "visit.note.aiOriginal", "visit.note.aiSections", "visit.note.practitionerNotes", "visit.note.actionItems", "visit.note.signature", "visit.noteHistory", "visit.consents", "visit.chartTransfer", "visit.providerIdentifiers"]) {
      expect(byId[id], id).toMatchObject({ present: true, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    }
    expect(byId["visit.noteHistory"].count).toBe(1); expect(byId["visit.flags"].count).toBe(1); expect(byId["visit.consents"].count).toBe(1);
    expect(byId["visit.chartTransfer"].identifiers).toMatchObject({ transferId: "22222222-2222-4222-8222-222222222222", noteId: "n1" });
    expect(byId["zoom.aiCompanionSummary"]).toMatchObject({ present: false, identifiers: { zoomSummaryId: "uuid-900000001" } });
    for (const text of ["Fictional quick note", "Fictional flagged moment", "Fictional summary.", "Fictional practitioner text.", "Fictional earlier text", "Order ferritin", "Fictional provider summary", "Synthetic Signer"]) expect(result.body).not.toContain(text);
    // Every store is accounted for, and what cannot be certified is said.
    expect(new Set(inventory.locations.map((location) => location.store))).toEqual(new Set(["telehealth_visit_record", "chart", "zoom", "backups"]));
    expect(inventory.notCertifiable.join(" ")).toMatch(/Zoom/); expect(inventory.notCertifiable.join(" ")).toMatch(/backups/); expect(inventory.notCertifiable.join(" ")).toMatch(/retention/);
    expect(inventory.locations.every((location) => (location.controls as { erasure: { coverage: string } }).erasure.coverage !== "covered")).toBe(true);
  });

  it("consent withdrawal stops new processing and claims no deletion; the inventory of a running visit uses the current binding; a refused caller gets no inventory", async () => {
    const calls = fetchRouter(identityRoutes());
    queueGet(visitRecord({ status: "in_visit", providerMeetingId: "900000001", consents: [receipt({ status: "withdrawn", withdrawnAt: "2026-10-09T17:10:00.000Z" })], quickNotes: "Fictional live text" }));
    const running = await inventoryOf();
    expect(running.statusCode).toBe(200);
    const inventory = JSON.parse(running.body ?? "{}").data as { legalHold: boolean | null; consent: Record<string, unknown>; processing: Record<string, unknown> };
    expect(inventory).toMatchObject({ legalHold: null, consent: { granted: false, withdrawn: true, withdrawnAt: "2026-10-09T17:10:00.000Z" }, processing: { aiImportAllowed: false, reason: expect.stringContaining("not deleted") } });
    expect(calendarCalls(calls).length).toBeGreaterThan(0); expect(authorityCalls(calls)).toHaveLength(0);
    expect(running.body).not.toContain("Fictional live text");
    // After withdrawal the import route refuses; nothing on the record is removed.
    writes.length = 0;
    queueGet(completedVisit({ consents: [receipt({ status: "withdrawn" })], note: signedNote({ status: "not_reviewed", signedAt: null, signedBy: null }) }));
    const imported = await createTelehealthHandler(zoomConfig)(event("POST /clinical-core/workforce/appointments/visits/notes/import", { appointmentId: APPOINTMENT }, workforceClaims));
    expect(imported.statusCode).toBe(409);
    expect(JSON.parse(imported.body ?? "{}")).toEqual({ error: "consent_required" });
    expect(writes).toHaveLength(0);
    // Refused retained authority: no inventory at all.
    fetchRouter(identityRoutes({ authority: null }));
    queueGet(completedVisit({ quickNotes: "Fictional retained text" }));
    const refused = await inventoryOf();
    expect(refused.statusCode).toBe(403);
    expect(refused.body).not.toContain("Fictional");
  });

  it("there is no deletion route for a visit record, and a consumer identity cannot reach any visit route", async () => {
    const handler = createTelehealthHandler(config);
    for (const key of ["DELETE /clinical-core/workforce/appointments/visits", "POST /clinical-core/workforce/appointments/visits/delete", "POST /clinical-core/workforce/appointments/visits/notes/delete", "POST /clinical-core/workforce/appointments/visits/erase"]) {
      const result = await handler(event(key, { appointmentId: APPOINTMENT }, workforceClaims));
      expect(result.statusCode, key).toBe(404);
    }
    for (const key of ["GET /clinical-core/workforce/appointments/visits/notes/inventory", "GET /clinical-core/workforce/appointments/visits/notes", "POST /clinical-core/workforce/appointments/visits/notes/transfer"]) {
      const result = await handler({ ...(event(key, key.startsWith("POST") ? { appointmentId: APPOINTMENT, sourceRevision: 1, sourceDigest: "a".repeat(64) } : undefined, claims) as unknown as Record<string, unknown>), queryStringParameters: { appointmentId: APPOINTMENT } } as never);
      expect(result.statusCode, key).toBe(403);
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("signing a completed visit's note uses the retained-record authority and never the calendar", async () => {
    const calls = fetchRouter(identityRoutes({ calendar: [] }));
    const draft = signedNote({ status: "not_reviewed", signedAt: null, signedBy: null });
    queueGet(completedVisit({ note: draft, version: 4 }));
    const result = await createTelehealthHandler(config)(event("POST /clinical-core/workforce/appointments/visits/notes/sign", { appointmentId: APPOINTMENT, expectedVersion: 4, practitionerNotes: "Patient tolerating protocol.", aiSections: draft.aiSections, actionItems: [{ id: "a1", status: "approved" }] }, workforceClaims));
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body ?? "{}").data.note).toMatchObject({ status: "signed", revision: 3 });
    expect(authorityCalls(calls)).toHaveLength(1);
    expect(calendarCalls(calls)).toHaveLength(0);
  });

  it("signs a Meeting SDK JWT with the SDK key as appKey and HS256", () => {
    const token = signMeetingSdkJwt("sdk-key", "sdk-secret", { mn: "123456789", role: 1, iat: 1, exp: 2, tokenExp: 2 });
    const [header, payload, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "HS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toMatchObject({ appKey: "sdk-key", mn: "123456789", role: 1 });
    expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
