if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The Stripe TEST-MODE subscription boundary (server-only).
 *
 * Phase 8A shipped the persistence and ingest side of payments but never
 * contacted a processor. This module is the real adapter — and it is
 * DISABLED BY DEFAULT. Nothing here runs unless an operator deliberately
 * configures test credentials, and every guard below refuses rather than
 * degrades:
 *
 *   - a LIVE secret key (`sk_live_…`) or live webhook secret is refused
 *     outright; there is no code path that talks to live Stripe;
 *   - an event whose `livemode` is true is refused even if it is correctly
 *     signed, because a live object must never touch this database;
 *   - webhook signatures are verified over the RAW body with a constant-time
 *     compare and a timestamp tolerance, so a tampered or replayed payload
 *     cannot be accepted;
 *   - there is NO fixture fallback. When unconfigured this module reports
 *     `not_configured` and the caller renders an honest state. It never
 *     invents a customer, a subscription, or a settlement.
 *
 * A browser redirect back from Checkout is NOT payment proof and is never
 * treated as one: entitlements follow the verified webhook only.
 */

export type StripeMode = "disabled" | "test";

export interface StripeConfigReport {
  mode: StripeMode;
  configured: boolean;
  /** Operator-facing reasons the boundary is refusing, never secrets. */
  problems: string[];
}

const SECRET_KEY = "STRIPE_TEST_SECRET_KEY";
const WEBHOOK_SECRET = "STRIPE_TEST_WEBHOOK_SECRET";
const ENABLE_FLAG = "STRIPE_TEST_MODE_ENABLED";

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

/**
 * Inspect configuration without throwing. Used by the status surface and by
 * routes that must answer "not configured" honestly.
 */
export function getStripeConfig(): StripeConfigReport {
  const problems: string[] = [];
  const enabled = env(ENABLE_FLAG) === "1" || env(ENABLE_FLAG).toLowerCase() === "true";
  const secret = env(SECRET_KEY);
  const webhookSecret = env(WEBHOOK_SECRET);

  if (!enabled) {
    return {
      mode: "disabled",
      configured: false,
      problems: [`${ENABLE_FLAG} is not set — the Stripe boundary is disabled.`],
    };
  }

  // Live credentials are a configuration ERROR here, not an upgrade path.
  if (secret.startsWith("sk_live_") || secret.startsWith("rk_live_")) {
    problems.push(
      `${SECRET_KEY} holds a LIVE key. This build refuses live Stripe entirely.`,
    );
  }
  if (webhookSecret && !webhookSecret.startsWith("whsec_")) {
    problems.push(`${WEBHOOK_SECRET} is not a Stripe webhook secret.`);
  }
  if (!secret) problems.push(`${SECRET_KEY} is missing.`);
  if (!secret.startsWith("sk_test_") && !secret.startsWith("rk_test_") && secret) {
    problems.push(`${SECRET_KEY} is not a test-mode key.`);
  }
  if (!webhookSecret) problems.push(`${WEBHOOK_SECRET} is missing.`);

  return {
    mode: problems.length === 0 ? "test" : "disabled",
    configured: problems.length === 0,
    problems,
  };
}

export class StripeNotConfiguredError extends Error {
  readonly code = "not_configured";
  constructor(problems: string[]) {
    super("The Stripe test-mode boundary is not configured.");
    this.name = "StripeNotConfiguredError";
    this.problems = problems;
  }
  readonly problems: string[];
}

export class StripeRefusedError extends Error {
  readonly code = "refused";
  constructor(message: string) {
    super(message);
    this.name = "StripeRefusedError";
  }
}

/** Assert the boundary is usable, or throw a typed not-configured error. */
export function requireStripe(): StripeConfigReport {
  const report = getStripeConfig();
  if (!report.configured) throw new StripeNotConfiguredError(report.problems);
  return report;
}

/* ------------------------------------------------------------ signatures */

export interface VerifiedEvent {
  id: string;
  type: string;
  livemode: boolean;
  created: number;
  data: { object: Record<string, unknown> };
}

