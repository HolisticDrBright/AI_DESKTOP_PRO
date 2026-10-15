import { NextRequest, NextResponse } from "next/server";
import { AdapterError, HTTP_STATUS, toAdapterError } from "@/adapters/errors";
import { USE_LIVE_API } from "@/adapters/mode";
import { organizationsLive } from "@/adapters/organizations.live";
import { getClinicalAccessToken } from "@/adapters/session.server";
import { getRequestSession } from "@/server/session";
import { clinicalAuthorityMode, selectedClinicCookieValues, withSelectedClinic } from "@/adapters/selected-clinic.server";
import { getRequestSelectedClinic } from "@/server/request-clinic";
import { writeSelectedClinic } from "@/server/selected-clinic-cookies";

const WEEK = 60 * 60 * 24 * 7;

/**
 * GET → the caller's organizations + the active one.
 * POST { organizationId } → switch, after validating the id against the
 * caller's OWN memberships (the cookie only scopes the UI; database RLS and
 * guarded RPCs re-authorize every call regardless).
 */
export async function GET() {
  if (!USE_LIVE_API) {
    return NextResponse.json({ data: { mode: "mock", organizations: [], activeOrgId: null } });
  }
  try {
    const session = await getRequestSession();
    const token = await getClinicalAccessToken(session.token);
    // The list runs under the session's own current selection (it names every clinic the person belongs to).
    const orgs = await withSelectedClinic(await getRequestSelectedClinic(), () => organizationsLive.mine(token));
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
    // Under database_current the switch is checked against the clinic being chosen, never the previous selection: the
    // API resolves a current membership in that clinic for this subject or refuses.
    const candidate = selectedClinicCookieValues(body.organizationId, token);
    if (clinicalAuthorityMode() === "database_current" && !candidate) {
      throw new AdapterError("invalid", "Choose a clinic from your memberships.");
    }
    const orgs = await withSelectedClinic(candidate
      ? { state: "selected", organizationId: candidate.organization, binding: candidate.binding }
      : { state: "malformed" }, () => organizationsLive.mine(token));
    const match = orgs.find((o) => o.organizationId === body.organizationId);
    if (!match) {
      throw new AdapterError("forbidden", "You are not a member of that organization.");
    }
    const res = NextResponse.json({
      data: { activeOrgId: match.organizationId, name: match.name },
    });
    writeSelectedClinic(res, body.organizationId, token, WEEK);
    return res;
  } catch (e) {
    const err = toAdapterError(e);
    console.error(`[auth] org-switch ${err.code}`);
    return NextResponse.json(err.toJSON(), { status: HTTP_STATUS[err.code] });
  }
}
