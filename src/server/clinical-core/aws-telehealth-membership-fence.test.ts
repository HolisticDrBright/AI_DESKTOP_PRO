import { beforeEach, describe, expect, it, vi } from "vitest";

// The membership fence (membership-fence/1) for the telehealth writes under `database_current`: the real handler, the
// real fence writer, and the fictional conditional store standing in for DynamoDB (the appointments table and the fence
// table). The identity API, Zoom and Stripe are faked at `fetch`; Secrets Manager, SES and the scheduler at the SDK.
// Every identifier is fictional. This is source evidence only: not hosted, device, commercial or PHI evidence.
const { send, secretsSend, sesSend, schedulerSend } = vi.hoisted(() => ({
  send: vi.fn(), secretsSend: vi.fn(), sesSend: vi.fn(), schedulerSend: vi.fn(),
}));
vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class DynamoDBClient {} }));
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
  SESv2Client: class SESv2Client { send = sesSend; },
  SendEmailCommand: class SendEmailCommand { constructor(readonly input: unknown) {} },
}));
vi.mock("@aws-sdk/client-scheduler", () => ({
  SchedulerClient: class SchedulerClient { send = schedulerSend; },
  CreateScheduleCommand: class CreateScheduleCommand { constructor(readonly input: unknown) {} },
  DeleteScheduleCommand: class DeleteScheduleCommand { constructor(readonly input: unknown) {} },
  GetScheduleCommand: class GetScheduleCommand { constructor(readonly input: unknown) {} },
}));

import { createTelehealthHandler, TELEHEALTH_WORKFORCE_WRITE_ROUTES, type TelehealthConfiguration } from "./aws-telehealth-requests";
import { FictionalAppointmentStore } from "./appointment-operation-store.test-support";
import { createMembershipFenceWriter, MEMBERSHIP_FENCE_PROTOCOL, membershipFenceKey, type MembershipFenceChange } from "./membership-fence";

const ORIGIN = "https://abcdefghij.execute-api.us-east-2.amazonaws.com";
const HEADER = "x-alp-selected-organization-id";
const CLINIC = "2b7c9e2a-4a51-4c1e-9d3f-6f0a1b2c3d4e";
const SUB = "5d0e6b8a-3c2f-4b1e-8a9d-7e6f5a4b3c2d";
/** The practitioner as current rows name them; the token carries no person. */
const PERSON = "3f1a2b3c-4d5e-4f60-8a1b-2c3d4e5f6a7b";
const CONSUMER = "11111111-1111-4111-8111-111111111111";
const PATIENT = "66666666-6666-4666-8666-666666666666";
const APPOINTMENT = "77777777-7777-4777-8777-777777777777";
const REQUEST = "33333333-3333-4333-8333-333333333333";
const TRANSFER = "44444444-4444-4444-8444-444444444444";
const PREVIOUS_GENERATION = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const TABLE = "fictional-appointments";
const FENCE_TABLE = "fictional-membership-fences";
const ISSUER = "https://cognito-idp.us-east-2.amazonaws.com/us-east-2_workforce";

const config: TelehealthConfiguration = {
  tableName: TABLE, consumerIssuer: "https://cognito-idp.us-east-2.amazonaws.com/us-east-2_consumer", consumerAudience: "consumer-client",
  workforceIssuer: ISSUER, workforceAudience: "workforce-client",
  // A production-shaped handler built only inside this test. Nothing here activates PHI in any deployed Lambda.
  runtimeMode: "production", phiAllowed: true, workforceAuthority: "database_current", membershipFenceTable: FENCE_TABLE,
  zoomEnabled: true, zoomBaaVerified: true, zoomSecretArn: "arn:aws:secretsmanager:us-east-2:000000000000:secret:fictional-zoom",
  remindersEnabled: true, reminderSender: "reminders@example.test", reminderConfigurationSet: "alp-transactional",
  reminderScheduleGroup: "fictional-reminders", reminderSchedulerRoleArn: "arn:aws:iam::000000000000:role/fictional-scheduler",
  reminderTargetArn: "arn:aws:lambda:us-east-2:000000000000:function:fictional-telehealth",
  reminderEventsTopicArn: "arn:aws:sns:us-east-2:000000000000:fictional-reminder-events",
  stripeTestEnabled: true, stripeSecretArn: "arn:aws:secretsmanager:us-east-2:000000000000:secret:fictional-stripe",
  stripeSuccessUrl: "https://example.test/payment-complete", stripeCancelUrl: "https://example.test/payment-cancelled",
  identityApiOrigin: ORIGIN, chartAdmissionSecretArn: "arn:aws:secretsmanager:us-east-2:000000000000:secret:fictional-admission",
};
const SECRETS: Record<string, unknown> = {
  [config.zoomSecretArn]: { accountId: "acct", clientId: "client-id", clientSecret: "client-secret", userId: "host@example.test", sdkKey: "sdk-key", sdkSecret: "sdk-secret" },
  [config.stripeSecretArn]: { secretKey: "sk_test_fictional", webhookSecret: "whsec_fictional" },
  [config.chartAdmissionSecretArn]: { keyId: "fictional-admission-key-1", secret: "ab".repeat(32) },
};

const ROUTES = {
  action: "POST /clinical-core/workforce/appointments/actions",
  slot: "POST /clinical-core/workforce/appointments/slots",
  payment: "POST /clinical-core/workforce/appointments/payments",
  consent: "POST /clinical-core/workforce/appointments/visits/consent",
  withdraw: "POST /clinical-core/workforce/appointments/visits/consent/withdraw",
  start: "POST /clinical-core/workforce/appointments/visits/start",
  end: "POST /clinical-core/workforce/appointments/visits/end",
  import: "POST /clinical-core/workforce/appointments/visits/notes/import",
  sign: "POST /clinical-core/workforce/appointments/visits/notes/sign",
  transfer: "POST /clinical-core/workforce/appointments/visits/notes/transfer",
  complete: "POST /clinical-core/workforce/appointments/visits/notes/transfer/complete",
};

