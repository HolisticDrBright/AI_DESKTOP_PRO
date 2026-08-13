import { NextRequest } from "next/server";
import { billingLive } from "@/adapters/billing.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST — grant patient credit (reason required) or apply it to an invoice. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      action?: unknown;
      patientId?: unknown;
      invoiceId?: unknown;
      expectedVersion?: unknown;
      amountMinor?: unknown;
      reason?: unknown;
    };
    if (typeof b.amountMinor !== "number" || !Number.isFinite(b.amountMinor)) {
      throw new Error("amountMinor is required");
    }
    const session = await getRequestSession();

    if (b.action === "grant") {
      if (typeof b.patientId !== "string" || !b.patientId) {
        throw new Error("patientId is required");
      }
      return billingLive.grantCredit(
        {
          patientId: b.patientId,
          amountMinor: b.amountMinor,
          reason: typeof b.reason === "string" ? b.reason : "",
        },
        session.orgId,
        session.token,
      );
    }
    if (b.action === "apply") {
      if (typeof b.invoiceId !== "string" || !b.invoiceId) {
        throw new Error("invoiceId is required");
      }
      if (typeof b.expectedVersion !== "number" || !Number.isFinite(b.expectedVersion)) {
        throw new Error("expectedVersion is required");
      }
      return billingLive.applyCredit(
        {
          invoiceId: b.invoiceId,
          expectedVersion: b.expectedVersion,
          amountMinor: b.amountMinor,
        },
        session.orgId,
        session.token,
      );
    }
    throw new Error("action must be grant or apply");
  });
}
