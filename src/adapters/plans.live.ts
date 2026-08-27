if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
import { resolveOrgId } from "./config";
import { getClinicalAccessToken } from "./session.server";
import { clinicalRpc } from "./aws-clinical-data.server";
import type {
  LiveMembershipAction,
  LivePackageKind,
  LivePatientEntitlements,
  LivePlanLibrary,
  LivePlanMutationResult,
  LivePlanType,
  LiveReconciliationWorkspace,
} from "./live-types";

/**
 * Live Plans, memberships, entitlements & reconciliation (server-only).
 *
 * Every call is a Desktop-owned RPC executed as the signed-in practitioner, so
 * the database enforces membership, a SPECIFIC financial permission (not one
 * blanket billing role), patient access, tenant agreement on every referenced
 * row, expected-version concurrency, and the entitlement accounting policy.
 *
 * Boundaries this namespace can NEVER cross, because the RPCs have no such
 * code path:
 *
 *   - the browser cannot assert entitlement availability or consumption —
 *     every quantity comes back from the database, whose identity constraint
 *     (granted = remaining + reserved + consumed + expired + refunded) makes
 *     an unbalanced movement impossible to commit;
 *   - a purchase confers nothing until its invoice is PAID —
 *     `grantEntitlementsForInvoice` refuses any other invoice status;
 *   - a refund never recreates a consumed benefit; it can only revoke credit
 *     that is still unspent, and restoring spent credit is a separate,
 *     reason-required call needing the refund permission;
 *   - complimentary assignment needs the separate `comp.assign` permission
 *     and a reason, and creates no clinical record of any kind;
 *   - the two service_role processor RPCs are absent from this module
 *     entirely, so no browser-reachable path can settle a subscription.
 */
