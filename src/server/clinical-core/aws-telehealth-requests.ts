if (typeof window !== "undefined") throw new Error("aws-telehealth-requests is server-only");

import { randomUUID } from "node:crypto";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DynamoDBDocumentClient, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { ApiGatewayV2Event, ApiGatewayV2Response } from "./aws-identity-api";

const document = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const secrets = new SecretsManagerClient({});
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

export type TelehealthConfiguration = {
  tableName: string; consumerIssuer: string; consumerAudience: string; workforceIssuer: string; workforceAudience: string;
  runtimeMode: "synthetic" | "production"; phiAllowed: boolean; zoomEnabled: boolean; zoomBaaVerified: boolean; zoomSecretArn: string;
};

type AppointmentItem = {
  pk: string; sk: string; gsi1pk: string; gsi1sk: string; requestId: string; organizationId: string; consumerPersonId: string;
  status: "requested" | "awaiting_provider" | "scheduled" | "reschedule_requested" | "cancelled";
  visitType: "initial" | "follow_up" | "urgent_question"; preferredSlots: string[]; timeZone: string; note: string | null;
  scheduledStart: string | null; scheduledEnd: string | null; joinUrl: string | null; providerMeetingId: string | null;
  version: number; createdAt: string; updatedAt: string; lastActionBy: "consumer" | "workforce";
  slotId: string; appointmentId: string | null; priceMinor: number; currency: "USD"; cancellationPolicy: string;
};

type BookingSlot = {
  pk: string; sk: string; slotId: string; organizationId: string; start: string; end: string; timeZone: string;
  visitTypes: AppointmentItem["visitType"][]; priceMinor: number; currency: "USD"; cancellationPolicy: string;
  status: "available" | "held" | "booked"; heldBy: string | null; holdId: string | null; holdExpiresAt: number | null;
  createdAt: string; createdBy: string;
};

export function createTelehealthHandler(config: TelehealthConfiguration) {
  validateConfiguration(config);
  return async (event: ApiGatewayV2Event): Promise<ApiGatewayV2Response> => {
    if (config.runtimeMode === "production" && !config.phiAllowed) return response(503, { error: "production_not_activated", phiAllowed: false });
    try {
      const route = event.routeKey ?? "";
      const pool = route.includes("/workforce/") ? "workforce" : "consumer";
      const actor = identity(event, config, pool);
      if (route === CONSUMER_AVAILABILITY) return response(200, { data: await listAvailability(config, actor, body(event)) });
      if (route === CONSUMER_HOLD) return response(201, { data: await holdSlot(config, actor, body(event)) });
      if (route === CONSUMER_CREATE) return response(201, { data: await createRequest(config, actor, body(event)) });
      if (route === CONSUMER_LIST) return response(200, { data: await listConsumer(config, actor) });
      if (route === CONSUMER_ACTION) return response(200, { data: await consumerAction(config, actor, body(event)) });
      if (route === WORKFORCE_LIST) return response(200, { data: await listWorkforce(config, actor) });
      if (route === WORKFORCE_ACTION) return response(200, { data: await workforceAction(config, actor, body(event)) });
      if (route === WORKFORCE_SLOT_LIST) return response(200, { data: await listWorkforceSlots(config, actor) });
      if (route === WORKFORCE_SLOT_CREATE) return response(201, { data: await publishSlot(config, actor, body(event)) });
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
  };
  await document.send(new TransactWriteCommand({ TransactItems: [
    { Put: { TableName: config.tableName, Item: item, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } },
    { Update: { TableName: config.tableName, Key: { pk: slot.pk, sk: slot.sk }, UpdateExpression: "SET #status=:booked", ConditionExpression: "#status=:held AND heldBy=:person AND holdId=:hold AND holdExpiresAt>:now", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":booked": "booked", ":held": "held", ":person": actor.personId, ":hold": value.holdId, ":now": nowEpoch } } },
  ] }));
  return publicItem(item, "consumer");
}

