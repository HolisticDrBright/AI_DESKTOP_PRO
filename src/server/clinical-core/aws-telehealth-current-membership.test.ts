import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The telehealth boundary under the `database_current` workforce authority. DynamoDB, Secrets Manager, SES and the
// scheduler are faked at the SDK; the identity API is faked at `fetch`. Every identifier is fictional.
const { send, secretsSend, sesSend } = vi.hoisted(() => ({ send: vi.fn(), secretsSend: vi.fn(), sesSend: vi.fn() }));
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
  SchedulerClient: class SchedulerClient { send = vi.fn(); },
  CreateScheduleCommand: class CreateScheduleCommand { constructor(readonly input: unknown) {} },
  DeleteScheduleCommand: class DeleteScheduleCommand { constructor(readonly input: unknown) {} },
  GetScheduleCommand: class GetScheduleCommand { constructor(readonly input: unknown) {} },
}));

import { createTelehealthHandler, TELEHEALTH_WORKFORCE_READ_ROUTES, TELEHEALTH_WORKFORCE_WRITE_ROUTES,
  type TelehealthConfiguration } from "./aws-telehealth-requests";

const HEADER = "x-alp-selected-organization-id";
const CLINIC = "2b7c9e2a-4a51-4c1e-9d3f-6f0a1b2c3d4e";
const OTHER_CLINIC = "8e1d2c3b-4a5f-4e6d-8c7b-9a0f1e2d3c4b";
/** The stale clinic a legacy custom claim still names. It must never choose anything under database_current. */
const CLAIM_CLINIC = "22222222-2222-4222-8222-222222222222";
const SUB = "5d0e6b8a-3c2f-4b1e-8a9d-7e6f5a4b3c2d";
const APPOINTMENT = "77777777-7777-4777-8777-777777777777";
const PATIENT = "66666666-6666-4666-8666-666666666666";

const legacy: TelehealthConfiguration = {
  tableName: "fictional-appointments",
  consumerIssuer: "https://cognito-idp.us-east-2.amazonaws.com/us-east-2_consumer", consumerAudience: "consumer-client",
  workforceIssuer: "https://cognito-idp.us-east-2.amazonaws.com/us-east-2_workforce", workforceAudience: "workforce-client",
  runtimeMode: "synthetic", phiAllowed: false, zoomEnabled: false, zoomBaaVerified: false, zoomSecretArn: "",
  remindersEnabled: false, reminderSender: "", reminderConfigurationSet: "", reminderScheduleGroup: "", reminderSchedulerRoleArn: "",
  reminderTargetArn: "", reminderEventsTopicArn: "", stripeTestEnabled: false, stripeSecretArn: "", stripeSuccessUrl: "", stripeCancelUrl: "",
  identityApiOrigin: "https://abcdefghij.execute-api.us-east-2.amazonaws.com", chartAdmissionSecretArn: "",
};
/** A production-shaped handler built only inside this test. Nothing here activates PHI in any deployed Lambda. */
const current: TelehealthConfiguration = { ...legacy, runtimeMode: "production", phiAllowed: true, workforceAuthority: "database_current" };

const liveClaims = (overrides: Record<string, string> = {}) => ({
  iss: legacy.workforceIssuer, aud: legacy.workforceAudience, token_use: "id", sub: SUB, email_verified: "true",
  exp: String(Math.floor(Date.now() / 1000) + 3600),
  // Legacy custom claims a pre-successor token still carries. database_current ignores all of them.
  "custom:organization_id": CLAIM_CLINIC, "custom:person_id": "11111111-1111-4111-8111-111111111111", "custom:production_bound": "true",
  ...overrides,
});
type Header = [string, string];
function event(routeKey: string, options: { body?: unknown; query?: Record<string, string>; claims?: Record<string, string>; selection?: Header[] } = {}) {
  const selection = options.selection ?? [[HEADER, CLINIC]];
  return {
    routeKey,
    headers: { authorization: "Bearer fictional-workforce-token", ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...Object.fromEntries(selection) },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    queryStringParameters: options.query,
    requestContext: { authorizer: { jwt: { claims: options.claims ?? liveClaims() } } },
  } as never;
}

const ARTIFACT = { artifactId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", scope: "telehealth_recording", artifactVersion: "telehealth-recording/1",
  contentSha256: "b".repeat(64), jurisdiction: "US-CA", approvedAt: "2026-10-01T00:00:00.000Z" };
