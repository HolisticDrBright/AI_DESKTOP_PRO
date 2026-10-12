if (typeof window !== "undefined") {
  throw new Error("commerce/program-checkout-stripe is server-only.");
}
import { getStripeConfig, StripeNotConfiguredError } from "../stripe-boundary";
import { BoundedBodyError, readBoundedRequestBody } from "../bounded-request-body";
import { PAYMENT_INTENT_STATUSES, encodeCreationRequest, processorSession, type ProcessorSession, type ProcessorSessionRequest } from "../../contracts/programCheckout";
import { ProcessorError, type ProgramCheckoutProcessor } from "./program-checkout-processor";

/**
 * The Stripe TEST-MODE Checkout Session transport for program purchases, as source for the
 * clinical service's reviewed wiring. It is built on the existing boundary's rules (test keys only,
 * live refused, default off) and adds what program checkout needs:
 *
 *   - the account is PROVEN, not assumed: `authority()` retrieves the account the secret key belongs
 *     to (GET /v1/account) and every session is attributed to that observation; a configured label
 *     that disagrees with the key's own account is refused;
 *   - creation sends the order's SAVED request, form-encoded exactly as recorded, under its saved
 *     idempotency key; Stripe answers a replay of the same parameters with the first session and
 *     refuses different parameters with an idempotency error, which is surfaced as such;
 *   - every reply is read through a bounded byte reader (size, content-length disagreement, slow
 *     body, cancellation) under ONE deadline that covers connection, body and parsing;
 *   - nothing missing is filled in: a session without a hosted address has no address here.
 *
 * No request is made from this repository: `fetch` is injected, this module is not selected by any
 * runtime here, and the configuration names below are schema, never values.
 *
 * Configuration (names only):
 *   STRIPE_TEST_MODE_ENABLED, STRIPE_TEST_SECRET_KEY, STRIPE_TEST_WEBHOOK_SECRET  (existing boundary)
 *   STRIPE_TEST_ACCOUNT_ID       the acct_… the key must prove it belongs to (checked against GET /v1/account)
 *   STRIPE_API_VERSION_PINNED    the API version every request names and every event must match
 */
export const STRIPE_CHECKOUT_CONFIG_NAMES = ["STRIPE_TEST_MODE_ENABLED", "STRIPE_TEST_SECRET_KEY", "STRIPE_TEST_WEBHOOK_SECRET", "STRIPE_TEST_ACCOUNT_ID", "STRIPE_API_VERSION_PINNED"] as const;
const API_BASE = "https://api.stripe.com/v1";
export const MAX_REPLY_BYTES = 262_144;
export const DEADLINE_MS = 15_000;
/** Stripe keeps idempotency keys for at least 24 hours. */
export const STRIPE_IDEMPOTENCY_RETENTION_HOURS = 24;

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

/** Read a reply's exact bytes within the byte bound and what remains of the deadline, then parse it. */
export async function boundedJson(response: Response, deadline: number, signal: AbortSignal): Promise<Record<string, unknown>> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ProcessorError("timeout");
  let bytes: ArrayBuffer;
  try {
    bytes = await readBoundedRequestBody({ body: response.body, headers: response.headers, signal }, MAX_REPLY_BYTES, remaining);
  } catch (error) {
    if (error instanceof BoundedBodyError && error.reason === "interrupted" && Date.now() >= deadline) throw new ProcessorError("timeout");
    throw new ProcessorError("malformed_reply");
  }
  if (Date.now() >= deadline) throw new ProcessorError("timeout");
  let json: unknown;
  try { json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new ProcessorError("malformed_reply"); }
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new ProcessorError("malformed_reply");
  return json as Record<string, unknown>;
}

/** The Stripe object as this source reads it, into the contract's session shape, attributed to the PROVEN account; anything unexpected is a malformed reply. */
export function sessionFromStripeObject(object: Record<string, unknown>, provenAccountRef: string): ProcessorSession {
  const lineItems = (object.line_items as { data?: unknown } | undefined)?.data;
  const priceRefs = Array.isArray(lineItems) ? lineItems.map(item => (item as { price?: { id?: unknown } })?.price?.id).filter((id): id is string => typeof id === "string") : [];
  const intent = object.payment_intent;
  const intentStatus = intent && typeof intent === "object" && typeof (intent as { status?: unknown }).status === "string" && (PAYMENT_INTENT_STATUSES as readonly string[]).includes((intent as { status: string }).status) ? (intent as { status: string }).status : null;
  const parsed = processorSession.safeParse({
    sessionRef: object.id, url: typeof object.url === "string" ? object.url : null, expiresAt: typeof object.expires_at === "number" ? new Date(object.expires_at * 1000).toISOString() : undefined,
    status: object.status, paymentStatus: object.payment_status, paymentIntentStatus: intentStatus,
    successUrl: typeof object.success_url === "string" ? object.success_url : null, cancelUrl: typeof object.cancel_url === "string" ? object.cancel_url : null,
    mode: object.mode, livemode: object.livemode, amountTotal: object.amount_total ?? null,
    currency: object.currency ?? null, clientReferenceId: object.client_reference_id ?? null, metadata: object.metadata ?? {}, priceRefs, accountRef: provenAccountRef,
  });
  if (!parsed.success) throw new ProcessorError("malformed_reply");
  return parsed.data;
}