async function publishSlot(config: TelehealthConfiguration, actor: Actor, value: Record<string, unknown>) {
  exact(value, ["start", "end", "timeZone", "visitTypes", "priceMinor", "currency", "cancellationPolicy"], ["start", "end", "timeZone", "visitTypes", "priceMinor", "currency", "cancellationPolicy"]);
  const start = String(value.start); const end = String(value.end); const timeZone = zone(value.timeZone);
  const visitTypes = value.visitTypes;
  if (!date(start) || !date(end) || new Date(end) <= new Date(start) || new Date(start).getTime() <= Date.now()
    || new Date(start).getTime() > Date.now() + 180 * 86_400_000 || !Array.isArray(visitTypes) || visitTypes.length < 1
    || visitTypes.some((v) => !["initial", "follow_up", "urgent_question"].includes(String(v)))
    || !Number.isInteger(value.priceMinor) || Number(value.priceMinor) < 0 || Number(value.priceMinor) > 1_000_000
    || value.currency !== "USD" || typeof value.cancellationPolicy !== "string" || value.cancellationPolicy.length < 10 || value.cancellationPolicy.length > 1000) throw new TelehealthError("request_invalid");
  const existing = await rawSlots(config, actor.organizationId);
  if (existing.some((slot) => slot.status !== "booked" && new Date(slot.start) < new Date(end) && new Date(slot.end) > new Date(start))) throw new TelehealthError("conflict");
  const slotId = randomUUID(); const now = new Date().toISOString();
  const slot: BookingSlot = { pk: `ORG#${actor.organizationId}`, sk: `SLOT#${start}#${slotId}`, slotId, organizationId: actor.organizationId, start, end, timeZone,
    visitTypes: visitTypes as BookingSlot["visitTypes"], priceMinor: Number(value.priceMinor), currency: "USD", cancellationPolicy: value.cancellationPolicy,
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
function publicSlot(slot: BookingSlot, workforce: boolean) { const result: Record<string, unknown> = { slotId: slot.slotId, start: slot.start, end: slot.end, timeZone: slot.timeZone, visitTypes: slot.visitTypes, priceMinor: slot.priceMinor, currency: slot.currency, cancellationPolicy: slot.cancellationPolicy, status: slot.status }; if (workforce) Object.assign(result, { heldBy: slot.heldBy, holdExpiresAt: slot.holdExpiresAt ? new Date(slot.holdExpiresAt * 1000).toISOString() : null }); return result; }

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
  exact(value, ["requestId", "action", "expectedVersion", "preferredSlots", "timeZone"], ["requestId", "action", "expectedVersion"]);
  const item = await find(config, actor.organizationId, String(value.requestId));
  if (item.consumerPersonId !== actor.personId) throw new TelehealthError("identity_refused");
  const action = value.action;
  if (!Number.isInteger(value.expectedVersion) || !["cancel", "request_reschedule"].includes(String(action))) throw new TelehealthError("request_invalid");
  if (item.status === "cancelled" || (action === "request_reschedule" && !["requested", "awaiting_provider", "scheduled", "reschedule_requested"].includes(item.status))) {
    throw new TelehealthError("conflict");
  }
  const updates: Partial<AppointmentItem> = action === "cancel" ? { status: "cancelled" }
    : { status: "reschedule_requested", preferredSlots: slots(value.preferredSlots), timeZone: zone(value.timeZone) };
  return update(config, item, Number(value.expectedVersion), updates, "consumer");
}

async function workforceAction(config: TelehealthConfiguration, actor: Actor, value: Record<string, unknown>) {
  exact(value, ["requestId", "action", "expectedVersion", "scheduledStart", "scheduledEnd", "timeZone"], ["requestId", "action", "expectedVersion"]);
  const item = await find(config, actor.organizationId, String(value.requestId));
  if (!Number.isInteger(value.expectedVersion) || !["schedule", "reschedule", "cancel"].includes(String(value.action))) throw new TelehealthError("request_invalid");
  if (item.status === "cancelled") throw new TelehealthError("conflict");
  if (value.action === "cancel") return update(config, item, Number(value.expectedVersion), { status: "cancelled", joinUrl: null, providerMeetingId: null }, "workforce");
  if (value.action === "schedule" && !["requested", "reschedule_requested", "awaiting_provider"].includes(item.status)) throw new TelehealthError("conflict");
  if (value.action === "reschedule" && !["scheduled", "reschedule_requested", "awaiting_provider"].includes(item.status)) throw new TelehealthError("conflict");
  const start = String(value.scheduledStart ?? ""); const end = String(value.scheduledEnd ?? ""); const timeZone = zone(value.timeZone);
  if (!date(start) || !date(end) || new Date(end) <= new Date(start)) throw new TelehealthError("request_invalid");
  let meeting: { joinUrl: string; providerMeetingId: string } | null = null;
  if (config.zoomEnabled) {
    if (!config.zoomBaaVerified) throw new TelehealthError("provider_unavailable");
    meeting = await createZoomMeeting(config, { requestId: item.requestId, start, durationMinutes: Math.ceil((+new Date(end) - +new Date(start)) / 60_000), timeZone });
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
    cancellationPolicy: item.cancellationPolicy, updatedAt };
  try { await document.send(new TransactWriteCommand({ TransactItems: [
    { Update: { TableName: config.tableName, Key: { pk: item.pk, sk: item.sk }, UpdateExpression: "SET #version=:next,#status=:status,scheduledStart=:start,scheduledEnd=:end,joinUrl=:join,providerMeetingId=:meeting,timeZone=:zone,appointmentId=:appointment,updatedAt=:updated,lastActionBy=:by", ConditionExpression: "#version=:expected", ExpressionAttributeNames: { "#version": "version", "#status": "status" }, ExpressionAttributeValues: { ":expected": version, ":next": version + 1, ":status": values.status, ":start": values.scheduledStart, ":end": values.scheduledEnd, ":join": values.joinUrl, ":meeting": values.providerMeetingId, ":zone": values.timeZone, ":appointment": appointmentId, ":updated": updatedAt, ":by": "workforce" } } },
    { Put: { TableName: config.tableName, Item: appointment } },
  ] })); } catch(error) { if ((error as { name?: string }).name === "TransactionCanceledException" || (error as { name?: string }).name === "ConditionalCheckFailedException") throw new TelehealthError("conflict"); throw error; }
  return publicItem(next, "workforce");
}

async function update(config: TelehealthConfiguration, item: AppointmentItem, version: number, values: Partial<AppointmentItem>, by: "consumer" | "workforce") {
  if (version !== item.version) throw new TelehealthError("conflict");
  const names: Record<string, string> = { "#version": "version", "#status": "status" };
  const attrs: Record<string, unknown> = { ":expected": version, ":next": version + 1, ":updated": new Date().toISOString(), ":by": by, ":status": values.status };
  const clauses = ["#version=:next", "updatedAt=:updated", "lastActionBy=:by", "#status=:status"];
  for (const key of ["preferredSlots", "timeZone", "scheduledStart", "scheduledEnd", "joinUrl", "providerMeetingId"] as const) {
    if (key in values) { names[`#${key}`] = key; attrs[`:${key}`] = values[key]; clauses.push(`#${key}=:${key}`); }
  }
  try {
    const result = await document.send(new UpdateCommand({ TableName: config.tableName, Key: { pk: item.pk, sk: item.sk }, UpdateExpression: `SET ${clauses.join(", ")}`, ConditionExpression: "#version=:expected", ExpressionAttributeNames: names, ExpressionAttributeValues: attrs, ReturnValues: "ALL_NEW" }));
    return publicItem(result.Attributes as AppointmentItem, by);
  } catch (error) { if ((error as { name?: string }).name === "ConditionalCheckFailedException") throw new TelehealthError("conflict"); throw error; }
}

async function createZoomMeeting(config: TelehealthConfiguration, input: { requestId: string; start: string; durationMinutes: number; timeZone: string }) {
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId: config.zoomSecretArn }));
  let parsed: Record<string, unknown>; try { parsed = JSON.parse(secret.SecretString ?? "") as Record<string, unknown>; } catch { throw new TelehealthError("provider_unavailable"); }
  const accountId = field(parsed, "accountId"); const clientId = field(parsed, "clientId"); const clientSecret = field(parsed, "clientSecret"); const userId = field(parsed, "userId");
  const tokenResponse = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}` } });
  if (!tokenResponse.ok) throw new TelehealthError("provider_unavailable");
  const token = await tokenResponse.json() as Record<string, unknown>; const accessToken = field(token, "access_token");
  const meetingResponse = await fetch(`https://api.zoom.us/v2/users/${encodeURIComponent(userId)}/meetings`, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ topic: "AI Longevity Pro telehealth appointment", type: 2, start_time: input.start, duration: input.durationMinutes, timezone: input.timeZone, agenda: `Governed appointment request ${input.requestId}`, settings: { waiting_room: true, join_before_host: false, meeting_authentication: true } }) });
  if (!meetingResponse.ok) throw new TelehealthError("provider_unavailable");
  const meeting = await meetingResponse.json() as Record<string, unknown>;
  return { joinUrl: field(meeting, "join_url"), providerMeetingId: String(meeting.id ?? "") };
}

