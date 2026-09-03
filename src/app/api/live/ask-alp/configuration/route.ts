import { NextRequest, NextResponse } from "next/server";
import { AdapterError, HTTP_STATUS } from "@/adapters/errors";
import { activateAskAlpConfiguration, getAskAlpConfiguration } from "@/server/clinical-core/ask-alp-workforce-client";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

const MAX_BODY = 16 * 1024;

export async function GET() {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const session = await getRequestSession();
    return getAskAlpConfiguration(session.token);
  });
}

export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) throw new Error("origin mismatch");
    } catch {
      return NextResponse.json(new AdapterError("forbidden").toJSON(), { status: HTTP_STATUS.forbidden });
    }
  }
  const length = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY) {
    return NextResponse.json(new AdapterError("invalid").toJSON(), { status: 413 });
  }
  return runLive(async () => {
    const input = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const session = await getRequestSession();
    return activateAskAlpConfiguration(session.token, {
      version: typeof input.version === "string" ? input.version : "",
      confirmation: typeof input.confirmation === "string" ? input.confirmation : "",
      ruleCodes: Array.isArray(input.ruleCodes) && input.ruleCodes.every((item) => typeof item === "string")
        ? input.ruleCodes as string[] : [],
    });
  });
}
