import { NextRequest } from "next/server";
import { organizationsLive, type OrgMemberRole } from "@/adapters/organizations.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

const ROLES: OrgMemberRole[] = ["owner", "admin", "practitioner", "staff", "member"];

/** PATCH { membershipId, role } → change a member's role (rules live in the RPC). */
export async function PATCH(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const membershipId = typeof body.membershipId === "string" ? body.membershipId : "";
    const role = typeof body.role === "string" ? (body.role as OrgMemberRole) : "" as OrgMemberRole;
    if (!membershipId) throw new AdapterError("invalid", "A membership is required.");
    if (!ROLES.includes(role)) throw new AdapterError("invalid", "Choose a valid role.");
    const session = await getRequestSession();
    return organizationsLive.setRole({ membershipId, role }, session.token);
  });
}

/** DELETE { membershipId } → remove a member (self/owner guards live in the RPC). */
export async function DELETE(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const membershipId = typeof body.membershipId === "string" ? body.membershipId : "";
    if (!membershipId) throw new AdapterError("invalid", "A membership is required.");
    const session = await getRequestSession();
    return organizationsLive.remove({ membershipId }, session.token);
  });
}