type Actor = { personId: string; organizationId: string; subject: string };
function identity(event: ApiGatewayV2Event, config: TelehealthConfiguration, pool: "consumer" | "workforce"): Actor {
  const claims = event.requestContext?.authorizer?.jwt?.claims; const claim = (key: string) => typeof claims?.[key] === "string" ? claims[key] as string : "";
  const issuer = pool === "consumer" ? config.consumerIssuer : config.workforceIssuer; const audience = pool === "consumer" ? config.consumerAudience : config.workforceAudience;
  if (claim("iss") !== issuer || claim("aud") !== audience || claim("token_use") !== "id" || !UUID.test(claim("custom:person_id")) || !UUID.test(claim("custom:organization_id")) || !SUBJECT.test(claim("sub"))
    || (config.runtimeMode === "synthetic" ? claim("custom:synthetic_attested") !== "true" || claim("custom:production_bound") === "true" : claim("custom:production_bound") !== "true")) throw new TelehealthError("identity_refused");
  return { personId: claim("custom:person_id"), organizationId: claim("custom:organization_id"), subject: claim("sub") };
}

function body(event: ApiGatewayV2Event): Record<string, unknown> { const content = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === "content-type")?.[1]; if (!content?.startsWith("application/json") || typeof event.body !== "string" || Buffer.byteLength(event.body) > MAX_BODY) throw new TelehealthError("request_invalid"); try { const value = JSON.parse(event.body); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value; } catch { throw new TelehealthError("request_invalid"); } }
function exact(value: Record<string, unknown>, allowed: string[], required: string[]) { if (Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => !(key in value))) throw new TelehealthError("request_invalid"); }
function date(value: string) { return value.length <= 40 && Number.isFinite(+new Date(value)); }
function slots(value: unknown): string[] { if (!Array.isArray(value) || value.length < 1 || value.length > 3 || value.some((entry) => typeof entry !== "string" || !date(entry))) throw new TelehealthError("request_invalid"); return value; }
function zone(value: unknown): string { if (typeof value !== "string" || !/^[A-Za-z_]+\/[A-Za-z_+-]+$/.test(value)) throw new TelehealthError("request_invalid"); return value; }
function field(value: Record<string, unknown>, key: string): string { const found = value[key]; if (typeof found !== "string" || found.length < 2 || found.length > 500) throw new TelehealthError("provider_unavailable"); return found; }
function publicItem(item: AppointmentItem, pool: "consumer" | "workforce") {
  const result: Partial<AppointmentItem> = { ...item };
  delete result.pk; delete result.sk; delete result.gsi1pk; delete result.gsi1sk;
  if (pool === "consumer") delete result.consumerPersonId;
  return result;
}
function validateConfiguration(config: TelehealthConfiguration) { if (!config.tableName || !config.consumerIssuer || !config.workforceIssuer || !config.consumerAudience || !config.workforceAudience || (config.runtimeMode === "synthetic" && config.phiAllowed) || (config.zoomEnabled && (!config.zoomBaaVerified || !config.zoomSecretArn))) throw new Error("telehealth_configuration_invalid"); }
class TelehealthError extends Error { constructor(readonly category: "identity_refused" | "request_invalid" | "not_found" | "conflict" | "provider_unavailable" | "service_unavailable") { super(category); } }
function response(statusCode: number, payload: Record<string, unknown>): ApiGatewayV2Response { return { statusCode, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }, body: JSON.stringify(payload) }; }