const at = (days: number, minutes = 0) => new Date(Math.floor(Date.now() / 60_000) * 60_000 + days * 86_400_000 + minutes * 60_000).toISOString();
const ARTIFACT = { artifactId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", scope: "telehealth_recording", artifactVersion: "telehealth-recording/1",
  contentSha256: "b".repeat(64), jurisdiction: "US-CA", approvedAt: "2026-10-01T00:00:00.000Z" };
const receipt = () => ({ consentId: "88888888-8888-4888-8888-888888888888", consentType: "telehealth_recording_combined", scope: "telehealth_recording",
  artifactId: ARTIFACT.artifactId, artifactVersion: ARTIFACT.artifactVersion, contentSha256: ARTIFACT.contentSha256, signerName: "Fictional Signer",
  method: "staff_attested", representativeAuthority: "self", signedAt: "2026-10-01T00:00:00.000Z", recordedBy: PERSON, patientLocation: "CA",
  grantId: null, connectionId: null, status: "granted", withdrawnAt: null, withdrawnBy: null, withdrawalReason: null });
const MEETING = { providerMeetingId: "900000001", providerMeetingUuid: "uuid-900000001", joinUrl: "https://zoom.us/j/900000001?pwd=FICTIONAL", passcode: "real-password-900000001" };
const visit = (overrides: Record<string, unknown> = {}) => ({
  pk: `ORG#${CLINIC}`, sk: `VISIT#${APPOINTMENT}`, appointmentId: APPOINTMENT, organizationId: CLINIC, requestId: null, consumerPersonId: null,
  patientRecordId: PATIENT, practitionerUserId: PERSON, scheduledStart: at(2), scheduledEnd: at(2, 30), timeZone: "America/Los_Angeles",
  status: "scheduled", consents: [receipt()], meetingLease: null, providerMeetingId: null, providerMeetingUuid: null, joinUrl: null, passcode: null,
  startedAt: null, endedAt: null, providerShutdown: { status: "not_started", attemptedAt: null, confirmedAt: null, detail: null },
  flags: [], quickNotes: "", note: null, noteHistory: [], version: 1, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
});
const sections = { summary: "Fictional summary.", patient_reported: "Fictional report.", results_reviewed: "", plan_discussed: "Fictional plan." };
const draftNote = () => ({ status: "not_reviewed", source: "zoom_ai_companion", zoomSummaryId: "uuid-900000001", aiSections: sections,
  aiOriginal: { meeting_id: 900000001, summary_content: "Fictional provider summary" }, practitionerNotes: "",
  actionItems: [{ id: "a1", text: "Fictional follow-up", status: "suggested" }], revision: 1, importedAt: "2026-10-09T18:00:00.000Z", signedAt: null, signedBy: null });
const signedNote = () => ({ ...draftNote(), status: "signed", practitionerNotes: "Fictional practitioner text.",
  actionItems: [{ id: "a1", text: "Fictional follow-up", status: "approved" }], revision: 2, signedAt: "2026-10-09T18:30:00.000Z", signedBy: PERSON });
const request = (overrides: Record<string, unknown> = {}) => ({
  pk: `ORG#${CLINIC}`, sk: `REQ#2026-09-01T00:00:00.000Z#${REQUEST}`, requestId: REQUEST, organizationId: CLINIC, consumerPersonId: CONSUMER,
  consumerEmail: "fictional.patient@example.test", status: "requested", visitType: "follow_up", preferredSlots: [], timeZone: "America/Los_Angeles",
  note: null, scheduledStart: null, scheduledEnd: null, joinUrl: null, providerMeetingId: null, version: 2, createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z", lastActionBy: "consumer", slotId: "55555555-5555-4555-8555-555555555555", appointmentId: null,
  priceMinor: 15000, currency: "USD", cancellationPolicy: "Cancel at least 24 hours before the visit.", cancellationWindowHours: 24,
  cancellationFeeDueMinor: 0, reminderStatus: "disabled", paymentPolicyVersion: "telehealth-payments/1", paymentAuthorizationStatus: "authorized",
  paymentStatus: "not_due", paymentIntentId: null, paidMinor: 0, refundedMinor: 0, ...overrides,
});
const paymentProfile = () => ({ pk: `ORG#${CLINIC}`, sk: `PAYMENT_PROFILE#${CONSUMER}`, organizationId: CLINIC, consumerPersonId: CONSUMER,
  stripeCustomerId: "cus_fictional", stripePaymentMethodId: "pm_fictional", status: "active", updatedAt: "2026-09-01T00:00:00.000Z" });
const calendarRow = () => ({ id: APPOINTMENT, patient_id: PATIENT, patient_name: "Fictional Patient", practitioner_user_id: PERSON, practitioner_name: "Dr Fictional",
  title: null, appointment_type: "telehealth", location: "Telehealth", telehealth_url: null, status: "confirmed", version: 1,
  starts_at: at(2), ends_at: at(2, 30) });

/* ---- the fictional world ---- */

