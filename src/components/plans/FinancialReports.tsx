"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/adapters";
import { AdapterError } from "@/adapters/errors";
import type {
  LiveBillingWorkspace,
  LivePlanLibrary,
  LiveReconciliationWorkspace,
} from "@/adapters/live-types";
import { Card, CardTitle } from "@/components/ui/bits";
import { Metric } from "@/components/ui/Metric";
import { TableWrap, TD, TH } from "@/components/ui/Table";
import { Select } from "@/components/ui/Field";
import { ClinicalError, ClinicalLoading, ClinicalNote } from "@/components/ui/ClinicalStates";
import { formatMinor } from "@/lib/money";
import { cn } from "@/lib/cn";

function errText(e: unknown): string {
  return e instanceof AdapterError ? e.message : "Something went wrong. Try again.";
}

const RANGES = [
  { id: "30", label: "Last 30 days", days: 30 },
  { id: "90", label: "Last 90 days", days: 90 },
  { id: "365", label: "Last 12 months", days: 365 },
];

/**
 * A proportion bar with a REQUIRED text equivalent.
 *
 * Colour is never the only signal: every segment states its own label and
 * value in text, the bar carries an accessible name, and the same numbers
 * appear in the table beneath. A screen reader and a monochrome print get the
 * identical information.
 */
