if (typeof window !== "undefined") throw new Error("aws-telehealth-requests is server-only");

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { CreateScheduleCommand, DeleteScheduleCommand, SchedulerClient } from "@aws-sdk/client-scheduler";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { ApiGatewayV2Event, ApiGatewayV2Response } from "./aws-identity-api";

const document = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const secrets = new SecretsManagerClient({});
const ses = new SESv2Client({});
const scheduler = new SchedulerClient({});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUBJECT = /^[A-Za-z0-9:_-]{8,128}$/;
const MAX_BODY = 16_384;
const CONSUMER_CREATE = "POST /clinical-core/consumer/appointments/requests";
const CONSUMER_LIST = "GET /clinical-core/consumer/appointments/requests";
const CONSUMER_ACTION = "POST /clinical-core/consumer/appointments/actions";
const CONSUMER_AVAILABILITY = "POST /clinical-core/consumer/appointments/availability";
const CONSUMER_HOLD = "POST /clinical-core/consumer/appointments/holds";
const WORKFORCE_LIST = "GET /clinical-core/workforce/appointments/requests";
const WORKFORCE_ACTION = "POST /clinical-core/workforce/appointments/actions";
const WORKFORCE_SLOT_LIST = "GET /clinical-core/workforce/appointments/slots";
const WORKFORCE_SLOT_CREATE = "POST /clinical-core/workforce/appointments/slots";
const CONSUMER_PAYMENT_PROFILE = "GET /clinical-core/consumer/appointments/payment-methods";
const CONSUMER_PAYMENT_SETUP = "POST /clinical-core/consumer/appointments/payment-methods/setup";
const CONSUMER_PAYMENT_AUTHORIZE = "POST /clinical-core/consumer/appointments/payment-authorizations";
const WORKFORCE_PAYMENT = "POST /clinical-core/workforce/appointments/payments";
const STRIPE_WEBHOOK = "POST /clinical-core/webhooks/stripe/appointments";
// Telehealth VISIT boundary (desktop): one record per appointment that holds
// the combined telehealth + recording/AI-notes consent, the Zoom meeting the
// practitioner joins from inside Desktop Pro, and the post-visit note.
const WORKFORCE_VISIT_LIST = "GET /clinical-core/workforce/appointments/visits";
const WORKFORCE_VISIT_CONSENT_ARTIFACT = "GET /clinical-core/workforce/appointments/visits/consent-artifact";
const WORKFORCE_VISIT_CONSENT = "POST /clinical-core/workforce/appointments/visits/consent";
const WORKFORCE_VISIT_CONSENT_WITHDRAW = "POST /clinical-core/workforce/appointments/visits/consent/withdraw";
const WORKFORCE_VISIT_START = "POST /clinical-core/workforce/appointments/visits/start";
const WORKFORCE_VISIT_END = "POST /clinical-core/workforce/appointments/visits/end";
const WORKFORCE_VISIT_NOTE = "GET /clinical-core/workforce/appointments/visits/notes";
const WORKFORCE_VISIT_NOTE_IMPORT = "POST /clinical-core/workforce/appointments/visits/notes/import";
const WORKFORCE_VISIT_NOTE_SIGN = "POST /clinical-core/workforce/appointments/visits/notes/sign";
/** The one combined consent a telehealth visit requires. Wording is versioned; the version is recorded, never the text. */
export const TELEHEALTH_CONSENT_TYPE = "telehealth_recording_combined";
/** Meeting SDK signatures are short-lived: long enough for a visit, never a standing credential. */
const MEETING_SDK_SIGNATURE_TTL_SECONDS = 2 * 60 * 60;
const VISIT_NOTE_SECTION_KEYS = ["summary", "patient_reported", "results_reviewed", "plan_discussed"] as const;

export type TelehealthConfiguration = {
  tableName: string; consumerIssuer: string; consumerAudience: string; workforceIssuer: string; workforceAudience: string;
  runtimeMode: "synthetic" | "production"; phiAllowed: boolean; zoomEnabled: boolean; zoomBaaVerified: boolean; zoomSecretArn: string;
  remindersEnabled: boolean; reminderSender: string; reminderConfigurationSet: string; reminderScheduleGroup: string; reminderSchedulerRoleArn: string; reminderTargetArn: string;
  stripeTestEnabled: boolean; stripeSecretArn: string; stripeSuccessUrl: string; stripeCancelUrl: string;
  /** The clinical API's own origin: the governed consent authority (identity extension) is read through it with the caller's JWT. */
  identityApiOrigin: string;
};

type AppointmentItem = {
  pk: string; sk: string; gsi1pk: string; gsi1sk: string; requestId: string; organizationId: string; consumerPersonId: string;
  status: "requested" | "awaiting_provider" | "scheduled" | "reschedule_requested" | "cancelled";
  visitType: "initial" | "follow_up" | "urgent_question"; preferredSlots: string[]; timeZone: string; note: string | null;
  scheduledStart: string | null; scheduledEnd: string | null; joinUrl: string | null; providerMeetingId: string | null;
  version: number; createdAt: string; updatedAt: string; lastActionBy: "consumer" | "workforce";
  slotId: string; appointmentId: string | null; priceMinor: number; currency: "USD"; cancellationPolicy: string;
  cancellationWindowHours: number; cancellationFeeDueMinor: number;
  consumerEmail: string; reminderStatus: "disabled" | "scheduled" | "failed";
  paymentPolicyVersion: "telehealth-payments/1"; paymentAuthorizationStatus: "not_authorized" | "authorized" | "withdrawn";
  paymentStatus: "not_due" | "processing" | "paid" | "failed" | "refunded" | "partially_refunded"; paymentIntentId: string | null;
  paidMinor: number; refundedMinor: number;
  /** Signed by the patient in the app when the visit was requested (null for older requests). */
  consent?: VisitConsent | null;
};

export type VisitConsent = {
  consentId: string; consentType: typeof TELEHEALTH_CONSENT_TYPE; scope: "telehealth_recording";
  /** The approved artifact the signer saw: id, version and content hash from the governed consent authority. */
  artifactId: string; artifactVersion: string; contentSha256: string; signerName: string;
  method: "patient_app" | "staff_attested"; representativeAuthority: "self" | "guardian" | "healthcare_proxy" | "legal_representative";
  signedAt: string; recordedBy: string; patientLocation: string | null;
  /** The identity-authority grant this receipt stands on, when the patient has an app connection. */
  grantId: string | null; connectionId: string | null;
  status: "granted" | "withdrawn"; withdrawnAt: string | null; withdrawnBy: string | null; withdrawalReason: string | null;
};
/**
 * Durable creating-intent for the provider meeting. `acquired` = held, no
 * provider call yet; `dispatched` = a create was sent (`dispatchedAt`) and its
 * outcome is not yet proven (a thrown POST, a lost receipt). The lease id is
 * the ATTEMPT id: it is written into the provider meeting's marker, so the
 * outcome of exactly this attempt can be looked up. A dispatched lease is
 * never taken over on expiry: it is settled against provider evidence first.
 */
type MeetingLease = { leaseId: string; acquiredAt: string; state: "acquired" | "dispatched"; dispatchedAt: string | null; createdMeetingId: string | null };
type ProviderShutdown = { status: "not_started" | "pending" | "ended" | "failed"; attemptedAt: string | null; confirmedAt: string | null; detail: string | null };
export type VisitNoteSectionKey = typeof VISIT_NOTE_SECTION_KEYS[number];
export type VisitActionItem = { id: string; text: string; status: "suggested" | "approved" | "dismissed" };
export type VisitNote = {
  status: "not_reviewed" | "signed"; source: "zoom_ai_companion"; zoomSummaryId: string | null;
  aiSections: Record<VisitNoteSectionKey, string>; aiOriginal: Record<string, unknown>; practitionerNotes: string;
  actionItems: VisitActionItem[]; revision: number; importedAt: string; signedAt: string | null; signedBy: string | null;
};
type VisitFlag = { atSeconds: number; label: string };
type VisitItem = {
  pk: string; sk: string; appointmentId: string; organizationId: string; requestId: string | null; consumerPersonId: string | null;
  scheduledStart: string | null; scheduledEnd: string | null; timeZone: string | null;
  status: "scheduled" | "in_visit" | "ending" | "ended" | "cancelled"; consents: VisitConsent[]; meetingLease: MeetingLease | null;
  /** Attempt ids settled as "no meeting" after the settlement window: a meeting carrying one of these markers that shows up later is an orphan, never adopted. */
  settledLeaseIds?: string[];
  /**
   * The IMMUTABLE subject and practitioner of this visit, from the clinical
   * calendar (desktop-booked) or the request (patient-app) at creation. The
   * consent receipts belong to this subject; a calendar that now names a
   * different patient or practitioner is a different visit, and is refused.
   */
  patientRecordId: string | null; practitionerUserId: string | null;
  providerMeetingId: string | null; providerMeetingUuid: string | null; joinUrl: string | null;
  /** Zoom's actual meeting password from create/get meeting — never the encrypted `pwd` token of the join URL. */
  passcode: string | null;
  startedAt: string | null; endedAt: string | null; providerShutdown: ProviderShutdown; flags: VisitFlag[]; quickNotes: string;
  note: VisitNote | null; noteHistory: VisitNote[]; version: number; createdAt: string; updatedAt: string;
};

type PaymentProfile = { pk: string; sk: string; organizationId: string; consumerPersonId: string; stripeCustomerId: string; stripePaymentMethodId: string | null; status: "setup_pending" | "active" | "disabled"; updatedAt: string };

type ReminderEvent = { internalEvent?: string; organizationId?: string; requestId?: string; scheduledStart?: string };

type BookingSlot = {
  pk: string; sk: string; slotId: string; organizationId: string; start: string; end: string; timeZone: string;
  visitTypes: AppointmentItem["visitType"][]; priceMinor: number; currency: "USD"; cancellationPolicy: string;
  cancellationWindowHours: number;
  status: "available" | "held" | "booked"; heldBy: string | null; holdId: string | null; holdExpiresAt: number | null;
  createdAt: string; createdBy: string;
};

export function createTelehealthHandler(config: TelehealthConfiguration) {
  validateConfiguration(config);
  return async (event: ApiGatewayV2Event): Promise<ApiGatewayV2Response> => {
    if (config.runtimeMode === "production" && !config.phiAllowed) return response(503, { error: "production_not_activated", phiAllowed: false });
    const route = event.routeKey ?? "internal";
    try {
      const reminder = event as unknown as ReminderEvent;
      if (reminder.internalEvent === "send_appointment_reminder") return response(200, { data: await sendAppointmentReminder(config, reminder) });
      if (route === STRIPE_WEBHOOK) return response(200, { data: await handleStripeWebhook(config, event) });
      const pool = route.includes("/workforce/") ? "workforce" : "consumer";
      const actor = identity(event, config, pool);
      if (route === CONSUMER_PAYMENT_PROFILE) return response(200, { data: await getPaymentProfile(config, actor) });
      if (route === CONSUMER_PAYMENT_SETUP) return response(201, { data: await startPaymentSetup(config, actor) });
      if (route === CONSUMER_PAYMENT_AUTHORIZE) return response(200, { data: await authorizeAppointmentPayment(config, actor, body(event)) });
      if (route === CONSUMER_AVAILABILITY) return response(200, { data: await listAvailability(config, actor, body(event)) });
      if (route === CONSUMER_HOLD) return response(201, { data: await holdSlot(config, actor, body(event)) });
      if (route === CONSUMER_CREATE) return response(201, { data: await createRequest(config, actor, body(event)) });
      if (route === CONSUMER_LIST) return response(200, { data: await listConsumer(config, actor) });
      if (route === CONSUMER_ACTION) return response(200, { data: await consumerAction(config, actor, body(event)) });
      if (route === WORKFORCE_LIST) return response(200, { data: await listWorkforce(config, actor) });
      if (route === WORKFORCE_ACTION) return response(200, { data: await workforceAction(config, actor, body(event)) });
      if (route === WORKFORCE_SLOT_LIST) return response(200, { data: await listWorkforceSlots(config, actor) });
      if (route === WORKFORCE_SLOT_CREATE) return response(201, { data: await publishSlot(config, actor, body(event)) });
      if (route === WORKFORCE_PAYMENT) return response(200, { data: await workforcePayment(config, actor, body(event)) });
      if (route === WORKFORCE_VISIT_LIST) return response(200, { data: await listVisits(config, actor, event) });
      if (route === WORKFORCE_VISIT_CONSENT_ARTIFACT) return response(200, { data: await readConsentArtifact(config, actor) });
      if (route === WORKFORCE_VISIT_CONSENT) return response(200, { data: await recordVisitConsent(config, actor, body(event)) });
      if (route === WORKFORCE_VISIT_CONSENT_WITHDRAW) return response(200, { data: await withdrawVisitConsent(config, actor, body(event)) });
      if (route === WORKFORCE_VISIT_START) return response(200, { data: await startVisit(config, actor, body(event)) });
      if (route === WORKFORCE_VISIT_END) return response(200, { data: await endVisit(config, actor, body(event)) });
      if (route === WORKFORCE_VISIT_NOTE) return response(200, { data: await readVisitNote(config, actor, event) });
      if (route === WORKFORCE_VISIT_NOTE_IMPORT) return response(200, { data: await importVisitNote(config, actor, body(event)) });
      if (route === WORKFORCE_VISIT_NOTE_SIGN) return response(200, { data: await signVisitNote(config, actor, body(event)) });
      return response(404, { error: "route_not_found" });
    } catch (error) {
      console.warn(JSON.stringify({ event: "telehealth_request_refused", route, errorName: error instanceof Error ? error.name : "UnknownError",
        errorMessage: error instanceof Error ? error.message.replace(/[\r\n]/g, " ").slice(0, 300) : "unknown" }));
      const category = error instanceof TelehealthError ? error.category : "service_unavailable";
      const status = category === "identity_refused" ? 403 : category === "not_found" ? 404
        : ["conflict", "appointment_cancelled", "appointment_reassigned", "meeting_unsettled", "consent_required", "consent_withdrawn", "consent_superseded", "consent_version_refused", "consent_artifact_unavailable"].includes(category) ? 409
        : category === "provider_unavailable" || category === "service_unavailable" ? 503 : 400;
      return response(status, { error: category });
    }
  };
}