/**
 * Verify a Stripe webhook signature over the RAW request body.
 *
 * Mirrors Stripe's scheme (`t=…,v1=…`), including:
 *   - constant-time comparison, so a wrong signature leaks no timing;
 *   - a timestamp tolerance, so a captured payload cannot be replayed later;
 *   - acceptance of MULTIPLE v1 signatures (Stripe sends one per active
 *     secret during rotation).
 *
 * The raw body must be the exact bytes received. Parsing first and
 * re-serializing would change them and every signature would fail — which is
 * why the route reads `await req.text()` before any JSON parsing.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  options: { toleranceSeconds?: number; nowSeconds?: number } = {},
): VerifiedEvent {
  const report = requireStripe();
  if (report.mode !== "test") {
    throw new StripeRefusedError("The Stripe boundary is not in test mode.");
  }
  if (!signatureHeader) {
    throw new StripeRefusedError("Missing signature header.");
  }

  const parts = signatureHeader.split(",").map((p) => p.trim());
  const timestamp = parts.find((p) => p.startsWith("t="))?.slice(2);
  const signatures = parts.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));

  if (!timestamp || signatures.length === 0) {
    throw new StripeRefusedError("Malformed signature header.");
  }

  const tolerance = options.toleranceSeconds ?? 300;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    throw new StripeRefusedError("Malformed signature timestamp.");
  }
  if (Math.abs(now - ts) > tolerance) {
    throw new StripeRefusedError("Signature timestamp outside the tolerance window.");
  }

  const expected = createHmac("sha256", env(WEBHOOK_SECRET))
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");

  const expectedBuf = Buffer.from(expected, "utf8");
  const matched = signatures.some((candidate) => {
    const candidateBuf = Buffer.from(candidate, "utf8");
    if (candidateBuf.length !== expectedBuf.length) return false;
    return timingSafeEqual(candidateBuf, expectedBuf);
  });

  if (!matched) {
    throw new StripeRefusedError("Signature verification failed.");
  }

  let parsed: VerifiedEvent;
  try {
    parsed = JSON.parse(rawBody) as VerifiedEvent;
  } catch {
    throw new StripeRefusedError("Event body is not valid JSON.");
  }

  if (!parsed?.id || !parsed?.type) {
    throw new StripeRefusedError("Event is missing an id or type.");
  }

  // A correctly signed LIVE event is still refused: live objects must never
  // reach this database, and a signature does not make one acceptable.
  if (parsed.livemode === true) {
    throw new StripeRefusedError("Refusing a live-mode event in a test-only build.");
  }

  return parsed;
}

/* ------------------------------------------------------------- API calls */

const API_BASE = "https://api.stripe.com/v1";

async function stripeRequest<T>(
  path: string,
  body: Record<string, string>,
  idempotencyKey: string,
): Promise<T> {
  requireStripe();
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env(SECRET_KEY)}`,
      "content-type": "application/x-www-form-urlencoded",
      // Stripe deduplicates on this key, so a retried call cannot create a
      // second customer or subscription.
      "idempotency-key": idempotencyKey,
    },
    body: new URLSearchParams(body).toString(),
  });

  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = (json.error ?? {}) as { code?: string; type?: string };
    // The processor's message may echo submitted data; surface a code only.
    throw new StripeRefusedError(
      `Stripe refused the request (${err.type ?? "error"}${err.code ? `: ${err.code}` : ""}).`,
    );
  }
  if (json.livemode === true) {
    throw new StripeRefusedError("Stripe returned a live-mode object; refusing it.");
  }
  return json as T;
}

export interface StripeCustomer {
  id: string;
  livemode: boolean;
}

/** Create (or idempotently re-create) a test-mode customer. No card data. */
export async function createCustomer(input: {
  organizationId: string;
  patientId: string;
  /** An opaque practice-side label. Never a diagnosis or clinical detail. */
  description?: string;
}): Promise<StripeCustomer> {
  return stripeRequest<StripeCustomer>(
    "/customers",
    {
      "metadata[organization_id]": input.organizationId,
      "metadata[patient_id]": input.patientId,
      ...(input.description ? { description: input.description } : {}),
    },
    `customer:${input.organizationId}:${input.patientId}`,
  );
}

export interface StripeSubscription {
  id: string;
  status: string;
  livemode: boolean;
  current_period_end?: number;
  trial_end?: number | null;
}

/** Create a test-mode subscription for an existing customer and price. */
export async function createSubscription(input: {
  customerRef: string;
  priceRef: string;
  organizationId: string;
  patientMembershipId: string;
  trialDays?: number;
}): Promise<StripeSubscription> {
  return stripeRequest<StripeSubscription>(
    "/subscriptions",
    {
      customer: input.customerRef,
      "items[0][price]": input.priceRef,
      "metadata[organization_id]": input.organizationId,
      "metadata[patient_membership_id]": input.patientMembershipId,
      ...(input.trialDays ? { trial_period_days: String(input.trialDays) } : {}),
    },
    `subscription:${input.patientMembershipId}`,
  );
}

/**
 * Map a Stripe subscription status onto ours. Unknown statuses are NOT
 * guessed — they surface as null so the caller records an exception rather
 * than inventing a state.
 */
export function mapSubscriptionStatus(stripeStatus: string): string | null {
  const map: Record<string, string> = {
    trialing: "trialing",
    active: "active",
    past_due: "past_due",
    unpaid: "unpaid",
    paused: "paused",
    canceled: "canceled",
    incomplete: "incomplete",
    incomplete_expired: "incomplete_expired",
  };
  return map[stripeStatus] ?? null;
}
