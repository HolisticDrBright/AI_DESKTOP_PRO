"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/adapters";
import { AdapterError } from "@/adapters/errors";
import type {
  LiveBillingWorkspace,
  LiveInvoiceStatus,
} from "@/adapters/live-types";
import { Card, CardTitle } from "@/components/ui/bits";
import { Btn } from "@/components/ui/Btn";
import { Metric } from "@/components/ui/Metric";
import { TableWrap, TD, TH } from "@/components/ui/Table";
import { Select } from "@/components/ui/Field";
import {
  ClinicalError,
  ClinicalLoading,
  ClinicalNote,
} from "@/components/ui/ClinicalStates";
import { formatMinor } from "@/lib/money";
import { cn } from "@/lib/cn";

function errText(e: unknown): string {
  return e instanceof AdapterError ? e.message : "Something went wrong. Try again.";
}

function fmtDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const STATUS_TONE: Record<LiveInvoiceStatus, string> = {
  draft: "bg-slate-tint text-slate-badge",
  open: "bg-warning-tint text-warning-deep",
  partially_paid: "bg-warning-tint text-warning-deep",
  paid: "bg-positive-tint text-positive-deep",
  void: "bg-slate-tint text-slate-badge",
  refunded: "bg-critical-tint text-critical",
  partially_refunded: "bg-critical-tint text-critical",
  uncollectible: "bg-critical-tint text-critical",
};

const STATUS_LABEL: Record<LiveInvoiceStatus, string> = {
  draft: "Draft",
  open: "Open",
  partially_paid: "Partly paid",
  paid: "Paid",
  void: "Void",
  refunded: "Refunded",
  partially_refunded: "Partly refunded",
  uncollectible: "Uncollectible",
};

