import { NextRequest } from "next/server";
import { billingLive } from "@/adapters/billing.live";
import type { LiveInvoiceLineInput } from "@/adapters/live-types";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST — replace a draft's lines. Tax is deliberately not accepted: the
 * server computes it from the organization's configured rates. A discount
 * without a reason is refused by the database.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      invoiceId?: unknown;
      expectedVersion?: unknown;
      locationId?: unknown;
      lines?: unknown;
    };
    if (typeof b.invoiceId !== "string" || !b.invoiceId) {
      throw new Error("invoiceId is required");
    }
    if (typeof b.expectedVersion !== "number" || !Number.isFinite(b.expectedVersion)) {
      throw new Error("expectedVersion is required");
    }
    if (!Array.isArray(b.lines)) throw new Error("lines must be an array");

    const lines: LiveInvoiceLineInput[] = b.lines.map((raw) => {
      const l = (raw ?? {}) as Record<string, unknown>;
      if (typeof l.productId !== "string" || !l.productId) {
        throw new Error("every line needs a productId");
      }
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
      return {
        productId: l.productId,
        quantity: num(l.quantity),
        unitAmountMinor: num(l.unitAmountMinor),
        discountMinor: num(l.discountMinor),
        discountReason: typeof l.discountReason === "string" ? l.discountReason : null,
      };
    });

    const session = await getRequestSession();
    return billingLive.saveDraft(
      {
        invoiceId: b.invoiceId,
        expectedVersion: b.expectedVersion,
        locationId: typeof b.locationId === "string" ? b.locationId : null,
        lines,
      },
      session.orgId,
      session.token,
    );
  });
}