async function createRequest(config: TelehealthConfiguration, actor: Actor, value: Record<string, unknown>) {
  exact(value, ["visitType", "slotId", "holdId", "note", "consent"], ["visitType", "slotId", "holdId"]);
  const visitType = value.visitType;
  if (!["initial", "follow_up", "urgent_question"].includes(String(visitType)) || !UUID.test(String(value.slotId)) || !UUID.test(String(value.holdId))
    || !(value.note === undefined || value.note === null || (typeof value.note === "string" && value.note.length <= 500))) throw new TelehealthError("request_invalid");
  // The combined telehealth + recording/AI-notes consent is the last step of
  // "Request a virtual visit" in the patient app. It is optional on the wire
  // (older app builds), but a visit cannot START without it — see startVisit.
  const consent = value.consent === undefined || value.consent === null ? null : consentFromPatientApp(value.consent, actor, await currentArtifact(config, actor));
  const slot = await findSlot(config, actor.organizationId, String(value.slotId));
  const nowEpoch = Math.floor(Date.now() / 1000);
  if (slot.status !== "held" || slot.heldBy !== actor.personId || slot.holdId !== value.holdId || !slot.holdExpiresAt || slot.holdExpiresAt <= nowEpoch
    || !slot.visitTypes.includes(visitType as AppointmentItem["visitType"])) throw new TelehealthError("conflict");
  const now = new Date().toISOString(); const requestId = randomUUID();
  const item: AppointmentItem = {
    pk: `ORG#${actor.organizationId}`, sk: `REQ#${now}#${requestId}`,
    gsi1pk: `PERSON#${actor.personId}`, gsi1sk: `REQ#${now}#${requestId}`,
    requestId, organizationId: actor.organizationId, consumerPersonId: actor.personId,
    status: "requested", visitType: visitType as AppointmentItem["visitType"], preferredSlots: [slot.start], timeZone: slot.timeZone,
    note: typeof value.note === "string" && value.note.trim() ? value.note.trim() : null,
    scheduledStart: null, scheduledEnd: null, joinUrl: null, providerMeetingId: null,
    version: 1, createdAt: now, updatedAt: now, lastActionBy: "consumer",
    slotId: slot.slotId, appointmentId: null, priceMinor: slot.priceMinor, currency: slot.currency, cancellationPolicy: slot.cancellationPolicy,
    cancellationWindowHours: slot.cancellationWindowHours, cancellationFeeDueMinor: 0, consumerEmail: actor.email,
    reminderStatus: config.remindersEnabled ? "failed" : "disabled",
    paymentPolicyVersion: "telehealth-payments/1", paymentAuthorizationStatus: "not_authorized", paymentStatus: "not_due", paymentIntentId: null,
    paidMinor: 0, refundedMinor: 0, consent,
  };
  await document.send(new TransactWriteCommand({ TransactItems: [
    { Put: { TableName: config.tableName, Item: item, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } },
    { Update: { TableName: config.tableName, Key: { pk: slot.pk, sk: slot.sk }, UpdateExpression: "SET #status=:booked", ConditionExpression: "#status=:held AND heldBy=:person AND holdId=:hold AND holdExpiresAt>:now", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":booked": "booked", ":held": "held", ":person": actor.personId, ":hold": value.holdId, ":now": nowEpoch } } },
  ] }));
  return publicItem(item, "consumer");
}

async function publishSlot(config: TelehealthConfiguration, actor: Actor, value: Record<string, unknown>) {
  exact(value, ["start", "end", "timeZone", "visitTypes", "priceMinor", "currency", "cancellationPolicy", "cancellationWindowHours"], ["start", "end", "timeZone", "visitTypes", "priceMinor", "currency", "cancellationPolicy", "cancellationWindowHours"]);
  const start = String(value.start); const end = String(value.end); const timeZone = zone(value.timeZone);
  const visitTypes = value.visitTypes;
  if (!date(start) || !date(end) || new Date(end) <= new Date(start) || new Date(start).getTime() <= Date.now()
    || new Date(start).getTime() > Date.now() + 180 * 86_400_000 || !Array.isArray(visitTypes) || visitTypes.length < 1
    || visitTypes.some((v) => !["initial", "follow_up", "urgent_question"].includes(String(v)))
    || !Number.isInteger(value.priceMinor) || Number(value.priceMinor) < 0 || Number(value.priceMinor) > 1_000_000
    || value.currency !== "USD" || typeof value.cancellationPolicy !== "string" || value.cancellationPolicy.length < 10 || value.cancellationPolicy.length > 1000
    || !Number.isInteger(value.cancellationWindowHours) || Number(value.cancellationWindowHours) < 0 || Number(value.cancellationWindowHours) > 720) throw new TelehealthError("request_invalid");
  const existing = await rawSlots(config, actor.organizationId);
  if (existing.some((slot) => slot.status !== "booked" && new Date(slot.start) < new Date(end) && new Date(slot.end) > new Date(start))) throw new TelehealthError("conflict");
  const slotId = randomUUID(); const now = new Date().toISOString();
  const slot: BookingSlot = { pk: `ORG#${actor.organizationId}`, sk: `SLOT#${start}#${slotId}`, slotId, organizationId: actor.organizationId, start, end, timeZone,
    visitTypes: visitTypes as BookingSlot["visitTypes"], priceMinor: Number(value.priceMinor), currency: "USD", cancellationPolicy: value.cancellationPolicy,
    cancellationWindowHours: Number(value.cancellationWindowHours),
    status: "available", heldBy: null, holdId: null, holdExpiresAt: null, createdAt: now, createdBy: actor.subject };
  await document.send(new PutCommand({ TableName: config.tableName, Item: slot, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" }));
  return publicSlot(slot, true);
}

async function rawSlots(config: TelehealthConfiguration, organizationId: string) {
  const result = await document.send(new QueryCommand({ TableName: config.tableName, KeyConditionExpression: "pk=:org AND begins_with(sk,:slot)", ExpressionAttributeValues: { ":org": `ORG#${organizationId}`, ":slot": "SLOT#" }, ScanIndexForward: true, Limit: 500 }));
  return (result.Items ?? []) as BookingSlot[];
}
async function listWorkforceSlots(config: TelehealthConfiguration, actor: Actor) { return (await rawSlots(config, actor.organizationId)).map((slot) => publicSlot(slot, true)); }
async function listAvailability(config: TelehealthConfiguration, actor: Actor, value: Record<string, unknown>) {
  exact(value, ["visitType"], ["visitType"]); const visitType = String(value.visitType);
  if (!["initial", "follow_up", "urgent_question"].includes(visitType)) throw new TelehealthError("request_invalid");
  const now = Date.now(); const epoch = Math.floor(now / 1000);
  return (await rawSlots(config, actor.organizationId)).filter((slot) => new Date(slot.start).getTime() > now && slot.visitTypes.includes(visitType as AppointmentItem["visitType"])
    && (slot.status === "available" || (slot.status === "held" && (slot.holdExpiresAt ?? 0) <= epoch))).map((slot) => publicSlot(slot, false));
}
async function findSlot(config: TelehealthConfiguration, organizationId: string, slotId: string) {
  const slot = (await rawSlots(config, organizationId)).find((candidate) => candidate.slotId === slotId); if (!slot) throw new TelehealthError("not_found"); return slot;
}
async function holdSlot(config: TelehealthConfiguration, actor: Actor, value: Record<string, unknown>) {
  exact(value, ["slotId", "visitType"], ["slotId", "visitType"]); if (!UUID.test(String(value.slotId))) throw new TelehealthError("request_invalid");
  const slot = await findSlot(config, actor.organizationId, String(value.slotId));
  if (!slot.visitTypes.includes(value.visitType as AppointmentItem["visitType"])) throw new TelehealthError("request_invalid");
  const holdId = randomUUID(); const now = Math.floor(Date.now() / 1000); const expiresAt = now + 600;
  try { await document.send(new UpdateCommand({ TableName: config.tableName, Key: { pk: slot.pk, sk: slot.sk }, UpdateExpression: "SET #status=:held,heldBy=:person,holdId=:hold,holdExpiresAt=:expires", ConditionExpression: "#status=:available OR (#status=:held AND holdExpiresAt<=:now)", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":held": "held", ":available": "available", ":person": actor.personId, ":hold": holdId, ":expires": expiresAt, ":now": now } })); }
  catch (error) { if ((error as { name?: string }).name === "ConditionalCheckFailedException") throw new TelehealthError("conflict"); throw error; }
  return { holdId, slotId: slot.slotId, expiresAt: new Date(expiresAt * 1000).toISOString(), slot: publicSlot({ ...slot, status: "held", heldBy: actor.personId, holdId, holdExpiresAt: expiresAt }, false) };
}
function publicSlot(slot: BookingSlot, workforce: boolean) { const result: Record<string, unknown> = { slotId: slot.slotId, start: slot.start, end: slot.end, timeZone: slot.timeZone, visitTypes: slot.visitTypes, priceMinor: slot.priceMinor, currency: slot.currency, cancellationPolicy: slot.cancellationPolicy, cancellationWindowHours: slot.cancellationWindowHours, status: slot.status }; if (workforce) Object.assign(result, { heldBy: slot.heldBy, holdExpiresAt: slot.holdExpiresAt ? new Date(slot.holdExpiresAt * 1000).toISOString() : null }); return result; }

async function listConsumer(config: TelehealthConfiguration, actor: Actor) {
  const result = await document.send(new QueryCommand({ TableName: config.tableName, IndexName: "ByConsumer", KeyConditionExpression: "gsi1pk = :person", ExpressionAttributeValues: { ":person": `PERSON#${actor.personId}` }, ScanIndexForward: false, Limit: 100 }));
  return (result.Items ?? []).filter((item) => item.organizationId === actor.organizationId).map((item) => publicItem(item as AppointmentItem, "consumer"));
}

async function listWorkforce(config: TelehealthConfiguration, actor: Actor) {
  const result = await document.send(new QueryCommand({ TableName: config.tableName, KeyConditionExpression: "pk = :org AND begins_with(sk, :request)", ExpressionAttributeValues: { ":org": `ORG#${actor.organizationId}`, ":request": "REQ#" }, ScanIndexForward: false, Limit: 200 }));
  return (result.Items ?? []).map((item) => publicItem(item as AppointmentItem, "workforce"));
}

async function find(config: TelehealthConfiguration, organizationId: string, requestId: string): Promise<AppointmentItem> {
  if (!UUID.test(requestId)) throw new TelehealthError("request_invalid");
  const result = await document.send(new QueryCommand({ TableName: config.tableName, KeyConditionExpression: "pk = :org AND begins_with(sk, :request)", FilterExpression: "requestId = :id", ExpressionAttributeValues: { ":org": `ORG#${organizationId}`, ":request": "REQ#", ":id": requestId }, Limit: 200 }));
  const item = result.Items?.[0] as AppointmentItem | undefined;
  if (!item) throw new TelehealthError("not_found");
  return item;
}

async function consumerAction(config: TelehealthConfiguration, actor: Actor, value: Record<string, unknown>) {
  exact(value, ["requestId", "action", "expectedVersion", "slotId", "holdId"], ["requestId", "action", "expectedVersion"]);
  const item = await find(config, actor.organizationId, String(value.requestId));
  if (item.consumerPersonId !== actor.personId) throw new TelehealthError("identity_refused");
  const action = value.action;
  if (!Number.isInteger(value.expectedVersion) || !["cancel", "request_reschedule"].includes(String(action))) throw new TelehealthError("request_invalid");
  if (item.status === "cancelled" || (action === "request_reschedule" && !["requested", "awaiting_provider", "scheduled", "reschedule_requested"].includes(item.status))) {
    throw new TelehealthError("conflict");
  }
  if (action === "cancel") return cancelRequest(config, item, Number(value.expectedVersion), "consumer");
  if (!UUID.test(String(value.slotId)) || !UUID.test(String(value.holdId))) throw new TelehealthError("request_invalid");
  const replacement = await findSlot(config, actor.organizationId, String(value.slotId));
  const now = Math.floor(Date.now() / 1000);
  if (replacement.slotId === item.slotId || replacement.status !== "held" || replacement.heldBy !== actor.personId
    || replacement.holdId !== value.holdId || !replacement.holdExpiresAt || replacement.holdExpiresAt <= now
    || !replacement.visitTypes.includes(item.visitType)) throw new TelehealthError("conflict");
  return rescheduleRequest(config, item, replacement, Number(value.expectedVersion), String(value.holdId));
}

async function cancelRequest(config: TelehealthConfiguration, item: AppointmentItem, version: number, by: "consumer" | "workforce") {
  if (version !== item.version) throw new TelehealthError("conflict");
  if (config.zoomEnabled && item.providerMeetingId) await deleteZoomMeeting(config, item.providerMeetingId);
  if (config.remindersEnabled) await deleteAppointmentReminders(config, item.requestId);
  const slot = await findSlot(config, item.organizationId, item.slotId);
  const cutoff = new Date(slot.start).getTime() - slot.cancellationWindowHours * 3_600_000;
  const cancellationFeeDueMinor = Date.now() >= cutoff ? item.priceMinor : 0;
  const updatedAt = new Date().toISOString();
  const next = { ...item, status: "cancelled" as const, joinUrl: null, providerMeetingId: null,
    cancellationFeeDueMinor, version: version + 1, updatedAt, lastActionBy: by };
  const actions: ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"] = [
    { Update: { TableName: config.tableName, Key: { pk: item.pk, sk: item.sk },
      UpdateExpression: "SET #version=:next,#status=:cancelled,joinUrl=:none,providerMeetingId=:none,cancellationFeeDueMinor=:fee,updatedAt=:updated,lastActionBy=:by",
      ConditionExpression: "#version=:expected", ExpressionAttributeNames: { "#version": "version", "#status": "status" },
      ExpressionAttributeValues: { ":expected": version, ":next": version + 1, ":cancelled": "cancelled", ":none": null, ":fee": cancellationFeeDueMinor, ":updated": updatedAt, ":by": by } } },
  ];
  if (cancellationFeeDueMinor === 0) actions.push({ Update: { TableName: config.tableName, Key: { pk: slot.pk, sk: slot.sk },
    UpdateExpression: "SET #status=:available,heldBy=:none,holdId=:none,holdExpiresAt=:none",
    ConditionExpression: "#status=:booked", ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":booked": "booked", ":available": "available", ":none": null } } });
  if (item.appointmentId) actions.push({ Update: { TableName: config.tableName, Key: { pk: item.pk, sk: `APPT#${item.appointmentId}` },
    UpdateExpression: "SET #status=:cancelled,cancellationFeeDueMinor=:fee,updatedAt=:updated",
    ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":cancelled": "cancelled", ":fee": cancellationFeeDueMinor, ":updated": updatedAt } } });
  try { await document.send(new TransactWriteCommand({ TransactItems: actions })); }
  catch (error) { if ((error as { name?: string }).name === "TransactionCanceledException" || (error as { name?: string }).name === "ConditionalCheckFailedException") throw new TelehealthError("conflict"); throw error; }
  await reconcileVisitForCancelledRequest(config, item);
  return publicItem(next, by);
}

