import { clinicalMembershipDiscovery } from "@/adapters/aws-clinical-data.server";
import { organizationsLive, type OrgMembership } from "@/adapters/organizations.live";
import { clinicalAuthorityMode } from "@/adapters/selected-clinic.server";

/**
 * The clinics the signed-in account may choose from, for sign-in, the Settings switcher and a switch.
 *
 * Under `database_current` they come from the identity API's subject-only discovery: active clinical memberships for
 * the token's own subject, read before any clinic is selected, with pending memberships listed apart (they are not
 * access). No clinic the caller names is used to ask. Under the legacy default they are `list_my_organizations`, read
 * exactly as before.
 */
export type PendingClinic = { organizationId: string; name: string };
export type ClinicChoices = { clinics: OrgMembership[]; pending: PendingClinic[] };

export async function clinicChoices(token: string): Promise<ClinicChoices> {
  if (clinicalAuthorityMode() !== "database_current") {
    return { clinics: (await organizationsLive.mine(token)).filter((org) => org.organizationId), pending: [] };
  }
  const discovery = await clinicalMembershipDiscovery(token);
  return {
    clinics: discovery.clinics.map((clinic) => ({
      organizationId: clinic.organizationId, name: clinic.name, slug: clinic.organizationId, role: clinic.role,
    })),
    pending: discovery.pending,
  };
}

/**
 * The clinic to select at sign-in. Under `database_current` only a single active clinic is selected; with several the
 * choice is left to the practitioner, never made for them. The legacy default keeps its first-membership behaviour.
 */
export async function signInClinic(token: string): Promise<string | null> {
  if (clinicalAuthorityMode() !== "database_current") {
    const orgs = await organizationsLive.mine(token);
    return orgs.find((org) => org.organizationId)?.organizationId ?? null;
  }
  const { clinics } = await clinicChoices(token);
  return clinics.length === 1 ? clinics[0]!.organizationId : null;
}

/**
 * Where sign-in leaves the practitioner, under `database_current` only (the legacy default reports no step and keeps
 * its first-membership selection):
 * - `selected`: exactly one active clinic, selected;
 * - `choose`: several active clinics, none selected — the practitioner chooses explicitly;
 * - `onboard`: no active clinic (pending memberships are not access), so onboarding is next;
 * - `unknown`: the clinics could not be read, so nothing is selected and nothing is claimed about them.
 * A suspended clinic is not in discovery, so it is never selected or offered.
 */
export type ClinicStep = "selected" | "choose" | "onboard" | "unknown";
export type SignInClinicChoice = { organizationId: string | null; step: ClinicStep | null };

export async function signInClinicChoice(token: string): Promise<SignInClinicChoice> {
  if (clinicalAuthorityMode() !== "database_current") return { organizationId: await signInClinic(token), step: null };
  let clinics: OrgMembership[];
  try { clinics = (await clinicChoices(token)).clinics.filter((clinic) => clinic.organizationId); } catch { return { organizationId: null, step: "unknown" }; }
  if (clinics.length === 1) return { organizationId: clinics[0]!.organizationId, step: "selected" };
  return { organizationId: null, step: clinics.length === 0 ? "onboard" : "choose" };
}

/** The step to report when the sign-in read itself failed before a choice was made. */
export function failedSignInClinicChoice(): SignInClinicChoice {
  return { organizationId: null, step: clinicalAuthorityMode() === "database_current" ? "unknown" : null };
}
