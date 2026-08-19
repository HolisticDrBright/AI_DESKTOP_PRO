if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
import { resolveOrgId } from "./config";
import { getClinicalAccessToken } from "./session.server";
import { clinicalRpc } from "./aws-clinical-data.server";
import type {
  LiveBillingCatalog,
  LiveBillingCatalogFilters,
  LiveBillingMutationResult,
  LiveBillingProductKind,
  LiveBillingWorkspace,
  LiveBillingWorkspaceFilters,
  LiveCardPaymentIntent,
  LiveInventoryAdjustmentKind,
  LiveInventoryMovement,
  LiveInventoryReturnCondition,
  LiveInvoice,
  LiveInvoiceLineInput,
  LiveManualPaymentMethod,
  LivePatientBilling,
} from "./live-types";

/**
 * Live Billing, checkout, catalog & inventory namespace (server-only).
 *
 * Every call is a Desktop-owned RPC executed as the signed-in practitioner, so
 * the database enforces membership, the financial role gate
 * (owner/admin/practitioner), patient access, tenant agreement on every
 * referenced row, expected-version concurrency, and the inventory accounting
 * policy (reserve at finalize, commit once at settlement, release on void).
 *
 * Boundaries this namespace can NEVER cross, because the RPCs have no such
 * code path: the client cannot supply tax — it is computed from the
 * organization's configured rates and snapshotted server-side; the browser
 * cannot assert a payment succeeded — `startCardPayment` only creates a
 * PENDING test-mode row, and only the service_role processor boundary
 * (`attach_payment_processor_ref` / `record_billing_webhook`, deliberately
 * absent from this module) can settle it; a refund never restocks inventory —
 * `returnInventoryStock` is the explicit, reason-and-condition-required path;
 * and a finalized invoice's money and lines are immutable at trigger level.
 */
