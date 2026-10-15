import { NextRequest, NextResponse } from "next/server";
import { AdapterError, HTTP_STATUS, toAdapterError } from "@/adapters/errors";
import { USE_LIVE_API } from "@/adapters/mode";
import { getClinicalAccessToken } from "@/adapters/session.server";
import { getRequestSession } from "@/server/session";
import { clinicalAuthorityMode } from "@/adapters/selected-clinic.server";
import { getRequestSelectedClinic } from "@/server/request-clinic";
import { writeSelectedClinic } from "@/server/selected-clinic-cookies";
import { clinicChoices } from "@/server/clinic-choices";

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
    // Under database_current the list is the subject's own discovery, read without any selection, so a first clinic
    // can be chosen; pending memberships are listed apart and are not choices. The active clinic is the session's
    // selection only while it is bound to this account and still among its clinics.
    const { clinics, pending } = await clinicChoices(token);
    let activeOrgId = session.orgId;
    if (clinicalAuthorityMode() === "database_current") {
      const selection = await getRequestSelectedClinic();
      activeOrgId = selection.state === "selected" && clinics.some((clinic) => clinic.organizationId === selection.organizationId)
        ? selection.organizationId : null;
    }
    return NextResponse.json({
      data: {
        mode: "live",
        organizations: clinics,
        activeOrgId,
        ...(clinicalAuthorityMode() === "database_current" ? { pending } : {}),
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
    // The chosen clinic must be one of this account's own clinics, read now. Under database_current that is the
    // subject-only discovery: the requested id is only compared with it, never sent as a selection to ask with.
    const { clinics, pending } = await clinicChoices(token);
    const requested = body.organizationId.toLowerCase();
    const match = clinics.find((o) => o.organizationId === (clinicalAuthorityMode() === "database_current" ? requested : body.organizationId));
    if (!match) {
      if (pending.some((clinic) => clinic.organizationId === requested)) {
        throw new AdapterError("forbidden", "Your membership at that clinic is awaiting approval.", "clinic_membership_pending");
      }
      throw new AdapterError("forbidden", "You are not a member of that organization.");
    }
    const res = NextResponse.json({
      data: { activeOrgId: match.organizationId, name: match.name },
    });
    writeSelectedClinic(res, match.organizationId!, token, WEEK);
    return res;
  } catch (e) {
    const err = toAdapterError(e);
    console.error(`[auth] org-switch ${err.code}`);
    return NextResponse.json(err.toJSON(), { status: HTTP_STATUS[err.code] });
  }
}
