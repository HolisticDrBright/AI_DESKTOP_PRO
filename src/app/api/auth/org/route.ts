import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIES, cookieOptions } from "@/adapters/auth.server";
import { AdapterError, HTTP_STATUS, toAdapterError } from "@/adapters/errors";
import { USE_LIVE_API } from "@/adapters/mode";
import { organizationsLive } from "@/adapters/organizations.live";
import { getClinicalAccessToken } from "@/adapters/session.server";
import { getRequestSession } from "@/server/session";

const WEEK = 60 * 60 * 24 * 7;

/**
 * GET → the caller's organizations + the active one.
 * POST { organizationId } → switch, after validating the id against the
 * caller's OWN memberships (the cookie only scopes the UI; the backend
 * re-authorizes every call regardless).
 */
export async function GET() {
  if (!USE_LIVE_API) {
    return NextResponse.json({ data: { mode: "mock", organizations: [], activeOrgId: null } });
  }
  try {
    const session = await getRequestSession();
    const token = await getClinicalAccessToken(session.token);
    const orgs = await organizationsLive.mine(token);
    return NextResponse.json({
      data: {
        mode: "live",
        organizations: orgs.filter((o) => o.organizationId),
        activeOrgId: session.orgId,
      },
    });
  } catch (e) {
    const err = toAdapterError(e);
    return NextResponse.json(err.toJSON(), { status: HTTP_STATUS[err.code] });
  }
}

export async function POST(req: NextRequest) {
  if (!USE_LIVE_API) {
    return NextResponse.json(
      new AdapterError("unavailable", "Demo mode has no organizations.").toJSON(),
      { status: HTTP_STATUS.unavailable },
    );
  }
  try {
    const body = (await req.json().catch(() => ({}))) as { organizationId?: unknown };
    if (typeof body.organizationId !== "string" || !body.organizationId) {
      throw new AdapterError("invalid", "An organization id is required.");
    }
    const session = await getRequestSession();
    const token = await getClinicalAccessToken(session.token);
    const orgs = await organizationsLive.mine(token);
    const match = orgs.find((o) => o.organizationId === body.organizationId);
    if (!match) {
      throw new AdapterError("forbidden", "You are not a member of that organization.");
    }
    const res = NextResponse.json({
      data: { activeOrgId: match.organizationId, name: match.name },
    });
    res.cookies.set(AUTH_COOKIES.org, body.organizationId, cookieOptions(WEEK));
    return res;
  } catch (e) {
    const err = toAdapterError(e);
    console.error(`[auth] org-switch ${err.code}`);
    return NextResponse.json(err.toJSON(), { status: HTTP_STATUS[err.code] });
  }
}