const receipt = (overrides: Record<string, unknown> = {}) => ({ consentId: "88888888-8888-4888-8888-888888888888", consentType: "telehealth_recording_combined",
  scope: "telehealth_recording", artifactId: ARTIFACT.artifactId, artifactVersion: ARTIFACT.artifactVersion, contentSha256: ARTIFACT.contentSha256,
  signerName: "Fictional Signer", method: "staff_attested", representativeAuthority: "self", signedAt: "2026-10-01T00:00:00.000Z",
  recordedBy: "fictional-recorder", patientLocation: "CA", grantId: null, connectionId: null, status: "granted", withdrawnAt: null, withdrawnBy: null,
  withdrawalReason: null, ...overrides });
const visitRecord = (overrides: Record<string, unknown> = {}) => ({
  pk: `ORG#${CLINIC}`, sk: `VISIT#${APPOINTMENT}`, appointmentId: APPOINTMENT, organizationId: CLINIC, requestId: null, consumerPersonId: null,
  patientRecordId: PATIENT, practitionerUserId: null, scheduledStart: "2026-10-09T17:00:00.000Z", scheduledEnd: "2026-10-09T17:30:00.000Z",
  timeZone: "America/Los_Angeles", status: "scheduled", consents: [receipt()], meetingLease: null, providerMeetingId: null, providerMeetingUuid: null,
  joinUrl: null, passcode: null, startedAt: null, endedAt: null, providerShutdown: { status: "not_started", attemptedAt: null, confirmedAt: null, detail: null },
  flags: [], quickNotes: "", note: null, noteHistory: [], version: 1, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
});
const calendarRow = { id: APPOINTMENT, patient_id: PATIENT, practitioner_user_id: null, appointment_type: "telehealth", status: "confirmed",
  starts_at: "2026-10-09T17:00:00.000Z", ends_at: "2026-10-09T17:30:00.000Z" };

/** What the current-membership identity API answers for this subject and the clinic the request selected. */
type Membership = "current" | "none" | "suspended" | "wrong_clinic_refused" | "wrong_clinic_listed" | "demoted" | "outage";
type IdentityCall = { url: string; method: string; selected: string[]; body: Record<string, unknown> | null };
let membership: Membership;
let recordAuthorized: boolean;
let visit: Record<string, unknown>;
let identityCalls: IdentityCall[];
let onAuthorityRead: (() => void) | null;
const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
function identityApi(url: string, init?: RequestInit) {
  const headers = Object.entries((init?.headers ?? {}) as Record<string, string>);
  const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
  identityCalls.push({ url, method: init?.method ?? "GET", selected: headers.filter(([key]) => key.toLowerCase() === HEADER).map(([, value]) => value), body });
  if (membership === "outage") return json(503, { error: "database_unavailable" });
  // Under database_current the API resolves membership from current rows for the selected clinic: a suspended or
  // revoked membership, or a clinic this person was never in, is refused there; the wire cannot tell them apart.
  if (["none", "suspended", "wrong_clinic_refused"].includes(membership)) return json(403, { error: "identity_refused" });
  if (body?.functionName === "list_my_organizations") {
    const answer = json(200, { data: membership === "wrong_clinic_listed" ? [{ organization_id: OTHER_CLINIC, role: "practitioner" }]
      : [{ organization_id: CLINIC, role: membership === "demoted" ? "member" : "practitioner" }] });
    onAuthorityRead?.();
    return answer;
  }
  if (body?.functionName === "get_desktop_calendar") return json(200, { data: { appointments: [calendarRow], practitioners: [], patients: [] } });
  if (body?.functionName === "get_telehealth_record_authority") {
    return recordAuthorized ? json(200, { data: { authorized: true, actor_person_id: "fictional", patient_record_id: PATIENT, legal_hold: false, appointment: null, transfer: null } })
      : json(403, { error: "operation_refused" });
  }
  if (url.includes("/consent-artifact")) return json(200, { data: ARTIFACT });
  throw new Error(`unrouted identity call ${url}`);
}
type DynamoCall = { kind: string; input: Record<string, unknown> };
let dynamo: DynamoCall[];
const writes = () => dynamo.filter((call) => !["GetCommand", "QueryCommand"].includes(call.kind));

beforeEach(() => {
  membership = "current"; recordAuthorized = true; visit = visitRecord(); identityCalls = []; dynamo = []; onAuthorityRead = null;
  send.mockReset(); secretsSend.mockReset(); sesSend.mockReset();
  send.mockImplementation(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    dynamo.push({ kind: command.constructor.name, input: command.input });
    if (command.constructor.name === "GetCommand") return { Item: visit };
    if (command.constructor.name === "QueryCommand") {
      const values = command.input.ExpressionAttributeValues as Record<string, unknown>;
      return { Items: values[":visit"] === "VISIT#" ? [visit] : [] };
    }
    return {};
  });
  vi.unstubAllGlobals();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => identityApi(url, init)));
});

