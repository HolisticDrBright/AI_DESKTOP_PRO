import { NextResponse } from "next/server";
import { HTTP_STATUS, toAdapterError } from "@/adapters/errors";
import { withSelectedClinic } from "@/adapters/selected-clinic.server";
import { getRequestSelectedClinic } from "@/server/request-clinic";
import { clinicFence } from "@/server/clinic-fence";
import { CLINIC_BINDING_HEADER } from "@/lib/clinic-binding-headers";

/**
 * Shared plumbing for the `/api/live/*` route handlers — the server-side bridge
 * a client component uses to reach authenticated clinical data services
 * without importing server-only code into the browser bundle.
 *
 * Every response is `{ data }` on success or `{ error: { code, message } }` on
 * failure, with a matching HTTP status. Failures are logged with code + safe
 * detail only — never request bodies or backend payloads (possible PHI).
 */

export { liveGuard } from "./route-guard";

/**
 * Runs one live request with its session's selected clinic in a request-scoped context, so the clinical transport can
 * name that clinic (under `database_current`) without any caller choosing it. First, the stale-tab fence: a tab that
 * was rendered for another clinic or account is refused before the operation runs, and every answer names the
 * binding it was produced under.
 */
export async function runLive<T>(fn: () => Promise<T>): Promise<NextResponse> {
  try {
    const selection = await getRequestSelectedClinic();
    const binding = await clinicFence(selection);
    const data = await withSelectedClinic(selection, fn);
    const response = NextResponse.json({ data });
    if (binding) response.headers.set(CLINIC_BINDING_HEADER, binding);
    return response;
  } catch (e) {
    const err = toAdapterError(e);
    console.error(`[live] ${err.code}: ${err.detail ?? err.message}`);
    return NextResponse.json(err.toJSON(), { status: HTTP_STATUS[err.code] });
  }
}
