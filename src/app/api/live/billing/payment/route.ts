import { NextRequest } from "next/server";
import { billingLive } from "@/adapters/billing.live";
import type { LiveManualPaymentMethod } from "@/adapters/live-types";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

const MANUAL_METHODS: LiveManualPaymentMethod[] = ["cash", "check", "bank_transfer", "external"];

/**
 * POST — record a payment the practice already took by hand. Card payments
 * are NOT accepted here: they go through `billing/card` and settle only via
 * the server-only processor webhook.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      invoiceId?: unknown;
      expectedVersion?: unknown;
      amountMinor?: unknown;
      method?: unknown;
      reference?: unknown;
      idempotencyKey?: unknown;
    };
    if (typeof b.invoiceId !== "string" || !b.invoiceId) {
      throw new Error("invoiceId is required");
    }
    if (typeof b.expectedVersion !== "number" || !Number.isFinite(b.expectedVersion)) {
      throw new Error("expectedVersion is required");
    }
    if (typeof b.amountMinor !== "number" || !Number.isFinite(b.amountMinor)) {
      throw new Error("amountMinor is required");
    }
    if (!MANUAL_METHODS.includes(b.method as LiveManualPaymentMethod)) {
      throw new Error("method must be cash, check, bank_transfer, or external");
    }
    const session = await getRequestSession();
    return billingLive.recordManualPayment(
      {
        invoiceId: b.invoiceId,
        expectedVersion: b.expectedVersion,
        amountMinor: b.amountMinor,
        method: b.method as LiveManualPaymentMethod,
        reference: typeof b.reference === "string" ? b.reference : null,
        idempotencyKey: typeof b.idempotencyKey === "string" ? b.idempotencyKey : null,
      },
      session.orgId,
      session.token,
    );
  });
}