const READS: Array<[route: string, query?: Record<string, string>]> = [
  ["GET /clinical-core/workforce/appointments/requests"],
  ["GET /clinical-core/workforce/appointments/slots"],
  ["GET /clinical-core/workforce/appointments/visits"],
  ["GET /clinical-core/workforce/appointments/visits/consent-artifact"],
  ["GET /clinical-core/workforce/appointments/visits/notes", { appointmentId: APPOINTMENT }],
  ["GET /clinical-core/workforce/appointments/visits/notes/inventory", { appointmentId: APPOINTMENT }],
];
const WRITES = [
  "POST /clinical-core/workforce/appointments/actions",
  "POST /clinical-core/workforce/appointments/slots",
  "POST /clinical-core/workforce/appointments/payments",
  "POST /clinical-core/workforce/appointments/visits/consent",
  "POST /clinical-core/workforce/appointments/visits/consent/withdraw",
  "POST /clinical-core/workforce/appointments/visits/start",
  "POST /clinical-core/workforce/appointments/visits/end",
  "POST /clinical-core/workforce/appointments/visits/notes/import",
  "POST /clinical-core/workforce/appointments/visits/notes/sign",
  "POST /clinical-core/workforce/appointments/visits/notes/transfer",
  "POST /clinical-core/workforce/appointments/visits/notes/transfer/complete",
];
const futureSlot = () => ({ start: new Date(Date.now() + 2 * 86_400_000).toISOString(), end: new Date(Date.now() + 2 * 86_400_000 + 1_800_000).toISOString(),
  timeZone: "America/Los_Angeles", visitTypes: ["follow_up"], priceMinor: 0, currency: "USD", cancellationPolicy: "Cancel 24 hours ahead.", cancellationWindowHours: 24 });
const status = async (result: Promise<{ statusCode: number; body?: string }>) => {
  const settled = await result; return { status: settled.statusCode, body: JSON.parse(settled.body ?? "{}") as Record<string, unknown> };
};