export const plansLive = {
  /* ------------------------------------------------------------- reads */

  async listPlans(
    includeArchived: boolean,
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LivePlanLibrary> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LivePlanLibrary>(
      "list_plans",
      { _organization_id: orgId, _include_archived: includeArchived },
      token,
    );
  },

  async getPatientEntitlements(
    patientId: string,
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LivePatientEntitlements> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LivePatientEntitlements>(
      "get_patient_entitlements",
      { _organization_id: orgId, _patient_id: patientId },
      token,
    );
  },

  async getReconciliation(
    status: string | null,
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveReconciliationWorkspace> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LiveReconciliationWorkspace>(
      "get_reconciliation_workspace",
      { _organization_id: orgId, _status: status },
      token,
    );
  },

  /* ------------------------------------------------------ plan authoring */

  async upsertPlan(
    input: {
      planType: LivePlanType;
      id?: string | null;
      expectedVersion?: number | null;
      name?: string | null;
      description?: string | null;
      kind?: LivePackageKind | null;
      archive?: boolean;
    },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LivePlanMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LivePlanMutationResult>(
      "upsert_plan",
      {
        _organization_id: orgId,
        _plan_type: input.planType,
        _id: input.id ?? null,
        _expected_version: input.expectedVersion ?? null,
        _name: input.name ?? null,
        _description: input.description ?? null,
        _kind: input.kind ?? null,
        _archive: input.archive ?? false,
      },
      token,
    );
  },

  /**
   * Draft the next version. Commercial terms live on the VERSION, so
   * publishing freezes them and an accepted version can never be rewritten.
   */
  async createPlanVersion(
    input: {
      planType: LivePlanType;
      planId: string;
      priceMinor: number;
      currency?: string;
      creditQuantity?: number;
      creditMode?: string;
      expiresAfterDays?: number | null;
      intervalUnit?: string;
      intervalCount?: number;
      trialDays?: number;
      includedCredits?: number;
      minimumCommitmentPeriods?: number;
      gracePeriodDays?: number;
      eligibleProductIds?: string[];
      eligibleLocationIds?: string[];
      eligiblePractitionerIds?: string[];
      transferPolicy?: string;
      termsSummary?: string | null;
    },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LivePlanMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LivePlanMutationResult>(
      "create_plan_version",
      {
        _organization_id: orgId,
        _plan_type: input.planType,
        _plan_id: input.planId,
        _price_minor: input.priceMinor,
        _currency: input.currency ?? "USD",
        _credit_quantity: input.creditQuantity ?? 0,
        _credit_mode: input.creditMode ?? "single_use",
        _expires_after_days: input.expiresAfterDays ?? null,
        _interval_unit: input.intervalUnit ?? "month",
        _interval_count: input.intervalCount ?? 1,
        _trial_days: input.trialDays ?? 0,
        _included_credits: input.includedCredits ?? 0,
        _minimum_commitment_periods: input.minimumCommitmentPeriods ?? 0,
        _grace_period_days: input.gracePeriodDays ?? 0,
        _eligible_product_ids: input.eligibleProductIds ?? [],
        _eligible_location_ids: input.eligibleLocationIds ?? [],
        _eligible_practitioner_ids: input.eligiblePractitionerIds ?? [],
        _transfer_policy: input.transferPolicy ?? "non_transferable",
        _terms_summary: input.termsSummary ?? null,
      },
      token,
    );
  },

  async publishPlanVersion(
    input: { planType: LivePlanType; versionId: string },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LivePlanMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LivePlanMutationResult>(
      "publish_plan_version",
      { _organization_id: orgId, _plan_type: input.planType, _version_id: input.versionId },
      token,
    );
  },

  /** The no-show / late-cancel rule is configuration, never an implicit default. */
  async setBillingPolicy(
    input: {
      noShowPolicy: string;
      lateCancelPolicy: string;
      lateCancelWindowHours: number;
      consumeOn: string;
    },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LivePlanMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LivePlanMutationResult>(
      "set_org_billing_policy",
      {
        _organization_id: orgId,
        _no_show_policy: input.noShowPolicy,
        _late_cancel_policy: input.lateCancelPolicy,
        _late_cancel_window_hours: input.lateCancelWindowHours,
        _consume_on: input.consumeOn,
      },
      token,
    );
  },

  /* --------------------------------------------------- purchase & comp */

  /** Drafts the purchase invoice. Grants NOTHING until that invoice is paid. */
  async purchasePackage(
    input: { patientId: string; packageVersionId: string; acceptanceMethod?: string },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LivePlanMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LivePlanMutationResult>(
      "purchase_package",
      {
        _organization_id: orgId,
        _patient_id: input.patientId,
        _package_version_id: input.packageVersionId,
        _acceptance_method: input.acceptanceMethod ?? "in_person",
      },
      token,
    );
  },

  /** Idempotent by construction — a duplicate call grants nothing extra. */
  async grantEntitlementsForInvoice(
    invoiceId: string,
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LivePlanMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LivePlanMutationResult>(
      "grant_entitlements_for_invoice",
      { _organization_id: orgId, _invoice_id: invoiceId },
      token,
    );
  },

  /**
   * Requires the separate `comp.assign` permission plus a reason, and records
   * an explicit zero-amount invoice so the gift is visible in the financial
   * record. Confers a COMMERCIAL benefit only — no clinical order follows.
   */
  async assignComplimentary(
    input: {
      patientId: string;
      planType: LivePlanType;
      versionId: string;
      reason: string;
      expiresAt?: string | null;
    },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LivePlanMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LivePlanMutationResult>(
      "assign_complimentary_plan",
      {
        _organization_id: orgId,
        _patient_id: input.patientId,
        _plan_type: input.planType,
        _version_id: input.versionId,
        _reason: input.reason,
        _expires_at: input.expiresAt ?? null,
      },
      token,
    );
  },

  /* ------------------------------------------------ redemption lifecycle */

  async reserveCredit(
    input: { entitlementId: string; appointmentId: string; quantity?: number },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LivePlanMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LivePlanMutationResult>(
      "reserve_entitlement_for_appointment",
      {
        _organization_id: orgId,
        _entitlement_id: input.entitlementId,
        _appointment_id: input.appointmentId,
        _quantity: input.quantity ?? 1,
      },
      token,
    );
  },

  /** The outcome decides; the ORGANIZATION'S policy decides what that means. */
  async settleCredit(
    input: { appointmentId: string; outcome: string; reason?: string | null },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LivePlanMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LivePlanMutationResult>(
      "settle_entitlement_for_appointment",
      {
        _organization_id: orgId,
        _appointment_id: input.appointmentId,
        _outcome: input.outcome,
        _reason: input.reason ?? null,
      },
      token,
    );
  },

  /** Restoring SPENT credit is corrective: refund authority + a reason. */
  async restoreCredit(
    input: { entitlementId: string; quantity: number; reason: string },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LivePlanMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LivePlanMutationResult>(
      "restore_entitlement",
      {
        _organization_id: orgId,
        _entitlement_id: input.entitlementId,
        _quantity: input.quantity,
        _reason: input.reason,
      },
      token,
    );
  },

  async expireCredits(
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LivePlanMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LivePlanMutationResult>(
      "expire_entitlements",
      { _organization_id: orgId },
      token,
    );
  },

  /** Revokes UNSPENT credit only — a received visit is never clawed back. */
  async revokeForRefund(
    input: { invoiceId: string; reason: string },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LivePlanMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LivePlanMutationResult>(
      "revoke_entitlements_for_refund",
      { _organization_id: orgId, _invoice_id: input.invoiceId, _reason: input.reason },
      token,
    );
  },

  /* ------------------------------------------------ subscription control */

  async setMembershipLifecycle(
    input: {
      patientMembershipId: string;
      action: LiveMembershipAction;
      expectedVersion: number;
      reason?: string | null;
    },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LivePlanMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LivePlanMutationResult>(
      "set_membership_lifecycle",
      {
        _organization_id: orgId,
        _patient_membership_id: input.patientMembershipId,
        _action: input.action,
        _expected_version: input.expectedVersion,
        _reason: input.reason ?? null,
      },
      token,
    );
  },

  /* ---------------------------------------------------- reconciliation */

  async resolveException(
    input: {
      exceptionId: string;
      resolution: "resolved" | "dismissed";
      reason: string;
      expectedVersion: number;
    },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LivePlanMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LivePlanMutationResult>(
      "resolve_reconciliation_exception",
      {
        _organization_id: orgId,
        _exception_id: input.exceptionId,
        _resolution: input.resolution,
        _reason: input.reason,
        _expected_version: input.expectedVersion,
      },
      token,
    );
  },
};
