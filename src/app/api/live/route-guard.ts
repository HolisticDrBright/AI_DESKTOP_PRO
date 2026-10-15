import { NextResponse } from "next/server";
import { USE_LIVE_API } from "@/adapters/mode";
import { AdapterError, HTTP_STATUS } from "@/adapters/errors";

/**
 * Refuse live routes when the flag is off, so mock builds expose no live surface. Kept apart from `runLive` so a route
 * that only needs the guard (the campaign route, which must reach no clinical code) does not import the clinical
 * request context.
 */
export function liveGuard(): NextResponse | null {
  if (!USE_LIVE_API) {
    return NextResponse.json(new AdapterError("unavailable", "Live API is disabled.").toJSON(), {
      status: HTTP_STATUS.unavailable,
    });
  }
  return null;
}
