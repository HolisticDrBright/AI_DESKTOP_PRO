/**
 * The clinic-membership refusals a gated live route (care messages, program assignments) can answer, read from either
 * refusal shape: the route's own `{error: "<code>"}`, or the browser fence's `{error: {code: "conflict"}}` for an answer
 * produced under another tab binding (src/lib/clinic-binding.ts). Each is its own claim, so each is said on its own:
 * a clinic switched elsewhere, no usable clinic selection, or a family not served under clinic-membership sign-in yet.
 * None of them is "nothing here", and none is "access refused" by the service.
 */
export type ClinicRefusal = "clinic_changed" | "clinic_selection_required" | "membership_authority_not_configured";

export async function clinicRefusal(response: Response): Promise<ClinicRefusal | null> {
  if (![403, 409, 503].includes(response.status)) return null;
  let body: unknown;
  try { body = await response.clone().json(); } catch { return null; }
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  if (response.status === 409 && (error === "clinic_selection_changed"
    || (error && typeof error === "object" && (error as { code?: unknown }).code === "conflict"))) return "clinic_changed";
  if (response.status === 403 && error === "clinic_selection_required") return "clinic_selection_required";
  if (response.status === 503 && error === "membership_authority_not_configured") return "membership_authority_not_configured";
  return null;
}
