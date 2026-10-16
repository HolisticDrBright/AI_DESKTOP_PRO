import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { currentFullscriptSession } from "@/server/fullscript/clinic-authority";
import { connectedFullscriptClient } from "@/server/fullscript/runtime";
import { liveGuard, runLive } from "../../route-helpers";

export async function POST(request: Request) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const session = await currentFullscriptSession(await getRequestSession());
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body.action !== "string") throw new AdapterError("invalid", "Invalid Fullscript request.");
    // Creating a lab checkout commits a treatment plan at Fullscript. Nothing here can fence that commit against a
    // membership or clinic change, and nothing undoes it, so it is held before any token is read, refreshed or sent,
    // whatever FULLSCRIPT_LAB_ORDERING_ENABLED says (docs/fullscript-subject-binding-2026-10-16.md).
    if (body.action === "create_lab_checkout") throw new AdapterError("forbidden", FULLSCRIPT_LAB_CHECKOUT_HELD, "fullscript_lab_checkout_held");
    const { client, connection } = await connectedFullscriptClient(session);
    const result = await perform(body, client, connection.environment);
    // Fullscript answered under the authority read at the start of this request. Read it again before the answer
    // reaches the practitioner, so a membership removed or a clinic suspended while Fullscript was answering withholds
    // the catalog result or treatment-plan link (a refusal here returns nothing from the provider call).
    await currentFullscriptSession(session);
    return result;
  });
}

const FULLSCRIPT_LAB_CHECKOUT_HELD = "Lab checkout through Fullscript is held for review and isn't available from the Desktop.";

async function perform(body: Record<string, unknown>, client: Awaited<ReturnType<typeof connectedFullscriptClient>>["client"],
  environment: string) {
  if (body.action === "search_products" && typeof body.query === "string") return client.searchProducts(body.query);
  if (body.action === "search_labs" && typeof body.query === "string") return client.searchLabs(body.query);
  if (body.action === "lab_order" && typeof body.id === "string") return client.retrieveLabOrder(body.id);
  if (body.action === "new_treatment_plan_link") {
    const result = await client.retrieveNewTreatmentPlanLink();
    const redirectUrl = result.redirect_url;
    if (typeof redirectUrl !== "string" || !isFullscriptUrl(redirectUrl)) throw new AdapterError("unavailable", "Fullscript did not return a safe treatment-plan link.");
    return { redirectUrl, kind: "practitioner_treatment_plan", environment };
  }
  throw new AdapterError("invalid", "Unsupported Fullscript action.");
}

function isFullscriptUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      && (url.hostname === "fullscript.com" || url.hostname.endsWith(".fullscript.com") || url.hostname.endsWith(".fullscript.io"));
  } catch { return false; }
}