async function rescheduleRequest(config: TelehealthConfiguration, item: AppointmentItem, replacement: BookingSlot, version: number, holdId: string) {
  if (version !== item.version) throw new TelehealthError("conflict");
  if (config.zoomEnabled && item.providerMeetingId) await deleteZoomMeeting(config, item.providerMeetingId);
  if (config.remindersEnabled) await deleteAppointmentReminders(config, item.requestId);
  const previous = await findSlot(config, item.organizationId, item.slotId);
  const updatedAt = new Date().toISOString();
  const next = { ...item, status: "reschedule_requested" as const, preferredSlots: [replacement.start],
    scheduledStart: replacement.start, scheduledEnd: replacement.end, timeZone: replacement.timeZone,
    slotId: replacement.slotId, priceMinor: replacement.priceMinor, cancellationPolicy: replacement.cancellationPolicy,
    cancellationWindowHours: replacement.cancellationWindowHours, cancellationFeeDueMinor: 0,
    joinUrl: null, providerMeetingId: null, version: version + 1, updatedAt, lastActionBy: "consumer" as const };
  const actions: ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"] = [
    { Update: { TableName: config.tableName, Key: { pk: item.pk, sk: item.sk },
      UpdateExpression: "SET #version=:next,#status=:status,preferredSlots=:slots,scheduledStart=:start,scheduledEnd=:end,#timeZone=:zone,slotId=:slot,priceMinor=:price,cancellationPolicy=:policy,cancellationWindowHours=:window,cancellationFeeDueMinor=:zero,joinUrl=:none,providerMeetingId=:none,updatedAt=:updated,lastActionBy=:by",
      ConditionExpression: "#version=:expected", ExpressionAttributeNames: { "#version": "version", "#status": "status", "#timeZone": "timeZone" }, ExpressionAttributeValues: {
        ":expected": version, ":next": version + 1, ":status": "reschedule_requested", ":slots": [replacement.start], ":start": replacement.start, ":end": replacement.end,
        ":zone": replacement.timeZone, ":slot": replacement.slotId, ":price": replacement.priceMinor, ":policy": replacement.cancellationPolicy,
        ":window": replacement.cancellationWindowHours, ":zero": 0, ":none": null, ":updated": updatedAt, ":by": "consumer",
      } } },
    { Update: { TableName: config.tableName, Key: { pk: replacement.pk, sk: replacement.sk }, UpdateExpression: "SET #status=:booked",
      ConditionExpression: "#status=:held AND heldBy=:person AND holdId=:hold AND holdExpiresAt>:now", ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":booked": "booked", ":held": "held", ":person": item.consumerPersonId, ":hold": holdId, ":now": Math.floor(Date.now() / 1000) } } },
    { Update: { TableName: config.tableName, Key: { pk: previous.pk, sk: previous.sk }, UpdateExpression: "SET #status=:available,heldBy=:none,holdId=:none,holdExpiresAt=:none",
      ConditionExpression: "#status=:booked", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":booked": "booked", ":available": "available", ":none": null } } },
  ];
  if (item.appointmentId) actions.push({ Put: { TableName: config.tableName, Item: { pk: item.pk, sk: `APPT#${item.appointmentId}`,
    appointmentId: item.appointmentId, organizationId: item.organizationId, consumerPersonId: item.consumerPersonId, requestId: item.requestId,
    slotId: replacement.slotId, status: "reschedule_requested", visitType: item.visitType, start: replacement.start, end: replacement.end,
    timeZone: replacement.timeZone, joinUrl: null, providerMeetingId: null, priceMinor: replacement.priceMinor, currency: replacement.currency,
    cancellationPolicy: replacement.cancellationPolicy, cancellationWindowHours: replacement.cancellationWindowHours, cancellationFeeDueMinor: 0, updatedAt } } });
  try { await document.send(new TransactWriteCommand({ TransactItems: actions })); }
  catch (error) { if ((error as { name?: string }).name === "TransactionCanceledException" || (error as { name?: string }).name === "ConditionalCheckFailedException") throw new TelehealthError("conflict"); throw error; }
  return publicItem(next, "consumer");
}

async function workforceAction(config: TelehealthConfiguration, actor: Actor, value: Record<string, unknown>) {
  exact(value, ["requestId", "action", "expectedVersion", "scheduledStart", "scheduledEnd", "timeZone"], ["requestId", "action", "expectedVersion"]);
  const item = await find(config, actor.organizationId, String(value.requestId));
  if (!Number.isInteger(value.expectedVersion) || !["schedule", "reschedule", "cancel"].includes(String(value.action))) throw new TelehealthError("request_invalid");
  if (item.status === "cancelled") throw new TelehealthError("conflict");
  if (value.action === "cancel") return cancelRequest(config, item, Number(value.expectedVersion), "workforce");
  if (value.action === "schedule" && !["requested", "reschedule_requested", "awaiting_provider"].includes(item.status)) throw new TelehealthError("conflict");
  if (value.action === "reschedule" && !["scheduled", "reschedule_requested", "awaiting_provider"].includes(item.status)) throw new TelehealthError("conflict");
  const start = String(value.scheduledStart ?? ""); const end = String(value.scheduledEnd ?? ""); const timeZone = zone(value.timeZone);
  if (!date(start) || !date(end) || new Date(end) <= new Date(start)) throw new TelehealthError("request_invalid");
  let meeting: { joinUrl: string; providerMeetingId: string } | null = null;
  if (config.zoomEnabled) {
    if (!config.zoomBaaVerified) throw new TelehealthError("provider_unavailable");
    const meetingInput = { agenda: `Governed appointment request ${item.requestId}`, start, durationMinutes: Math.ceil((+new Date(end) - +new Date(start)) / 60_000), timeZone };
    meeting = item.providerMeetingId && item.joinUrl
      ? await updateZoomMeeting(config, item.providerMeetingId, item.joinUrl, meetingInput)
      : await createZoomMeeting(config, meetingInput);
  }
  return scheduleRequest(config, item, Number(value.expectedVersion), {
    status: meeting ? "scheduled" : "awaiting_provider", scheduledStart: start, scheduledEnd: end,
    joinUrl: meeting?.joinUrl ?? null, providerMeetingId: meeting?.providerMeetingId ?? null, timeZone,
  });
}

async function scheduleRequest(config: TelehealthConfiguration, item: AppointmentItem, version: number, values: Partial<AppointmentItem>) {
  if (version !== item.version) throw new TelehealthError("conflict");
  const appointmentId = item.appointmentId ?? randomUUID(); const updatedAt = new Date().toISOString();
  const next = { ...item, ...values, appointmentId, version: version + 1, updatedAt, lastActionBy: "workforce" as const };
  const appointment = { pk: item.pk, sk: `APPT#${appointmentId}`, appointmentId, organizationId: item.organizationId, consumerPersonId: item.consumerPersonId,
    requestId: item.requestId, slotId: item.slotId, status: values.status, visitType: item.visitType, start: values.scheduledStart, end: values.scheduledEnd,
    timeZone: values.timeZone, joinUrl: values.joinUrl, providerMeetingId: values.providerMeetingId, priceMinor: item.priceMinor, currency: item.currency,
    cancellationPolicy: item.cancellationPolicy, cancellationWindowHours: item.cancellationWindowHours,
    cancellationFeeDueMinor: item.cancellationFeeDueMinor, updatedAt };
  try { await document.send(new TransactWriteCommand({ TransactItems: [
    { Update: { TableName: config.tableName, Key: { pk: item.pk, sk: item.sk }, UpdateExpression: "SET #version=:next,#status=:status,scheduledStart=:start,scheduledEnd=:end,joinUrl=:join,providerMeetingId=:meeting,#timeZone=:zone,appointmentId=:appointment,updatedAt=:updated,lastActionBy=:by", ConditionExpression: "#version=:expected", ExpressionAttributeNames: { "#version": "version", "#status": "status", "#timeZone": "timeZone" }, ExpressionAttributeValues: { ":expected": version, ":next": version + 1, ":status": values.status, ":start": values.scheduledStart, ":end": values.scheduledEnd, ":join": values.joinUrl, ":meeting": values.providerMeetingId, ":zone": values.timeZone, ":appointment": appointmentId, ":updated": updatedAt, ":by": "workforce" } } },
    { Put: { TableName: config.tableName, Item: appointment } },
  ] })); } catch(error) { if ((error as { name?: string }).name === "TransactionCanceledException" || (error as { name?: string }).name === "ConditionalCheckFailedException") throw new TelehealthError("conflict"); throw error; }
  // A consent signed at booking follows the appointment into its visit record
  // so the desktop sees one consent state per appointment. Idempotent: a visit
  // record that already exists (e.g. a reschedule) is left untouched.
  if (item.consent) {
    try {
      await document.send(new PutCommand({ TableName: config.tableName, Item: newVisitItem(item.organizationId, appointmentId,
        { requestId: item.requestId, consumerPersonId: item.consumerPersonId, patientRecordId: null, practitionerUserId: null, scheduledStart: values.scheduledStart ?? null, scheduledEnd: values.scheduledEnd ?? null, timeZone: values.timeZone ?? null, providerMeetingId: values.providerMeetingId ?? null, joinUrl: values.joinUrl ?? null },
        [item.consent]), ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" }));
    } catch (error) {
      if ((error as { name?: string }).name !== "ConditionalCheckFailedException") throw error;
    }
  }
  if (config.remindersEnabled) {
    try {
      await scheduleAppointmentReminders(config, next);
      next.reminderStatus = "scheduled";
      await document.send(new UpdateCommand({ TableName: config.tableName, Key: { pk: item.pk, sk: item.sk }, UpdateExpression: "SET reminderStatus=:scheduled", ExpressionAttributeValues: { ":scheduled": "scheduled" } }));
    } catch {
      next.reminderStatus = "failed";
    }
  }
  return publicItem(next, "workforce");
}

async function zoomAccess(config: TelehealthConfiguration) {
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId: config.zoomSecretArn }));
  let parsed: Record<string, unknown>; try { parsed = JSON.parse(secret.SecretString ?? "") as Record<string, unknown>; } catch { throw new TelehealthError("provider_unavailable"); }
  const accountId = field(parsed, "accountId"); const clientId = field(parsed, "clientId"); const clientSecret = field(parsed, "clientSecret"); const userId = field(parsed, "userId");
  const tokenResponse = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}` } });
  if (!tokenResponse.ok) throw new TelehealthError("provider_unavailable");
  const token = await tokenResponse.json() as Record<string, unknown>; const accessToken = field(token, "access_token");
  return { accessToken, userId };
}

async function createZoomMeeting(config: TelehealthConfiguration, input: { agenda: string; start: string; durationMinutes: number; timeZone: string }) {
  const { accessToken, userId } = await zoomAccess(config);
  const meetingResponse = await fetch(`https://api.zoom.us/v2/users/${encodeURIComponent(userId)}/meetings`, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ topic: "AI Longevity Pro telehealth appointment", type: 2, start_time: input.start, duration: input.durationMinutes, timezone: input.timeZone, agenda: input.agenda, settings: { waiting_room: true, join_before_host: false, meeting_authentication: true } }) });
  if (!meetingResponse.ok) throw new TelehealthError("provider_unavailable");
  return zoomMeetingRecord(await meetingResponse.json() as Record<string, unknown>, userId);
}
type ZoomMeetingRecord = { providerMeetingId: string; providerMeetingUuid: string | null; joinUrl: string; password: string };
/** Does a provider object name the configured host account (by user id or email)? Absent host fields are no match: the account is verified, not assumed. */
function namesConfiguredHost(record: Record<string, unknown>, userId: string, keys: { id: string; email: string }): boolean {
  const id = record[keys.id]; const email = record[keys.email];
  if (typeof id === "string" && id.length > 0 && id === userId) return true;
  return typeof email === "string" && email.length > 0 && email.toLowerCase() === userId.toLowerCase();
}
/**
 * The fields a visit keeps from Zoom's meeting object. `password` is the API's
 * meeting password; the join URL's `pwd` is an encrypted token and is never
 * used. The object must name the configured host account: a meeting under
 * another host is never bound, whatever its marker says.
 */
function zoomMeetingRecord(meeting: Record<string, unknown>, userId: string): ZoomMeetingRecord {
  const id = String(meeting.id ?? "");
  if (!/^\d{9,12}$/.test(id)) throw new TelehealthError("provider_unavailable");
  if (!namesConfiguredHost(meeting, userId, { id: "host_id", email: "host_email" })) throw new TelehealthError("provider_unavailable");
  const password = meeting.password === undefined || meeting.password === null ? "" : String(meeting.password);
  if (password.length > 64) throw new TelehealthError("provider_unavailable");
  return { providerMeetingId: id, providerMeetingUuid: typeof meeting.uuid === "string" ? meeting.uuid : null, joinUrl: field(meeting, "join_url"), password };
}
/** GET one meeting by id: the password and uuid for a meeting this Lambda did not just create (request-booked, or adopted by evidence). Null when the provider says it no longer exists. */
async function getZoomMeeting(config: TelehealthConfiguration, meetingId: string): Promise<ZoomMeetingRecord | null> {
  const { accessToken, userId } = await zoomAccess(config);
  const result = await fetch(`https://api.zoom.us/v2/meetings/${encodeURIComponent(meetingId)}`, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { authorization: `Bearer ${accessToken}` } });
  if (result.status === 404) return null;
  if (!result.ok) throw new TelehealthError("provider_unavailable");
  const record = zoomMeetingRecord(await result.json() as Record<string, unknown>, userId);
  if (record.providerMeetingId !== meetingId.replace(/\D/g, "")) throw new TelehealthError("provider_unavailable");
  return record;
}

async function updateZoomMeeting(config: TelehealthConfiguration, meetingId: string, joinUrl: string, input: { agenda: string; start: string; durationMinutes: number; timeZone: string }) {
  const { accessToken } = await zoomAccess(config);
  const result = await fetch(`https://api.zoom.us/v2/meetings/${encodeURIComponent(meetingId)}`, { method: "PATCH", redirect: "manual", signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ start_time: input.start, duration: input.durationMinutes, timezone: input.timeZone, agenda: input.agenda }) });
  if (!result.ok) throw new TelehealthError("provider_unavailable");
  return { joinUrl, providerMeetingId: meetingId };
}

async function deleteZoomMeeting(config: TelehealthConfiguration, meetingId: string) {
  const { accessToken } = await zoomAccess(config);
  const result = await fetch(`https://api.zoom.us/v2/meetings/${encodeURIComponent(meetingId)}`, { method: "DELETE", redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { authorization: `Bearer ${accessToken}` } });
  if (!result.ok && result.status !== 404) throw new TelehealthError("provider_unavailable");
}

/* ---------------------------------------------------------------- visits */

const CONSENT_SCOPE = "telehealth_recording";
/** An `acquired` lease older than this is treated as abandoned (the holder died before any provider call). */
const MEETING_LEASE_TTL_MS = 2 * 60_000;
/**
 * The settlement window for a dispatched create whose outcome is unknown: a
 * new create is admitted only once this much time has passed since dispatch
 * AND a complete, exact listing shows no meeting for that attempt. The window
 * must exceed the longest life of the invocation that sent the create (the
 * function timeout, asserted against the template in tests) by a wide margin,
 * so "the admitted writer is finished" is a fact about the platform, not a
 * guess about the provider's list.
 */
export const MEETING_SETTLEMENT_MS = 5 * 60_000;
export const MAX_SUMMARY_BYTES = 256 * 1024;
const MAX_LIST_PAGES = 20;
const MAX_NOTE_HISTORY = 20;