export function createStripeCheckoutProcessor(config: StripeCheckoutConfig, fetchImpl: Fetch): ProgramCheckoutProcessor {
  const request = async (path: string, init: { method: "GET" | "POST"; body?: string; idempotencyKey?: string }): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + DEADLINE_MS;
    const signal = AbortSignal.timeout(DEADLINE_MS);
    let response: Response;
    try {
      response = await fetchImpl(`${API_BASE}${path}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${config.secretKey}`, "stripe-version": config.apiVersion, accept: "application/json",
          ...(init.body !== undefined ? { "content-type": "application/x-www-form-urlencoded" } : {}),
          ...(init.idempotencyKey ? { "idempotency-key": init.idempotencyKey } : {}),
        },
        body: init.body, redirect: "error", cache: "no-store", signal,
      });
    } catch (error) {
      throw new ProcessorError(error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "timeout" : error instanceof TypeError && /redirect/i.test(error.message) ? "redirect_reply" : "unavailable");
    }
    if (response.status >= 300 && response.status < 400) throw new ProcessorError("redirect_reply");
    // 409 (a concurrent request with the same key), 429 and 5xx leave the outcome unknown.
    if (response.status >= 500 || response.status === 409 || response.status === 429) throw new ProcessorError("unavailable");
    const json = await boundedJson(response, deadline, signal);
    if (!response.ok) {
      const type = (json.error as { type?: unknown } | undefined)?.type;
      throw new ProcessorError(type === "idempotency_error" ? "idempotency_mismatch" : "refused");
    }
    if (json.livemode === true) throw new ProcessorError("refused");
    return json;
  };
  let proven: { accountRef: string; at: number } | null = null;
  const authority = async () => {
    if (!config.secretKey.startsWith("sk_test_") && !config.secretKey.startsWith("rk_test_")) throw new ProcessorError("refused");
    if (proven && Date.now() - proven.at < 300_000) return { accountRef: proven.accountRef, livemode: false as const };
    const account = await request("/account", { method: "GET" });
    if (typeof account.id !== "string" || !/^acct_[A-Za-z0-9]{8,64}$/.test(account.id)) throw new ProcessorError("malformed_reply");
    proven = { accountRef: account.id, at: Date.now() };
    return { accountRef: account.id, livemode: false as const };
  };
  const provenAccount = async () => (await authority()).accountRef;
  return {
    accountRef: config.accountRef,
    checkoutHosts: ["checkout.stripe.com"],
    idempotencyRetentionHours: STRIPE_IDEMPOTENCY_RETENTION_HOURS,
    authority,
    async createSession(creation: ProcessorSessionRequest) {
      const account = await provenAccount();
      // The saved request, form-encoded exactly as recorded; the expansions are read-side only and identical on every replay.
      const body = `${encodeCreationRequest(creation.request)}&expand%5B0%5D=line_items&expand%5B1%5D=payment_intent`;
      return sessionFromStripeObject(await request("/checkout/sessions", { method: "POST", body, idempotencyKey: creation.idempotencyKey }), account);
    },
    async retrieveSession(sessionRef) {
      if (!/^cs_test_[A-Za-z0-9]{8,200}$/.test(sessionRef)) throw new ProcessorError("refused");
      const account = await provenAccount();
      return sessionFromStripeObject(await request(`/checkout/sessions/${sessionRef}?expand[0]=line_items&expand[1]=payment_intent`, { method: "GET" }), account);
    },
  };
}

/** Construct the transport only from a complete, test-only configuration; otherwise the typed not-configured refusal. */
export function requireStripeCheckoutProcessor(fetchImpl: Fetch, env: Record<string, string | undefined> = process.env): ProgramCheckoutProcessor {
  const config = stripeCheckoutConfig(env);
  if (!config.configured) throw new StripeNotConfiguredError(config.problems);
  return createStripeCheckoutProcessor(config.config, fetchImpl);
}
