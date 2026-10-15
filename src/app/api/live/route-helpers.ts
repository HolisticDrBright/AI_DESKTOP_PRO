import { NextResponse } from "next/server";
import { HTTP_STATUS, toAdapterError } from "@/adapters/errors";
import { withSelectedClinic } from "@/adapters/selected-clinic.server";
import { getRequestSelectedClinic } from "@/server/request-clinic";

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
 * name that clinic (under `database_current`) without any caller choosing it.
 */
export async function runLive<T>(fn: () => Promise<T>): Promise<NextResponse> {
  try {
    const data = await withSelectedClinic(await getRequestSelectedClinic(), fn);
    return NextResponse.json({ data });
  } catch (e) {
    const err = toAdapterError(e);
    console.error(`[live] ${err.code}: ${err.detail ?? err.message}`);
    return NextResponse.json(err.toJSON(), { status: HTTP_STATUS[err.code] });
  }
}