function visitKey(organizationId: string, appointmentId: string) { return { pk: `ORG#${organizationId}`, sk: `VISIT#${appointmentId}` }; }
function newVisitItem(organizationId: string, appointmentId: string, binding: VisitBinding, consents: VisitConsent[]): VisitItem {
  const now = new Date().toISOString();
  return { ...visitKey(organizationId, appointmentId), appointmentId, organizationId, requestId: binding.requestId,
    consumerPersonId: binding.consumerPersonId, scheduledStart: binding.scheduledStart, scheduledEnd: binding.scheduledEnd, timeZone: binding.timeZone,
    patientRecordId: binding.patientRecordId, practitionerUserId: binding.practitionerUserId,
    status: "scheduled", consents, meetingLease: null, providerMeetingId: null, providerMeetingUuid: null, joinUrl: null, passcode: null,
    startedAt: null, endedAt: null, providerShutdown: { status: "not_started", attemptedAt: null, confirmedAt: null, detail: null },
    flags: [], quickNotes: "", note: null, noteHistory: [], version: 1, createdAt: now, updatedAt: now };
}
async function findVisit(config: TelehealthConfiguration, organizationId: string, appointmentId: string): Promise<VisitItem | null> {
  if (!UUID.test(appointmentId)) throw new TelehealthError("request_invalid");
  const result = await document.send(new GetCommand({ TableName: config.tableName, Key: visitKey(organizationId, appointmentId) }));
  return (result.Item as VisitItem | undefined) ?? null;
}
async function requireVisit(config: TelehealthConfiguration, organizationId: string, appointmentId: string): Promise<VisitItem> {
  const visit = await findVisit(config, organizationId, appointmentId);
  if (!visit) throw new TelehealthError("not_found");
  return visit;
}
/** Optimistic replace: the whole record is rewritten under its version so two tabs cannot interleave. */
async function saveVisit(config: TelehealthConfiguration, visit: VisitItem, expectedVersion: number | null) {
  const next: VisitItem = { ...visit, version: (expectedVersion ?? 0) + 1, updatedAt: new Date().toISOString() };
  try {
    await document.send(new PutCommand({ TableName: config.tableName, Item: next,
      ...(expectedVersion === null
        ? { ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" }
        : { ConditionExpression: "#version = :expected", ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: { ":expected": expectedVersion } }) }));
  } catch (error) {
    if ((error as { name?: string }).name === "ConditionalCheckFailedException") throw new TelehealthError("conflict");
    throw error;
  }
  return next;
}
function activeConsents(visit: VisitItem) { return visit.consents.filter((consent) => consent.status === "granted"); }
/** The passcode is a join credential: it leaves the Lambda only inside a start-visit session, never in a list. */
function publicVisit(visit: VisitItem) {
  const result: Partial<VisitItem> = { ...visit };
  delete result.pk; delete result.sk; delete result.passcode; delete result.meetingLease; delete result.settledLeaseIds;
  return { ...result, consentSigned: activeConsents(visit).length > 0 };
}
/** Day-list projection: state only, no note bodies or AI text (bounded page size, nothing to leak in a list). */
function publicVisitSummary(visit: VisitItem) {
  const { note, flags: _flags, quickNotes: _quickNotes, noteHistory: _history, ...rest } = publicVisit(visit);
  return { ...rest, flags: [], quickNotes: "", noteHistory: [],
    note: note ? { status: note.status, source: note.source, zoomSummaryId: note.zoomSummaryId, revision: note.revision, importedAt: note.importedAt, signedAt: note.signedAt, signedBy: note.signedBy } : null };
}

/* ---- the governed consent authority (identity API, caller's workforce JWT forwarded) ---- */

async function identityApi<T>(config: TelehealthConfiguration, actor: Actor, path: string, init?: { method: "POST"; body: Record<string, unknown> }, notFound: TelehealthRefusal = "service_unavailable"): Promise<T> {
  if (!/^https:\/\//.test(config.identityApiOrigin)) throw new TelehealthError("service_unavailable");
  let response: Response;
  try {
    response = await fetch(`${config.identityApiOrigin}${path}`, { method: init?.method ?? "GET", redirect: "manual", signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${actor.bearer}`, accept: "application/json", ...(init ? { "content-type": "application/json" } : {}) },
      ...(init ? { body: JSON.stringify(init.body) } : {}) });
  } catch { throw new TelehealthError("service_unavailable"); }
  let payload: unknown; try { payload = await response.json(); } catch { throw new TelehealthError("service_unavailable"); }
  if (!response.ok || !payload || typeof payload !== "object" || !("data" in payload)) {
    if (response.status === 403) throw new TelehealthError("identity_refused");
    if (response.status === 404 || response.status === 409) throw new TelehealthError(notFound);
    throw new TelehealthError("service_unavailable");
  }
  return (payload as { data: T }).data;
}
type ArtifactRecord = { artifactId: string; scope: string; artifactVersion: string; contentSha256: string; jurisdiction: string; approvedAt: string };
type CurrentConsentRecord = { status: "granted" | "revoked" | "none"; patientRecordId: string | null; connectionId: string | null; consentId: string | null; artifactId: string | null; artifactVersion: string | null; contentSha256: string | null; artifactStatus: "approved" | "retired" | null };
const currentArtifact = (config: TelehealthConfiguration, actor: Actor) =>
  identityApi<ArtifactRecord>(config, actor, `/clinical-core/workforce/consent-artifact?scope=${CONSENT_SCOPE}`, undefined, "consent_artifact_unavailable");
const currentGrant = (config: TelehealthConfiguration, actor: Actor, consumerPersonId: string) =>
  identityApi<CurrentConsentRecord>(config, actor, `/clinical-core/workforce/consents/current?scope=${CONSENT_SCOPE}&consumerPersonId=${encodeURIComponent(consumerPersonId)}`);

/**
 * Is there CURRENT authority to run (or read the AI summary of) this visit?
 *   1. a granted, un-withdrawn receipt on the visit;
 *   2. whose artifact is still the organization's approved artifact (a
 *      retired/superseded release is no authority, whatever was signed);
 *   3. and, when the patient has an app connection, a current `granted`
 *      grant for the scope in the identity authority (withdrawal there
 *      revokes the visit too).
 * Refusals name their reason; nothing (no secret, no provider call) runs first.
 */
async function requireConsentAuthority(config: TelehealthConfiguration, actor: Actor, visit: VisitItem): Promise<VisitConsent> {
  const receipts = activeConsents(visit);
  if (receipts.length === 0) throw new TelehealthError("consent_required");
  const receipt = receipts[receipts.length - 1];
  const artifact = await currentArtifact(config, actor);
  if (artifact.artifactId !== receipt.artifactId || artifact.contentSha256 !== receipt.contentSha256) throw new TelehealthError("consent_superseded");
  if (visit.consumerPersonId) {
    // A patient-app visit stands on a live connection and its current grant.
    // A connection that disappeared or was replaced is lost authority, not a
    // fallback to staff-only consent.
    const grant = await currentGrant(config, actor, visit.consumerPersonId);
    if (!grant.connectionId) throw new TelehealthError("consent_required");
    if (receipt.connectionId && receipt.connectionId !== grant.connectionId) throw new TelehealthError("consent_required");
    if (grant.status !== "granted" || grant.artifactId !== artifact.artifactId || grant.artifactStatus !== "approved") {
      throw new TelehealthError(grant.status === "revoked" ? "consent_withdrawn" : "consent_required");
    }
  }
  return receipt;
}

/* ---- appointment binding ---- */

type VisitBinding = { requestId: string | null; consumerPersonId: string | null; patientRecordId: string | null; practitionerUserId: string | null; scheduledStart: string | null; scheduledEnd: string | null; timeZone: string | null; providerMeetingId: string | null; joinUrl: string | null };
const CLOSED_APPOINTMENT_STATUSES = new Set(["cancelled", "no_show"]);
/**
 * The authoritative clinical-calendar appointment, read INSIDE the AWS
 * boundary through the reviewed desktop-compatibility operation
 * (`get_desktop_calendar`) with the caller's own JWT — so a direct call to
 * these routes gets exactly the appointments that practitioner can see under
 * the clinical core's role rules, and nothing else. Nonexistent, another
 * organization, revoked membership or no access: refused before any write.
 */
async function calendarWindow(config: TelehealthConfiguration, actor: Actor, fromIso: string, toIso: string): Promise<Array<Record<string, unknown>>> {
  const calendar = await identityApi<{ appointments?: Array<Record<string, unknown>> }>(config, actor, "/clinical-core/workforce/data-compatibility", { method: "POST",
    body: { kind: "rpc", functionName: "get_desktop_calendar", args: { _organization_id: actor.organizationId, _from: fromIso, _to: toIso } } });
  return (Array.isArray(calendar?.appointments) ? calendar.appointments : []).filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object");
}
async function calendarAppointment(config: TelehealthConfiguration, actor: Actor, appointmentId: string, hintIso: string | null): Promise<{ patientRecordId: string | null; practitionerUserId: string | null; status: string; startsAt: string; endsAt: string }> {
  const center = hintIso && date(hintIso) ? Date.parse(hintIso) : Date.now();
  const from = new Date(center - 14 * 86_400_000).toISOString(); const to = new Date(center + 14 * 86_400_000).toISOString();
  const row = (await calendarWindow(config, actor, from, to)).find((entry) => entry.id === appointmentId);
  if (!row) throw new TelehealthError("not_found");
  if (row.appointment_type !== "telehealth" || typeof row.starts_at !== "string" || typeof row.ends_at !== "string") throw new TelehealthError("request_invalid");
  return { patientRecordId: typeof row.patient_id === "string" ? row.patient_id : null, practitionerUserId: typeof row.practitioner_user_id === "string" ? row.practitioner_user_id : null,
    status: String(row.status ?? ""), startsAt: row.starts_at, endsAt: row.ends_at };
}
/**
 * A visit's subject and practitioner are fixed at creation. If the authority
 * now names a different patient or practitioner for the appointment, the
 * receipts on this record were given by someone else for someone else: no
 * read, consent, credential, meeting or session is issued against it. The
 * appointment must be corrected, or a new visit (and consent) created.
 */
function assertImmutableIdentity(visit: VisitItem, binding: VisitBinding) {
  if (visit.patientRecordId !== binding.patientRecordId || visit.practitionerUserId !== binding.practitionerUserId) throw new TelehealthError("appointment_reassigned");
}
/**
 * A patient-app visit is bound to its request: the request must exist in the
 * caller's organization, name this exact appointment, and not be cancelled;
 * its stored times and meeting are authoritative. A desktop-booked visit is
 * bound to the clinical calendar's appointment as read above; the calendar's
 * stored times are what the visit keeps. Caller-supplied times are at most a
 * search hint. `mode: "close"` (ending a visit) tolerates a cancelled or
 * no-show appointment so an outstanding meeting can still be shut down.
 */
async function resolveBinding(config: TelehealthConfiguration, actor: Actor, appointmentId: string, requestId: string | null, supplied: { start?: unknown; end?: unknown; timeZone?: unknown }, mode: "mutate" | "close" = "mutate"): Promise<VisitBinding> {
  if (requestId !== null) {
    const request = await find(config, actor.organizationId, requestId);
    if (request.status === "cancelled" && mode === "mutate") throw new TelehealthError("appointment_cancelled");
    if (request.appointmentId !== appointmentId || !request.scheduledStart || !request.scheduledEnd) throw new TelehealthError("request_invalid");
    return { requestId, consumerPersonId: request.consumerPersonId, patientRecordId: null, practitionerUserId: null, scheduledStart: request.scheduledStart, scheduledEnd: request.scheduledEnd, timeZone: request.timeZone,
      providerMeetingId: request.providerMeetingId, joinUrl: request.joinUrl };
  }
  const hint = supplied.start === undefined || supplied.start === null ? null : String(supplied.start);
  const timeZone = supplied.timeZone === undefined || supplied.timeZone === null ? null : zone(supplied.timeZone);
  const appointment = await calendarAppointment(config, actor, appointmentId, hint);
  if (CLOSED_APPOINTMENT_STATUSES.has(appointment.status) && mode === "mutate") throw new TelehealthError("appointment_cancelled");
  return { requestId: null, consumerPersonId: null, patientRecordId: appointment.patientRecordId, practitionerUserId: appointment.practitionerUserId,
    scheduledStart: appointment.startsAt, scheduledEnd: appointment.endsAt, timeZone, providerMeetingId: null, joinUrl: null };
}
/**
 * Re-establish authority over an existing visit before acting on — or
 * reading — it: the same binding check the visit was created under, with the
 * caller's current JWT (revoked membership or a record the caller may not see
 * refuses), plus the immutable subject/practitioner identity. The lookup is
 * centred on the visit's stored time, so a historical record is reached
 * through its own appointment, not a future calendar entry.
 */
async function requireBindingAuthority(config: TelehealthConfiguration, actor: Actor, visit: VisitItem, mode: "mutate" | "close" = "mutate", supplied: { timeZone?: unknown } = {}): Promise<VisitBinding> {
  const binding = await resolveBinding(config, actor, visit.appointmentId, visit.requestId, { start: visit.scheduledStart, timeZone: supplied.timeZone ?? visit.timeZone }, mode);
  assertImmutableIdentity(visit, binding);
  return binding;
}
function requestIdOf(value: Record<string, unknown>, existing: VisitItem | null): string | null {
  if (existing?.requestId) {
    if (value.requestId !== undefined && value.requestId !== null && value.requestId !== existing.requestId) throw new TelehealthError("request_invalid");
    return existing.requestId;
  }
  if (value.requestId === undefined || value.requestId === null) return null;
  if (!UUID.test(String(value.requestId))) throw new TelehealthError("request_invalid");
  return String(value.requestId);
}

/* ---- consent receipts ---- */

function buildReceipt(record: Record<string, unknown>, artifact: ArtifactRecord, method: VisitConsent["method"], recordedBy: string, grant: { grantId: string | null; connectionId: string | null }): VisitConsent {
  const signerName = String(record.signerName ?? "").trim(); const location = record.patientLocation;
  const authority = record.representativeAuthority === undefined ? "self" : String(record.representativeAuthority);
  if (record.agreed !== true || signerName.length < 2 || signerName.length > 200
    || !["self", "guardian", "healthcare_proxy", "legal_representative"].includes(authority)
    || !(location === undefined || location === null || (typeof location === "string" && location.trim().length <= 120))) throw new TelehealthError("request_invalid");
  return { consentId: randomUUID(), consentType: TELEHEALTH_CONSENT_TYPE, scope: CONSENT_SCOPE, artifactId: artifact.artifactId, artifactVersion: artifact.artifactVersion,
    contentSha256: artifact.contentSha256, signerName, method, representativeAuthority: authority as VisitConsent["representativeAuthority"], signedAt: new Date().toISOString(), recordedBy,
    patientLocation: typeof location === "string" && location.trim() ? location.trim() : null, grantId: grant.grantId, connectionId: grant.connectionId, status: "granted", withdrawnAt: null, withdrawnBy: null, withdrawalReason: null };
}
/** The patient app's consent at booking: it must name the exact approved artifact it displayed. */
function consentFromPatientApp(value: unknown, actor: Actor, artifact: ArtifactRecord): VisitConsent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TelehealthError("request_invalid");
  const record = value as Record<string, unknown>;
  exact(record, ["artifactId", "artifactVersion", "contentSha256", "signerName", "patientLocation", "representativeAuthority", "agreed"], ["artifactId", "artifactVersion", "contentSha256", "signerName", "agreed"]);
  if (record.artifactId !== artifact.artifactId || record.artifactVersion !== artifact.artifactVersion || record.contentSha256 !== artifact.contentSha256) throw new TelehealthError("consent_version_refused");
  return buildReceipt(record, artifact, "patient_app", actor.personId, { grantId: null, connectionId: null });
}

async function readConsentArtifact(config: TelehealthConfiguration, actor: Actor) {
  const artifact = await currentArtifact(config, actor);
  return { artifactId: artifact.artifactId, artifactVersion: artifact.artifactVersion, contentSha256: artifact.contentSha256, jurisdiction: artifact.jurisdiction, approvedAt: artifact.approvedAt, scope: CONSENT_SCOPE };
}

/**
 * Staff-attested consent for a visit. The receipt must name the organization's
 * CURRENT approved artifact (id, version, hash) — an unknown, retired or
 * superseded release is refused before anything is written. When the patient
 * has an app connection the grant is recorded in the governed authority
 * through the identity API (method `in_person`), so a later withdrawal there
 * revokes this visit too; the receipt stores the grant id. Append-only.
 */
async function recordVisitConsent(config: TelehealthConfiguration, actor: Actor, value: Record<string, unknown>) {
  exact(value, ["appointmentId", "requestId", "artifactId", "artifactVersion", "contentSha256", "signerName", "patientLocation", "representativeAuthority", "agreed", "start", "end", "timeZone"],
    ["appointmentId", "artifactId", "artifactVersion", "contentSha256", "signerName", "agreed"]);
  const appointmentId = String(value.appointmentId ?? "");
  if (!UUID.test(appointmentId) || value.agreed !== true) throw new TelehealthError("request_invalid");
  const existing = await findVisit(config, actor.organizationId, appointmentId);
  if (existing?.status === "cancelled") throw new TelehealthError("appointment_cancelled");
  const binding = await resolveBinding(config, actor, appointmentId, requestIdOf(value, existing), value);
  if (existing) assertImmutableIdentity(existing, binding); // a new receipt joins THIS subject's record, never a reassigned one
  const artifact = await currentArtifact(config, actor);
  if (value.artifactId !== artifact.artifactId || value.artifactVersion !== artifact.artifactVersion || value.contentSha256 !== artifact.contentSha256) throw new TelehealthError("consent_version_refused");
  let grant: { grantId: string | null; connectionId: string | null } = { grantId: null, connectionId: null };
  if (binding.consumerPersonId) {
    const current = await currentGrant(config, actor, binding.consumerPersonId);
    if (current.connectionId) {
      if (current.status === "granted" && current.artifactId === artifact.artifactId && current.artifactStatus === "approved") {
        grant = { grantId: current.consentId, connectionId: current.connectionId };
      } else {
        const recorded = await identityApi<{ consentId: string; connectionId: string; status: string }>(config, actor, "/clinical-core/workforce/consents/grant", { method: "POST",
          body: { connectionId: current.connectionId, artifactId: artifact.artifactId, scope: CONSENT_SCOPE, method: "in_person", representativeAuthority: value.representativeAuthority ?? "self" } });
        grant = { grantId: recorded.consentId, connectionId: recorded.connectionId };
      }
    }
  }
  const receipt = buildReceipt(value, artifact, "staff_attested", actor.personId, grant);
  const visit = existing ?? newVisitItem(actor.organizationId, appointmentId, binding, []);
  const saved = await saveVisit(config, { ...visit, consumerPersonId: visit.consumerPersonId ?? binding.consumerPersonId,
    scheduledStart: binding.scheduledStart ?? visit.scheduledStart, scheduledEnd: binding.scheduledEnd ?? visit.scheduledEnd, timeZone: visit.timeZone ?? binding.timeZone,
    consents: [...visit.consents, receipt] }, existing ? existing.version : null);
  return publicVisit(saved);
}

/** Withdrawal is append-only too: receipts are marked, never removed, and a governed grant is revoked through the identity API. */
async function withdrawVisitConsent(config: TelehealthConfiguration, actor: Actor, value: Record<string, unknown>) {
  exact(value, ["appointmentId", "expectedVersion", "reason"], ["appointmentId", "expectedVersion"]);
  const visit = await requireVisit(config, actor.organizationId, String(value.appointmentId ?? ""));
  if (!Number.isInteger(value.expectedVersion)) throw new TelehealthError("request_invalid");
  await requireBindingAuthority(config, actor, visit, "close");
  const reason = value.reason === undefined || value.reason === null ? "patient_request" : String(value.reason);
  if (!/^[a-z_]{1,64}$/.test(reason)) throw new TelehealthError("request_invalid");
  const at = new Date().toISOString();
  const withGrant = activeConsents(visit).find((consent) => consent.grantId && consent.connectionId);
  if (withGrant?.connectionId) {
    await identityApi(config, actor, "/clinical-core/workforce/consents/revoke", { method: "POST", body: { connectionId: withGrant.connectionId, scope: CONSENT_SCOPE, reasonCode: "patient_request" } });
  }
  const consents = visit.consents.map((consent) => consent.status === "granted" ? { ...consent, status: "withdrawn" as const, withdrawnAt: at, withdrawnBy: actor.personId, withdrawalReason: reason } : consent);
  const saved = await saveVisit(config, { ...visit, consents }, Number(value.expectedVersion));
  return publicVisit(saved);
}

/* ---- the meeting: one admitted creation per visit, settled against the provider ---- */

function leaseExpired(lease: MeetingLease) { return Date.now() - Date.parse(lease.acquiredAt) > MEETING_LEASE_TTL_MS; }
function leaseSettled(lease: MeetingLease) { return Date.now() - Date.parse(lease.dispatchedAt ?? lease.acquiredAt) >= MEETING_SETTLEMENT_MS; }
/**
 * Provider meetings carry an exact marker — this visit AND this attempt — so
 * the outcome of one specific create can be looked up, never inferred from
 * "some meeting for this appointment".
 */
const MARKER_PREFIX = "Governed telehealth visit alp-visit:";
function meetingMarker(appointmentId: string, leaseId: string) { return `${MARKER_PREFIX}${appointmentId}:${leaseId}`; }
const MARKER_PATTERN = /^Governed telehealth visit alp-visit:([0-9a-f-]{36}):([0-9a-f-]{36})$/i;
function parseMarker(agenda: unknown): { appointmentId: string; leaseId: string } | null {
  if (typeof agenda !== "string") return null;
  const match = MARKER_PATTERN.exec(agenda);
  return match ? { appointmentId: match[1].toLowerCase(), leaseId: match[2].toLowerCase() } : null;
}
const MAX_LIST_LOOKUP_PAGES = 10;
type MarkerMeeting = { id: string; leaseId: string };
/**
 * EVERY upcoming meeting of the configured host carrying this visit's marker,
 * with the attempt each one belongs to. The listing always runs to its last
 * page (no early return on a first match, so a duplicate is seen); `complete`
 * is false when the page bound was hit, and an incomplete listing is never
 * taken as "nothing exists". Matching is exact, never substring.
 */
async function listMarkerMeetings(config: TelehealthConfiguration, appointmentId: string): Promise<{ matches: MarkerMeeting[]; complete: boolean }> {
  const { accessToken, userId } = await zoomAccess(config);
  const wanted = appointmentId.toLowerCase();
  const matches: MarkerMeeting[] = [];
  let nextPageToken = "";
  for (let page = 0; page < MAX_LIST_LOOKUP_PAGES; page += 1) {
    const result = await fetch(`https://api.zoom.us/v2/users/${encodeURIComponent(userId)}/meetings?type=upcoming&page_size=300${nextPageToken ? `&next_page_token=${encodeURIComponent(nextPageToken)}` : ""}`,
      { method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { authorization: `Bearer ${accessToken}` } });
    if (!result.ok) throw new TelehealthError("provider_unavailable");
    const payload = await result.json() as { meetings?: Array<Record<string, unknown>>; next_page_token?: string };
    for (const meeting of payload.meetings ?? []) {
      const marker = parseMarker(meeting?.agenda);
      if (marker && marker.appointmentId === wanted && meeting.id !== undefined && meeting.id !== null) matches.push({ id: String(meeting.id), leaseId: marker.leaseId });
    }
    nextPageToken = typeof payload.next_page_token === "string" ? payload.next_page_token : "";
    if (!nextPageToken) return { matches, complete: true };
  }
  return { matches, complete: false };
}
/**
 * Sort a complete listing against the visit: the one meeting of the attempt
 * being settled (adoptable), meetings of attempts already settled as absent
 * (late materialisations: orphans, deleted), and anything else carrying this
 * visit's marker (an unknown attempt, or a duplicate: ambiguous, refused).
 */
async function classifyMarkerMeetings(config: TelehealthConfiguration, visit: VisitItem, attemptLeaseId: string | null, matches: MarkerMeeting[]): Promise<ZoomMeetingRecord | null> {
  const settled = new Set((visit.settledLeaseIds ?? []).map((id) => id.toLowerCase()));
  const own = matches.filter((meeting) => attemptLeaseId !== null && meeting.leaseId === attemptLeaseId.toLowerCase());
  const orphans = matches.filter((meeting) => settled.has(meeting.leaseId));
  const foreign = matches.filter((meeting) => !own.includes(meeting) && !orphans.includes(meeting));
  for (const orphan of orphans) { try { await deleteZoomMeeting(config, orphan.id); } catch { /* seen again on the next listing */ } }
  if (foreign.length > 0 || own.length > 1) throw new TelehealthError("meeting_unsettled");
  if (own.length === 0) return null;
  const record = await getZoomMeeting(config, own[0].id); // the list omits the password; the GET also verifies the host
  if (!record) return null;
  return record;
}
/** Conditional lease write under the visit's version. */
async function writeLease(config: TelehealthConfiguration, visit: VisitItem, lease: MeetingLease | null, settledLeaseIds = visit.settledLeaseIds ?? []): Promise<VisitItem> {
  return saveVisit(config, { ...visit, meetingLease: lease, settledLeaseIds }, visit.version);
}
/**
 * Settle an inherited lease before this attempt may hold one:
 *   - `acquired` and expired → the previous holder never reached the provider; take over;
 *   - `acquired` and live   → another start is in progress; refuse (`conflict`);
 *   - `dispatched` with the created id → exact evidence: adopt, or clear when the provider says it is gone;
 *   - `dispatched` without one → the outcome of THAT attempt is looked up by its exact marker in a
 *     COMPLETE listing. Found once → adopt. Not found: the attempt stays open (`meeting_unsettled`)
 *     until the settlement window since dispatch has passed — the invocation that sent the create
 *     cannot still be running — and only then is it recorded as settled-absent, so a meeting that
 *     materialises later under that marker is an orphan and is never adopted. Ambiguity (two
 *     meetings for one attempt, or a marker from no known attempt) is refused, not resolved by
 *     picking a row.
 * An empty provider list on its own never admits a new create.
 */
async function settleInheritedLease(config: TelehealthConfiguration, visit: VisitItem): Promise<VisitItem> {
  const lease = visit.meetingLease;
  if (!lease) return visit;
  if (lease.state === "acquired") {
    if (!leaseExpired(lease)) throw new TelehealthError("conflict");
    return visit;
  }
  if (lease.createdMeetingId) {
    const record = await getZoomMeeting(config, lease.createdMeetingId);
    if (record) return bindMeeting(config, visit, record);
    return writeLease(config, visit, null);
  }
  const listing = await listMarkerMeetings(config, visit.appointmentId);
  if (!listing.complete) throw new TelehealthError("provider_unavailable");
  const found = await classifyMarkerMeetings(config, visit, lease.leaseId, listing.matches);
  if (found) return bindMeeting(config, visit, found);
  if (!leaseSettled(lease)) throw new TelehealthError("meeting_unsettled");
  return writeLease(config, visit, null, [...(visit.settledLeaseIds ?? []), lease.leaseId].slice(-20));
}
/**
 * Bind a provider meeting to the visit and clear the lease. If the receipt is
 * lost (the write throws), the visit is reread ONCE: a write that actually
 * landed is returned as success, never undone; otherwise the current row is
 * handed back so the caller can decide with evidence, not guesses.
 */
async function tryBindMeeting(config: TelehealthConfiguration, visit: VisitItem, meeting: ZoomMeetingRecord): Promise<{ ok: true; visit: VisitItem } | { ok: false; current: VisitItem | null; error: unknown }> {
  try {
    return { ok: true, visit: await saveVisit(config, { ...visit, meetingLease: null, providerMeetingId: meeting.providerMeetingId, providerMeetingUuid: meeting.providerMeetingUuid, joinUrl: meeting.joinUrl, passcode: meeting.password }, visit.version) };
  } catch (error) {
    const current = await findVisit(config, visit.organizationId, visit.appointmentId);
    if (current?.providerMeetingId === meeting.providerMeetingId) return { ok: true, visit: current };
    return { ok: false, current, error };
  }
}
async function bindMeeting(config: TelehealthConfiguration, visit: VisitItem, meeting: ZoomMeetingRecord): Promise<VisitItem> {
  const bound = await tryBindMeeting(config, visit, meeting);
  if (bound.ok) return bound.visit;
  throw bound.error;
}
/** Create or adopt the provider meeting under a durable lease; bind it, or leave exact evidence of what this attempt did. */
async function admitProviderMeeting(config: TelehealthConfiguration, visit: VisitItem, binding: VisitBinding): Promise<VisitItem> {
  if (visit.providerMeetingId && visit.joinUrl && visit.passcode !== null) return visit;
  if (visit.providerMeetingId) {
    // Bound before passwords were stored: read the real password now.
    const record = await getZoomMeeting(config, visit.providerMeetingId);
    if (!record) throw new TelehealthError("provider_unavailable");
    return bindMeeting(config, visit, record);
  }
  if (binding.providerMeetingId) {
    // A patient-app visit already has the meeting its reminders link to.
    const record = await getZoomMeeting(config, binding.providerMeetingId);
    if (!record) throw new TelehealthError("provider_unavailable");
    return bindMeeting(config, visit, record);
  }
  const settled = await settleInheritedLease(config, visit);
  if (settled.providerMeetingId) return settled;
  const lease: MeetingLease = { leaseId: randomUUID(), acquiredAt: new Date().toISOString(), state: "acquired", dispatchedAt: null, createdMeetingId: null };
  let held = await writeLease(config, settled, lease);
  // A COMPLETE exact listing before creating: nothing of this visit may exist at the provider
  // (orphans of settled attempts are removed here; anything unexplained refuses).
  let listing: { matches: MarkerMeeting[]; complete: boolean };
  try { listing = await listMarkerMeetings(config, visit.appointmentId); } catch (error) { await writeLease(config, held, null); throw error; }
  if (!listing.complete) { await writeLease(config, held, null); throw new TelehealthError("provider_unavailable"); }
  try { await classifyMarkerMeetings(config, held, null, listing.matches); } catch (error) { await writeLease(config, held, null); throw error; }
  // The create is recorded as dispatched BEFORE it is sent: a thrown POST leaves the fence up.
  const dispatched: MeetingLease = { ...lease, state: "dispatched", dispatchedAt: new Date().toISOString() };
  held = await writeLease(config, held, dispatched);
  let created: ZoomMeetingRecord;
  try {
    created = await createZoomMeeting(config, {
      agenda: meetingMarker(visit.appointmentId, lease.leaseId), start: binding.scheduledStart ?? new Date().toISOString(),
      durationMinutes: Math.max(15, Math.ceil(((binding.scheduledEnd ? +new Date(binding.scheduledEnd) : 0) - (binding.scheduledStart ? +new Date(binding.scheduledStart) : 0)) / 60_000) || 30),
      timeZone: binding.timeZone ?? "UTC" });
  } catch {
    throw new TelehealthError("provider_unavailable"); // lease stays dispatched; the next start settles it by exact marker
  }
  // Exact provider-attempt evidence, kept whatever happens next.
  try {
    held = await writeLease(config, held, { ...dispatched, createdMeetingId: created.providerMeetingId });
  } catch (error) {
    const current = await findVisit(config, visit.organizationId, visit.appointmentId);
    if (current?.meetingLease?.leaseId === lease.leaseId && current.meetingLease.createdMeetingId === created.providerMeetingId) held = current;
    else { try { await deleteZoomMeeting(config, created.providerMeetingId); } catch { /* exact-marker settlement on the next start */ } throw error; }
  }
  const bound = await tryBindMeeting(config, held, created);
  if (bound.ok) return bound.visit;
  const { current } = bound;
  if (current && (current.status === "cancelled" || activeConsents(current).length === 0 || (current.providerMeetingId && current.providerMeetingId !== created.providerMeetingId))) {
    // The visit moved on underneath this attempt (cancelled, consent withdrawn, bound elsewhere):
    // the meeting it created will never be used and is removed.
    try { await deleteZoomMeeting(config, created.providerMeetingId); } catch { /* evidence remains on the lease */ }
    throw new TelehealthError(current.status === "cancelled" ? "appointment_cancelled" : activeConsents(current).length === 0 ? "consent_withdrawn" : "conflict");
  }
  throw bound.error; // evidence (createdMeetingId) remains on the dispatched lease for the next start
}

/**
 * Starting a visit is the server-side consent control: no current consent
 * authority, no meeting and no SDK session — whatever the UI showed. Returns
 * the embedded-meeting session (meeting number, passcode, short-lived Meeting
 * SDK signature, host ZAK) only when Zoom is enabled under a verified BAA.
 */
async function startVisit(config: TelehealthConfiguration, actor: Actor, value: Record<string, unknown>) {
  exact(value, ["appointmentId", "requestId", "start", "end", "timeZone", "hostDisplayName"], ["appointmentId", "hostDisplayName"]);
  const appointmentId = String(value.appointmentId ?? ""); const hostDisplayName = String(value.hostDisplayName ?? "").trim();
  if (!UUID.test(appointmentId) || hostDisplayName.length < 1 || hostDisplayName.length > 120) throw new TelehealthError("request_invalid");
  const visit = await findVisit(config, actor.organizationId, appointmentId);
  if (!visit) throw new TelehealthError("consent_required");
  if (visit.status === "cancelled") throw new TelehealthError("appointment_cancelled");
  if (visit.status === "ended" || visit.status === "ending") throw new TelehealthError("conflict");
  requestIdOf(value, visit);
  // Authority first, in order: the appointment (current calendar access, same subject and
  // practitioner as the record), then consent. Times reconcile from the authority; identity never does.
  const binding = await requireBindingAuthority(config, actor, visit, "mutate", value);
  await requireConsentAuthority(config, actor, visit);
  if (!config.zoomEnabled || !config.zoomBaaVerified) throw new TelehealthError("provider_unavailable");
  const reconciled: VisitItem = { ...visit, scheduledStart: binding.scheduledStart ?? visit.scheduledStart, scheduledEnd: binding.scheduledEnd ?? visit.scheduledEnd, timeZone: visit.timeZone ?? binding.timeZone };
  const withMeeting = await admitProviderMeeting(config, reconciled, binding);
  if (withMeeting !== reconciled) {
    // Provider work took time: a withdrawal or reassignment meanwhile must stop the
    // session here, after the meeting is bound and before any credential is issued.
    await requireBindingAuthority(config, actor, withMeeting, "mutate", value);
    await requireConsentAuthority(config, actor, withMeeting);
  }
  const session = await meetingSdkSession(config, withMeeting.providerMeetingId as string, withMeeting.passcode, hostDisplayName);
  const saved = await saveVisit(config, { ...withMeeting, status: "in_visit", startedAt: withMeeting.startedAt ?? new Date().toISOString() }, withMeeting.version);
  return { visit: publicVisit(saved), session };
}

/**
 * Ending a visit is a durable shutdown intent followed by provider
 * termination. The visit reads `ended` only once Zoom confirms the meeting is
 * no longer running; otherwise it stays `ending` with the shutdown marked
 * pending/failed so the practitioner can retry. Notes and flags are saved
 * either way. Leaving one client is never taken as termination.
 */
async function endVisit(config: TelehealthConfiguration, actor: Actor, value: Record<string, unknown>) {
  exact(value, ["appointmentId", "expectedVersion", "flags", "quickNotes"], ["appointmentId", "expectedVersion"]);
  const visit = await requireVisit(config, actor.organizationId, String(value.appointmentId ?? ""));
  if (!Number.isInteger(value.expectedVersion)) throw new TelehealthError("request_invalid");
  const flags = value.flags === undefined ? visit.flags : parseFlags(value.flags);
  const quickNotes = value.quickNotes === undefined ? visit.quickNotes : String(value.quickNotes);
  if (quickNotes.length > 20_000) throw new TelehealthError("request_invalid");
  if (visit.status === "ended") return publicVisit(visit);
  if (visit.status !== "in_visit" && visit.status !== "ending") throw new TelehealthError("conflict");
  await requireBindingAuthority(config, actor, visit, "close");
  const at = new Date().toISOString();
  const intent = await saveVisit(config, { ...visit, status: "ending", flags, quickNotes, providerShutdown: { status: "pending", attemptedAt: at, confirmedAt: null, detail: null } }, Number(value.expectedVersion));
  if (!intent.providerMeetingId) {
    return publicVisit(await saveVisit(config, { ...intent, status: "ended", endedAt: at, providerShutdown: { status: "ended", attemptedAt: at, confirmedAt: at, detail: "no provider meeting" } }, intent.version));
  }
  // An existing meeting is a running meeting until the provider says otherwise — a disabled provider is no observation.
  const outcome = config.zoomEnabled && config.zoomBaaVerified
    ? await endZoomMeeting(config, intent.providerMeetingId)
    : { ended: false as const, detail: "provider disabled on this deployment; meeting state unknown" };
  if (outcome.ended) {
    const ended = await saveVisit(config, { ...intent, status: "ended", endedAt: outcome.at, providerShutdown: { status: "ended", attemptedAt: at, confirmedAt: outcome.at, detail: null } }, intent.version);
    await sweepSettledOrphans(config, ended);
    return publicVisit(ended);
  }
  return publicVisit(await saveVisit(config, { ...intent, providerShutdown: { status: "failed", attemptedAt: at, confirmedAt: null, detail: outcome.detail } }, intent.version));
}
/**
 * A meeting from an attempt settled as absent can still materialise after the
 * visit bound another: it carries that attempt's marker, is never adopted,
 * and is removed here once the visit is over. Best effort: never changes the
 * end outcome.
 */
async function sweepSettledOrphans(config: TelehealthConfiguration, visit: VisitItem) {
  if (!(visit.settledLeaseIds?.length) || !config.zoomEnabled || !config.zoomBaaVerified) return;
  try {
    const listing = await listMarkerMeetings(config, visit.appointmentId);
    const settled = new Set(visit.settledLeaseIds.map((id) => id.toLowerCase()));
    for (const meeting of listing.matches) if (settled.has(meeting.leaseId) && meeting.id !== visit.providerMeetingId) await deleteZoomMeeting(config, meeting.id);
  } catch { /* swept again on a later listing */ }
}
/** End-for-all at the provider, then confirm by reading the meeting state. An unconfirmed end is reported as failed, never as ended. */
async function endZoomMeeting(config: TelehealthConfiguration, meetingId: string): Promise<{ ended: true; at: string } | { ended: false; detail: string }> {
  try {
    const { accessToken } = await zoomAccess(config);
    const end = await fetch(`https://api.zoom.us/v2/meetings/${encodeURIComponent(meetingId)}/status`, { method: "PUT", redirect: "manual", signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ action: "end" }) });
    if (!end.ok) return { ended: false, detail: `provider end refused (${end.status})` };
    const check = await fetch(`https://api.zoom.us/v2/meetings/${encodeURIComponent(meetingId)}`, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { authorization: `Bearer ${accessToken}` } });
    if (check.status === 404) return { ended: false, detail: "provider no longer reports this meeting; its final state is unproven" };
    if (!check.ok) return { ended: false, detail: `provider state unavailable (${check.status})` };
    let state: Record<string, unknown>; try { state = await check.json() as Record<string, unknown>; } catch { return { ended: false, detail: "provider state unreadable" }; }
    if (!state || typeof state !== "object" || String(state.id ?? "") !== meetingId.replace(/\D/g, "")) return { ended: false, detail: "provider returned a state for a different meeting" };
    // Zoom documents exactly two states for a scheduled meeting: `waiting` (not in progress) and `started`.
    if (state.status === "waiting") return { ended: true, at: new Date().toISOString() };
    if (state.status === "started") return { ended: false, detail: "provider reports the meeting still running" };
    return { ended: false, detail: "provider returned no recognised meeting state" };
  } catch (error) {
    return { ended: false, detail: error instanceof Error && error.message !== "provider_unavailable" ? `provider unreachable: ${error.name}` : "provider unreachable" };
  }
}
function parseFlags(value: unknown): VisitFlag[] {
  if (!Array.isArray(value) || value.length > 200) throw new TelehealthError("request_invalid");
  return value.map((entry) => {
    const flag = entry as Record<string, unknown>;
    if (!flag || typeof flag !== "object" || !Number.isInteger(flag.atSeconds) || Number(flag.atSeconds) < 0 || typeof flag.label !== "string" || flag.label.length > 200) throw new TelehealthError("request_invalid");
    return { atSeconds: Number(flag.atSeconds), label: flag.label };
  });
}

