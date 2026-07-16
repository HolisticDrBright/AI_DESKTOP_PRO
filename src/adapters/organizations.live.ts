if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
import { trpcMutation, trpcQuery } from "./trpc.server";
import { resolveOrgId } from "./config";

/**
 * Live `organizations` namespace (server-only): the caller's ACTIVE
 * memberships, read under their own RLS view via
 * `clinical.organizations.mine`. Used to auto-select the sole organization at
 * sign-in and to validate any organization switch before the org cookie is
 * set — the cookie is never trusted as authorization (the backend re-checks
 * membership on every call); it only scopes which org the UI operates in.
 *
 * Membership management (members/invite/setRole/remove) is admin-gated twice:
 * by the backend procedure AND inside the SECURITY DEFINER RPCs (migration
 * 0020) that also write the audit rows.
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

export const organizationsLive = {
  mine(sessionToken?: string | null): Promise<OrgMembership[]> {
    return trpcQuery<OrgMembership[]>("clinical.organizations.mine", undefined, sessionToken);
  },

  /** Activate the caller's own pending invitations (idempotent). */
  claim(sessionToken?: string | null): Promise<{ activated: number }> {
    return trpcMutation<{ activated: number }>("clinical.organizations.claim", {}, sessionToken);
  },

  members(sessionToken?: string | null, orgId?: string | null): Promise<OrgMemberRow[]> {
    return trpcQuery<OrgMemberRow[]>(
      "clinical.organizations.members",
      { organizationId: resolveOrgId(orgId) },
      sessionToken,
    );
  },

  invite(
    input: { email: string; role: OrgMemberRole },
    sessionToken?: string | null,
    orgId?: string | null,
  ): Promise<{ membershipId: string; invitedNewUser: boolean }> {
    return trpcMutation("clinical.organizations.invite", {
      organizationId: resolveOrgId(orgId),
      email: input.email,
      role: input.role,
    }, sessionToken);
  },

  setRole(
    input: { membershipId: string; role: OrgMemberRole },
    sessionToken?: string | null,
  ): Promise<{ ok: true }> {
    return trpcMutation("clinical.organizations.setRole", input, sessionToken);
  },

  remove(
    input: { membershipId: string },
    sessionToken?: string | null,
  ): Promise<{ ok: true }> {
    return trpcMutation("clinical.organizations.remove", input, sessionToken);
  },
};