describe("telehealth workforce routes under database_current", () => {
  it("classifies every workforce route the handler serves as a fenced read or a disabled write", () => {
    const source = readFileSync(new URL("./aws-telehealth-requests.ts", import.meta.url), "utf8");
    const declared = [...source.matchAll(/"((?:GET|POST) \/clinical-core\/workforce\/[^"]+)"/g)].map((match) => match[1]!);
    expect([...TELEHEALTH_WORKFORCE_READ_ROUTES, ...TELEHEALTH_WORKFORCE_WRITE_ROUTES].sort()).toEqual([...new Set(declared)].sort());
    expect([...TELEHEALTH_WORKFORCE_READ_ROUTES].sort()).toEqual(READS.map(([route]) => route).sort());
    expect([...TELEHEALTH_WORKFORCE_WRITE_ROUTES].sort()).toEqual([...WRITES].sort());
  });

  it.each(READS)("%s checks current membership first and asks the identity API for exactly the selected clinic", async (route, query) => {
    const result = await status(createTelehealthHandler(current)(event(route, { query })));
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(identityCalls[0]?.body).toEqual({ kind: "rpc", functionName: "list_my_organizations", args: {} });
    for (const call of identityCalls) {
      expect(call.selected).toEqual([CLINIC]);
      const args = (call.body?.args ?? {}) as Record<string, unknown>;
      if ("_organization_id" in args) expect(args._organization_id).toBe(CLINIC);
    }
    // The token's custom clinic claim chooses nothing: no partition, key or argument names it.
    expect(JSON.stringify(dynamo)).not.toContain(CLAIM_CLINIC);
    expect(JSON.stringify(identityCalls)).not.toContain(CLAIM_CLINIC);
    for (const call of dynamo) {
      const partition = (call.input.ExpressionAttributeValues as Record<string, unknown> | undefined)?.[":org"]
        ?? (call.input.Key as Record<string, unknown> | undefined)?.pk;
      expect(partition).toBe(`ORG#${CLINIC}`);
    }
    expect(writes()).toEqual([]);
  });

  it.each([
    ["no selection", []],
    ["a malformed selection", [[HEADER, "clinic-a"]]],
    ["a non-canonical (upper-case) selection", [[HEADER, CLINIC.toUpperCase()]]],
    ["an empty selection", [[HEADER, ""]]],
    ["two selections", [[HEADER, CLINIC], ["X-ALP-Selected-Organization-Id", OTHER_CLINIC]]],
  ] as Array<[string, Header[]]>)("refuses %s before any identity call or table read", async (_label, selection) => {
    for (const [route, query] of READS) {
      const result = await status(createTelehealthHandler(current)(event(route, { query, selection })));
      expect(result).toEqual({ status: 403, body: { error: "identity_refused" } });
    }
    expect(identityCalls).toEqual([]);
    expect(dynamo).toEqual([]);
  });

  it.each([
    ["an expired token", { exp: String(Math.floor(Date.now() / 1000) - 1) }],
    ["a token without an expiry", { exp: "" }],
    ["an unverified email", { email_verified: "false" }],
    ["a non-UUID subject", { sub: "synthetic-workforce-1234" }],
    ["a synthetic-attested token", { "custom:synthetic_attested": "true" }],
    ["an access token", { token_use: "access" }],
    ["another issuer", { iss: "https://cognito-idp.us-east-2.amazonaws.com/us-east-2_other" }],
  ])("refuses %s before any identity call or table read", async (_label, overrides) => {
    const result = await status(createTelehealthHandler(current)(event(READS[0]![0], { claims: liveClaims(overrides) })));
    expect(result).toEqual({ status: 403, body: { error: "identity_refused" } });
    expect(identityCalls).toEqual([]);
    expect(dynamo).toEqual([]);
  });

  it.each(WRITES)("keeps %s disabled: no identity call, table access, secret or email", async (route) => {
    const result = await status(createTelehealthHandler(current)(event(route, { body: { appointmentId: APPOINTMENT } })));
    expect(result).toEqual({ status: 503, body: { error: "membership_fence_unavailable" } });
    expect(identityCalls).toEqual([]);
    expect(dynamo).toEqual([]);
    expect(secretsSend).not.toHaveBeenCalled();
    expect(sesSend).not.toHaveBeenCalled();
  });

  it("still requires a valid token and one selection before reporting a write as disabled", async () => {
    const unselected = await status(createTelehealthHandler(current)(event(WRITES[0]!, { body: {}, selection: [] })));
    expect(unselected).toEqual({ status: 403, body: { error: "identity_refused" } });
  });

  it("leaves the legacy default unchanged: an inbound selection is neither forwarded nor used", async () => {
    const result = await status(createTelehealthHandler(legacy)(event("GET /clinical-core/workforce/appointments/slots", {
      claims: { iss: legacy.workforceIssuer, aud: legacy.workforceAudience, token_use: "id", sub: "synthetic-workforce-1234",
        "custom:person_id": "11111111-1111-4111-8111-111111111111", "custom:organization_id": CLINIC, "custom:synthetic_attested": "true",
        "custom:production_bound": "false" },
      selection: [[HEADER, OTHER_CLINIC]],
    })));
    expect(result.status).toBe(200);
    expect(identityCalls).toHaveLength(1);
    expect(identityCalls[0]!.selected).toEqual([]);
    expect(JSON.stringify(dynamo)).not.toContain(OTHER_CLINIC);
  });

  it("will not run database_current outside the production runtime, or accept an unknown authority", () => {
    expect(() => createTelehealthHandler({ ...legacy, workforceAuthority: "database_current" })).toThrow("telehealth_configuration_invalid");
    expect(() => createTelehealthHandler({ ...current, workforceAuthority: "claims" as never })).toThrow("telehealth_configuration_invalid");
    expect(() => createTelehealthHandler({ ...legacy, workforceAuthority: "legacy_claims" })).not.toThrow();
  });
});