const MAX_LIST_WINDOW_MS = 31 * 86_400_000;
/**
 * Paginated, bounded, state-only list of ONE window (`from`/`to`, at most 31
 * days), authorized through the caller's own calendar for that window: a
 * desktop-booked visit is returned only when the calendar returns its
 * appointment to this caller (membership, organization and record access as
 * the clinical core decides them); a patient-app visit only inside the window
 * and only to a caller whose calendar call succeeded. `complete=false` says
 * the page bound was hit — never a silently truncated page.
 */
async function listVisits(config: TelehealthConfiguration, actor: Actor, event: ApiGatewayV2Event) {
  const from = String(event.queryStringParameters?.from ?? ""); const to = String(event.queryStringParameters?.to ?? "");
  if (!date(from) || !date(to) || Date.parse(to) <= Date.parse(from) || Date.parse(to) - Date.parse(from) > MAX_LIST_WINDOW_MS) throw new TelehealthError("request_invalid");
  const fromIso = new Date(from).toISOString(); const toIso = new Date(to).toISOString();
  const visible = new Set((await calendarWindow(config, actor, fromIso, toIso)).filter((row) => row.appointment_type === "telehealth").map((row) => String(row.id)));
  const inWindow = (startIso: string | null) => startIso !== null && Date.parse(startIso) >= Date.parse(fromIso) && Date.parse(startIso) < Date.parse(toIso);
  const visits: VisitItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  let complete = false;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const result = await document.send(new QueryCommand({ TableName: config.tableName, KeyConditionExpression: "pk = :org AND begins_with(sk, :visit)",
      ExpressionAttributeValues: { ":org": `ORG#${actor.organizationId}`, ":visit": "VISIT#" },
      ProjectionExpression: "appointmentId, organizationId, requestId, consumerPersonId, patientRecordId, practitionerUserId, scheduledStart, scheduledEnd, timeZone, #status, consents, providerMeetingId, joinUrl, startedAt, endedAt, providerShutdown, note.#status, note.#source, note.zoomSummaryId, note.revision, note.importedAt, note.signedAt, note.signedBy, #version, createdAt, updatedAt",
      ExpressionAttributeNames: { "#status": "status", "#source": "source", "#version": "version" },
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}) }));
    for (const item of result.Items ?? []) {
      const visit = { flags: [], quickNotes: "", noteHistory: [], ...(item as Partial<VisitItem>) } as VisitItem;
      if (visit.requestId === null ? visible.has(visit.appointmentId) : inWindow(visit.scheduledStart)) visits.push(visit);
    }
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (!exclusiveStartKey) { complete = true; break; }
  }
  return { visits: visits.map(publicVisitSummary), complete, from: fromIso, to: toIso };
}

