import { NextResponse } from "next/server";
import { AUTH_COOKIES } from "@/adapters/auth.server";

/** POST → sign out: clear the session cookies. (Local sign-out only.) */
export async function POST() {
  const res = NextResponse.json({ data: { signedIn: false } });
  for (const name of Object.values(AUTH_COOKIES)) {
    res.cookies.set(name, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
  }
  return res;
}
