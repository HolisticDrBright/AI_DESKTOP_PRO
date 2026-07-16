import { NextRequest } from "next/server";
import { organizationsLive, type OrgMemberRole } from "@/adapters/organizations.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

const ROLES: OrgMemberRole[] = ["owner", "admin", "practitioner", "staff", "member"];

/** GET → the active organization's roster (admin-gated by backend + RPC). */
export async function GET() {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const session = await getRequestSession();
    return organizationsLive.members(session.token, session.orgId);
  });
}

/** POST { email, role } → invite into the active organization. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const role = typeof body.role === "string" ? (body.role as OrgMemberRole) : "" as OrgMemberRole;
    if (!email.includes("@") || email.length > 320) {
      throw new AdapterError("invalid", "Enter the invitee's email address.");
    }
    if (!ROLES.includes(role)) {
      throw new AdapterError("invalid", "Choose a role for the invitee.");
    }
    const session = await getRequestSession();
    return organizationsLive.invite({ email, role }, session.token, session.orgId);
  });
}
