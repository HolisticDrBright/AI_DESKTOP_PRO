import { NextResponse } from "next/server";
import { StripeNotConfiguredError, StripeRefusedError, getStripeConfig, verifyWebhookSignature } from "@/server/stripe-boundary";
import { BoundedBodyError, readBoundedRequestBody } from "@/server/bounded-request-body";
import { resolvePurchaseRuntime } from "@/server/commerce/program-commerce-runtime";

/**
 * The program-checkout webhook receiver. Provider authentication, not a browser origin: the body is
 * read as BYTES through the bounded reader (a byte bound that holds with an absent or dishonest
 * Content-Length, a deadline for a slow body, cancellation of an abandoned one), the signature,
 * timestamp tolerance and livemode are verified over those exact bytes, then the expected account
 * and the pinned API version are checked, then the event is admitted DURABLY and only then
 * acknowledged. Nothing runs after the reply: processing belongs to the commerce worker
 * (src/server/commerce/program-commerce-worker.ts), which a host schedules independently and which
 * recovers everything admitted here even if this process exits the moment it answers.
 *
 *   503  the boundary is not configured, or no checkout runtime exists for this process: the local fixture,
 *        or the reviewed runtime only while its bootstrap installed it and its target still verifies
 *   400  the body is malformed, too large or arrived too slowly; or the signature, tolerance, livemode,
 *        account or API version refuses the event (not ours to accept)
 *   500  the event could not be recorded durably (the processor must retry)
 *   200  admitted or a recorded duplicate
 */
export const dynamic = "force-dynamic";
const json = (status: number, value: unknown) => NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });
const MAX_BODY_BYTES = 262_144;
const BODY_DEADLINE_MS = 10_000;

export async function POST(request: Request) {
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await readBoundedRequestBody(request, MAX_BODY_BYTES, BODY_DEADLINE_MS)); }
  catch (error) {
    const reason = error instanceof BoundedBodyError ? error.reason : "interrupted";
    return json(400, { error: { code: "refused", message: reason === "too_large" ? "body_too_large" : `body_${reason}` } });
  }
  const signature = request.headers.get("stripe-signature");
  const selection = await resolvePurchaseRuntime();
  if (selection.kind === "disabled") return json(503, { error: { code: "not_configured", message: selection.reason } });
  if (!getStripeConfig().configured) return json(503, { error: { code: "not_configured", message: "The Stripe boundary is disabled." } });
  let event;
  try {
    event = verifyWebhookSignature(bytes, signature);
  } catch (error) {
    if (error instanceof StripeNotConfiguredError) return json(503, { error: { code: "not_configured", message: error.message } });
    if (error instanceof StripeRefusedError) return json(400, { error: { code: "refused", message: error.message } });
    return json(400, { error: { code: "refused", message: "Webhook could not be verified." } });
  }
  const admission = await selection.checkout.admitEvent(event, bytes, selection.expected);
  if (admission.outcome === "refused") return json(400, { error: { code: "refused", message: admission.detail } });
  if (admission.outcome === "store_unavailable") return json(500, { error: { code: "unavailable", message: "Could not record the event." } });
  // Acknowledged. Nothing else happens in this request: the worker processes admitted intake.
  return json(200, { received: true, outcome: admission.outcome });
}
