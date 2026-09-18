import { liveGuard } from "../../route-helpers";
import { getRequestSession } from "@/server/session";
import { recordingAuthorityRequest } from "@/adapters/recording-authority.server";
import { AdapterError, HTTP_STATUS } from "@/adapters/errors";
import { BoundedBodyError, readBoundedRequestBody } from "@/server/bounded-request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
export async function POST(request: Request) {
  const guard = liveGuard(); if (guard) { guard.headers.set("cache-control", "no-store"); return guard; }
  try {
    if (request.headers.get("origin") !== new URL(request.url).origin
      || request.headers.has("sec-fetch-site") && request.headers.get("sec-fetch-site") !== "same-origin")
      throw new AdapterError("forbidden");
    const session = await getRequestSession();
    if (!session.signedIn || !session.token) throw new AdapterError("unauthenticated");
    if (new URL(request.url).search || request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
      throw new AdapterError("invalid");
    const bytes = await readBoundedRequestBody(request, 10000, 5000);
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new AdapterError("invalid"); }
    const result = await recordingAuthorityRequest(raw, session.token, request.signal);
    return Response.json(result, { headers });
  } catch (error) {
    const safe = error instanceof AdapterError ? error : new AdapterError(error instanceof BoundedBodyError ? "invalid" : "unavailable");
    return Response.json(safe.toJSON(), { status: HTTP_STATUS[safe.code], headers });
  }
}