describe("the negative matrix for every fenced read", () => {
  const MATRIX: Array<[label: string, state: Membership, expected: { status: number; body: Record<string, unknown> }]> = [
    ["wrong clinic (the API refuses the selection)", "wrong_clinic_refused", { status: 403, body: { error: "identity_refused" } }],
    ["wrong clinic (the membership list omits the selection)", "wrong_clinic_listed", { status: 403, body: { error: "identity_refused" } }],
    ["no current membership", "none", { status: 403, body: { error: "identity_refused" } }],
    ["a suspended membership", "suspended", { status: 403, body: { error: "identity_refused" } }],
    ["a demotion out of the clinical roles", "demoted", { status: 403, body: { error: "identity_refused" } }],
    ["an identity-service outage", "outage", { status: 503, body: { error: "service_unavailable" } }],
  ];
  for (const [route, query] of READS) {
    it.each(MATRIX)(`${route}: %s refuses before its table is read`, async (_label, state, expected) => {
      membership = state;
      expect(await status(createTelehealthHandler(current)(event(route, { query })))).toEqual(expected);
      expect(dynamo).toEqual([]);
      expect(identityCalls).toHaveLength(1);
      expect(identityCalls[0]!.selected).toEqual([CLINIC]);
    });
  }

  it("a practitioner demoted to staff keeps the list but loses a completed visit's retained record", async () => {
    visit = visitRecord({ status: "ended" });
    recordAuthorized = false;
    for (const [route, query] of READS.slice(4)) {
      expect(await status(createTelehealthHandler(current)(event(route, { query })))).toEqual({ status: 403, body: { error: "identity_refused" } });
    }
    // It passed the membership list and was refused by the retained-record authority, for the selected clinic.
    const authority = identityCalls.filter((call) => call.body?.functionName === "get_telehealth_record_authority");
    expect(authority).toHaveLength(2);
    for (const call of authority) {
      expect(call.selected).toEqual([CLINIC]);
      expect((call.body!.args as Record<string, unknown>)._organization_id).toBe(CLINIC);
    }
  });

  it("consent withdrawal: the visit still reads, as withdrawn; starting or importing stays disabled", async () => {
    visit = visitRecord({ consents: [receipt({ status: "withdrawn", withdrawnAt: "2026-10-02T00:00:00.000Z", withdrawnBy: "fictional", withdrawalReason: "patient_request" })] });
    const note = await status(createTelehealthHandler(current)(event(READS[4]![0], { query: READS[4]![1] })));
    expect(note.status).toBe(200);
    expect((note.body.data as Record<string, unknown>).consentSigned).toBe(false);
    identityCalls = [];
    for (const route of ["POST /clinical-core/workforce/appointments/visits/start", "POST /clinical-core/workforce/appointments/visits/notes/import"]) {
      expect(await status(createTelehealthHandler(current)(event(route, { body: { appointmentId: APPOINTMENT } }))))
        .toEqual({ status: 503, body: { error: "membership_fence_unavailable" } });
    }
    expect(identityCalls).toEqual([]);
  });
});

describe("a membership change between the authority read and the telehealth write", () => {
  const legacyClaims = { iss: legacy.workforceIssuer, aud: legacy.workforceAudience, token_use: "id", sub: "synthetic-workforce-1234",
    "custom:person_id": "11111111-1111-4111-8111-111111111111", "custom:organization_id": CLINIC, "custom:synthetic_attested": "true",
    "custom:production_bound": "false" };

  it("the separate-call design cannot fence it: under the legacy authority the write lands after the revocation", async () => {
    const timeline: string[] = [];
    onAuthorityRead = () => { timeline.push("authority_read"); membership = "none"; timeline.push("membership_revoked"); };
    send.mockImplementation(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      dynamo.push({ kind: command.constructor.name, input: command.input });
      if (command.constructor.name === "PutCommand") timeline.push("telehealth_write");
      return command.constructor.name === "QueryCommand" ? { Items: [] } : {};
    });
    const handler = createTelehealthHandler(legacy);
    const created = await status(handler(event("POST /clinical-core/workforce/appointments/slots", { body: futureSlot(), claims: legacyClaims, selection: [] })));
    expect(created.status).toBe(201);
    expect(timeline).toEqual(["authority_read", "membership_revoked", "telehealth_write"]);
    // The revocation is real: the next request is refused. The slot it did not stop is already published.
    expect((await handler(event("GET /clinical-core/workforce/appointments/slots", { claims: legacyClaims, selection: [] }))).statusCode).toBe(403);
  });

  it("under database_current the same write is refused before the authority read, so nothing can land after a revocation", async () => {
    const timeline: string[] = [];
    onAuthorityRead = () => { timeline.push("authority_read"); membership = "none"; };
    const result = await status(createTelehealthHandler(current)(event("POST /clinical-core/workforce/appointments/slots", { body: futureSlot() })));
    expect(result).toEqual({ status: 503, body: { error: "membership_fence_unavailable" } });
    expect(timeline).toEqual([]);
    expect(dynamo).toEqual([]);
  });

  it("each read rechecks: a revocation after one read refuses the next before its table is read", async () => {
    const handler = createTelehealthHandler(current);
    expect((await handler(event(READS[0]![0]))).statusCode).toBe(200);
    const readsBefore = dynamo.length;
    membership = "none";
    expect((await handler(event(READS[0]![0]))).statusCode).toBe(403);
    expect(dynamo).toHaveLength(readsBefore);
  });
});
