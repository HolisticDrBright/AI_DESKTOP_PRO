if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
import { AdapterError, isAdapterError } from "./errors";
import { clinicalRpc } from "./aws-clinical-data.server";
import { resolveOrgId } from "./config";
import { getClinicalAccessToken } from "./session.server";

/**
 * Live `organizations` namespace (server-only): the caller's ACTIVE
 * memberships, read under their own RLS view via
 * `list_my_organizations`. Used to auto-select the sole organization at
 * sign-in and to validate any organization switch before the org cookie is
 * set — the cookie is never trusted as authorization (RLS and the database
 * RPCs re-check membership on every call); it only scopes which org the UI
 * operates in.
 *
 * Membership management (members/invite/setRole/remove) is admin-gated inside
 * the SECURITY DEFINER RPCs (migration 0020), which also write audit rows.
 */
export interface OrgMembership {
  organizationId: string | null;
  name: string | null;
  slug: string | null;
  role: string;
}

export type OrgMemberRole = "owner" | "admin" | "practitioner" | "staff" | "member";

export interface OrgMemberRow {
  membershipId: string;
  userId: string;
  email: string | null;
  displayName: string | null;
  role: string;
  status: string;
  joinedAt: string;
}

interface DatabaseOrganization {
  organization_id: string;
  name: string;
  slug: string;
  role: string;
}

interface DatabaseOrgMember {
  membership_id: string;
  user_id: string;
  email: string | null;
  display_name: string | null;
  role: string;
  status: string;
  joined_at: string;
}

export const organizationsLive = {
  async mine(sessionToken?: string | null): Promise<OrgMembership[]> {
    const token = await getClinicalAccessToken(sessionToken);
    const rows = await clinicalRpc<DatabaseOrganization[]>(
      "list_my_organizations",
      {},
      token,
    );
    return rows.map((row) => ({
      organizationId: row.organization_id,
      name: row.name,
      slug: row.slug,
      role: row.role,
    }));
  },

  /** Activate the caller's own pending invitations (idempotent). */
  async claim(sessionToken?: string | null): Promise<{ activated: number }> {
    const token = await getClinicalAccessToken(sessionToken);
    const activated = await clinicalRpc<number>(
      "activate_my_memberships",
      {},
      token,
    );
    return { activated };
  },

  async members(sessionToken?: string | null, orgId?: string | null): Promise<OrgMemberRow[]> {
    const token = await getClinicalAccessToken(sessionToken);
    const rows = await clinicalRpc<DatabaseOrgMember[]>(
      "list_org_members",
      { _organization_id: resolveOrgId(orgId) },
      token,
    );
    return rows.map((row) => ({
      membershipId: row.membership_id,
      userId: row.user_id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      status: row.status,
      joinedAt: row.joined_at,
    }));
  },

  async invite(
    input: { email: string; role: OrgMemberRole },
    sessionToken?: string | null,
    orgId?: string | null,
  ): Promise<{ membershipId: string; invitedNewUser: boolean }> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<string>(
      "add_org_member",
      {
        _organization_id: resolveOrgId(orgId),
        _email: input.email,
        _role: input.role,
      },
      token,
    )
      .then((membershipId) => ({ membershipId, invitedNewUser: false }))
      .catch((error: unknown) => {
        if (isAdapterError(error) && error.code === "not_found") {
          throw new AdapterError(
            "invalid",
            "No account exists for that email. Create it through the approved identity-admin process, then add it here.",
          );
        }
        throw error;
      });
  },

  async setRole(
    input: { membershipId: string; role: OrgMemberRole },
    sessionToken?: string | null,
  ): Promise<{ ok: true }> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<null>(
      "set_org_member_role",
      { _membership_id: input.membershipId, _role: input.role },
      token,
    ).then(() => ({ ok: true as const }));
  },

  async remove(
    input: { membershipId: string },
    sessionToken?: string | null,
  ): Promise<{ ok: true }> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<null>(
      "remove_org_member",
      { _membership_id: input.membershipId },
      token,
    ).then(() => ({ ok: true as const }));
  },
};
