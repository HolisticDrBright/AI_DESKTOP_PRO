import { AdapterError } from "@/adapters/errors";
import { clinicalAuthorityMode, SELECTED_CLINIC_HEADER, selectedClinicHeaders, withSelectedClinic } from "@/adapters/selected-clinic.server";
import { clinicFence } from "@/server/clinic-fence";
import { getRequestSelectedClinic } from "@/server/request-clinic";

/**
 * The clinic side of a gated live route (care messages, program assignments; src/server/clinic-authority-families.ts)
 * under `database_current`.
 *
 * - The stale-tab fence first: a tab rendered for another clinic or account is refused as "clinic changed" before the
 *   request body is read, including for actions that name no clinic at all.
 * - The only clinic sent is the session's own account-bound selection, as `x-alp-selected-organization-id`. A body,
 *   query, token claim or browser storage never chooses it; a missing, malformed, duplicated or other account's
 *   selection is refused here, before the token leaves the process.
 * - The answer is accepted only when the service names the clinic it decided in, and it is that selection
 *   (`decidedInSelectedClinic`). A service still on the claim path names none, so its answer is refused rather than
 *   shown as if the selected clinic had decided it.
 *
 * Under the legacy default it adds nothing and refuses nothing.
 */
export type CurrentMembershipCall =
  | { ok: true; headers: Record<string, string>; organizationId: string | null; binding: string | null }
  | { ok: false; status: 403 | 409; error: "clinic_selection_required" | "clinic_selection_changed" };

export async function currentMembershipCall(token: string): Promise<CurrentMembershipCall> {
  if (clinicalAuthorityMode() !== "database_current") return { ok: true, headers: {}, organizationId: null, binding: null };
  const selection = await getRequestSelectedClinic();
  try {
    const binding = await clinicFence(selection);
    const headers = await withSelectedClinic(selection, async () => selectedClinicHeaders(token, null));
    const organizationId = headers[SELECTED_CLINIC_HEADER];
    if (!organizationId || !binding) return { ok: false, status: 403, error: "clinic_selection_required" };
    return { ok: true, headers, organizationId, binding };
  } catch (error) {
    if (error instanceof AdapterError && error.code === "conflict") return { ok: false, status: 409, error: "clinic_selection_changed" };
    return { ok: false, status: 403, error: "clinic_selection_required" };
  }
}

/** Under `database_current`, whether an upstream answer names the selected clinic as the one it was decided in. */
export function decidedInSelectedClinic(response: Response, organizationId: string | null): boolean {
  if (organizationId === null) return true;
  const named = response.headers.get(SELECTED_CLINIC_HEADER);
  return named !== null && named.toLowerCase() === organizationId;
}
