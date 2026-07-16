import { NextResponse } from "next/server";
import { USE_LIVE_API } from "@/adapters/mode";
import { AdapterError, HTTP_STATUS, toAdapterError } from "@/adapters/errors";

/**
 * Shared plumbing for the `/api/live/*` route handlers — the server-side bridge
 * a client component uses to reach the authenticated tRPC backend without ever
 * importing server-only code into the browser bundle.
 *
 * Every response is `{ data }` on success or `{ error: { code, message } }` on
 * failure, with a matching HTTP status. Failures are logged with code + safe
 * detail only — never request bodies or backend payloads (possible PHI).
 */

/** Refuse live routes when the flag is off, so mock builds expose no live surface. */
export function liveGuard(): NextResponse | null {
  if (!USE_LIVE_API) {
    return NextResponse.json(new AdapterError("unavailable", "Live API is disabled.").toJSON(), {
      status: HTTP_STATUS.unavailable,
    });
  }
  return null;
}

export async function runLive<T>(fn: () => Promise<T>): Promise<NextResponse> {
  try {
    const data = await fn();
    return NextResponse.json({ data });
  } catch (e) {
    const err = toAdapterError(e);
    console.error(`[live] ${err.code}: ${err.detail ?? err.message}`);
    return NextResponse.json(err.toJSON(), { status: HTTP_STATUS[err.code] });
  }
}