function StatusPill({ status }: { status: LiveInvoiceStatus }) {
  return (
    <span
      data-testid={`invoice-status-${status}`}
      className={cn(
        "inline-flex items-center rounded-full px-[7px] py-px text-[11px] font-semibold",
        STATUS_TONE[status],
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

const RANGES = [
  { id: "30", label: "Last 30 days", days: 30 },
  { id: "90", label: "Last 90 days", days: 90 },
  { id: "365", label: "Last 12 months", days: 365 },
];

/**
 * The practice billing workspace. Every figure on this screen is summed by
 * the database from persisted rows — this component computes no totals of its
 * own, so what a practitioner reads is what was actually recorded.
 */
export function BillingWorkspace() {
  const [data, setData] = useState<LiveBillingWorkspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rangeId, setRangeId] = useState("30");
  const [status, setStatus] = useState("");

  const load = useCallback(async (range: string, statusFilter: string) => {
    setError(null);
    const days = RANGES.find((r) => r.id === range)?.days ?? 30;
    try {
      setData(
        await api.billing.workspace({
          from: new Date(Date.now() - days * 86_400_000).toISOString(),
          to: new Date().toISOString(),
          status: statusFilter || null,
        }),
      );
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  useEffect(() => {
    void load(rangeId, status);
  }, [rangeId, status, load]);

  if (error && !data) {
    return <ClinicalError message={error} onRetry={() => void load(rangeId, status)} />;
  }
  if (!data) return <ClinicalLoading label="Loading the billing workspace…" />;

  const { summary, invoices, payments, aging, productSales, inventory, reconciliation } = data;

  return (
    <div className="flex flex-col gap-4" data-testid="billing-workspace">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Date range"
          data-testid="billing-range"
          value={rangeId}
          onChange={(e) => setRangeId(e.target.value)}
          className="w-[160px]"
        >
          {RANGES.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Invoice status"
          data-testid="billing-status-filter"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="w-[170px]"
        >
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="open">Open</option>
          <option value="partially_paid">Partly paid</option>
          <option value="paid">Paid</option>
          <option value="void">Void</option>
        </Select>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-6">
        <Metric label="Invoiced" value={formatMinor(summary.invoicedMinor)} />
        <Metric label="Collected" value={formatMinor(summary.collectedMinor)} />
        <Metric label="Outstanding" value={formatMinor(summary.outstandingMinor)} />
        <Metric label="Refunded" value={formatMinor(summary.refundedMinor)} />
        <Metric label="Discounts" value={formatMinor(summary.discountMinor)} />
        <Metric label="Tax" value={formatMinor(summary.taxMinor)} />
      </div>

      <Card className="p-[14px]">
        <CardTitle>Invoices</CardTitle>
        {invoices.length === 0 ? (
          <p className="mt-2 mb-0 text-[12.5px] text-subtle">
            No invoices in this range.
          </p>
        ) : (
          <TableWrap className="mt-[10px]">
            <thead>
              <tr>
                <TH>Number</TH>
                <TH>Patient</TH>
                <TH>Status</TH>
                <TH className="text-right">Total</TH>
                <TH className="text-right">Balance</TH>
                <TH>Finalized</TH>
              </tr>
            </thead>
            <tbody data-testid="billing-invoice-rows">
              {invoices.map((inv) => (
                <tr key={inv.id}>
                  <TD>
                    <Link
                      href={`/billing/${inv.id}`}
                      className="font-semibold text-action hover:underline"
                      data-testid={`invoice-link-${inv.id}`}
                    >
                      {inv.number ?? "Draft"}
                    </Link>
                  </TD>
                  <TD>{inv.patientName ?? "—"}</TD>
                  <TD>
                    <StatusPill status={inv.status} />
                  </TD>
                  <TD className="text-right tabular-nums">{formatMinor(inv.totalMinor)}</TD>
                  <TD className="text-right tabular-nums">{formatMinor(inv.balanceMinor)}</TD>
                  <TD className="text-muted">{fmtDate(inv.finalizedAt)}</TD>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-[14px]">
          <CardTitle>Accounts receivable aging</CardTitle>
          <div className="mt-[10px] grid grid-cols-2 gap-2">
            <Metric label="Current" value={formatMinor(aging.current)} />
            <Metric label="31–60 days" value={formatMinor(aging.days31to60)} />
            <Metric label="61–90 days" value={formatMinor(aging.days61to90)} />
            <Metric label="Over 90 days" value={formatMinor(aging.over90)} />
          </div>
        </Card>

        <Card className="p-[14px]">
          <CardTitle>Inventory</CardTitle>
          <div className="mt-[10px]">
            <Metric label="Stock valuation (at cost)" value={formatMinor(inventory.valuationMinor)} />
          </div>
          {inventory.lowStock.length === 0 ? (
            <p className="mt-[10px] mb-0 text-[12.5px] text-subtle">
              Nothing is at or below its reorder threshold.
            </p>
          ) : (
            <TableWrap className="mt-[10px]">
              <thead>
                <tr>
                  <TH>Product</TH>
                  <TH>Location</TH>
                  <TH className="text-right">Available</TH>
                  <TH className="text-right">Threshold</TH>
                </tr>
              </thead>
              <tbody data-testid="billing-low-stock-rows">
                {inventory.lowStock.map((row) => (
                  <tr key={`${row.productId}-${row.locationId}`}>
                    <TD className="font-medium">{row.name}</TD>
                    <TD className="text-muted">{row.locationName ?? "—"}</TD>
                    <TD className="text-right tabular-nums font-semibold text-warning-deep">
                      {row.available}
                    </TD>
                    <TD className="text-right tabular-nums text-muted">{row.reorderThreshold}</TD>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-[14px]">
          <CardTitle>Payments</CardTitle>
          {payments.length === 0 ? (
            <p className="mt-2 mb-0 text-[12.5px] text-subtle">No payments in this range.</p>
          ) : (
            <TableWrap className="mt-[10px]">
              <thead>
                <tr>
                  <TH>Method</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Amount</TH>
                  <TH>Taken</TH>
                </tr>
              </thead>
              <tbody data-testid="billing-payment-rows">
                {payments.map((p) => (
                  <tr key={p.id}>
                    <TD className="font-medium">
                      {p.method === "card_test" ? "Card (test mode)" : p.method.replace("_", " ")}
                    </TD>
                    <TD>{p.status}</TD>
                    <TD className="text-right tabular-nums">{formatMinor(p.amountMinor)}</TD>
                    <TD className="text-muted">{fmtDate(p.createdAt)}</TD>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Card>

        <Card className="p-[14px]">
          <CardTitle>Product & service sales</CardTitle>
          {productSales.length === 0 ? (
            <p className="mt-2 mb-0 text-[12.5px] text-subtle">Nothing sold in this range.</p>
          ) : (
            <TableWrap className="mt-[10px]">
              <thead>
                <tr>
                  <TH>Item</TH>
                  <TH className="text-right">Qty</TH>
                  <TH className="text-right">Net</TH>
                </tr>
              </thead>
              <tbody data-testid="billing-product-sales-rows">
                {productSales.map((s) => (
                  <tr key={`${s.productId}-${s.name}`}>
                    <TD className="font-medium">{s.name ?? "—"}</TD>
                    <TD className="text-right tabular-nums">{s.quantity}</TD>
                    <TD className="text-right tabular-nums">{formatMinor(s.amountMinor)}</TD>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Card>
      </div>

      <Card className="p-[14px]" data-testid="billing-reconciliation">
        <CardTitle>Processor reconciliation</CardTitle>
        <ClinicalNote>
          Card payments run in Stripe TEST MODE. A started payment is never a
          completed charge: settlement is recorded only when the processor
          webhook confirms it, and every refused or duplicate event is kept
          below rather than dropped.
        </ClinicalNote>
        <div className="mt-[10px]">
          <Metric
            label="Card payments awaiting settlement"
            value={reconciliation.pendingCardPayments}
          />
        </div>
        {reconciliation.webhookEvents.length === 0 ? (
          <p className="mt-[10px] mb-0 text-[12.5px] text-subtle">
            No processor events received.
          </p>
        ) : (
          <TableWrap className="mt-[10px]">
            <thead>
              <tr>
                <TH>Event</TH>
                <TH>Outcome</TH>
                <TH>Detail</TH>
                <TH>Received</TH>
              </tr>
            </thead>
            <tbody data-testid="billing-webhook-rows">
              {reconciliation.webhookEvents.map((e) => (
                <tr key={e.eventId}>
                  <TD className="font-medium">{e.type}</TD>
                  <TD>
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full px-[7px] py-px text-[11px] font-semibold",
                        e.outcome === "processed"
                          ? "bg-positive-tint text-positive-deep"
                          : e.outcome === "refused"
                            ? "bg-critical-tint text-critical"
                            : "bg-slate-tint text-slate-badge",
                      )}
                    >
                      {e.outcome.replace("_", " ")}
                    </span>
                  </TD>
                  <TD className="text-muted">{e.detail ?? "—"}</TD>
                  <TD className="text-muted">{fmtDate(e.receivedAt)}</TD>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>

      {error && (
        <div className="flex items-center gap-2">
          <p className="m-0 text-[12.5px] text-critical">{error}</p>
          <Btn variant="outline" size="sm" onClick={() => void load(rangeId, status)}>
            Retry
          </Btn>
        </div>
      )}
    </div>
  );
}