function ShareBar({
  segments,
  ariaLabel,
  testId,
}: {
  segments: { label: string; value: number; className: string }[];
  ariaLabel: string;
  testId: string;
}) {
  const total = segments.reduce((s, x) => s + Math.max(x.value, 0), 0);
  if (total <= 0) {
    return (
      <p className="m-0 text-[12.5px] text-subtle" data-testid={`${testId}-empty`}>
        Nothing recorded in this range.
      </p>
    );
  }
  return (
    <div data-testid={testId}>
      <div
        role="img"
        aria-label={`${ariaLabel}. ${segments
          .map((s) => `${s.label}: ${formatMinor(s.value)}`)
          .join("; ")}`}
        className="flex h-[10px] w-full overflow-hidden rounded-full bg-sunken"
      >
        {segments.map((s) => (
          <span
            key={s.label}
            className={cn("h-full", s.className)}
            style={{ width: `${(Math.max(s.value, 0) / total) * 100}%` }}
          />
        ))}
      </div>
      <ul className="mt-[8px] mb-0 flex list-none flex-wrap gap-x-[14px] gap-y-[3px] p-0">
        {segments.map((s) => (
          <li key={s.label} className="text-[11.5px] text-subtle">
            <span className={cn("mr-[5px] inline-block h-[8px] w-[8px] rounded-full align-middle", s.className)} />
            {/* the label and figure are text, so colour is never load-bearing */}
            {s.label}: <span className="font-semibold text-body">{formatMinor(s.value)}</span>
            <span className="text-faint"> ({Math.round((Math.max(s.value, 0) / total) * 100)}%)</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Financial reporting.
 *
 * Everything is summed by the database from persisted rows. Figures that are
 * ESTIMATES say so in the heading and the note — nothing here is called
 * recognized revenue, profit, or an accounting-certified result.
 */
export function FinancialReports() {
  const [workspace, setWorkspace] = useState<LiveBillingWorkspace | null>(null);
  const [plans, setPlans] = useState<LivePlanLibrary | null>(null);
  const [recon, setRecon] = useState<LiveReconciliationWorkspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rangeId, setRangeId] = useState("30");
  const [compare, setCompare] = useState<LiveBillingWorkspace | null>(null);

  const load = useCallback(async (range: string) => {
    setError(null);
    const days = RANGES.find((r) => r.id === range)?.days ?? 30;
    const now = Date.now();
    const from = new Date(now - days * 86_400_000).toISOString();
    const prevFrom = new Date(now - days * 2 * 86_400_000).toISOString();
    try {
      const [ws, prev, lib, rc] = await Promise.all([
        api.billing.workspace({ from, to: new Date(now).toISOString() }),
        api.billing.workspace({ from: prevFrom, to: from }),
        api.plans.library(true).catch(() => null),
        api.plans.reconciliation(null).catch(() => null),
      ]);
      setWorkspace(ws);
      setCompare(prev);
      setPlans(lib);
      setRecon(rc);
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  useEffect(() => {
    void load(rangeId);
  }, [rangeId, load]);

  if (error && !workspace) return <ClinicalError message={error} onRetry={() => void load(rangeId)} />;
  if (!workspace) return <ClinicalLoading label="Loading reports…" />;

  const s = workspace.summary;
  const prev = compare?.summary;
  const delta = (now: number, before?: number) => {
    if (before == null || before === 0) return null;
    return Math.round(((now - before) / before) * 100);
  };

  const membershipCount = plans?.memberships.length ?? 0;
  const packageCount = plans?.packages.length ?? 0;
  const openExceptions = recon?.exceptions.filter((x) => x.status === "open").length ?? 0;

  const complimentaryMinor = workspace.invoices
    .filter((i) => i.totalMinor === 0 && i.status !== "void")
    .reduce((sum) => sum, 0);

  return (
    <div className="flex flex-col gap-4" data-testid="financial-reports">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={rangeId}
          aria-label="Reporting range"
          data-testid="reports-range"
          className="w-[170px]"
          onChange={(e) => setRangeId(e.target.value)}
        >
          {RANGES.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </Select>
        <span className="text-[11.5px] text-faint">
          compared with the preceding period of equal length
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-6">
        <Metric
          label="Gross charges"
          value={formatMinor(s.invoicedMinor)}
          sub={delta(s.invoicedMinor, prev?.invoicedMinor) != null
            ? `${delta(s.invoicedMinor, prev?.invoicedMinor)! >= 0 ? "+" : ""}${delta(s.invoicedMinor, prev?.invoicedMinor)}% vs prior`
            : "no prior period"}
        />
        <Metric label="Payments collected" value={formatMinor(s.collectedMinor)} />
        <Metric label="Outstanding" value={formatMinor(s.outstandingMinor)} />
        <Metric label="Refunds" value={formatMinor(s.refundedMinor)} />
        <Metric label="Discounts" value={formatMinor(s.discountMinor)} />
        <Metric label="Tax" value={formatMinor(s.taxMinor)} />
      </div>

      <Card className="p-[14px]">
        <CardTitle>Where the money went</CardTitle>
        <div className="mt-[10px]">
          <ShareBar
            testId="revenue-share"
            ariaLabel="Collected, outstanding, and refunded amounts"
            segments={[
              { label: "Collected", value: s.collectedMinor, className: "bg-positive" },
              { label: "Outstanding", value: s.outstandingMinor, className: "bg-warning" },
              { label: "Refunded", value: s.refundedMinor, className: "bg-critical" },
            ]}
          />
        </div>
        {/* The same numbers as a table: the chart is never the only source. */}
        <TableWrap className="mt-[12px]">
          <thead>
            <tr>
              <TH>Measure</TH>
              <TH className="text-right">This period</TH>
              <TH className="text-right">Prior period</TH>
            </tr>
          </thead>
          <tbody data-testid="report-comparison-rows">
            {[
              ["Gross charges", s.invoicedMinor, prev?.invoicedMinor],
              ["Payments collected", s.collectedMinor, prev?.collectedMinor],
              ["Outstanding balance", s.outstandingMinor, prev?.outstandingMinor],
              ["Refunds and credits", s.refundedMinor, prev?.refundedMinor],
              ["Discounts", s.discountMinor, prev?.discountMinor],
              ["Taxes", s.taxMinor, prev?.taxMinor],
            ].map(([label, cur, before]) => (
              <tr key={String(label)}>
                <TD className="font-medium">{label as string}</TD>
                <TD className="text-right tabular-nums">{formatMinor(cur as number)}</TD>
                <TD className="text-right tabular-nums text-muted">
                  {before == null ? "—" : formatMinor(before as number)}
                </TD>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-[14px]">
          <CardTitle>Accounts receivable aging</CardTitle>
          <div className="mt-[10px]">
            <ShareBar
              testId="aging-share"
              ariaLabel="Receivables by age bucket"
              segments={[
                { label: "Current", value: workspace.aging.current, className: "bg-positive" },
                { label: "31–60 days", value: workspace.aging.days31to60, className: "bg-warning" },
                { label: "61–90 days", value: workspace.aging.days61to90, className: "bg-critical" },
                { label: "Over 90 days", value: workspace.aging.over90, className: "bg-slate-badge" },
              ]}
            />
          </div>
        </Card>

        <Card className="p-[14px]">
          <CardTitle>Plans &amp; memberships</CardTitle>
          <div className="mt-[10px] grid grid-cols-2 gap-2">
            <Metric label="Packages offered" value={packageCount} />
            <Metric label="Memberships offered" value={membershipCount} />
            <Metric label="Complimentary invoices" value={complimentaryMinor === 0 ? "—" : formatMinor(complimentaryMinor)} />
            <Metric label="Open reconciliation" value={openExceptions} />
          </div>
          <ClinicalNote>
            Recurring revenue by membership state needs subscription billing
            history, which exists only once a processor has settled at least one
            period. It is left out rather than estimated from plan prices.
          </ClinicalNote>
        </Card>
      </div>

      <Card className="p-[14px]">
        <CardTitle>Product &amp; service sales</CardTitle>
        {workspace.productSales.length === 0 ? (
          <p className="mt-2 mb-0 text-[12.5px] text-subtle" data-testid="report-sales-empty">
            Nothing sold in this range.
          </p>
        ) : (
          <TableWrap className="mt-[10px]">
            <thead>
              <tr>
                <TH>Item</TH>
                <TH>Category</TH>
                <TH className="text-right">Qty</TH>
                <TH className="text-right">Net</TH>
              </tr>
            </thead>
            <tbody data-testid="report-sales-rows">
              {workspace.productSales.map((row) => (
                <tr key={`${row.productId}-${row.name}`}>
                  <TD className="font-medium">{row.name ?? "—"}</TD>
                  <TD className="text-muted">{row.kind ?? "—"}</TD>
                  <TD className="text-right tabular-nums">{row.quantity}</TD>
                  <TD className="text-right tabular-nums">{formatMinor(row.amountMinor)}</TD>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>

      <Card className="p-[14px]" data-testid="report-estimates">
        <CardTitle>Inventory cost &amp; margin — ESTIMATES</CardTitle>
        <ClinicalNote>
          These are <strong>estimates</strong> computed from recorded cost and
          sale figures. They are <strong>not</strong> recognized revenue, not
          profit, and not an accounting-certified result. Fees, returns,
          shrinkage, and taxes owed are not modelled here. Use your accounting
          system for anything that must be correct.
        </ClinicalNote>
        <div className="mt-[10px] grid grid-cols-2 gap-2 md:grid-cols-3">
          <Metric
            label="Stock valuation (at cost)"
            value={formatMinor(workspace.inventory.valuationMinor)}
          />
          <Metric
            label="Gross margin estimate"
            value={
              s.collectedMinor > 0
                ? `${Math.round(((s.collectedMinor - workspace.inventory.valuationMinor) / s.collectedMinor) * 100)}%`
                : "—"
            }
            sub="estimate only"
          />
          <Metric label="Items below reorder point" value={workspace.inventory.lowStock.length} />
        </div>
      </Card>
    </div>
  );
}