const json = (status: number, payload: unknown) => new Response(status === 204 ? null : JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
let store: FictionalAppointmentStore;
/** The membership writer, against the same fence table the boundary reads. */
let membershipWriter: ReturnType<typeof createMembershipFenceWriter>;
let member: "current" | "revoked";
let onPosture: (() => Promise<void>) | null;
let afterFencedWrite: (() => Promise<void>) | null;
let onProvider: ((call: { method: string; url: string }) => Promise<void>) | null;
let recordTransfer: Record<string, unknown> | null;
let intentStatus: string;
let identityCalls: Array<{ path: string; selected: string[] }>;
let providerCalls: Array<{ method: string; url: string; body: unknown; idempotencyKey: string | null }>;
let intents: Map<string, Record<string, unknown>>;

async function revoke() {
  const change = await membershipWriter.begin([{ kind: "subject", subject: SUB }]);
  member = "revoked";
  await membershipWriter.settle(change);
}
function identity(url: URL, init?: RequestInit) {
  const headers = Object.entries((init?.headers ?? {}) as Record<string, string>);
  identityCalls.push({ path: url.pathname, selected: headers.filter(([key]) => key.toLowerCase() === HEADER).map(([, value]) => value) });
  // The identity API decides from current rows in its own transaction: a revoked membership is refused there.
  if (member === "revoked") return json(403, { error: "identity_refused" });
  const body = typeof init?.body === "string" ? JSON.parse(init.body) as { functionName?: string } : {};
  if (url.pathname === "/clinical-core/workforce/posture") {
    return json(200, { data: { identityPool: "workforce", membership: { organizationId: CLINIC, role: "practitioner", personId: PERSON } } });
  }
  if (url.pathname === "/clinical-core/workforce/consent-artifact") return json(200, { data: ARTIFACT });
  if (url.pathname === "/clinical-core/workforce/data-compatibility") {
    if (body.functionName === "list_my_organizations") return json(200, { data: [{ organization_id: CLINIC, role: "practitioner" }] });
    if (body.functionName === "get_desktop_calendar") return json(200, { data: { appointments: [calendarRow()], practitioners: [], patients: [] } });
    if (body.functionName === "get_telehealth_record_authority") return json(200, { data: { authorized: true, actor_person_id: PERSON,
      patient_record_id: PATIENT, legal_hold: false, transfer: recordTransfer,
      appointment: { id: APPOINTMENT, status: "completed", deleted: false, appointment_type: "telehealth", patient_matches: true, practitioner_person_id: PERSON } } });
  }
  throw new Error(`unrouted identity call ${url.pathname}`);
}
const meetingBody = (id: number) => ({ id, uuid: `uuid-${id}`, host_id: "zoom-host-id", type: 2, join_url: `https://zoom.us/j/${id}?pwd=FICTIONAL`,
  password: `real-password-${id}`, status: "waiting" });
function zoom(url: URL, method: string) {
  if (url.hostname === "zoom.us") return json(200, { access_token: "zoom-access" });
  const path = url.pathname;
  if (/^\/v2\/users\/[^/]+\/meetings$/.test(path)) return method === "POST" ? json(201, meetingBody(900000001)) : json(200, { meetings: [] });
  if (/^\/v2\/users\/[^/]+\/token$/.test(path)) return json(200, { token: "zak-token" });
  if (/^\/v2\/users\/[^/]+$/.test(path)) return json(200, { id: "zoom-host-id", account_id: "acct", email: "host@example.test", status: "active" });
  if (/\/status$/.test(path)) return json(204, {});
  if (/\/meeting_summary$/.test(path)) return json(200, { meeting_id: 900000001, meeting_uuid: "uuid-900000001", summary_content: "# Fictional visit" });
  if (method === "PATCH" || method === "DELETE") return json(204, {});
  return json(200, meetingBody(Number(/\/meetings\/(\d+)/.exec(path)?.[1] ?? "0")));
}
function stripe(url: URL, method: string, body: URLSearchParams) {
  const path = url.pathname;
  if (method === "POST" && path === "/v1/payment_intents") {
    const id = `pi_fictional_${intents.size + 1}`;
    const intent = { id, object: "payment_intent", livemode: false, status: intentStatus, amount: Number(body.get("amount")),
      amount_received: intentStatus === "succeeded" ? Number(body.get("amount")) : 0,
      metadata: { organization_id: body.get("metadata[organization_id]"), request_id: body.get("metadata[request_id]") } };
    intents.set(id, intent);
    return json(200, intent);
  }
  const intent = intents.get(/\/v1\/payment_intents\/([^/]+)/.exec(path)?.[1] ?? "");
  if (method === "GET" && intent) return json(200, intent);
  if (method === "POST" && intent && path.endsWith("/cancel")) { intent.status = "canceled"; return json(200, intent); }
  if (method === "POST" && path === "/v1/refunds") return json(200, { id: "re_fictional", object: "refund", livemode: false, status: "succeeded" });
  throw new Error(`unrouted stripe call ${method} ${path}`);
}

beforeEach(() => {
  store = new FictionalAppointmentStore();
  membershipWriter = createMembershipFenceWriter((command) => store.send(command as never), FENCE_TABLE);
  member = "current"; onPosture = null; afterFencedWrite = null; onProvider = null; recordTransfer = null; intentStatus = "succeeded";
  identityCalls = []; providerCalls = []; intents = new Map();
  send.mockReset(); secretsSend.mockReset(); sesSend.mockReset(); schedulerSend.mockReset();
  send.mockImplementation(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const result = await store.send(command);
    if (afterFencedWrite && command.constructor.name === "TransactWriteCommand" && fenceChecks(command.input).length > 0) {
      const hook = afterFencedWrite; afterFencedWrite = null; await hook();
    }
    return result;
  });
  secretsSend.mockImplementation(async (command: { input: { SecretId: string } }) => {
    if (!(command.input.SecretId in SECRETS)) throw new Error("fictional secret not found");
    return { SecretString: JSON.stringify(SECRETS[command.input.SecretId]) };
  });
  schedulerSend.mockResolvedValue({});
  sesSend.mockResolvedValue({ MessageId: "fictional" });
  vi.unstubAllGlobals();
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input), method = init?.method ?? "GET";
    if (url.origin === ORIGIN) {
      if (url.pathname === "/clinical-core/workforce/posture" && onPosture) { const hook = onPosture; onPosture = null; await hook(); }
      return identity(url, init);
    }
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    const call = { method, url: `${url.origin}${url.pathname}`, body: typeof init?.body === "string" ? init.body : null,
      idempotencyKey: headers.get("idempotency-key") };
    providerCalls.push(call);
    if (onProvider) await onProvider(call);
    if (url.hostname === "api.stripe.com") return stripe(url, method, new URLSearchParams(typeof init?.body === "string" ? init.body : ""));
    return zoom(url, method);
  }));
});