/** A single visit record, read under the same current authority as every mutation: the caller's calendar must return the appointment (any status), for the same subject and practitioner. */
async function readVisitNote(config: TelehealthConfiguration, actor: Actor, event: ApiGatewayV2Event) {
  const appointmentId = String(event.queryStringParameters?.appointmentId ?? "");
  const visit = await requireVisit(config, actor.organizationId, appointmentId);
  await requireBindingAuthority(config, actor, visit, "close");
  return publicVisit(visit);
}

/**
 * Import Zoom AI Companion's summary as a NOT-REVIEWED note. Zoom's payload is
 * stored verbatim (`aiOriginal`). Its current unified `summary_content`
 * (Markdown) is kept as one unreviewed Summary section; legacy
 * overview/details/next-steps fields are mapped by label. Nothing is rewritten
 * by a model, no section is invented, and next steps are SUGGESTIONS only. A
 * payload with no usable text is "not ready", never an empty note.
 */
async function importVisitNote(config: TelehealthConfiguration, actor: Actor, value: Record<string, unknown>) {
  exact(value, ["appointmentId"], ["appointmentId"]);
  const visit = await requireVisit(config, actor.organizationId, String(value.appointmentId ?? ""));
  if (visit.note?.status === "signed") throw new TelehealthError("conflict");
  if (!visit.providerMeetingId || !["ending", "ended"].includes(visit.status)) throw new TelehealthError("conflict");
  await requireBindingAuthority(config, actor, visit, "close");
  await requireConsentAuthority(config, actor, visit);
  if (!config.zoomEnabled || !config.zoomBaaVerified) throw new TelehealthError("provider_unavailable");
  const summary = await zoomMeetingSummary(config, visit);
  if (!summary) return { visit: publicVisit(visit), summaryReady: false };
  const aiSections = sectionsFromZoomSummary(summary); const suggested = nextStepsFromZoomSummary(summary);
  if (!Object.values(aiSections).some((text) => text.trim()) && suggested.length === 0) return { visit: publicVisit(visit), summaryReady: false };
  const previous = visit.note;
  const actionItems = suggested.map((item) => { const earlier = previous?.actionItems.find((entry) => entry.text === item.text); return earlier ? { ...item, id: earlier.id, status: earlier.status } : item; });
  const note: VisitNote = {
    status: "not_reviewed", source: "zoom_ai_companion", zoomSummaryId: typeof summary.meeting_uuid === "string" ? summary.meeting_uuid : null,
    aiSections, aiOriginal: summary, practitionerNotes: previous?.practitionerNotes ?? "", actionItems,
    revision: (previous?.revision ?? 0) + 1, importedAt: new Date().toISOString(), signedAt: null, signedBy: null,
  };
  const saved = await saveVisit(config, { ...visit, note, noteHistory: previous ? [...visit.noteHistory, previous].slice(-MAX_NOTE_HISTORY) : visit.noteHistory }, visit.version);
  return { visit: publicVisit(saved), summaryReady: true };
}

/**
 * One signature stores the reviewed AI sections, the practitioner's own notes
 * and the action-item decisions together and freezes the note. The prior
 * revision is kept in the visit's history. This is the TELEHEALTH visit
 * record; it is not posted to the chart's clinical-note path (see docs).
 */
