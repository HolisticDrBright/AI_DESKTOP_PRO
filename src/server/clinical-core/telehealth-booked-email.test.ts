import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Your consultation is booked": when staff schedule (or reschedule) a visit, one email to the address the
 * appointment already carries, through the reminders' sender and the `alp-transactional` set, after the
 * schedule is committed. Off by default; it never changes, fails or delays the schedule; a bounced or
 * complained address is skipped; it names the clinic, the local date and time and how to join or
 * reschedule, and nothing about the reason, the visit type or the practitioner. Fictional people only.
 */
const { send, sesSend } = vi.hoisted(() => ({ send: vi.fn(), sesSend: vi.fn() }));
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
  SecretsManagerClient: class SecretsManagerClient { send = vi.fn(); },
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
}));

import { bookedEmail, createTelehealthHandler, type TelehealthConfiguration } from "./aws-telehealth-requests";
import { FictionalAppointmentStore } from "./appointment-operation-store.test-support";

const config: TelehealthConfiguration = {
  tableName: "synthetic-appointments", consumerIssuer: "https://cognito-idp.us-east-2.amazonaws.com/us-east-2_consumer", consumerAudience: "consumer-client",
  workforceIssuer: "https://cognito-idp.us-east-2.amazonaws.com/us-east-2_workforce", workforceAudience: "workforce-client", runtimeMode: "synthetic", phiAllowed: false,
  zoomEnabled: false, zoomBaaVerified: false, zoomSecretArn: "", remindersEnabled: false, reminderSender: "", reminderConfigurationSet: "", reminderScheduleGroup: "",
  reminderSchedulerRoleArn: "", reminderTargetArn: "", reminderEventsTopicArn: "", stripeTestEnabled: false, stripeSecretArn: "", stripeSuccessUrl: "", stripeCancelUrl: "",
  identityApiOrigin: "https://abcdefghij.execute-api.us-east-2.amazonaws.com", chartAdmissionSecretArn: "arn:aws:secretsmanager:us-east-2:000000000000:secret:fictional-chart-admission",
};
const booked: TelehealthConfiguration = { ...config, enquirerEmailsEnabled: true, reminderSender: "AI Longevity Pro <no-reply@ailongevitypro.app>",
  reminderConfigurationSet: "alp-transactional", clinicDisplayName: "Fictional Clinic" };
const ORG = "22222222-2222-4222-8222-222222222222", PERSON = "11111111-1111-4111-8111-111111111111", REQUEST = "33333333-3333-4333-8333-333333333333";
const workforce = { iss: config.workforceIssuer, aud: config.workforceAudience, token_use: "id", sub: "synthetic-workforce-1234", email: "staff@example.test",
  "custom:person_id": "99999999-9999-4999-8999-999999999999", "custom:organization_id": ORG, "custom:synthetic_attested": "true", "custom:production_bound": "false" };
const event = (routeKey: string, body: Record<string, unknown>, bearer: string | null = "fictional-workforce-token") => ({ routeKey,
  headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body),
  requestContext: { authorizer: { jwt: { claims: workforce } } } }) as never;
/** The identity service's answer to the handler's current-membership recheck (list_my_organizations), per test. */
const identity = vi.hoisted(() => ({ reply: (): Response => new Response(null, { status: 500 }) }));
const membership = (rows: unknown[]) => () => new Response(JSON.stringify({ data: rows }), { status: 200 });
const identityFetch = vi.fn(async (url: string, init?: RequestInit) => {
  if (url !== `${config.identityApiOrigin}/clinical-core/workforce/data-compatibility`
    || JSON.parse(String(init?.body)).functionName !== "list_my_organizations") throw new Error(`unexpected outbound call: ${url}`);
  return identity.reply();
});
const request = (overrides: Record<string, unknown> = {}) => ({
  pk: `ORG#${ORG}`, sk: `REQ#2026-09-01T00:00:00.000Z#${REQUEST}`, gsi1pk: `PERSON#${PERSON}`, gsi1sk: `REQ#2026-09-01T00:00:00.000Z#${REQUEST}`,
  requestId: REQUEST, organizationId: ORG, consumerPersonId: PERSON, consumerEmail: "ava.fictional@example.test", status: "requested", visitType: "follow_up",
  preferredSlots: ["2026-09-03T17:00:00.000Z"], timeZone: "America/Los_Angeles", note: null, scheduledStart: null, scheduledEnd: null, joinUrl: null, providerMeetingId: null,
  version: 1, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", lastActionBy: "consumer", slotId: "55555555-5555-4555-8555-555555555555",
  appointmentId: null, priceMinor: 15000, currency: "USD", cancellationPolicy: "Cancel at least 24 hours before the visit.", cancellationWindowHours: 24,
  cancellationFeeDueMinor: 0, reminderStatus: "disabled", paymentPolicyVersion: "telehealth-payments/1", paymentAuthorizationStatus: "not_authorized", paymentStatus: "not_due",
  paymentIntentId: null, paidMinor: 0, refundedMinor: 0, ...overrides,
});
const schedule = (handlerConfig: TelehealthConfiguration, action = "schedule", expectedVersion = 1, bearer?: string | null) => createTelehealthHandler(handlerConfig)(event("POST /clinical-core/workforce/appointments/actions", {
  requestId: REQUEST, action, expectedVersion, scheduledStart: "2026-09-03T17:00:00.000Z", scheduledEnd: "2026-09-03T17:45:00.000Z", timeZone: "America/Los_Angeles" }, bearer));
