if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
import type { VerifiedEvent } from "./stripe-boundary";
import { mapSubscriptionStatus } from "./stripe-boundary";

/**
 * The service_role processor boundary (server-only).
 *
 * Holds the ONLY calls to `record_billing_webhook` and
 * `attach_payment_processor_ref`. Deliberately NOT imported by any adapter or
 * client module, so a compromised browser cannot even name these RPCs — a
 * property `payments-boundary.test.ts` asserts from the outside.
 *
 * Everything here assumes the event has ALREADY been signature-verified and
 * livemode-checked by `stripe-boundary.verifyWebhookSignature`. This module's
 * job is the durable, deduplicating write.
 */

export interface WebhookOutcome {
  outcome: "processed" | "duplicate" | "ignored" | "refused" | "out_of_order";
  detail?: string;
}

function serviceRoleConfig(): { url: string; key: string } | null {
  const url = (process.env.CLINICAL_SUPABASE_URL ?? "").trim();
  const key = (process.env.CLINICAL_SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  if (!url || !key) return null;
  return { url, key };
}

/** Call a service_role-only RPC. Never reachable from a browser session. */
async function serviceRpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const config = serviceRoleConfig();
  if (!config) {
    throw new Error("The processor boundary is not configured.");
  }
  const res = await fetch(`${config.url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: config.key,
      authorization: `Bearer ${config.key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    // The server message may reference stored values; keep it out of logs.
    throw new Error(`processor rpc ${fn} failed with ${res.status}`);
  }
  return (await res.json()) as T;
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

  const result = await serviceRpc<WebhookOutcome>("record_billing_webhook", {
    _event_id: event.id,
    _event_type: event.type,
    _processor_ref:
      typeof object.payment_intent === "string"
        ? object.payment_intent
        : typeof object.id === "string"
          ? object.id
          : null,
    _amount_minor: amountMinor,
    _currency: typeof object.currency === "string" ? object.currency.toUpperCase() : null,
  });

  // An event we do not handle is still recorded above; say so plainly.
  if (!HANDLED.has(event.type)) {
    return { outcome: "ignored", detail: "event type not handled by this build" };
  }
  if (rawStatus && !mappedStatus) {
    return { outcome: "ignored", detail: "unrecognised subscription status" };
  }
  return result;
}

/**
 * Attach a processor reference to a pending payment. Attach-once at the
 * database level, so a retry cannot rebind a payment to a different charge.
 */
export async function attachProcessorRef(
  paymentId: string,
  processorRef: string,
): Promise<void> {
  await serviceRpc("attach_payment_processor_ref", {
    _payment_id: paymentId,
    _processor_ref: processorRef,
  });
}