export const billingLive = {
  /* ------------------------------------------------------------- reads */

  async getWorkspace(
    filters: LiveBillingWorkspaceFilters,
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveBillingWorkspace> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LiveBillingWorkspace>(
      "get_billing_workspace",
      {
        _organization_id: orgId,
        _from: filters.from ?? null,
        _to: filters.to ?? null,
        _status: filters.status ?? null,
        _practitioner_user_id: filters.practitionerUserId ?? null,
        _location_id: filters.locationId ?? null,
        _method: filters.method ?? null,
      },
      token,
    );
  },

  async getInvoice(
    invoiceId: string,
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveInvoice> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LiveInvoice>(
      "get_billing_invoice",
      { _organization_id: orgId, _invoice_id: invoiceId },
      token,
    );
  },

  async getPatientBilling(
    patientId: string,
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LivePatientBilling> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LivePatientBilling>(
      "get_patient_billing",
      { _organization_id: orgId, _patient_id: patientId },
      token,
    );
  },

  async listCatalog(
    filters: LiveBillingCatalogFilters,
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveBillingCatalog> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LiveBillingCatalog>(
      "list_billing_catalog",
      {
        _organization_id: orgId,
        _query: filters.query ?? null,
        _kind: filters.kind ?? null,
        _supplier_id: filters.supplierId ?? null,
        _location_id: filters.locationId ?? null,
        _stock_filter: filters.stockFilter ?? null,
        _include_archived: filters.includeArchived ?? false,
        _limit: filters.limit ?? 100,
      },
      token,
    );
  },

  async getInventoryHistory(
    input: { productId: string; locationId?: string | null; limit?: number },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveInventoryMovement[]> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LiveInventoryMovement[]>(
      "get_inventory_history",
      {
        _organization_id: orgId,
        _product_id: input.productId,
        _location_id: input.locationId ?? null,
        _limit: input.limit ?? 50,
      },
      token,
    );
  },

  /* --------------------------------------------- catalog & reference */

  async upsertProduct(
    input: {
      id?: string | null;
      expectedVersion?: number | null;
      name?: string | null;
      kind?: LiveBillingProductKind | null;
      amountMinor?: number | null;
      currency?: string | null;
      sku?: string | null;
      barcode?: string | null;
      supplierId?: string | null;
      costMinor?: number | null;
      taxRateId?: string | null;
      description?: string | null;
      trackInventory?: boolean | null;
      reorderThreshold?: number | null;
    },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveBillingMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LiveBillingMutationResult>(
      "upsert_billing_product",
      {
        _organization_id: orgId,
        _id: input.id ?? null,
        _expected_version: input.expectedVersion ?? null,
        _name: input.name ?? null,
        _kind: input.kind ?? null,
        _amount_minor: input.amountMinor ?? null,
        _currency: input.currency ?? null,
        _sku: input.sku ?? null,
        _barcode: input.barcode ?? null,
        _supplier_id: input.supplierId ?? null,
        _cost_minor: input.costMinor ?? null,
        _tax_rate_id: input.taxRateId ?? null,
        _description: input.description ?? null,
        _track_inventory: input.trackInventory ?? null,
        _reorder_threshold: input.reorderThreshold ?? null,
        _catalog_product_id: null,
      },
      token,
    );
  },

  /** Archive preserves history: past invoices keep their line snapshots. */
  async archiveProduct(
    input: { productId: string; expectedVersion: number },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveBillingMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LiveBillingMutationResult>(
      "archive_billing_product",
      {
        _organization_id: orgId,
        _product_id: input.productId,
        _expected_version: input.expectedVersion,
      },
      token,
    );
  },

  async upsertLocation(
    input: { id?: string | null; name?: string | null; archive?: boolean },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveBillingMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LiveBillingMutationResult>(
      "upsert_billing_location",
      {
        _organization_id: orgId,
        _id: input.id ?? null,
        _name: input.name ?? null,
        _archive: input.archive ?? false,
      },
      token,
    );
  },

  async upsertSupplier(
    input: {
      id?: string | null;
      name?: string | null;
      contactEmail?: string | null;
      phone?: string | null;
      notes?: string | null;
      archive?: boolean;
    },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveBillingMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LiveBillingMutationResult>(
      "upsert_supplier",
      {
        _organization_id: orgId,
        _id: input.id ?? null,
        _name: input.name ?? null,
        _contact_email: input.contactEmail ?? null,
        _phone: input.phone ?? null,
        _notes: input.notes ?? null,
        _archive: input.archive ?? false,
      },
      token,
    );
  },

  async upsertTaxRate(
    input: { id?: string | null; name?: string | null; rateBps?: number | null; active?: boolean },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveBillingMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LiveBillingMutationResult>(
      "upsert_tax_rate",
      {
        _organization_id: orgId,
        _id: input.id ?? null,
        _name: input.name ?? null,
        _rate_bps: input.rateBps ?? null,
        _active: input.active ?? true,
      },
      token,
    );
  },

  /* ------------------------------------------------------- inventory */

  async receiveStock(
    input: {
      locationId: string;
      productId: string;
      quantity: number;
      unitCostMinor?: number | null;
      supplierId?: string | null;
      reference?: string | null;
    },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveBillingMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LiveBillingMutationResult>(
      "receive_inventory_stock",
      {
        _organization_id: orgId,
        _location_id: input.locationId,
        _product_id: input.productId,
        _quantity: input.quantity,
        _unit_cost_minor: input.unitCostMinor ?? null,
        _supplier_id: input.supplierId ?? null,
        _reference: input.reference ?? null,
      },
      token,
    );
  },

  /** Every adjustment needs a reason; damaged/expired can only remove stock. */
  async adjustStock(
    input: {
      locationId: string;
      productId: string;
      delta: number;
      kind: LiveInventoryAdjustmentKind;
      reason: string;
    },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveBillingMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LiveBillingMutationResult>(
      "adjust_inventory_stock",
      {
        _organization_id: orgId,
        _location_id: input.locationId,
        _product_id: input.productId,
        _delta: input.delta,
        _kind: input.kind,
        _reason: input.reason,
      },
      token,
    );
  },

  /**
   * The ONLY restock path after a sale. A refund deliberately does not call
   * this: returning goods is a separate, explicit decision with a condition.
   */
  async returnStock(
    input: {
      locationId: string;
      productId: string;
      quantity: number;
      condition: LiveInventoryReturnCondition;
      reason: string;
      invoiceId?: string | null;
    },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveBillingMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LiveBillingMutationResult>(
      "return_inventory_stock",
      {
        _organization_id: orgId,
        _location_id: input.locationId,
        _product_id: input.productId,
        _quantity: input.quantity,
        _condition: input.condition,
        _reason: input.reason,
        _invoice_id: input.invoiceId ?? null,
      },
      token,
    );
  },

  /* ----------------------------------------------- checkout / invoice */

  async createDraft(
    input: { patientId: string; appointmentId?: string | null; locationId?: string | null },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveInvoice> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LiveInvoice>(
      "create_invoice_draft",
      {
        _organization_id: orgId,
        _patient_id: input.patientId,
        _appointment_id: input.appointmentId ?? null,
        _location_id: input.locationId ?? null,
      },
      token,
    );
  },

  /**
   * Replaces the draft's lines wholesale. Tax is NOT part of the input: the
   * server snapshots the configured rate for each product.
   */
  async saveDraft(
    input: {
      invoiceId: string;
      expectedVersion: number;
      locationId?: string | null;
      lines: LiveInvoiceLineInput[];
    },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveInvoice> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    // Project each line to exactly the fields a client is allowed to propose.
    // Anything else a caller attaches — a tax amount above all — is dropped
    // here rather than merely ignored by the database, so "the client cannot
    // price tax" holds at every layer.
    const lines = input.lines.map((line) => ({
      productId: line.productId,
      quantity: line.quantity,
      unitAmountMinor: line.unitAmountMinor,
      discountMinor: line.discountMinor,
      discountReason: line.discountReason,
    }));
    return clinicalRpc<LiveInvoice>(
      "save_invoice_draft",
      {
        _organization_id: orgId,
        _invoice_id: input.invoiceId,
        _expected_version: input.expectedVersion,
        _location_id: input.locationId ?? null,
        _lines: lines,
      },
      token,
    );
  },

  /** Opens the invoice, assigns its number, and RESERVES tracked stock. */
  async finalize(
    input: { invoiceId: string; expectedVersion: number },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveInvoice> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LiveInvoice>(
      "finalize_invoice",
      {
        _organization_id: orgId,
        _invoice_id: input.invoiceId,
        _expected_version: input.expectedVersion,
      },
      token,
    );
  },

  /** Unpaid invoices only; releases reservations. Paid invoices refund. */
  async voidInvoice(
    input: { invoiceId: string; expectedVersion: number; reason: string },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveInvoice> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LiveInvoice>(
      "void_invoice",
      {
        _organization_id: orgId,
        _invoice_id: input.invoiceId,
        _expected_version: input.expectedVersion,
        _reason: input.reason,
      },
      token,
    );
  },

  /* -------------------------------------------------------- payments */

  async recordManualPayment(
    input: {
      invoiceId: string;
      expectedVersion: number;
      amountMinor: number;
      method: LiveManualPaymentMethod;
      reference?: string | null;
      idempotencyKey?: string | null;
    },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveInvoice> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LiveInvoice>(
      "record_manual_payment",
      {
        _organization_id: orgId,
        _invoice_id: input.invoiceId,
        _expected_version: input.expectedVersion,
        _amount_minor: input.amountMinor,
        _method: input.method,
        _reference: input.reference ?? null,
        _idempotency_key: input.idempotencyKey ?? null,
      },
      token,
    );
  },

  async grantCredit(
    input: { patientId: string; amountMinor: number; reason: string },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveBillingMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LiveBillingMutationResult>(
      "grant_patient_credit",
      {
        _organization_id: orgId,
        _patient_id: input.patientId,
        _amount_minor: input.amountMinor,
        _reason: input.reason,
      },
      token,
    );
  },

  async applyCredit(
    input: { invoiceId: string; expectedVersion: number; amountMinor: number },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveInvoice> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LiveInvoice>(
      "apply_patient_credit",
      {
        _organization_id: orgId,
        _invoice_id: input.invoiceId,
        _expected_version: input.expectedVersion,
        _amount_minor: input.amountMinor,
      },
      token,
    );
  },

  /** Manual payments only — card refunds belong to the processor workflow. */
  async refundPayment(
    input: { paymentId: string; amountMinor: number; reason: string; method?: string | null },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveInvoice> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LiveInvoice>(
      "refund_payment",
      {
        _organization_id: orgId,
        _payment_id: input.paymentId,
        _amount_minor: input.amountMinor,
        _reason: input.reason,
        _method: input.method ?? null,
      },
      token,
    );
  },

  /**
   * Creates the PENDING test-mode payment row and returns the amount owed.
   * It does NOT charge anything and cannot report success: settlement arrives
   * only through the server-only webhook boundary.
   */
  async startCardPayment(
    input: { invoiceId: string; expectedVersion: number; idempotencyKey: string },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveCardPaymentIntent> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LiveCardPaymentIntent>(
      "start_card_payment",
      {
        _organization_id: orgId,
        _invoice_id: input.invoiceId,
        _expected_version: input.expectedVersion,
        _idempotency_key: input.idempotencyKey,
      },
      token,
    );
  },
};
