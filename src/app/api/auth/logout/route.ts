import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  AUTH_COOKIES,
  readAuthSession,
  signOutSession,
} from "@/adapters/auth.server";

/** POST → revoke the current provider session, then always clear local cookies. */
export async function POST() {
  const session = readAuthSession(await cookies());
  let providerRevoked = false;
  if (session.refreshToken) {
    try {
      await signOutSession(session.refreshToken);
      providerRevoked = true;
    } catch {
      // Local sign-out must still complete when the identity provider is down.
    }
  }

  const res = NextResponse.json({ data: { signedIn: false, providerRevoked } });
  for (const name of Object.values(AUTH_COOKIES)) {
    res.cookies.set(name, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
  }
  return res;
}
