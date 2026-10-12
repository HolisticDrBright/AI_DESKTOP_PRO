import { NextResponse } from "next/server";
import { z } from "zod";
import { programsLive } from "@/adapters/programs.live";
import { getRequestSession } from "@/server/session";
import { readBoundedRequestBody } from "@/server/bounded-request-body";
import { sameBrowserOrigin } from "@/server/same-browser-origin";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST — create or update a LEGACY offer (the free / manual_comp / stripe terms the program
 * dispatcher stores). Terms storage ONLY: the database never charges, and a stripe-mode offer
 * refuses enrollment as not configured. Paid program sales use the program-offer/1 contract at
 * /api/live/commerce/offers, not this route.
 *
 * Every field is required and exact. On 08d07b3 this route turned an unknown payment mode into
 * `free`, a non-finite price into 0 and absent flags into open/active, so malformed paid terms
 * reached the dispatcher as a free, open, active offer; it also read the body unbounded and
 * without an origin check. Now a body that is not exactly the contract is refused with 400 and
 * nothing is forwarded; nothing is defaulted.
 */
const legacyOffer = z.object({
  programId: z.string().min(1).max(200),
  offerId: z.string().min(1).max(200).nullable(),
  name: z.string().trim().min(1).max(200).nullable(),
  priceCents: z.number().int().min(0).max(1_000_000),
  currency: z.enum(["usd"]),
  accessDurationDays: z.number().int().min(1).max(3650).nullable(),
  paymentMode: z.enum(["free", "manual_comp", "stripe"]),
  enrollmentOpen: z.boolean(),
  status: z.enum(["active", "retired"]),
}).strict();

const json = (status: number, value: unknown) => NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  if (!sameBrowserOrigin(request)) return json(403, { error: { code: "forbidden", message: "identity_refused" } });
  let body: z.infer<typeof legacyOffer>;
  try {
    body = legacyOffer.parse(JSON.parse(new TextDecoder().decode(await readBoundedRequestBody(request, 4096, 5000))));
  } catch {
    return json(400, { error: { code: "invalid", message: "request_invalid" } });
  }
  return runLive(async () => {
    const session = await getRequestSession();
    return programsLive.upsertOffer(body, session.token);
  });
}