let store: FictionalAppointmentStore;
const seed = (overrides: Record<string, unknown> = {}) => { store = new FictionalAppointmentStore().seed(request(overrides)); send.mockImplementation(store.send); };
const mails = () => sesSend.mock.calls.map(([command]) => (command as { input: { FromEmailAddress: string; ConfigurationSetName: string; Destination: { ToAddresses: string[] };
  Content: { Simple: { Subject: { Data: string }; Body: { Text: { Data: string } } } } } }).input);

beforeEach(() => {
  send.mockReset(); sesSend.mockReset(); sesSend.mockResolvedValue({ MessageId: "fictional-message" });
  // The handler rechecks the staff member's current clinic membership before any workforce action: by default the
  // identity service answers with this clinic and an allowed role. Any other outbound call fails the request.
  identity.reply = membership([{ organization_id: ORG, role: "practitioner" }]);
  identityFetch.mockClear(); vi.stubGlobal("fetch", identityFetch);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("the booked email", () => {
  it("is off by default: scheduling sends nothing", async () => {
    seed();
    expect((await schedule(config)).statusCode).toBe(200);
    expect(sesSend).not.toHaveBeenCalled();
  });
  it("when on, one email after the schedule is committed: the clinic, the local date and time, how to join or reschedule, and nothing the visitor chose", async () => {
    seed();
    const result = await schedule(booked);
    expect(result.statusCode).toBe(200);
    expect(mails()).toHaveLength(1);
    const [mail] = mails();
    expect(mail).toMatchObject({ FromEmailAddress: "AI Longevity Pro <no-reply@ailongevitypro.app>", ConfigurationSetName: "alp-transactional", Destination: { ToAddresses: ["ava.fictional@example.test"] } });
    expect(mail!.Content.Simple.Subject.Data).toBe("Your consultation is booked");
    expect(mail!.Content.Simple.Body.Text.Data).toBe("Fictional Clinic has booked your consultation for Thu, Sep 3, 2026, 10:00 AM PDT.\n\n"
      + "When it is time, open AI Longevity Pro for the secure visit details.\n\nTo reschedule or cancel, open AI Longevity Pro.\n\nPlease do not reply to this email with health information.\n");
    expect(JSON.stringify(mail)).not.toMatch(/follow|initial|urgent|reason|program|15000|150\.00|Cancel at least/i);
    // The email was sent after the committed write: the stored request is scheduled.
    expect([...store.rows.values()].find(row => row.requestId === REQUEST && String(row.sk).startsWith("REQ#"))).toMatchObject({ scheduledStart: "2026-09-03T17:00:00.000Z" });
  });
  it("a reschedule sends the new time the same way", async () => {
    seed({ status: "scheduled", scheduledStart: "2026-09-02T17:00:00.000Z", scheduledEnd: "2026-09-02T17:45:00.000Z", appointmentId: "66666666-6666-4666-8666-666666666666", version: 3 });
    expect((await schedule(booked, "reschedule", 3)).statusCode).toBe(200);
    expect(mails()).toHaveLength(1);
    expect(mails()[0]!.Content.Simple.Body.Text.Data).toContain("for Thu, Sep 3, 2026, 10:00 AM PDT.");
  });
  it("a send failure never changes, fails or rolls back the schedule", async () => {
    seed(); sesSend.mockRejectedValue(new Error("ses down"));
    const result = await schedule(booked);
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body ?? "{}").data).toMatchObject({ status: "awaiting_provider", scheduledStart: "2026-09-03T17:00:00.000Z" });
  });
  it("skips a bounced or complained address", async () => {
    seed();
    const stored = store.send.bind(store);
    send.mockImplementation(async (command: { constructor: { name: string }; input: { Key?: { pk?: string } } }) =>
      command.constructor.name === "GetCommand" && command.input.Key?.pk === "EMAIL_SUPPRESSION" ? { Item: { pk: "EMAIL_SUPPRESSION", reason: "complaint" } } : stored(command as never));
    expect((await schedule(booked)).statusCode).toBe(200);
    expect(sesSend).not.toHaveBeenCalled();
  });
  it("a refused schedule (stale version) sends nothing", async () => {
    seed({ version: 2 });
    expect((await schedule(booked, "schedule", 1)).statusCode).toBe(409);
    expect(sesSend).not.toHaveBeenCalled();
  });
  it("cannot be switched on without the transactional sender, exactly alp-transactional and a clinic name", () => {
    expect(() => createTelehealthHandler(booked)).not.toThrow();
    for (const broken of [{ reminderSender: "" }, { reminderConfigurationSet: "alp-marketing" }, { clinicDisplayName: "" }, { clinicDisplayName: "<b>Clinic</b>" }]) {
      expect(() => createTelehealthHandler({ ...booked, ...broken }), JSON.stringify(broken)).toThrow("telehealth_configuration_invalid");
    }
  });
  it("the template refuses an unreadable time zone or clinic name rather than guessing", () => {
    expect(() => bookedEmail({ clinic: "Fictional Clinic", scheduledStart: "2026-09-03T17:00:00.000Z", timeZone: "Mars/Olympus", joinUrl: null })).toThrow();
    expect(() => bookedEmail({ clinic: "Fictional\nClinic", scheduledStart: "2026-09-03T17:00:00.000Z", timeZone: "America/Los_Angeles", joinUrl: null })).toThrow();
    expect(bookedEmail({ clinic: "Fictional Clinic", scheduledStart: "2026-09-03T17:00:00.000Z", timeZone: "America/New_York", joinUrl: "https://us02web.zoom.us/j/12345678901" }).text)
      .toContain("Thu, Sep 3, 2026, 1:00 PM EDT.\n\nJoin your secure visit: https://us02web.zoom.us/j/12345678901");
  });
});

