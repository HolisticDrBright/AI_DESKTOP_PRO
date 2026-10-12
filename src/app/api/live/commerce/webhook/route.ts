import { NextResponse } from "next/server";
import { StripeNotConfiguredError, StripeRefusedError, getStripeConfig, verifyWebhookSignature } from "@/server/stripe-boundary";
import { selectProgramCheckout } from "@/server/commerce/program-commerce-runtime";

/**
 * The program-checkout webhook receiver. Provider authentication, not a browser origin: the raw
 * body is read first and the signature, timestamp tolerance and livemode are verified over those
 * exact bytes by the existing boundary; then the expected account and the pinned API version are
 * checked; then the event is admitted DURABLY and only then acknowledged. Processing runs after the
 * acknowledgement through the bounded, retryable path; this route never settles an order itself.
 *
 *   503  the boundary is not configured, or no checkout runtime exists for this process (never a fixture)
 *   400  the signature, tolerance, livemode, account or API version refuses the event (not ours to accept)
 *   500  the event could not be recorded durably (the processor must retry)
 *   200  admitted or a recorded duplicate
 *
 * Under the local contract fixture the fictional runtime verifies the same signature scheme with the
 * configured test secret, so the browser suite can drive a signed, fictional event end to end.
 */
export const dynamic = "force-dynamic";
const json = (status: number, value: unknown) => NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });
const MAX_BODY_BYTES = 262_144;

export async function POST(request: Request) {
  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) return json(400, { error: { code: "refused", message: "body_too_large" } });
  const signature = request.headers.get("stripe-signature");
  const selection = selectProgramCheckout();
  if (selection.kind === "disabled") return json(503, { error: { code: "not_configured", message: selection.reason } });
  if (!getStripeConfig().configured) return json(503, { error: { code: "not_configured", message: "The Stripe boundary is disabled." } });
  let event;
  try {
    event = verifyWebhookSignature(rawBody, signature);
  } catch (error) {
    if (error instanceof StripeNotConfiguredError) return json(503, { error: { code: "not_configured", message: error.message } });
    if (error instanceof StripeRefusedError) return json(400, { error: { code: "refused", message: error.message } });
    return json(400, { error: { code: "refused", message: "Webhook could not be verified." } });
  }
  const admission = await selection.checkout.admitEvent(event, rawBody, selection.expected);
  if (admission.outcome === "refused") return json(400, { error: { code: "refused", message: admission.detail } });
  if (admission.outcome === "store_unavailable") return json(500, { error: { code: "unavailable", message: "Could not record the event." } });
  // Acknowledged. Processing is bounded and retryable; its outcome is visible in the intake record, never in this reply.
  // Settlement of whatever is verified follows the same way: idempotent per order, recoverable by the worker.
  void selection.checkout.processEvent(event.id).then(() => selection.settlement.settleDue(5)).catch(() => undefined);
  return json(200, { received: true, outcome: admission.outcome });
}
