import { NextRequest, NextResponse } from "next/server";
import {
  StripeNotConfiguredError,
  StripeRefusedError,
  getStripeConfig,
  verifyWebhookSignature,
} from "@/server/stripe-boundary";
import { recordBillingWebhook } from "@/server/stripe-processor.server";

/**
 * The Stripe TEST-MODE webhook receiver.
 *
 * This is the ONLY path by which a subscription or payment may settle. It runs
 * server-side with the service_role processor RPCs, which are unreachable from
 * any browser module.
 *
 * Order matters and is deliberate:
 *   1. read the RAW body first — parsing and re-serializing would change the
 *      bytes the signature covers, and every signature would then fail;
 *   2. refuse when the boundary is not configured (no fixture fallback);
 *   3. verify the signature, timestamp tolerance, and livemode;
 *   4. hand to the durable ledger, whose unique (provider, event_id) makes a
 *      replay a RECORDED duplicate rather than a second effect.
 *
 * A refusal is always recorded and always answered 200 where Stripe expects
 * it, so the processor does not retry a payload we have deliberately rejected;
 * signature failures answer 400 because those are not ours to accept.
 */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // 1. RAW body, before anything else touches it.
  const rawBody = await req.text();
  const signature = req.headers.get("stripe-signature");

  const config = getStripeConfig();
  if (!config.configured) {
    // 2. Honest refusal — never a fixture, never a silent accept.
    console.warn("[stripe] webhook received while the boundary is disabled");
    return NextResponse.json(
      { error: { code: "not_configured", message: "The Stripe boundary is disabled." } },
      { status: 503 },
    );
  }

  let event;
  try {
    // 3. Signature + tolerance + livemode.
    event = verifyWebhookSignature(rawBody, signature);
  } catch (e) {
    if (e instanceof StripeNotConfiguredError) {
      return NextResponse.json(
        { error: { code: "not_configured", message: e.message } },
        { status: 503 },
      );
    }
    if (e instanceof StripeRefusedError) {
      // Never echo the payload; the reason is a fixed, safe string.
      console.warn(`[stripe] webhook refused: ${e.message}`);
      return NextResponse.json(
        { error: { code: "refused", message: e.message } },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: { code: "refused", message: "Webhook could not be verified." } },
      { status: 400 },
    );
  }

  try {
    // 4. Durable, deduplicating ledger write.
    const outcome = await recordBillingWebhook(event);
    return NextResponse.json({ received: true, outcome: outcome.outcome });
  } catch {
    // A storage failure must NOT look accepted: let Stripe retry.
    console.error("[stripe] webhook could not be recorded");
    return NextResponse.json(
      { error: { code: "unavailable", message: "Could not record the event." } },
      { status: 500 },
    );
  }
}
