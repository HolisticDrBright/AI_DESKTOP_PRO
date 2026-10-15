import { headers } from "next/headers";
import { AdapterError } from "@/adapters/errors";
import { clinicalAuthorityMode, type SelectedClinic } from "@/adapters/selected-clinic.server";
import { EXPECTED_CLINIC_HEADER } from "@/lib/clinic-binding-headers";
import { clinicBindingToken } from "@/server/selected-clinic-binding";

/**
 * The stale-tab clinic fence, under `database_current`.
 *
 * The selection is per browser session, so a switch in one tab changes the clinic of every tab's next request. Each
 * page and live response therefore names, as an opaque token, the account and clinic it was produced under; the
 * browser sends its tab's token back on every live call (src/lib/clinic-binding.ts). Here, immediately before the
 * operation runs, that token is compared with the token of the session's current, account-bound selection. A
 * different one is refused as "clinic changed", including for operations whose request names no clinic at all.
 *
 * The token is never authority: the clinic is still only the session's own selection. A request with no token yet (a
 * tab's first call) is accepted and told the current one. A selection that is missing, malformed, duplicated or
 * another account's keeps its own refusal in the transport. Under the legacy default nothing here runs.
 */
export async function clinicFence(selection: SelectedClinic): Promise<string | null> {
  if (clinicalAuthorityMode() !== "database_current" || selection.state !== "selected") return null;
  const current = clinicBindingToken(selection);
  let expected: string | null = null;
  try {
    expected = (await headers()).get(EXPECTED_CLINIC_HEADER);
  } catch {
    expected = null;
  }
  if (expected !== null && expected !== current) {
    throw new AdapterError("conflict", "Your clinic changed in another window. Reload to continue.", "clinic_selection_changed");
  }
  return current;
}

/** The token a server-rendered page embeds for its tab, or null when there is nothing to bind. */
export function pageClinicBinding(selection: SelectedClinic): string | null {
  return clinicalAuthorityMode() === "database_current" && selection.state === "selected" ? clinicBindingToken(selection) : null;
}
