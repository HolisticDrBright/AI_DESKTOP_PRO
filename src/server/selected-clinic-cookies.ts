import type { NextResponse } from "next/server";
import { AUTH_COOKIES, cookieOptions } from "@/adapters/auth.server";
import { selectedClinicCookieValues } from "@/server/selected-clinic-binding";

/**
 * Write the session's clinic selection after the server has checked membership. The `aidp_org` cookie is written
 * exactly as before; `aidp_org_sub` records which account chose it. With no clinic, both are cleared, so a later
 * sign-in by another account on the same browser never inherits the previous account's choice.
 */
export function writeSelectedClinic(response: NextResponse, organizationId: string | null, idToken: string, maxAgeSeconds: number) {
  if (!organizationId) {
    clearSelectedClinic(response);
    return;
  }
  response.cookies.set(AUTH_COOKIES.org, organizationId, cookieOptions(maxAgeSeconds));
  const values = selectedClinicCookieValues(organizationId, idToken);
  if (values) response.cookies.set(AUTH_COOKIES.orgBinding, values.binding, cookieOptions(maxAgeSeconds));
  else response.cookies.set(AUTH_COOKIES.orgBinding, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
}

export function clearSelectedClinic(response: NextResponse) {
  for (const name of [AUTH_COOKIES.org, AUTH_COOKIES.orgBinding]) {
    response.cookies.set(name, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
  }
}
