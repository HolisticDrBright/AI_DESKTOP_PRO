import { NextRequest } from "next/server";
import { lensLive, LENS_PARADIGMS, type LensParadigm } from "@/adapters/lens.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

function parseParadigm(raw: unknown): LensParadigm {
  if (typeof raw !== "string" || !LENS_PARADIGMS.includes(raw as LensParadigm)) {
    throw new AdapterError("invalid", "Choose a valid paradigm.");
  }
  return raw as LensParadigm;
}

/** GET ?encounterId=&paradigm= → latest evaluation (with questions + safety blocks) or null. */
export async function GET(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const encounterId = req.nextUrl.searchParams.get("encounterId");
    if (!encounterId) throw new AdapterError("invalid", "An encounter is required.");
    const paradigm = parseParadigm(req.nextUrl.searchParams.get("paradigm"));
    const session = await getRequestSession();
    return lensLive.evaluation({ encounterId, paradigm }, session.token);
  });
}

/**
 * POST { encounterId, paradigm } → run a deterministic evaluation. A blocked
 * run persists reviewable safety failures and ZERO questions — the response
 * carries the status either way.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const encounterId = typeof body.encounterId === "string" ? body.encounterId : "";
    if (!encounterId) throw new AdapterError("invalid", "An encounter is required.");
    const paradigm = parseParadigm(body.paradigm);
    const session = await getRequestSession();
    return lensLive.evaluate({ encounterId, paradigm }, session.token);
  });
}
