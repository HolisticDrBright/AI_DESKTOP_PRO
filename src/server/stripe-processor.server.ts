if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
import type { VerifiedEvent } from "./stripe-boundary";
import { mapSubscriptionStatus } from "./stripe-boundary";
import {
  DynamoDBClient,
  PutItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";

/**
 * The AWS billing-ledger processor boundary (server-only).
 *
 * Writes only minimum-necessary, PHI-free processor metadata into the
 * encrypted AWS billing ledger. Deliberately NOT imported by any adapter or
 * client module, so a compromised browser cannot reach this boundary.
 *
 * Everything here assumes the event has ALREADY been signature-verified and
 * livemode-checked by `stripe-boundary.verifyWebhookSignature`. This module's
 * job is the durable, deduplicating write.
 */

export interface WebhookOutcome {
  outcome: "processed" | "duplicate" | "ignored" | "refused" | "out_of_order";
  detail?: string;
}

function billingConfig(): { tableName: string; region: string } {
  const tableName = (process.env.CLINICAL_AWS_BILLING_LEDGER_TABLE ?? "").trim();
  const region = (process.env.CLINICAL_AWS_REGION ?? process.env.AWS_REGION ?? "").trim();
  if (!/^[A-Za-z0-9_.-]{3,255}$/.test(tableName) || !/^[a-z]{2}-[a-z]+-\d$/.test(region)) {
    throw new Error("The AWS processor boundary is not configured.");
  }
  return { tableName, region };
}

function isConditionalFailure(error: unknown): boolean {
  return Boolean(error) && typeof error === "object"
    && (error as { name?: string }).name === "ConditionalCheckFailedException";
}

function bounded(value: unknown, pattern: RegExp, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!pattern.test(text)) throw new Error(`Invalid ${label}.`);
  return text;
}

/**
 * Which Stripe event types this build understands. An unknown type is
 * RECORDED as `ignored` rather than guessed at — silence would look identical
 * to success.
 */
const HANDLED = new Set([
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "charge.refunded",
  "charge.dispute.created",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_succeeded",
  "invoice.payment_failed",
]);

/**
 * Record a verified event in the durable ledger.
 *
 * Dedup is the DATABASE's `unique (provider, event_id)`, not a check here: a
 * replay that races us still lands as a duplicate rather than a second effect.
 */
export async function recordBillingWebhook(event: VerifiedEvent): Promise<WebhookOutcome> {
  const object = (event.data?.object ?? {}) as Record<string, unknown>;

  // Subscription-shaped events carry their own status; a status this build
  // does not know maps to null and is recorded rather than assumed.
  const rawStatus = typeof object.status === "string" ? object.status : null;
  const mappedStatus = rawStatus ? mapSubscriptionStatus(rawStatus) : null;

  const amountMinor =
    typeof object.amount === "number"
      ? object.amount
      : typeof object.amount_paid === "number"
        ? object.amount_paid
        : null;

  const eventId = bounded(event.id, /^[A-Za-z0-9_.:-]{3,255}$/, "event id");
  const eventType = bounded(event.type, /^[a-z0-9_.]{3,160}$/, "event type");
  const processorRef = typeof object.payment_intent === "string"
    ? object.payment_intent : typeof object.id === "string" ? object.id : null;
  const outcome: WebhookOutcome = !HANDLED.has(event.type)
    ? { outcome: "ignored", detail: "event type not handled by this build" }
    : rawStatus && !mappedStatus
      ? { outcome: "ignored", detail: "unrecognised subscription status" }
      : { outcome: "processed" };
  const config = billingConfig();
  const item: Record<string, AttributeValue> = {
    pk: { S: `EVENT#${eventId}` }, sk: { S: "EVENT" },
    event_type: { S: eventType }, outcome: { S: outcome.outcome },
    received_at: { S: new Date().toISOString() }, data_classification: { S: "billing_metadata_no_phi" },
  };
  if (processorRef) item.processor_ref = { S: bounded(processorRef, /^[A-Za-z0-9_.:-]{2,255}$/, "processor reference") };
  if (amountMinor !== null && Number.isSafeInteger(amountMinor)) item.amount_minor = { N: String(amountMinor) };
  if (typeof object.currency === "string" && /^[a-zA-Z]{3}$/.test(object.currency)) item.currency = { S: object.currency.toUpperCase() };
  try {
    await new DynamoDBClient({ region: config.region }).send(new PutItemCommand({
      TableName: config.tableName, Item: item, ConditionExpression: "attribute_not_exists(pk)",
    }));
  } catch (error) {
    if (isConditionalFailure(error)) return { outcome: "duplicate" };
    throw new Error("AWS billing ledger write failed.");
  }
  return outcome;
}

/**
 * Attach a processor reference to a pending payment. Attach-once at the
 * database level, so a retry cannot rebind a payment to a different charge.
 */
export async function attachProcessorRef(
  paymentId: string,
  processorRef: string,
): Promise<void> {
  const payment = bounded(paymentId, /^[0-9a-f]{8}-[0-9a-f-]{27,45}$/i, "payment id");
  const reference = bounded(processorRef, /^[A-Za-z0-9_.:-]{2,255}$/, "processor reference");
  const config = billingConfig();
  try {
    await new DynamoDBClient({ region: config.region }).send(new PutItemCommand({
      TableName: config.tableName,
      Item: {
        pk: { S: `PAYMENT#${payment}` }, sk: { S: "PROCESSOR_REF" }, processor_ref: { S: reference },
        attached_at: { S: new Date().toISOString() }, data_classification: { S: "billing_metadata_no_phi" },
      },
      ConditionExpression: "attribute_not_exists(pk) OR processor_ref = :processor_ref",
      ExpressionAttributeValues: { ":processor_ref": { S: reference } },
    }));
  } catch (error) {
    if (isConditionalFailure(error)) throw new Error("Processor reference conflict.");
    throw new Error("AWS billing ledger write failed.");
  }
}
