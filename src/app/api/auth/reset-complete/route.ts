import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIES, completePasswordReset } from "@/adapters/auth.server";
import { AdapterError, HTTP_STATUS, toAdapterError } from "@/adapters/errors";
import { USE_LIVE_API } from "@/adapters/mode";

/**
 * POST { email, confirmationCode, password } → set the new password using the
 * one-time Cognito code. On success every auth cookie is
 * cleared — the practitioner signs in fresh with the new password.
 */
export async function POST(req: NextRequest) {
  if (!USE_LIVE_API) {
    return NextResponse.json(
      new AdapterError("unavailable", "Demo mode does not use sign-in.").toJSON(),
      { status: HTTP_STATUS.unavailable },
    );
  }
  try {
    const body = (await req.json().catch(() => ({}))) as {
      email?: unknown;
      confirmationCode?: unknown;
      password?: unknown;
    };
    if (typeof body.email !== "string" || !body.email.includes("@")) {
      throw new AdapterError("invalid", "Enter the email address for the workforce account.");
    }
    if (typeof body.confirmationCode !== "string" || !/^\d{6}$/.test(body.confirmationCode)) {
      throw new AdapterError("invalid", "Enter the six-digit code from the reset email.");
    }
    if (typeof body.password !== "string" || body.password.length < 14) {
      throw new AdapterError("invalid", "Choose a password of at least 14 characters.");
    }
    await completePasswordReset(body.email.trim(), body.confirmationCode, body.password);

    const res = NextResponse.json({ data: { ok: true } });
    for (const name of Object.values(AUTH_COOKIES)) {
      res.cookies.set(name, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
    }
    return res;
  } catch (e) {
    const err = toAdapterError(e);
    console.error(`[auth] reset-complete ${err.code}`);
    return NextResponse.json(err.toJSON(), { status: HTTP_STATUS[err.code] });
  }
}
