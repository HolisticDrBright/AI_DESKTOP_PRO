import type { BootstrapSuspensionReason } from "@/contracts/workforceClinicBootstrap";

/**
 * What the operator console may say from one route's answer. A failed read is never an empty list: "No proposals"
 * describes the review queue, and with the service down nobody is in a position to say it.
 */
export type OperatorRead<T> =
  | { kind: "not_released" }
  | { kind: "signed_out" }
  | { kind: "refused" }
  | { kind: "not_configured" }
  | { kind: "failed" }
  | { kind: "answered"; value: T };

export function operatorRead<T>(status: number, body: unknown, pick: (data: unknown) => T | null): OperatorRead<T> {
  const error = (body as { error?: unknown } | null)?.error;
  if (status === 503 && (error === "platform_operator_not_released" || error === "platform_operator_sign_in_not_released")) return { kind: "not_released" };
  if (status === 401 || error === "operator_sign_in_required") return { kind: "signed_out" };
  if (status === 403 && error === "platform_operator_refused") return { kind: "refused" };
  if (error === "operator_service_not_configured") return { kind: "not_configured" };
  if (status !== 200) return { kind: "failed" };
  const value = pick((body as { data?: unknown } | null)?.data);
  return value === null ? { kind: "failed" } : { kind: "answered", value };
}

export const SUSPENSION_REASON_LABEL: Record<BootstrapSuspensionReason, string> = {
  security_concern: "A security concern",
  identity_not_verified: "Identity not verified",
  agreement_not_accepted: "Agreement not accepted",
  operator_request: "At the platform team's request",
};
export const PROPOSAL_REJECTION_LABEL: Record<string, string> = {
  clinic_proposal_incomplete: "The proposal was incomplete",
  clinic_proposal_declined: "The proposal was declined",
  duplicate_request: "Duplicate request",
};
export const DECISION_LABEL: Record<string, string> = { ...PROPOSAL_REJECTION_LABEL, clinic_proposal_verified: "Proposal verified" };