async function signVisitNote(config: TelehealthConfiguration, actor: Actor, value: Record<string, unknown>) {
  exact(value, ["appointmentId", "expectedVersion", "practitionerNotes", "aiSections", "actionItems"], ["appointmentId", "expectedVersion", "practitionerNotes", "aiSections", "actionItems"]);
  const visit = await requireVisit(config, actor.organizationId, String(value.appointmentId ?? ""));
  if (!Number.isInteger(value.expectedVersion) || typeof value.practitionerNotes !== "string" || value.practitionerNotes.length > 50_000) throw new TelehealthError("request_invalid");
  if (!visit.note) throw new TelehealthError("conflict");
  if (visit.note.status === "signed") throw new TelehealthError("conflict");
  await requireBindingAuthority(config, actor, visit, "close");
  const aiSections = parseSections(value.aiSections); const actionItems = parseActionItems(value.actionItems, visit.note.actionItems);
  const signedAt = new Date().toISOString();
  const note: VisitNote = { ...visit.note, status: "signed", aiSections, practitionerNotes: value.practitionerNotes, actionItems, revision: visit.note.revision + 1, signedAt, signedBy: actor.personId };
  const saved = await saveVisit(config, { ...visit, note, noteHistory: [...visit.noteHistory, visit.note].slice(-MAX_NOTE_HISTORY) }, Number(value.expectedVersion));
  return publicVisit(saved);
}
function parseSections(value: unknown): VisitNote["aiSections"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TelehealthError("request_invalid");
  const record = value as Record<string, unknown>;
  exact(record, [...VISIT_NOTE_SECTION_KEYS], [...VISIT_NOTE_SECTION_KEYS]);
  const sections = {} as VisitNote["aiSections"];
  for (const key of VISIT_NOTE_SECTION_KEYS) { const text = record[key]; if (typeof text !== "string" || text.length > 50_000) throw new TelehealthError("request_invalid"); sections[key] = text; }
  return sections;
}
function parseActionItems(value: unknown, existing: VisitActionItem[]): VisitActionItem[] {
  if (!Array.isArray(value) || value.length !== existing.length) throw new TelehealthError("request_invalid");
  return existing.map((item, index) => {
    const decision = value[index] as Record<string, unknown>;
    if (!decision || typeof decision !== "object" || decision.id !== item.id || !["suggested", "approved", "dismissed"].includes(String(decision.status))) throw new TelehealthError("request_invalid");
    return { ...item, status: decision.status as VisitActionItem["status"] };
  });
}
function sectionsFromZoomSummary(summary: Record<string, unknown>): VisitNote["aiSections"] {
  const sections: VisitNote["aiSections"] = { summary: "", patient_reported: "", results_reviewed: "", plan_discussed: "" };
  // Current API: one Markdown document. Kept whole as unreviewed source text.
  if (typeof summary.summary_content === "string" && summary.summary_content.trim()) sections.summary = summary.summary_content.trim();
  // Legacy API: overview + labelled details.
  if (typeof summary.summary_overview === "string" && summary.summary_overview.trim()) sections.summary += (sections.summary ? "\n\n" : "") + summary.summary_overview.trim();
  const details = Array.isArray(summary.summary_details) ? summary.summary_details as Array<Record<string, unknown>> : [];
  const leftovers: string[] = [];
  for (const detail of details) {
    const label = String(detail?.label ?? "").toLowerCase(); const text = typeof detail?.summary === "string" ? detail.summary.trim() : "";
    if (!text) continue;
    if (/report|symptom|history|concern/.test(label)) sections.patient_reported += (sections.patient_reported ? "\n\n" : "") + text;
    else if (/result|lab|marker|review/.test(label)) sections.results_reviewed += (sections.results_reviewed ? "\n\n" : "") + text;
    else if (/plan|protocol|recommend|treatment/.test(label)) sections.plan_discussed += (sections.plan_discussed ? "\n\n" : "") + text;
    else leftovers.push(detail?.label ? `${String(detail.label)}: ${text}` : text);
  }
  if (leftovers.length) sections.summary += (sections.summary ? "\n\n" : "") + leftovers.join("\n\n");
  return sections;
}
function nextStepsFromZoomSummary(summary: Record<string, unknown>): VisitActionItem[] {
  const steps = Array.isArray(summary.next_steps) ? summary.next_steps : [];
  return steps.filter((step): step is string => typeof step === "string" && step.trim().length > 0).slice(0, 50)
    .map((text) => ({ id: randomUUID(), text: text.trim().slice(0, 1000), status: "suggested" as const }));
}
/**
 * Read a JSON body under a hard byte bound WITHOUT materialising it first: the
 * declared length (when present) must be a well-formed integer within the
 * bound; the body is then consumed chunk by chunk, cancelled the moment the
 * running count exceeds the bound, decoded as strict UTF-8 (malformed bytes
 * refuse), and refused when the bytes received disagree with the declared
 * length (truncated or dishonest). No `text()`/`json()` fallback: a response
 * with no readable stream is refused, not trusted.
 */
export async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const refuse = () => new TelehealthError("provider_unavailable");
  const header = response.headers?.get?.("content-length");
  let declared: number | null = null;
  if (header !== null && header !== undefined && header !== "") {
    if (!/^\d{1,15}$/.test(header.trim())) throw refuse();
    declared = Number(header.trim());
    if (declared > maxBytes) throw refuse();
  }
  const body = response.body;
  if (!body || typeof body.getReader !== "function") throw refuse();
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let received = 0; let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) { await reader.cancel("bounded"); throw refuse(); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    try { await reader.cancel("refused"); } catch { /* already closed */ }
    throw refuse();
  }
  if (declared !== null && declared !== received) throw refuse();
  try { return JSON.parse(text) as unknown; } catch { throw refuse(); }
}
/**
 * The uuid of the one held instance of a meeting, from the provider's own
 * instance list, for a visit that was bound without a uuid. Zero instances →
 * nothing to summarise (null); more than one → ambiguous, refused: a
 * reusable meeting number never stands in for a specific instance.
 */
async function soleHeldInstanceUuid(config: TelehealthConfiguration, accessToken: string, meetingId: string): Promise<string | null> {
  const result = await fetch(`https://api.zoom.us/v2/past_meetings/${encodeURIComponent(meetingId)}/instances`, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { authorization: `Bearer ${accessToken}` } });
  if (result.status === 404) return null;
  if (!result.ok) throw new TelehealthError("provider_unavailable");
  const payload = await readBoundedJson(result, MAX_SUMMARY_BYTES) as { meetings?: Array<Record<string, unknown>> };
  const instances = Array.isArray(payload?.meetings) ? payload.meetings.filter((row) => row && typeof row.uuid === "string" && row.uuid.length > 0) : [];
  if (instances.length === 0) return null;
  if (instances.length > 1) throw new TelehealthError("provider_unavailable");
  return String(instances[0].uuid);
}
/**
 * Zoom AI Companion summary for THIS meeting instance: null until produced. A
 * payload is imported only when it names this meeting id, the EXACT instance
 * uuid the visit holds (or, for a visit bound without one, the sole held
 * instance the provider reports), and the configured host account. Missing,
 * mismatched or ambiguous instance identity is refused, as is any body that
 * exceeds the bound (never materialised first).
 */
async function zoomMeetingSummary(config: TelehealthConfiguration, visit: VisitItem): Promise<Record<string, unknown> | null> {
  const meetingId = visit.providerMeetingId as string;
  const { accessToken, userId } = await zoomAccess(config);
  const instanceUuid = visit.providerMeetingUuid ?? await soleHeldInstanceUuid(config, accessToken, meetingId);
  if (!instanceUuid) return null;
  const result = await fetch(`https://api.zoom.us/v2/meetings/${encodeURIComponent(meetingId)}/meeting_summary`, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { authorization: `Bearer ${accessToken}` } });
  if (result.status === 404) return null;
  if (!result.ok) throw new TelehealthError("provider_unavailable");
  const payload = await readBoundedJson(result, MAX_SUMMARY_BYTES);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new TelehealthError("provider_unavailable");
  const summary = payload as Record<string, unknown>;
  if (summary.meeting_id === undefined || summary.meeting_id === null || String(summary.meeting_id).replace(/\D/g, "") !== meetingId.replace(/\D/g, "")) throw new TelehealthError("provider_unavailable");
  if (typeof summary.meeting_uuid !== "string" || summary.meeting_uuid !== instanceUuid) throw new TelehealthError("provider_unavailable");
  if (!namesConfiguredHost(summary, userId, { id: "meeting_host_id", email: "meeting_host_email" })) throw new TelehealthError("provider_unavailable");
  return summary;
}
/**
 * The Meeting SDK session the browser needs to embed the meeting as HOST:
 * the SDK signature (HS256 JWT over the SDK key/secret held in Secrets
 * Manager, 2-hour TTL) plus the host's ZAK. The SDK secret never leaves here.
 */
