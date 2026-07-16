import { NextRequest, NextResponse } from "next/server";
import { requestPasswordReset } from "@/adapters/auth.server";
import { AdapterError, HTTP_STATUS, toAdapterError } from "@/adapters/errors";
import { USE_LIVE_API } from "@/adapters/mode";

const ATTEMPTS_PER_MINUTE = 5;
const windows = new Map<string, { count: number; resetAt: number }>();

/**
 * POST { email } → send a reset email. Enumeration-safe: success and
 * unknown-account responses are identical. Rate-limited per IP.
 */
export async function POST(req: NextRequest) {
  if (!USE_LIVE_API) {
    return NextResponse.json(
      new AdapterError("unavailable", "Demo mode does not use sign-in.").toJSON(),
      { status: HTTP_STATUS.unavailable },
    );
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const now = Date.now();
  const w = windows.get(ip);
  if (!w || now >= w.resetAt) {
    windows.set(ip, { count: 1, resetAt: now + 60_000 });
  } else if (w.count >= ATTEMPTS_PER_MINUTE) {
    return NextResponse.json(
      new AdapterError("unavailable", "Too many reset requests. Try again in a minute.").toJSON(),
      { status: 429 },
    );
  } else {
    w.count += 1;
  }

  try {
    const body = (await req.json().catch(() => ({}))) as { email?: unknown };
    if (typeof body.email !== "string" || !body.email.includes("@")) {
      throw new AdapterError("invalid", "A valid email is required.");
    }
    await requestPasswordReset(body.email.trim());
    return NextResponse.json({ data: { ok: true } });
  } catch (e) {
    const err = toAdapterError(e);
    console.error(`[auth] reset-request ${err.code}`);
    return NextResponse.json(err.toJSON(), { status: HTTP_STATUS[err.code] });
  }
}
