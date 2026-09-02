import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIES, cookieOptions } from "@/adapters/auth.server";
import { isAdapterError } from "@/adapters/errors";
import { safeOrganizationRecoveryPath } from "@/adapters/organization-recovery";
import { organizationsLive } from "@/adapters/organizations.live";
import { getRequestSession } from "@/server/session";

const WEEK = 60 * 60 * 24 * 7;

function pause(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function localRedirect(path: string) {
  // A relative Location keeps the browser on the public App Runner origin.
  // req.url contains App Runner's internal 0.0.0.0:3000 address.
  return new NextResponse(null, { status: 307, headers: { location: path } });
}

/**
 * Recover an authenticated practitioner whose sole organization was not
 * written to the session during sign-in (for example while Aurora was waking).
 * Membership is always re-read from the guarded AWS API before the cookie is
 * set. Multiple memberships still require an explicit choice in Settings.
 */
export async function GET(req: NextRequest) {
  const nextPath = safeOrganizationRecoveryPath(req.nextUrl.searchParams.get("next"));
  const session = await getRequestSession();

  if (!session.signedIn || !session.token) {
    return localRedirect(`/login?next=${encodeURIComponent(nextPath)}`);
  }

  let organizations: Awaited<ReturnType<typeof organizationsLive.mine>> | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      organizations = await organizationsLive.mine(session.token);
      break;
    } catch (error) {
      const retryable = isAdapterError(error) && error.code === "unavailable";
      if (!retryable || attempt === 2) break;
      await pause(350 * (attempt + 1));
    }
  }

  const available = (organizations ?? []).filter((org) => org.organizationId);
  if (available.length !== 1 || !available[0]?.organizationId) {
    return localRedirect("/settings#practice-preferences");
  }

  const response = localRedirect(nextPath);
  response.cookies.set(AUTH_COOKIES.org, available[0].organizationId, cookieOptions(WEEK));
  return response;
}