async function meetingSdkSession(config: TelehealthConfiguration, meetingId: string, passcode: string | null, hostDisplayName: string) {
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId: config.zoomSecretArn }));
  let parsed: Record<string, unknown>; try { parsed = JSON.parse(secret.SecretString ?? "") as Record<string, unknown>; } catch { throw new TelehealthError("provider_unavailable"); }
  const sdkKey = field(parsed, "sdkKey"); const sdkSecret = field(parsed, "sdkSecret");
  const { accessToken, userId } = await zoomAccess(config);
  const zakResponse = await fetch(`https://api.zoom.us/v2/users/${encodeURIComponent(userId)}/token?type=zak`, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { authorization: `Bearer ${accessToken}` } });
  if (!zakResponse.ok) throw new TelehealthError("provider_unavailable");
  const zak = field(await zakResponse.json() as Record<string, unknown>, "token");
  const meetingNumber = meetingId.replace(/\D/g, "");
  if (!/^\d{9,12}$/.test(meetingNumber)) throw new TelehealthError("provider_unavailable");
  const issuedAt = Math.floor(Date.now() / 1000) - 30; const expiresAt = issuedAt + MEETING_SDK_SIGNATURE_TTL_SECONDS;
  const signature = signMeetingSdkJwt(sdkKey, sdkSecret, { appKey: sdkKey, sdkKey, mn: meetingNumber, role: 1, iat: issuedAt, exp: expiresAt, tokenExp: expiresAt });
  return { meetingNumber, passcode: passcode ?? "", signature, sdkKey, zak, hostDisplayName, expiresAt: new Date(expiresAt * 1000).toISOString() };
}
export function signMeetingSdkJwt(sdkKey: string, sdkSecret: string, payload: Record<string, string | number>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ ...payload, appKey: sdkKey })}`;
  return `${signingInput}.${createHmac("sha256", sdkSecret).update(signingInput).digest("base64url")}`;
}
/** A cancelled booking takes its visit with it: the visit is closed and a meeting this visit created is deleted. */
async function reconcileVisitForCancelledRequest(config: TelehealthConfiguration, item: AppointmentItem) {
  if (!item.appointmentId) return;
  const visit = await findVisit(config, item.organizationId, item.appointmentId);
  if (!visit || visit.status === "cancelled") return;
  if (config.zoomEnabled && visit.providerMeetingId && visit.providerMeetingId !== item.providerMeetingId) await deleteZoomMeeting(config, visit.providerMeetingId);
  await saveVisit(config, { ...visit, status: "cancelled", providerMeetingId: null, providerMeetingUuid: null, joinUrl: null, passcode: null, meetingLease: null }, visit.version);
}

function reminderName(requestId: string, offset: "24h" | "1h") { return `alp-${requestId.replaceAll("-", "")}-${offset}`; }
function atExpression(value: Date) { return `at(${value.toISOString().slice(0, 19)})`; }
async function deleteAppointmentReminders(config: TelehealthConfiguration, requestId: string) {
  for (const offset of ["24h", "1h"] as const) {
    try { await scheduler.send(new DeleteScheduleCommand({ GroupName: config.reminderScheduleGroup, Name: reminderName(requestId, offset) })); }
    catch (error) { if ((error as { name?: string }).name !== "ResourceNotFoundException") throw new TelehealthError("service_unavailable"); }
  }
}
async function scheduleAppointmentReminders(config: TelehealthConfiguration, item: AppointmentItem) {
  if (!item.scheduledStart) throw new TelehealthError("service_unavailable");
  await deleteAppointmentReminders(config, item.requestId);
  const start = new Date(item.scheduledStart).getTime();
  for (const [offset, milliseconds] of [["24h", 86_400_000], ["1h", 3_600_000]] as const) {
    const runAt = new Date(start - milliseconds); if (runAt.getTime() <= Date.now()) continue;
    await scheduler.send(new CreateScheduleCommand({ GroupName: config.reminderScheduleGroup, Name: reminderName(item.requestId, offset),
      ScheduleExpression: atExpression(runAt), ScheduleExpressionTimezone: "UTC", FlexibleTimeWindow: { Mode: "OFF" }, ActionAfterCompletion: "DELETE",
      Target: { Arn: config.reminderTargetArn, RoleArn: config.reminderSchedulerRoleArn,
        Input: JSON.stringify({ internalEvent: "send_appointment_reminder", organizationId: item.organizationId, requestId: item.requestId, scheduledStart: item.scheduledStart }) } }));
  }
}
async function sendAppointmentReminder(config: TelehealthConfiguration, event: ReminderEvent) {
  if (!config.remindersEnabled || !UUID.test(String(event.organizationId)) || !UUID.test(String(event.requestId)) || !date(String(event.scheduledStart))) throw new TelehealthError("service_unavailable");
  const item = await find(config, String(event.organizationId), String(event.requestId));
  if (item.status === "cancelled" || item.scheduledStart !== event.scheduledStart) return { sent: false, reason: "stale" };
  const when = new Date(item.scheduledStart ?? "").toISOString();
  const link = item.joinUrl ? `\nJoin your secure visit: ${item.joinUrl}` : "\nOpen AI Longevity Pro for the latest secure visit details.";
  await ses.send(new SendEmailCommand({ FromEmailAddress: config.reminderSender, ConfigurationSetName: config.reminderConfigurationSet,
    Destination: { ToAddresses: [item.consumerEmail] }, Content: { Simple: { Subject: { Data: "Your AI Longevity Pro appointment reminder" },
      Body: { Text: { Data: `Your telehealth appointment is scheduled for ${when}.${link}\n\nTo reschedule or cancel, open AI Longevity Pro. Do not reply with health information.` } } } } }));
  return { sent: true };
}

async function stripeCredentials(config: TelehealthConfiguration) {
  if (!config.stripeTestEnabled || !config.stripeSecretArn) throw new TelehealthError("provider_unavailable");
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId: config.stripeSecretArn }));
  let parsed: Record<string, unknown>; try { parsed = JSON.parse(secret.SecretString ?? "") as Record<string, unknown>; } catch { throw new TelehealthError("provider_unavailable"); }
  const secretKey = field(parsed, "secretKey"); const webhookSecret = field(parsed, "webhookSecret");
  if (!secretKey.startsWith("sk_test_") && !secretKey.startsWith("rk_test_")) throw new TelehealthError("provider_unavailable");
  if (!webhookSecret.startsWith("whsec_")) throw new TelehealthError("provider_unavailable");
  return { secretKey, webhookSecret };
}
async function stripePost(config: TelehealthConfiguration, path: string, values: Record<string, string>, idempotencyKey: string) {
  const { secretKey } = await stripeCredentials(config);
  const result = await fetch(`https://api.stripe.com/v1${path}`, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/x-www-form-urlencoded", "idempotency-key": idempotencyKey }, body: new URLSearchParams(values).toString() });
  const payload = await result.json().catch(() => ({})) as Record<string, unknown>;
  if (!result.ok || payload.livemode === true) throw new TelehealthError("provider_unavailable");
  return payload;
}
async function stripeGet(config: TelehealthConfiguration, path: string) {
  const { secretKey } = await stripeCredentials(config);
  const result = await fetch(`https://api.stripe.com/v1${path}`, { redirect: "manual", signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${secretKey}` } });
  const payload = await result.json().catch(() => ({})) as Record<string, unknown>;
  if (!result.ok || payload.livemode === true) throw new TelehealthError("provider_unavailable");
  return payload;
}
function paymentProfileKey(organizationId: string, personId: string) { return { pk: `ORG#${organizationId}`, sk: `PAYMENT_PROFILE#${personId}` }; }
async function rawPaymentProfile(config: TelehealthConfiguration, actor: Pick<Actor, "organizationId" | "personId">): Promise<PaymentProfile | null> {
  const found = await document.send(new GetCommand({ TableName: config.tableName, Key: paymentProfileKey(actor.organizationId, actor.personId) }));
  return found.Item as PaymentProfile | undefined ?? null;
}
async function getPaymentProfile(config: TelehealthConfiguration, actor: Actor) {
  const profile = await rawPaymentProfile(config, actor);
  return { available: config.stripeTestEnabled, status: profile?.status ?? "not_configured", cardOnFile: profile?.status === "active" && Boolean(profile.stripePaymentMethodId), mode: "test" };
}
async function startPaymentSetup(config: TelehealthConfiguration, actor: Actor) {
  if (!config.stripeTestEnabled || !/^https:\/\//.test(config.stripeSuccessUrl) || !/^https:\/\//.test(config.stripeCancelUrl)) throw new TelehealthError("provider_unavailable");
  let profile = await rawPaymentProfile(config, actor);
  let customer = profile?.stripeCustomerId ?? "";
  if (!customer) {
    const created = await stripePost(config, "/customers", { email: actor.email, "metadata[organization_id]": actor.organizationId, "metadata[consumer_person_id]": actor.personId }, `telehealth-customer:${actor.organizationId}:${actor.personId}`);
    customer = field(created, "id");
    profile = { ...paymentProfileKey(actor.organizationId, actor.personId), organizationId: actor.organizationId, consumerPersonId: actor.personId,
      stripeCustomerId: customer, stripePaymentMethodId: null, status: "setup_pending", updatedAt: new Date().toISOString() };
    await document.send(new PutCommand({ TableName: config.tableName, Item: profile }));
  }
  const session = await stripePost(config, "/checkout/sessions", { mode: "setup", customer, success_url: config.stripeSuccessUrl, cancel_url: config.stripeCancelUrl,
    "metadata[organization_id]": actor.organizationId, "metadata[consumer_person_id]": actor.personId,
    "setup_intent_data[metadata][organization_id]": actor.organizationId, "setup_intent_data[metadata][consumer_person_id]": actor.personId },
    `telehealth-setup:${actor.organizationId}:${actor.personId}:${randomUUID()}`);
  return { mode: "test", checkoutUrl: urlField(session, "url"), expiresAt: typeof session.expires_at === "number" ? new Date(session.expires_at * 1000).toISOString() : null };
}
async function authorizeAppointmentPayment(config: TelehealthConfiguration, actor: Actor, value: Record<string, unknown>) {
  exact(value, ["requestId", "expectedVersion", "policyVersion", "authorized"], ["requestId", "expectedVersion", "policyVersion", "authorized"]);
  if (value.policyVersion !== "telehealth-payments/1" || typeof value.authorized !== "boolean" || !Number.isInteger(value.expectedVersion)) throw new TelehealthError("request_invalid");
  const item = await find(config, actor.organizationId, String(value.requestId));
  if (item.consumerPersonId !== actor.personId || item.status === "cancelled") throw new TelehealthError("identity_refused");
  if (value.authorized) { const profile = await rawPaymentProfile(config, actor); if (profile?.status !== "active" || !profile.stripePaymentMethodId) throw new TelehealthError("provider_unavailable"); }
  const status = value.authorized ? "authorized" : "withdrawn"; const updatedAt = new Date().toISOString();
  try { const result = await document.send(new UpdateCommand({ TableName: config.tableName, Key: { pk: item.pk, sk: item.sk },
    UpdateExpression: "SET paymentAuthorizationStatus=:status,paymentPolicyVersion=:policy,#version=:next,updatedAt=:updated,lastActionBy=:by",
    ConditionExpression: "#version=:expected", ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: { ":status": status, ":policy": "telehealth-payments/1", ":expected": value.expectedVersion, ":next": Number(value.expectedVersion) + 1, ":updated": updatedAt, ":by": "consumer" }, ReturnValues: "ALL_NEW" }));
    return publicItem(result.Attributes as AppointmentItem, "consumer");
  } catch (error) { if ((error as { name?: string }).name === "ConditionalCheckFailedException") throw new TelehealthError("conflict"); throw error; }
}
async function workforcePayment(config: TelehealthConfiguration, actor: Actor, value: Record<string, unknown>) {
  exact(value, ["requestId", "action", "expectedVersion", "amountMinor", "serviceDelivered", "reason"], ["requestId", "action", "expectedVersion", "amountMinor"]);
  if (!Number.isInteger(value.expectedVersion) || !Number.isInteger(value.amountMinor) || Number(value.amountMinor) < 1 || !["charge", "refund"].includes(String(value.action))) throw new TelehealthError("request_invalid");
  const item = await find(config, actor.organizationId, String(value.requestId)); const amount = Number(value.amountMinor);
  if (amount > Math.max(item.priceMinor, item.cancellationFeeDueMinor) || !config.stripeTestEnabled) throw new TelehealthError("request_invalid");
  if (value.action === "charge") {
    if (item.paymentAuthorizationStatus !== "authorized" || (item.cancellationFeeDueMinor === 0 && value.serviceDelivered !== true)) throw new TelehealthError("identity_refused");
    const profile = await rawPaymentProfile(config, { organizationId: item.organizationId, personId: item.consumerPersonId });
    if (profile?.status !== "active" || !profile.stripePaymentMethodId) throw new TelehealthError("provider_unavailable");
    const intent = await stripePost(config, "/payment_intents", { amount: String(amount), currency: item.currency.toLowerCase(), customer: profile.stripeCustomerId,
      payment_method: profile.stripePaymentMethodId, off_session: "true", confirm: "true", receipt_email: item.consumerEmail,
      "metadata[organization_id]": item.organizationId, "metadata[request_id]": item.requestId }, `telehealth-charge:${item.requestId}:${value.expectedVersion}`);
    return updatePaymentState(config, item, Number(value.expectedVersion), { paymentStatus: "processing", paymentIntentId: field(intent, "id") });
  }
  if (!item.paymentIntentId || !["paid", "partially_refunded"].includes(item.paymentStatus) || amount > item.paidMinor - item.refundedMinor || typeof value.reason !== "string" || value.reason.length < 3 || value.reason.length > 500) throw new TelehealthError("request_invalid");
  await stripePost(config, "/refunds", { payment_intent: item.paymentIntentId, amount: String(amount), "metadata[organization_id]": item.organizationId,
    "metadata[request_id]": item.requestId, "metadata[reason_code]": "workforce_approved" }, `telehealth-refund:${item.requestId}:${item.refundedMinor}:${amount}`);
  return updatePaymentState(config, item, Number(value.expectedVersion), { paymentStatus: amount === item.paidMinor - item.refundedMinor ? "refunded" : "partially_refunded", refundedMinor: item.refundedMinor + amount });
}
async function updatePaymentState(config: TelehealthConfiguration, item: AppointmentItem, version: number, values: Partial<AppointmentItem>) {
  const next = { ...item, ...values, version: version + 1, updatedAt: new Date().toISOString(), lastActionBy: "workforce" as const };
  const names: Record<string, string> = { "#version": "version" }; const attrs: Record<string, unknown> = { ":expected": version, ":next": version + 1, ":updated": next.updatedAt };
  const clauses = ["#version=:next", "updatedAt=:updated"];
  for (const key of ["paymentStatus", "paymentIntentId", "paidMinor", "refundedMinor"] as const) if (key in values) { names[`#${key}`] = key; attrs[`:${key}`] = values[key]; clauses.push(`#${key}=:${key}`); }
  try { await document.send(new UpdateCommand({ TableName: config.tableName, Key: { pk: item.pk, sk: item.sk }, UpdateExpression: `SET ${clauses.join(",")}`,
    ConditionExpression: "#version=:expected", ExpressionAttributeNames: names, ExpressionAttributeValues: attrs })); return publicItem(next, "workforce"); }
  catch (error) { if ((error as { name?: string }).name === "ConditionalCheckFailedException") throw new TelehealthError("conflict"); throw error; }
}
async function handleStripeWebhook(config: TelehealthConfiguration, event: ApiGatewayV2Event) {
  const raw = typeof event.body === "string" ? event.body : ""; const header = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === "stripe-signature")?.[1] ?? "";
  const { webhookSecret } = await stripeCredentials(config); const parts = header.split(",").map((part) => part.trim()); const timestamp = parts.find((part) => part.startsWith("t="))?.slice(2) ?? "";
  const signatures = parts.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3)); const epoch = Number(timestamp);
  if (!timestamp || !Number.isFinite(epoch) || Math.abs(Date.now() / 1000 - epoch) > 300 || signatures.length === 0) throw new TelehealthError("request_invalid");
  const expected = createHmac("sha256", webhookSecret).update(`${timestamp}.${raw}`).digest("hex"); const expectedBuffer = Buffer.from(expected);
  if (!signatures.some((signature) => { const candidate = Buffer.from(signature); return candidate.length === expectedBuffer.length && timingSafeEqual(candidate, expectedBuffer); })) throw new TelehealthError("request_invalid");
  let parsed: Record<string, unknown>; try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { throw new TelehealthError("request_invalid"); }
  if (parsed.livemode === true) throw new TelehealthError("request_invalid"); const object = ((parsed.data as Record<string, unknown> | undefined)?.object ?? {}) as Record<string, unknown>;
  if (parsed.type === "checkout.session.completed" && object.mode === "setup") {
    const setupId = field(object, "setup_intent"); const setup = await stripeGet(config, `/setup_intents/${encodeURIComponent(setupId)}`); const metadata = setup.metadata as Record<string, unknown> | undefined;
    const organizationId = String(metadata?.organization_id ?? ""); const personId = String(metadata?.consumer_person_id ?? ""); if (!UUID.test(organizationId) || !UUID.test(personId)) throw new TelehealthError("request_invalid");
    await document.send(new UpdateCommand({ TableName: config.tableName, Key: paymentProfileKey(organizationId, personId), UpdateExpression: "SET stripePaymentMethodId=:method,#status=:active,updatedAt=:updated",
      ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":method": field(setup, "payment_method"), ":active": "active", ":updated": new Date().toISOString() } }));
  }
  if (["payment_intent.succeeded", "payment_intent.payment_failed"].includes(String(parsed.type))) {
    const metadata = object.metadata as Record<string, unknown> | undefined; const organizationId = String(metadata?.organization_id ?? ""); const requestId = String(metadata?.request_id ?? "");
    if (!UUID.test(organizationId) || !UUID.test(requestId)) throw new TelehealthError("request_invalid"); const item = await find(config, organizationId, requestId);
    const succeeded = parsed.type === "payment_intent.succeeded"; await updatePaymentState(config, item, item.version, { paymentStatus: succeeded ? "paid" : "failed", paymentIntentId: field(object, "id"), ...(succeeded && Number.isInteger(object.amount_received) ? { paidMinor: Number(object.amount_received) } : {}) });
  }
  return { received: true };
}

type Actor = { personId: string; organizationId: string; subject: string; email: string; /** The caller's own JWT, forwarded to the identity API for consent reads/writes. */ bearer: string };
function identity(event: ApiGatewayV2Event, config: TelehealthConfiguration, pool: "consumer" | "workforce"): Actor {
  const claims = event.requestContext?.authorizer?.jwt?.claims; const claim = (key: string) => typeof claims?.[key] === "string" ? claims[key] as string : "";
  const issuer = pool === "consumer" ? config.consumerIssuer : config.workforceIssuer; const audience = pool === "consumer" ? config.consumerAudience : config.workforceAudience;
  const email = claim("email").toLowerCase();
  if (claim("iss") !== issuer || claim("aud") !== audience || claim("token_use") !== "id" || !UUID.test(claim("custom:person_id")) || !UUID.test(claim("custom:organization_id")) || !SUBJECT.test(claim("sub"))
    || (pool === "consumer" && !/^[^\s@]{1,64}@[^\s@]{1,190}$/.test(email))
    || (config.runtimeMode === "synthetic" ? claim("custom:synthetic_attested") !== "true" || claim("custom:production_bound") === "true" : claim("custom:production_bound") !== "true")) throw new TelehealthError("identity_refused");
  const authorization = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === "authorization")?.[1] ?? "";
  return { personId: claim("custom:person_id"), organizationId: claim("custom:organization_id"), subject: claim("sub"), email, bearer: authorization.replace(/^Bearer\s+/i, "") };
}

function body(event: ApiGatewayV2Event): Record<string, unknown> { const content = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === "content-type")?.[1]; if (!content?.startsWith("application/json") || typeof event.body !== "string" || Buffer.byteLength(event.body) > MAX_BODY) throw new TelehealthError("request_invalid"); try { const value = JSON.parse(event.body); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value; } catch { throw new TelehealthError("request_invalid"); } }
function exact(value: Record<string, unknown>, allowed: string[], required: string[]) { if (Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => !(key in value))) throw new TelehealthError("request_invalid"); }
function date(value: string) { return value.length <= 40 && Number.isFinite(+new Date(value)); }
function zone(value: unknown): string { if (typeof value !== "string" || !/^[A-Za-z_]+\/[A-Za-z_+-]+$/.test(value)) throw new TelehealthError("request_invalid"); return value; }
function field(value: Record<string, unknown>, key: string): string { const found = value[key]; if (typeof found !== "string" || found.length < 2 || found.length > 500) throw new TelehealthError("provider_unavailable"); return found; }
function urlField(value: Record<string, unknown>, key: string): string { const found = value[key]; if (typeof found !== "string" || found.length > 2048) throw new TelehealthError("provider_unavailable"); try { const parsed = new URL(found); if (parsed.protocol !== "https:" || parsed.hostname !== "checkout.stripe.com") throw new Error(); return parsed.toString(); } catch { throw new TelehealthError("provider_unavailable"); } }
function publicItem(item: AppointmentItem, pool: "consumer" | "workforce") {
  const result: Partial<AppointmentItem> = { ...item };
  delete result.pk; delete result.sk; delete result.gsi1pk; delete result.gsi1sk;
  delete result.consumerEmail;
  if (pool === "consumer") delete result.paymentIntentId;
  if (pool === "consumer") delete result.consumerPersonId;
  return result;
}
function validateConfiguration(config: TelehealthConfiguration) { if (!config.tableName || !config.consumerIssuer || !config.workforceIssuer || !config.consumerAudience || !config.workforceAudience || (config.runtimeMode === "synthetic" && config.phiAllowed) || (config.zoomEnabled && (!config.zoomBaaVerified || !config.zoomSecretArn)) || (config.remindersEnabled && (!config.reminderSender || !config.reminderConfigurationSet || !config.reminderScheduleGroup || !config.reminderSchedulerRoleArn || !config.reminderTargetArn)) || (config.stripeTestEnabled && (!config.stripeSecretArn || !/^https:\/\//.test(config.stripeSuccessUrl) || !/^https:\/\//.test(config.stripeCancelUrl)))) throw new Error("telehealth_configuration_invalid"); }
type TelehealthRefusal = "identity_refused" | "request_invalid" | "not_found" | "conflict" | "appointment_cancelled" | "appointment_reassigned" | "meeting_unsettled"
  | "consent_required" | "consent_withdrawn" | "consent_superseded" | "consent_version_refused" | "consent_artifact_unavailable"
  | "provider_unavailable" | "service_unavailable";
class TelehealthError extends Error { constructor(readonly category: TelehealthRefusal) { super(category); } }
function response(statusCode: number, payload: Record<string, unknown>): ApiGatewayV2Response { return { statusCode, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }, body: JSON.stringify(payload) }; }
