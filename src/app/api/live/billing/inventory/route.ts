import { NextRequest } from "next/server";
import { billingLive } from "@/adapters/billing.live";
import type {
  LiveInventoryAdjustmentKind,
  LiveInventoryReturnCondition,
} from "@/adapters/live-types";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

const ADJUST_KINDS: LiveInventoryAdjustmentKind[] = ["adjustment", "damaged", "expired"];

/**
 * POST — receive, adjust, or return stock. Every movement lands in the
 * append-only ledger; adjustments and returns require a reason, and a return
 * must declare its condition because only a resalable one restocks.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      action?: unknown;
      locationId?: unknown;
      productId?: unknown;
      quantity?: unknown;
      delta?: unknown;
      kind?: unknown;
      reason?: unknown;
      condition?: unknown;
      unitCostMinor?: unknown;
      supplierId?: unknown;
      reference?: unknown;
      invoiceId?: unknown;
    };
    if (typeof b.locationId !== "string" || !b.locationId) {
      throw new Error("locationId is required");
    }
    if (typeof b.productId !== "string" || !b.productId) {
      throw new Error("productId is required");
    }
    const session = await getRequestSession();
    const reason = typeof b.reason === "string" ? b.reason : "";

    if (b.action === "receive") {
      if (typeof b.quantity !== "number" || !Number.isFinite(b.quantity)) {
        throw new Error("quantity is required");
      }
      return billingLive.receiveStock(
        {
          locationId: b.locationId,
          productId: b.productId,
          quantity: b.quantity,
          unitCostMinor:
            typeof b.unitCostMinor === "number" && Number.isFinite(b.unitCostMinor)
              ? b.unitCostMinor
              : null,
          supplierId: typeof b.supplierId === "string" && b.supplierId ? b.supplierId : null,
          reference: typeof b.reference === "string" ? b.reference : null,
        },
        session.orgId,
        session.token,
      );
    }
    if (b.action === "adjust") {
      if (typeof b.delta !== "number" || !Number.isFinite(b.delta)) {
        throw new Error("delta is required");
      }
      if (!ADJUST_KINDS.includes(b.kind as LiveInventoryAdjustmentKind)) {
        throw new Error("kind must be adjustment, damaged, or expired");
      }
      return billingLive.adjustStock(
        {
          locationId: b.locationId,
          productId: b.productId,
          delta: b.delta,
          kind: b.kind as LiveInventoryAdjustmentKind,
          reason,
        },
        session.orgId,
        session.token,
      );
    }
    if (b.action === "return") {
      if (typeof b.quantity !== "number" || !Number.isFinite(b.quantity)) {
        throw new Error("quantity is required");
      }
      if (b.condition !== "resalable" && b.condition !== "damaged") {
        throw new Error("condition must be resalable or damaged");
      }
      return billingLive.returnStock(
        {
          locationId: b.locationId,
          productId: b.productId,
          quantity: b.quantity,
          condition: b.condition as LiveInventoryReturnCondition,
          reason,
          invoiceId: typeof b.invoiceId === "string" && b.invoiceId ? b.invoiceId : null,
        },
        session.orgId,
        session.token,
      );
    }
    throw new Error("action must be receive, adjust, or return");
  });
}
