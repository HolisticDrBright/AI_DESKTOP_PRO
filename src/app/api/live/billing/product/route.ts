import { NextRequest } from "next/server";
import { billingLive } from "@/adapters/billing.live";
import type { LiveBillingProductKind } from "@/adapters/live-types";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

const KINDS: LiveBillingProductKind[] = [
  "service",
  "visit",
  "program",
  "package",
  "lab",
  "product",
  "supplement",
  "adjustment",
  "other",
];

/**
 * POST — create, update, or archive a catalog product. The database enforces
 * the financial role, tenant agreement on supplier/tax references, and the
 * expected version; archiving preserves every past invoice line snapshot.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      action?: unknown;
      id?: unknown;
      expectedVersion?: unknown;
      name?: unknown;
      kind?: unknown;
      amountMinor?: unknown;
      currency?: unknown;
      sku?: unknown;
      barcode?: unknown;
      supplierId?: unknown;
      costMinor?: unknown;
      taxRateId?: unknown;
      description?: unknown;
      trackInventory?: unknown;
      reorderThreshold?: unknown;
    };
    const session = await getRequestSession();
    const expectedVersion =
      typeof b.expectedVersion === "number" && Number.isFinite(b.expectedVersion)
        ? b.expectedVersion
        : null;

    if (b.action === "archive") {
      if (typeof b.id !== "string" || !b.id) throw new Error("id is required");
      if (expectedVersion === null) throw new Error("expectedVersion is required");
      return billingLive.archiveProduct(
        { productId: b.id, expectedVersion },
        session.orgId,
        session.token,
      );
    }

    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return billingLive.upsertProduct(
      {
        id: typeof b.id === "string" && b.id ? b.id : null,
        expectedVersion,
        name: typeof b.name === "string" ? b.name : null,
        kind: KINDS.includes(b.kind as LiveBillingProductKind)
          ? (b.kind as LiveBillingProductKind)
          : null,
        amountMinor: num(b.amountMinor),
        currency: typeof b.currency === "string" && b.currency ? b.currency : null,
        sku: typeof b.sku === "string" ? b.sku : null,
        barcode: typeof b.barcode === "string" ? b.barcode : null,
        supplierId: typeof b.supplierId === "string" && b.supplierId ? b.supplierId : null,
        costMinor: num(b.costMinor),
        taxRateId: typeof b.taxRateId === "string" && b.taxRateId ? b.taxRateId : null,
        description: typeof b.description === "string" ? b.description : null,
        trackInventory: typeof b.trackInventory === "boolean" ? b.trackInventory : null,
        reorderThreshold: num(b.reorderThreshold),
      },
      session.orgId,
      session.token,
    );
  });
}
