if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
import { trpcQuery } from "./trpc.server";

/**
 * Live `organizations` namespace (server-only): the caller's ACTIVE
 * memberships, read under their own RLS view via
 * `clinical.organizations.mine`. Used to auto-select the sole organization at
 * sign-in and to validate any organization switch before the org cookie is
 * set — the cookie is never trusted as authorization (the backend re-checks
 * membership on every call); it only scopes which org the UI operates in.
 */
export interface OrgMembership {
  organizationId: string | null;
  name: string | null;
  slug: string | null;
  role: string;
}

export const organizationsLive = {
  mine(sessionToken?: string | null): Promise<OrgMembership[]> {
    return trpcQuery<OrgMembership[]>("clinical.organizations.mine", undefined, sessionToken);
  },
};
