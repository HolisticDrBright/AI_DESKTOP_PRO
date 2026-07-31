import { NextRequest } from "next/server";
import { billingLive } from "@/adapters/billing.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST — create or update a location, supplier, or tax rate. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      entity?: unknown;
      id?: unknown;
      name?: unknown;
      contactEmail?: unknown;
      phone?: unknown;
      notes?: unknown;
      rateBps?: unknown;
      active?: unknown;
      archive?: unknown;
    };
    const session = await getRequestSession();
    const id = typeof b.id === "string" && b.id ? b.id : null;
    const name = typeof b.name === "string" ? b.name : null;
    const archive = b.archive === true;

    if (b.entity === "location") {
      return billingLive.upsertLocation({ id, name, archive }, session.orgId, session.token);
    }
    if (b.entity === "supplier") {
      return billingLive.upsertSupplier(
        {
          id,
          name,
          contactEmail: typeof b.contactEmail === "string" ? b.contactEmail : null,
          phone: typeof b.phone === "string" ? b.phone : null,
          notes: typeof b.notes === "string" ? b.notes : null,
          archive,
        },
        session.orgId,
        session.token,
      );
    }
    if (b.entity === "taxRate") {
      return billingLive.upsertTaxRate(
        {
          id,
          name,
          rateBps:
            typeof b.rateBps === "number" && Number.isFinite(b.rateBps) ? b.rateBps : null,
          active: b.active !== false,
        },
        session.orgId,
        session.token,
      );
    }
    throw new Error("entity must be location, supplier, or taxRate");
  });
}
