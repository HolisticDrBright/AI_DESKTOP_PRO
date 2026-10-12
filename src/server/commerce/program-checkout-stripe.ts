if (typeof window !== "undefined") {
  throw new Error("commerce/program-checkout-stripe is server-only.");
}
import { getStripeConfig, StripeNotConfiguredError } from "../stripe-boundary";
import { processorSession, type ProcessorSession, type ProcessorSessionRequest } from "../../contracts/programCheckout";
import { ProcessorError, type ProgramCheckoutProcessor } from "./program-checkout-processor";

/**
 * The Stripe TEST-MODE Checkout Session transport for program purchases, as source for the
 * clinical service's reviewed wiring. It is built on the existing boundary's rules (test keys only,
 * live refused, default off) and adds what program checkout needs: the expected account the key is
 * bound to, a pinned API version, a bounded deadline, a bounded reply, refusal of redirects and of
 * malformed replies, and a request that carries the price reference and the opaque order id and
 * nothing else. No request is made from this repository: `fetch` is injected, this module is not
 * selected by any runtime here, and the configuration names below are schema, never values.
 *
 * Configuration (names only):
 *   STRIPE_TEST_MODE_ENABLED, STRIPE_TEST_SECRET_KEY, STRIPE_TEST_WEBHOOK_SECRET  (existing boundary)
 *   STRIPE_TEST_ACCOUNT_ID       the acct_… the key belongs to; every retrieved object is bound to it
 *   STRIPE_API_VERSION_PINNED    the API version every request names and every event must match
 */
export const STRIPE_CHECKOUT_CONFIG_NAMES = ["STRIPE_TEST_MODE_ENABLED", "STRIPE_TEST_SECRET_KEY", "STRIPE_TEST_WEBHOOK_SECRET", "STRIPE_TEST_ACCOUNT_ID", "STRIPE_API_VERSION_PINNED"] as const;
const API_BASE = "https://api.stripe.com/v1";
const MAX_REPLY_BYTES = 262_144;
const DEADLINE_MS = 15_000;

export type StripeCheckoutConfig = { secretKey: string; accountRef: string; apiVersion: string };

export function stripeCheckoutConfig(env: Record<string, string | undefined> = process.env): { configured: true; config: StripeCheckoutConfig } | { configured: false; problems: string[] } {
  const base = getStripeConfig();
  const problems = [...base.problems];
  const accountRef = (env.STRIPE_TEST_ACCOUNT_ID ?? "").trim();
  const apiVersion = (env.STRIPE_API_VERSION_PINNED ?? "").trim();
  if (!/^acct_[A-Za-z0-9]{8,64}$/.test(accountRef)) problems.push("STRIPE_TEST_ACCOUNT_ID is missing or not an account id.");
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:\.[a-z]+)?$/.test(apiVersion)) problems.push("STRIPE_API_VERSION_PINNED is missing or not an API version.");
  if (!base.configured || problems.length) return { configured: false, problems };
  return { configured: true, config: { secretKey: (env.STRIPE_TEST_SECRET_KEY ?? "").trim(), accountRef, apiVersion } };
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const length = response.headers.get("content-length");
  if (length && Number(length) > MAX_REPLY_BYTES) throw new ProcessorError("malformed_reply");
  const text = await response.text();
  if (text.length > MAX_REPLY_BYTES) throw new ProcessorError("malformed_reply");
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new ProcessorError("malformed_reply"); }
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new ProcessorError("malformed_reply");
  return json as Record<string, unknown>;
}

/** The Stripe object as this source reads it, into the contract's session shape; anything unexpected is a malformed reply. */
export function sessionFromStripeObject(object: Record<string, unknown>, accountRef: string): ProcessorSession {
  const lineItems = (object.line_items as { data?: unknown } | undefined)?.data;
  const priceRefs = Array.isArray(lineItems) ? lineItems.map(item => (item as { price?: { id?: unknown } })?.price?.id).filter((id): id is string => typeof id === "string") : [];
  const parsed = processorSession.safeParse({
    sessionRef: object.id, url: object.url ?? "https://checkout.stripe.com/c/pay/retrieved", expiresAt: typeof object.expires_at === "number" ? new Date(object.expires_at * 1000).toISOString() : undefined,
    status: object.status, paymentStatus: object.payment_status, mode: object.mode, livemode: object.livemode, amountTotal: object.amount_total ?? null,
    currency: object.currency ?? null, clientReferenceId: object.client_reference_id ?? null, metadata: object.metadata ?? {}, priceRefs, accountRef,
  });
  if (!parsed.success) throw new ProcessorError("malformed_reply");
  return parsed.data;
}

export function createStripeCheckoutProcessor(config: StripeCheckoutConfig, fetchImpl: Fetch): ProgramCheckoutProcessor {
  const request = async (path: string, init: { method: "GET" | "POST"; body?: URLSearchParams; idempotencyKey?: string }): Promise<Record<string, unknown>> => {
    let response: Response;
    try {
      response = await fetchImpl(`${API_BASE}${path}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${config.secretKey}`, "stripe-version": config.apiVersion, accept: "application/json",
          ...(init.body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
          ...(init.idempotencyKey ? { "idempotency-key": init.idempotencyKey } : {}),
        },
        body: init.body?.toString(), redirect: "error", cache: "no-store", signal: AbortSignal.timeout(DEADLINE_MS),
      });
    } catch (error) {
      throw new ProcessorError(error instanceof Error && error.name === "TimeoutError" ? "timeout" : error instanceof TypeError && /redirect/i.test(error.message) ? "redirect_reply" : "unavailable");
    }
    if (response.status >= 300 && response.status < 400) throw new ProcessorError("redirect_reply");
    if (response.status >= 500) throw new ProcessorError("unavailable");
    const json = await boundedJson(response);
    if (!response.ok) throw new ProcessorError("refused");
    if (json.livemode === true) throw new ProcessorError("refused");
    return json;
  };
  return {
    accountRef: config.accountRef,
    async createSession(input: ProcessorSessionRequest) {
      const body = new URLSearchParams({
        mode: input.pricing.billing.kind === "one_time" ? "payment" : "subscription",
        "line_items[0][price]": input.providerPriceRef, "line_items[0][quantity]": "1",
        success_url: input.successUrl, cancel_url: input.cancelUrl,
        client_reference_id: input.orderId, "metadata[order_id]": input.orderId,
        expires_at: String(Math.floor(Date.parse(input.expiresAt) / 1000)),
        "expand[0]": "line_items",
      });
      return sessionFromStripeObject(await request("/checkout/sessions", { method: "POST", body, idempotencyKey: input.idempotencyKey }), config.accountRef);
    },
    async retrieveSession(sessionRef) {
      if (!/^cs_test_[A-Za-z0-9]{8,200}$/.test(sessionRef)) throw new ProcessorError("refused");
      return sessionFromStripeObject(await request(`/checkout/sessions/${sessionRef}?expand[0]=line_items`, { method: "GET" }), config.accountRef);
    },
    async findSessionByIdempotencyKey() {
      // Stripe answers an idempotent replay from the same key; the boundary retries the create instead of searching.
      return null;
    },
  };
}

/** Construct the transport only from a complete, test-only configuration; otherwise the typed not-configured refusal. */
export function requireStripeCheckoutProcessor(fetchImpl: Fetch, env: Record<string, string | undefined> = process.env): ProgramCheckoutProcessor {
  const config = stripeCheckoutConfig(env);
  if (!config.configured) throw new StripeNotConfiguredError(config.problems);
  return createStripeCheckoutProcessor(config.config, fetchImpl);
}
