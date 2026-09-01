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

export type TelehealthConfiguration = {
  tableName: string; consumerIssuer: string; consumerAudience: string; workforceIssuer: string; workforceAudience: string;
  runtimeMode: "synthetic" | "production"; phiAllowed: boolean; zoomEnabled: boolean; zoomBaaVerified: boolean; zoomSecretArn: string;
  remindersEnabled: boolean; reminderSender: string; reminderConfigurationSet: string; reminderScheduleGroup: string; reminderSchedulerRoleArn: string; reminderTargetArn: string;
  stripeTestEnabled: boolean; stripeSecretArn: string; stripeSuccessUrl: string; stripeCancelUrl: string;
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
    try {
      const reminder = event as unknown as ReminderEvent;
      if (reminder.internalEvent === "send_appointment_reminder") return response(200, { data: await sendAppointmentReminder(config, reminder) });
      const route = event.routeKey ?? "";
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
      return response(404, { error: "route_not_found" });
    } catch (error) {
      const category = error instanceof TelehealthError ? error.category : "service_unavailable";
      const status = category === "identity_refused" ? 403 : category === "not_found" ? 404 : category === "conflict" ? 409
        : category === "provider_unavailable" || category === "service_unavailable" ? 503 : 400;
      return response(status, { error: category });
    }
  };
}

async function createRequest(config: TelehealthConfiguration, actor: Actor, value: Record<string, unknown>) {
  exact(value, ["visitType", "slotId", "holdId", "note"], ["visitType", "slotId", "holdId"]);
  const visitType = value.visitType;
  if (!["initial", "follow_up", "urgent_question"].includes(String(visitType)) || !UUID.test(String(value.slotId)) || !UUID.test(String(value.holdId))
    || !(value.note === undefined || value.note === null || (typeof value.note === "string" && value.note.length <= 500))) throw new TelehealthError("request_invalid");
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
    paidMinor: 0, refundedMinor: 0,
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
      UpdateExpression: "SET #version=:next,#status=:status,preferredSlots=:slots,scheduledStart=:start,scheduledEnd=:end,timeZone=:zone,slotId=:slot,priceMinor=:price,cancellationPolicy=:policy,cancellationWindowHours=:window,cancellationFeeDueMinor=:zero,joinUrl=:none,providerMeetingId=:none,updatedAt=:updated,lastActionBy=:by",
      ConditionExpression: "#version=:expected", ExpressionAttributeNames: { "#version": "version", "#status": "status" }, ExpressionAttributeValues: {
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
    const meetingInput = { requestId: item.requestId, start, durationMinutes: Math.ceil((+new Date(end) - +new Date(start)) / 60_000), timeZone };
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
    { Update: { TableName: config.tableName, Key: { pk: item.pk, sk: item.sk }, UpdateExpression: "SET #version=:next,#status=:status,scheduledStart=:start,scheduledEnd=:end,joinUrl=:join,providerMeetingId=:meeting,timeZone=:zone,appointmentId=:appointment,updatedAt=:updated,lastActionBy=:by", ConditionExpression: "#version=:expected", ExpressionAttributeNames: { "#version": "version", "#status": "status" }, ExpressionAttributeValues: { ":expected": version, ":next": version + 1, ":status": values.status, ":start": values.scheduledStart, ":end": values.scheduledEnd, ":join": values.joinUrl, ":meeting": values.providerMeetingId, ":zone": values.timeZone, ":appointment": appointmentId, ":updated": updatedAt, ":by": "workforce" } } },
    { Put: { TableName: config.tableName, Item: appointment } },
  ] })); } catch(error) { if ((error as { name?: string }).name === "TransactionCanceledException" || (error as { name?: string }).name === "ConditionalCheckFailedException") throw new TelehealthError("conflict"); throw error; }
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

async function createZoomMeeting(config: TelehealthConfiguration, input: { requestId: string; start: string; durationMinutes: number; timeZone: string }) {
  const { accessToken, userId } = await zoomAccess(config);
  const meetingResponse = await fetch(`https://api.zoom.us/v2/users/${encodeURIComponent(userId)}/meetings`, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ topic: "AI Longevity Pro telehealth appointment", type: 2, start_time: input.start, duration: input.durationMinutes, timezone: input.timeZone, agenda: `Governed appointment request ${input.requestId}`, settings: { waiting_room: true, join_before_host: false, meeting_authentication: true } }) });
  if (!meetingResponse.ok) throw new TelehealthError("provider_unavailable");
  const meeting = await meetingResponse.json() as Record<string, unknown>;
  return { joinUrl: field(meeting, "join_url"), providerMeetingId: String(meeting.id ?? "") };
}

async function updateZoomMeeting(config: TelehealthConfiguration, meetingId: string, joinUrl: string, input: { requestId: string; start: string; durationMinutes: number; timeZone: string }) {
  const { accessToken } = await zoomAccess(config);
  const result = await fetch(`https://api.zoom.us/v2/meetings/${encodeURIComponent(meetingId)}`, { method: "PATCH", redirect: "manual", signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ start_time: input.start, duration: input.durationMinutes, timezone: input.timeZone, agenda: `Governed appointment request ${input.requestId}` }) });
  if (!result.ok) throw new TelehealthError("provider_unavailable");
  return { joinUrl, providerMeetingId: meetingId };
}

async function deleteZoomMeeting(config: TelehealthConfiguration, meetingId: string) {
  const { accessToken } = await zoomAccess(config);
  const result = await fetch(`https://api.zoom.us/v2/meetings/${encodeURIComponent(meetingId)}`, { method: "DELETE", redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { authorization: `Bearer ${accessToken}` } });
  if (!result.ok && result.status !== 404) throw new TelehealthError("provider_unavailable");
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

type Actor = { personId: string; organizationId: string; subject: string; email: string };
function identity(event: ApiGatewayV2Event, config: TelehealthConfiguration, pool: "consumer" | "workforce"): Actor {
  const claims = event.requestContext?.authorizer?.jwt?.claims; const claim = (key: string) => typeof claims?.[key] === "string" ? claims[key] as string : "";
  const issuer = pool === "consumer" ? config.consumerIssuer : config.workforceIssuer; const audience = pool === "consumer" ? config.consumerAudience : config.workforceAudience;
  const email = claim("email").toLowerCase();
  if (claim("iss") !== issuer || claim("aud") !== audience || claim("token_use") !== "id" || !UUID.test(claim("custom:person_id")) || !UUID.test(claim("custom:organization_id")) || !SUBJECT.test(claim("sub"))
    || (pool === "consumer" && !/^[^\s@]{1,64}@[^\s@]{1,190}$/.test(email))
    || (config.runtimeMode === "synthetic" ? claim("custom:synthetic_attested") !== "true" || claim("custom:production_bound") === "true" : claim("custom:production_bound") !== "true")) throw new TelehealthError("identity_refused");
  return { personId: claim("custom:person_id"), organizationId: claim("custom:organization_id"), subject: claim("sub"), email };
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
class TelehealthError extends Error { constructor(readonly category: "identity_refused" | "request_invalid" | "not_found" | "conflict" | "provider_unavailable" | "service_unavailable") { super(category); } }
function response(statusCode: number, payload: Record<string, unknown>): ApiGatewayV2Response { return { statusCode, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }, body: JSON.stringify(payload) }; }