describe("the current-membership recheck refuses before anything is scheduled or sent", () => {
  const writes = () => store.commands.filter(command => /Put|Update|TransactWrite|Delete/.test(command.constructor.name));
  const refused = async (outcome: { statusCode: number; body?: string }, status: number, error: string, before: string) => {
    expect(outcome.statusCode, outcome.body).toBe(status);
    expect(JSON.parse(outcome.body ?? "{}")).toEqual({ error });
    expect(writes()).toEqual([]);
    expect(JSON.stringify([...store.rows.entries()])).toBe(before);
    expect(sesSend).not.toHaveBeenCalled();
  };
  const cases: Array<[string, () => Response]> = [
    ["no current membership at all", membership([])],
    ["a membership only in another clinic", membership([{ organization_id: "44444444-4444-4444-8444-444444444444", role: "owner" }])],
    ["two membership rows for this clinic", membership([{ organization_id: ORG, role: "practitioner" }, { organization_id: ORG, role: "admin" }])],
    ["a membership revoked after the token was issued (the clinic is no longer listed)", membership([{ organization_id: "44444444-4444-4444-8444-444444444444", role: "practitioner" }])],
    ["a role this route does not admit", membership([{ organization_id: ORG, role: "member" }])],
    ["the identity service refusing the token", () => new Response(JSON.stringify({ error: "identity_refused" }), { status: 403 })],
  ];
  it("without a bearer token the identity service is never asked and nothing happens", async () => {
    seed(); const before = JSON.stringify([...store.rows.entries()]);
    await refused(await schedule(booked, "schedule", 1, null), 403, "identity_refused", before);
    expect(identityFetch).not.toHaveBeenCalled();
  });
  for (const [label, reply] of cases) it(`${label}: 403, no schedule, no email`, async () => {
    seed(); const before = JSON.stringify([...store.rows.entries()]);
    identity.reply = reply;
    await refused(await schedule(booked), 403, "identity_refused", before);
    expect(identityFetch).toHaveBeenCalledTimes(1);
  });
  it("an identity service that cannot answer is an outage, not a refusal, and still nothing happens", async () => {
    seed(); const before = JSON.stringify([...store.rows.entries()]);
    identity.reply = () => new Response("upstream", { status: 502 });
    await refused(await schedule(booked), 503, "service_unavailable", before);
  });
  it("the same request with the current membership restored schedules and sends once", async () => {
    seed();
    identity.reply = membership([{ organization_id: ORG, role: "staff" }]);
    expect((await schedule(booked)).statusCode).toBe(200);
    expect(mails()).toHaveLength(1);
  });
});
