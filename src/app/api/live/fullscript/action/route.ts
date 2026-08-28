import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { connectedFullscriptClient } from "@/server/fullscript/runtime";
import { liveGuard, runLive } from "../../route-helpers";

export async function POST(request: Request) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body.action !== "string") throw new AdapterError("invalid", "Invalid Fullscript request.");
    const { client, connection } = await connectedFullscriptClient(await getRequestSession());
    if (body.action === "search_products" && typeof body.query === "string") return client.searchProducts(body.query);
    if (body.action === "search_labs" && typeof body.query === "string") return client.searchLabs(body.query);
    if (body.action === "lab_order" && typeof body.id === "string") return client.retrieveLabOrder(body.id);
    if (body.action === "create_lab_checkout" && process.env.FULLSCRIPT_LAB_ORDERING_ENABLED === "true"
      && typeof body.fullscriptPatientId === "string" && typeof body.labTestId === "string"
      && typeof body.idempotencyKey === "string") {
      const result = await client.createLabTreatmentPlan({
        fullscriptPatientId: body.fullscriptPatientId,
        practitionerId: connection.resourceOwner.id,
        labTestId: body.labTestId,
        idempotencyKey: body.idempotencyKey,
      });
      const checkoutUrl = result.checkout_url;
      if (typeof checkoutUrl !== "string" || !isFullscriptUrl(checkoutUrl)) {
        throw new AdapterError("unavailable", "Fullscript did not return a safe lab checkout link.");
      }
      return {
        checkoutUrl,
        kind: "lab_checkout",
        labCheckoutStatus: typeof result.lab_checkout_status === "string" ? result.lab_checkout_status : null,
        environment: connection.environment,
      };
    }
    if (body.action === "new_treatment_plan_link") {
      const result = await client.retrieveNewTreatmentPlanLink();
      const redirectUrl = result.redirect_url;
      if (typeof redirectUrl !== "string" || !isFullscriptUrl(redirectUrl)) throw new AdapterError("unavailable", "Fullscript did not return a safe treatment-plan link.");
      return { redirectUrl, kind: "practitioner_treatment_plan", environment: connection.environment };
    }
    throw new AdapterError("invalid", "Unsupported Fullscript action.");
  });
}

function isFullscriptUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      && (url.hostname === "fullscript.com" || url.hostname.endsWith(".fullscript.com") || url.hostname.endsWith(".fullscript.io"));
  } catch { return false; }
}
