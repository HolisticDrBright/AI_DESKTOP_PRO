import { NextRequest } from "next/server";
import { programsLive } from "@/adapters/programs.live";
import type { LiveProgramOfferPaymentMode } from "@/adapters/live-types";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

const PAYMENT_MODES: LiveProgramOfferPaymentMode[] = ["free", "manual_comp", "stripe"];

/**
 * POST — create or update an offer. Terms storage ONLY: the database never
 * charges, and a stripe-mode offer refuses enrollment as not configured.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      programId?: unknown;
      offerId?: unknown;
      name?: unknown;
      priceCents?: unknown;
      currency?: unknown;
      accessDurationDays?: unknown;
      paymentMode?: unknown;
      enrollmentOpen?: unknown;
      status?: unknown;
    };
    if (typeof b.programId !== "string" || !b.programId) {
      throw new Error("programId is required");
    }
    const paymentMode = PAYMENT_MODES.includes(b.paymentMode as LiveProgramOfferPaymentMode)
      ? (b.paymentMode as LiveProgramOfferPaymentMode)
      : "free";
    const session = await getRequestSession();
    return programsLive.upsertOffer(
      {
        programId: b.programId,
        offerId: typeof b.offerId === "string" ? b.offerId : null,
        name: typeof b.name === "string" ? b.name : null,
        priceCents:
          typeof b.priceCents === "number" && Number.isFinite(b.priceCents) ? b.priceCents : 0,
        currency: typeof b.currency === "string" && b.currency ? b.currency : "usd",
        accessDurationDays:
          typeof b.accessDurationDays === "number" && Number.isFinite(b.accessDurationDays)
            ? b.accessDurationDays
            : null,
        paymentMode,
        enrollmentOpen: b.enrollmentOpen !== false,
        status: b.status === "retired" ? "retired" : "active",
      },
      session.token,
    );
  });
}