/* ---- observations ---- */

function event(routeKey: string, body?: Record<string, unknown>, query?: Record<string, string>) {
  return {
    routeKey,
    headers: { authorization: "Bearer fictional-workforce-token", [HEADER]: CLINIC, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined, queryStringParameters: query,
    requestContext: { authorizer: { jwt: { claims: { iss: ISSUER, aud: "workforce-client", token_use: "id", sub: SUB,
      email: "fictional.practitioner@example.test", email_verified: "true", exp: String(Math.floor(Date.now() / 1000) + 3600) } } } },
  } as never;
}
async function call(route: string, body?: Record<string, unknown>, query?: Record<string, string>) {
  const result = await createTelehealthHandler(config)(event(route, body, query));
  return { status: result.statusCode, body: JSON.parse(result.body ?? "{}") as Record<string, unknown> };
}
type Command = { constructor: { name: string }; input: Record<string, unknown> };
type FenceCheck = { ConditionCheck: { TableName: string; ConditionExpression: string; ExpressionAttributeValues?: Record<string, unknown> } };
const fenceChecks = (input: Record<string, unknown>) => ((input.TransactItems ?? []) as Array<Partial<FenceCheck>>)
  .filter((item): item is FenceCheck => item.ConditionCheck?.TableName === FENCE_TABLE);
const tableCommands = () => (send.mock.calls as Array<[Command]>).map(([command]) => command);
const tableWrites = () => tableCommands().filter((command) => !["GetCommand", "QueryCommand"].includes(command.constructor.name));
/** The appointment rows, without the fence items. */
const rows = () => [...store.rows.entries()].filter(([key]) => !key.endsWith("|MEMBERSHIP_FENCE"))
  .map(([key, row]) => [key, structuredClone(row)] as const).sort(([a], [b]) => a.localeCompare(b));
/** Calls that create, move, charge, schedule or send. Ending a meeting, deleting one or refunding is not among them. */
const granting = () => [
  ...providerCalls.filter((entry) => (entry.method === "POST" && /\/users\/[^/]+\/meetings$/.test(entry.url)) || entry.method === "PATCH"
    || (entry.method === "POST" && entry.url.endsWith("/v1/payment_intents"))).map((entry) => `${entry.method} ${entry.url}`),
  ...(schedulerSend.mock.calls as Array<[Command]>).filter(([command]) => command.constructor.name === "CreateScheduleCommand").map(() => "CreateSchedule"),
  ...sesSend.mock.calls.map(() => "SendEmail"),
];
const requestRow = () => store.get({ pk: `ORG#${CLINIC}`, sk: `REQ#2026-09-01T00:00:00.000Z#${REQUEST}` }) as Record<string, unknown>;
const operationRows = () => [...store.rows.values()].filter((row) => String(row.sk).startsWith(`REQOP#${REQUEST}#`));
const visitRow = () => store.get({ pk: `ORG#${CLINIC}`, sk: `VISIT#${APPOINTMENT}` }) as Record<string, unknown>;
const reminderNames = (generation: string) => ["24h", "1h"].map((offset) =>
  `alp-${REQUEST.replaceAll("-", "")}-${Buffer.from(generation.replaceAll("-", ""), "hex").toString("base64url")}-${offset}`);
const schedulerLog = () => (schedulerSend.mock.calls as Array<[Command]>).map(([command]) =>
  `${command.constructor.name === "CreateScheduleCommand" ? "create" : "delete"} ${String(command.input.Name)}`);

/** The ordinary source digest of a signed visit, read the way Desktop reads it. */
async function transferSource() {
  const read = await call("GET /clinical-core/workforce/appointments/visits/notes", undefined, { appointmentId: APPOINTMENT });
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  return (read.body.data as { chartTransferSource: { sourceRevision: number; sourceDigest: string } }).chartTransferSource;
}

/** Each of the 11 writes, with the fictional state it needs and its ordinary success answer. */
type WriteCase = { name: string; route: string; seed: () => Promise<Record<string, unknown>>; ok: number; writes: "one" | "several" };
const CASES: WriteCase[] = [
  { name: "schedule a requested visit", route: ROUTES.action, ok: 200, writes: "several", seed: async () => {
    store.seed(request());
    return { requestId: REQUEST, action: "schedule", expectedVersion: 2, scheduledStart: at(3), scheduledEnd: at(3, 30), timeZone: "America/Los_Angeles" };
  } },
  { name: "publish a slot", route: ROUTES.slot, ok: 201, writes: "one", seed: async () => ({ start: at(4), end: at(4, 30), timeZone: "America/Los_Angeles",
    visitTypes: ["follow_up"], priceMinor: 0, currency: "USD", cancellationPolicy: "Cancel 24 hours ahead.", cancellationWindowHours: 24 }) },
  { name: "charge a delivered visit", route: ROUTES.payment, ok: 200, writes: "several", seed: async () => {
    store.seed(request({ status: "scheduled" }), paymentProfile());
    return { requestId: REQUEST, action: "charge", expectedVersion: 2, amountMinor: 15000, serviceDelivered: true };
  } },
  { name: "record a consent", route: ROUTES.consent, ok: 200, writes: "one", seed: async () => ({ appointmentId: APPOINTMENT,
    artifactId: ARTIFACT.artifactId, artifactVersion: ARTIFACT.artifactVersion, contentSha256: ARTIFACT.contentSha256,
    signerName: "Fictional Signer", agreed: true }) },
  { name: "withdraw a consent", route: ROUTES.withdraw, ok: 200, writes: "one", seed: async () => {
    store.seed(visit());
    return { appointmentId: APPOINTMENT, expectedVersion: 1 };
  } },
  { name: "start a visit", route: ROUTES.start, ok: 200, writes: "several", seed: async () => {
    store.seed(visit());
    return { appointmentId: APPOINTMENT, hostDisplayName: "Dr Fictional" };
  } },
  { name: "end a visit", route: ROUTES.end, ok: 200, writes: "several", seed: async () => {
    store.seed(visit({ status: "in_visit", ...MEETING, startedAt: at(0), version: 3 }));
    return { appointmentId: APPOINTMENT, expectedVersion: 3 };
  } },
  { name: "import the AI note", route: ROUTES.import, ok: 200, writes: "one", seed: async () => {
    store.seed(visit({ status: "ended", ...MEETING, endedAt: at(0), version: 4 }));
    return { appointmentId: APPOINTMENT };
  } },
  { name: "sign the note", route: ROUTES.sign, ok: 200, writes: "one", seed: async () => {
    store.seed(visit({ status: "ended", ...MEETING, endedAt: at(0), note: draftNote(), version: 5 }));
    return { appointmentId: APPOINTMENT, expectedVersion: 5, practitionerNotes: "Fictional practitioner text.", aiSections: sections,
      actionItems: [{ id: "a1", status: "approved" }] };
  } },
  { name: "admit a chart transfer", route: ROUTES.transfer, ok: 200, writes: "one", seed: async () => {
    store.seed(visit({ status: "ended", ...MEETING, endedAt: at(0), note: signedNote(), version: 6 }));
    return { appointmentId: APPOINTMENT, ...await transferSource() };
  } },
  { name: "complete a chart transfer", route: ROUTES.complete, ok: 200, writes: "one", seed: async () => {
    store.seed(visit({ status: "ended", ...MEETING, endedAt: at(0), note: signedNote(), version: 6 }));
    const source = await transferSource();
    store.seed(visit({ status: "ended", ...MEETING, endedAt: at(0), note: signedNote(), version: 7, chartTransfer: { transferId: TRANSFER, state: "admitted",
      ...source, admittedAt: at(0), admittedBy: PERSON, encounterId: null, noteId: null, noteVersion: null, contentSha256: null, transferredAt: null, completedAt: null } }));
    recordTransfer = { transfer_id: TRANSFER, encounter_id: "eeeeeeee-1111-4111-8111-111111111111", note_id: "aaaaaaaa-2222-4222-8222-222222222222",
      note_version: 1, source_note_revision: source.sourceRevision, source_digest: source.sourceDigest, content_sha256: "c".repeat(64),
      transferred_at: at(0), transferred_by_person_id: PERSON, note_status: "draft", note_current_version: 1, note_deleted: false };
    return { appointmentId: APPOINTMENT };
  } },
];
/** Seed, then forget everything the seeding itself did. */
async function prepared(write: WriteCase) {
  const body = await write.seed();
  identityCalls = []; providerCalls = []; send.mockClear(); schedulerSend.mockClear(); sesSend.mockClear();
  return body;
}

describe("the membership fence covers every telehealth write", () => {
  it("names exactly the 11 writes the handler serves", () => {
    expect(CASES.map((write) => write.route).sort()).toEqual([...TELEHEALTH_WORKFORCE_WRITE_ROUTES].sort());
  });

  it.each(CASES)("$name: runs under current membership, with every table write held to both fences", async (write) => {
    const answered = await call(write.route, await prepared(write));
    expect(answered.status, JSON.stringify(answered.body)).toBe(write.ok);
    // The fences are read first, then current membership, for the selected clinic only.
    const [first, second] = tableCommands();
    expect([first, second].map((command) => [command?.constructor.name, command?.input.TableName])).toEqual([["GetCommand", FENCE_TABLE], ["GetCommand", FENCE_TABLE]]);
    expect([first, second].map((command) => (command!.input.Key as { pk: string }).pk).sort())
      .toEqual([membershipFenceKey({ kind: "clinic", organizationId: CLINIC }).pk, membershipFenceKey({ kind: "subject", subject: SUB }).pk].sort());
    expect(identityCalls[0]?.path).toBe("/clinical-core/workforce/posture");
    expect(identityCalls.every((entry) => entry.selected.length === 1 && entry.selected[0] === CLINIC)).toBe(true);
    // Every write is one transaction holding both fence conditions, except closing this invocation's own writer.
    const writes = tableWrites();
    expect(writes.length).toBeGreaterThan(0);
    for (const command of writes) {
      const closing = command.constructor.name === "UpdateCommand" && String(command.input.UpdateExpression).startsWith("SET writerStatus=:closed");
      if (closing) continue;
      expect(command.constructor.name).toBe("TransactWriteCommand");
      expect(fenceChecks(command.input).map((check) => check.ConditionCheck.ConditionExpression))
        .toEqual(["attribute_not_exists(pk)", "attribute_not_exists(pk)"]);
    }
  });
});

describe("revocation before admission", () => {
  it.each(CASES)("$name: a revocation that completed first is refused by current membership, before any write", async (write) => {
    const body = await prepared(write);
    await revoke();
    const before = rows();
    expect(await call(write.route, body)).toEqual({ status: 403, body: { error: "identity_refused" } });
    expect(identityCalls.map((entry) => entry.path)).toEqual(["/clinical-core/workforce/posture"]);
    expect(tableWrites()).toEqual([]);
    expect(rows()).toEqual(before);
    expect(providerCalls).toEqual([]);
  });

  it.each(CASES)("$name: a revocation still in flight is refused from the fence alone, before even the membership read", async (write) => {
    const body = await prepared(write);
    const inFlight = await membershipWriter.begin([{ kind: "subject", subject: SUB }]);
    const before = rows();
    expect(await call(write.route, body)).toEqual({ status: 409, body: { error: "membership_changed" } });
    expect(identityCalls).toEqual([]);
    expect(tableWrites()).toEqual([]);
    expect(rows()).toEqual(before);
    expect(providerCalls).toEqual([]);
    await membershipWriter.settle(inFlight);
  });

  it.each(CASES)("$name: a revocation that begins after the fence read, while current rows still read current, commits nothing", async (write) => {
    const body = await prepared(write);
    // The writer moves the fence; the database change has not committed yet, so the membership read still says current.
    let inFlight: MembershipFenceChange | null = null;
    onPosture = async () => { inFlight = await membershipWriter.begin([{ kind: "subject", subject: SUB }]); };
    const before = rows();
    expect(await call(write.route, body)).toEqual({ status: 409, body: { error: "membership_changed" } });
    expect(rows()).toEqual(before);
    expect(granting()).toEqual([]);
    // Then the revocation commits and settles: the next attempt is refused by current membership.
    member = "revoked";
    await membershipWriter.settle(inFlight!);
    expect((await call(write.route, body)).status).toBe(403);
  });
});

describe("revocation after admission", () => {
  it.each(CASES)("$name: a revocation right after the first write commits stops every later write and provider grant", async (write) => {
    const body = await prepared(write);
    afterFencedWrite = async () => { await revoke(); };
    const answered = await call(write.route, body);
    if (write.writes === "one") {
      // The one write committed before the revocation began: it stands, as any write ordered before a revocation does.
      expect(answered.status, JSON.stringify(answered.body)).toBe(write.ok);
    } else {
      expect(answered).toEqual({ status: 409, body: { error: "membership_changed" } });
      // Nothing that creates, moves, charges, schedules or sends ran after the membership changed.
      expect(granting()).toEqual([]);
    }
    expect((await call(write.route, body)).status).toBe(403);
  });

  it("schedule: the meeting a revoked caller's operation created is deleted before the appointment is released", async () => {
    store.seed(request());
    onProvider = async (entry) => { if (entry.method === "POST" && /\/users\/[^/]+\/meetings$/.test(entry.url)) { onProvider = null; await revoke(); } };
    const answered = await call(ROUTES.action, { requestId: REQUEST, action: "schedule", expectedVersion: 2, scheduledStart: at(3), scheduledEnd: at(3, 30), timeZone: "America/Los_Angeles" });
    expect(answered).toEqual({ status: 409, body: { error: "membership_changed" } });
    expect(providerCalls.filter((entry) => entry.method === "DELETE").map((entry) => entry.url)).toEqual(["https://api.zoom.us/v2/meetings/900000001"]);
    // Reminders never reached the scheduler: their dispatch mark was itself fenced.
    expect(schedulerSend).not.toHaveBeenCalled();
    expect(sesSend).not.toHaveBeenCalled();
    // The appointment is exactly as it was, unlocked, and the operation is a compensated refusal.
    expect(requestRow()).toEqual(request());
    expect(operationRows()).toEqual([expect.objectContaining({ phase: "refused", refusal: "membership_changed", sideEffects: "compensated",
      dispositionProtocol: "appointment-disposition/1", committedVersion: 2, writerStatus: "closed", actorPersonId: PERSON, actorSubject: SUB })]);
  });

  it("reschedule: the moved meeting goes back to its recorded time and the replaced reminders come back, newest undo first", async () => {
    const recorded = request({ status: "scheduled", appointmentId: APPOINTMENT, scheduledStart: at(2), scheduledEnd: at(2, 30), providerMeetingId: MEETING.providerMeetingId,
      joinUrl: MEETING.joinUrl, reminderStatus: "scheduled", reminderGeneration: PREVIOUS_GENERATION, version: 3 });
    store.seed(recorded);
    let creates = 0;
    schedulerSend.mockImplementation(async (command: Command) => {
      if (command.constructor.name === "CreateScheduleCommand" && ++creates === 1) await revoke();
      return {};
    });
    const answered = await call(ROUTES.action, { requestId: REQUEST, action: "reschedule", expectedVersion: 3, scheduledStart: at(5), scheduledEnd: at(5, 45), timeZone: "America/New_York" });
    expect(answered).toEqual({ status: 409, body: { error: "membership_changed" } });
    const created = (schedulerSend.mock.calls as Array<[Command]>).filter(([command]) => command.constructor.name === "CreateScheduleCommand")
      .slice(0, 2).map(([command]) => String(command.input.Name));
    expect(created).not.toEqual(reminderNames(PREVIOUS_GENERATION));
    expect(schedulerLog()).toEqual([
      ...reminderNames(PREVIOUS_GENERATION).map((name) => `delete ${name}`), ...created.map((name) => `create ${name}`),
      ...created.map((name) => `delete ${name}`), ...reminderNames(PREVIOUS_GENERATION).map((name) => `create ${name}`),
    ]);
    const restoredTokens = (schedulerSend.mock.calls as Array<[Command]>).slice(-2).map(([command]) => command.input.ClientToken);
    const originalTokens = (schedulerSend.mock.calls as Array<[Command]>).slice(2, 4).map(([command]) => command.input.ClientToken);
    expect(restoredTokens.some((token) => originalTokens.includes(token))).toBe(false);
    const patches = providerCalls.filter((entry) => entry.method === "PATCH").map((entry) => JSON.parse(String(entry.body)) as Record<string, unknown>);
    expect(patches).toEqual([
      expect.objectContaining({ start_time: at(5), duration: 45, timezone: "America/New_York" }),
      expect.objectContaining({ start_time: at(2), duration: 30, timezone: "America/Los_Angeles" }),
    ]);
    expect(requestRow()).toEqual(recorded);
    expect(operationRows()).toEqual([expect.objectContaining({ phase: "refused", refusal: "membership_changed", sideEffects: "compensated" })]);
  });

  it("charge: a charge that succeeded is refunded in full under a fixed key; one Stripe can still cancel is cancelled", async () => {
    for (const status of ["succeeded", "requires_action"]) {
      store = new FictionalAppointmentStore().seed(request({ status: "scheduled" }), paymentProfile());
      membershipWriter = createMembershipFenceWriter((command) => store.send(command as never), FENCE_TABLE);
      member = "current"; providerCalls = []; intents = new Map(); intentStatus = status;
      onProvider = async (entry) => { if (entry.url.endsWith("/v1/payment_intents")) { onProvider = null; await revoke(); } };
      const answered = await call(ROUTES.payment, { requestId: REQUEST, action: "charge", expectedVersion: 2, amountMinor: 15000, serviceDelivered: true });
      expect(answered, status).toEqual({ status: 409, body: { error: "membership_changed" } });
      const stripeWrites = providerCalls.filter((entry) => entry.method === "POST" && entry.url.startsWith("https://api.stripe.com"));
      const operationId = String(operationRows()[0]!.operationId);
      expect(stripeWrites.map((entry) => [entry.url.replace("https://api.stripe.com", ""), entry.idempotencyKey]), status).toEqual(status === "succeeded" ? [
        ["/v1/payment_intents", `telehealth-charge:${REQUEST}:${operationId}`],
        ["/v1/refunds", `telehealth-compensate-refund:${REQUEST}:${operationId}`],
      ] : [
        ["/v1/payment_intents", `telehealth-charge:${REQUEST}:${operationId}`],
        ["/v1/payment_intents/pi_fictional_1/cancel", `telehealth-compensate-cancel:${REQUEST}:${operationId}`],
      ]);
      if (status === "succeeded") expect(new URLSearchParams(String(stripeWrites[1]!.body)).get("amount")).toBe("15000");
      expect(requestRow(), status).toEqual(request({ status: "scheduled" }));
      expect(operationRows(), status).toEqual([expect.objectContaining({ phase: "refused", refusal: "membership_changed", sideEffects: "compensated" })]);
    }
  });

  it("charge: a charge Stripe cannot reverse yet keeps the appointment pending instead of claiming it was undone", async () => {
    store.seed(request({ status: "scheduled" }), paymentProfile());
    intentStatus = "processing";
    onProvider = async (entry) => { if (entry.url.endsWith("/v1/payment_intents")) { onProvider = null; await revoke(); } };
    expect(await call(ROUTES.payment, { requestId: REQUEST, action: "charge", expectedVersion: 2, amountMinor: 15000, serviceDelivered: true }))
      .toEqual({ status: 409, body: { error: "membership_changed" } });
    expect(providerCalls.filter((entry) => entry.url.endsWith("/v1/refunds") || entry.url.endsWith("/cancel"))).toEqual([]);
    expect(requestRow().mutationOperationId).toBe(operationRows()[0]!.operationId);
    expect(operationRows()).toEqual([expect.objectContaining({ phase: "effects_started", writerStatus: "closed" })]);
    // A current member's retry of the same operation sees it pending; nothing is charged again.
    member = "current";
    expect(await call(ROUTES.payment, { requestId: REQUEST, action: "charge", expectedVersion: 2, amountMinor: 15000, serviceDelivered: true }))
      .toEqual({ status: 503, body: { error: "appointment_change_pending" } });
    expect(providerCalls.filter((entry) => entry.url.endsWith("/v1/payment_intents"))).toHaveLength(1);
  });

  it("start: a meeting created under a membership that then changed is deleted, and no session leaves", async () => {
    store.seed(visit());
    onProvider = async (entry) => { if (entry.method === "POST" && /\/users\/[^/]+\/meetings$/.test(entry.url)) { onProvider = null; await revoke(); } };
    const answered = await call(ROUTES.start, { appointmentId: APPOINTMENT, hostDisplayName: "Dr Fictional" });
    expect(answered).toEqual({ status: 409, body: { error: "membership_changed" } });
    expect(JSON.stringify(answered.body)).not.toContain("signature");
    expect(providerCalls.filter((entry) => entry.method === "DELETE").map((entry) => entry.url)).toEqual(["https://api.zoom.us/v2/meetings/900000001"]);
    // No host token was fetched for a session.
    expect(providerCalls.some((entry) => /\/users\/[^/]+\/token$/.test(entry.url))).toBe(false);
    expect(visitRow()).toMatchObject({ status: "scheduled", providerMeetingId: null, passcode: null });
  });
});

describe("retry and idempotency", () => {
  it("retrying the refused operation answers the same refusal and charges nothing; a new operation charges once", async () => {
    store.seed(request({ status: "scheduled" }), paymentProfile());
    onProvider = async (entry) => { if (entry.url.endsWith("/v1/payment_intents")) { onProvider = null; await revoke(); } };
    const charge = { requestId: REQUEST, action: "charge", expectedVersion: 2, amountMinor: 15000, serviceDelivered: true };
    expect((await call(ROUTES.payment, charge)).status).toBe(409);
    // While revoked, current membership refuses any retry first.
    expect(await call(ROUTES.payment, charge)).toEqual({ status: 403, body: { error: "identity_refused" } });
    // Membership is restored. The same operation is still the same refusal: no second charge, no second refund.
    member = "current";
    expect(await call(ROUTES.payment, charge)).toEqual({ status: 409, body: { error: "membership_changed" } });
    expect(providerCalls.filter((entry) => entry.url.endsWith("/v1/payment_intents"))).toHaveLength(1);
    expect(providerCalls.filter((entry) => entry.url.endsWith("/v1/refunds"))).toHaveLength(1);
    // A deliberately new operation is admitted on its own and charges exactly once.
    const fresh = await call(ROUTES.payment, { ...charge, operationId: "5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e", operationProtocol: "appointment-change/1" });
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
    expect(providerCalls.filter((entry) => entry.url.endsWith("/v1/payment_intents"))).toHaveLength(2);
    expect(requestRow()).toMatchObject({ paymentStatus: "processing", paymentIntentId: "pi_fictional_2", version: 3 });
    expect(requestRow().mutationOperationId).toBeUndefined();
  });

  it("a change that never settled keeps every write refused until it is settled", async () => {
    const stuck = await membershipWriter.begin([{ kind: "subject", subject: SUB }]);
    const slot = await prepared(CASES[1]!);
    for (let attempt = 0; attempt < 3; attempt += 1) expect((await call(ROUTES.slot, slot)).status).toBe(409);
    expect(tableWrites()).toEqual([]);
    await membershipWriter.settle(stuck);
    expect((await call(ROUTES.slot, slot)).status).toBe(201);
  });

  it("a change to the clinic's own row fences the clinic's writes the same way", async () => {
    const slot = await prepared(CASES[1]!);
    const inFlight = await membershipWriter.begin([{ kind: "clinic", organizationId: CLINIC }]);
    expect(await call(ROUTES.slot, slot)).toEqual({ status: 409, body: { error: "membership_changed" } });
    await membershipWriter.settle(inFlight);
    expect((await call(ROUTES.slot, slot)).status).toBe(201);
    // The slot write held the clinic fence at the version it read, not merely its absence.
    const held = fenceChecks(tableWrites().at(-1)!.input);
    expect(held.map((check) => check.ConditionCheck.ExpressionAttributeValues ?? null)).toContainEqual({ ":fenceProtocol": MEMBERSHIP_FENCE_PROTOCOL, ":fenceVersion": 2 });
  });

  it("refuses a fence item that is not a membership-fence/1 fence rather than reading it as settled", async () => {
    const slot = await prepared(CASES[1]!);
    store.seed({ ...membershipFenceKey({ kind: "subject", subject: SUB }), fenceProtocol: "something-else", fenceVersion: 1 });
    expect(await call(ROUTES.slot, slot)).toEqual({ status: 503, body: { error: "service_unavailable" } });
    expect(identityCalls).toEqual([]);
    expect(tableWrites()).toEqual([]);
  });

  it("refuses a posture that cannot name the person, and one for another clinic or a non-clinical role", async () => {
    const slot = await prepared(CASES[1]!);
    const cases: Array<[Record<string, unknown>, number]> = [
      [{ organizationId: CLINIC, role: "practitioner" }, 503],
      [{ organizationId: "8e1d2c3b-4a5f-4e6d-8c7b-9a0f1e2d3c4b", role: "practitioner", personId: PERSON }, 403],
      [{ organizationId: CLINIC, role: "member", personId: PERSON }, 403],
    ];
    for (const [membership, status] of cases) {
      vi.mocked(fetch).mockImplementationOnce(async () => json(200, { data: { membership } }));
      expect((await call(ROUTES.slot, slot)).status, JSON.stringify(membership)).toBe(status);
    }
    expect(tableWrites()).toEqual([]);
  });
});

describe("configuration", () => {
  it("accepts a fence table only for database_current, as a table of its own", () => {
    const { workforceAuthority: _authority, membershipFenceTable: _table, ...legacy } = config;
    expect(() => createTelehealthHandler({ ...legacy, runtimeMode: "synthetic", phiAllowed: false, membershipFenceTable: FENCE_TABLE })).toThrow("telehealth_configuration_invalid");
    expect(() => createTelehealthHandler({ ...config, workforceAuthority: "legacy_claims" })).toThrow("telehealth_configuration_invalid");
    expect(() => createTelehealthHandler({ ...config, membershipFenceTable: TABLE })).toThrow("telehealth_configuration_invalid");
    expect(() => createTelehealthHandler({ ...config, membershipFenceTable: "a b" })).toThrow("telehealth_configuration_invalid");
    expect(() => createTelehealthHandler(config)).not.toThrow();
  });

  it("without the fence table every write stays refused before any call, as before", async () => {
    const { membershipFenceTable: _table, ...unfenced } = config;
    for (const route of TELEHEALTH_WORKFORCE_WRITE_ROUTES) {
      const result = await createTelehealthHandler(unfenced)(event(route, { appointmentId: APPOINTMENT }));
      expect(JSON.parse(result.body ?? "{}"), route).toEqual({ error: "membership_fence_unavailable" });
    }
    expect(identityCalls).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("the deployed Lambda entry sets no fence table, so nothing is enabled by this change", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of ["aws-telehealth-requests-lambda.ts", "telehealth-lambda-environment.ts"]) {
      expect(readFileSync(new URL(`./${file}`, import.meta.url), "utf8"), file).not.toMatch(/membershipFence/);
    }
  });
});
