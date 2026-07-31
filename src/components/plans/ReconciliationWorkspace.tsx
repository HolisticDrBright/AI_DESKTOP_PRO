"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/adapters";
import { AdapterError } from "@/adapters/errors";
import type { LiveReconciliationWorkspace } from "@/adapters/live-types";
import { Card, CardTitle } from "@/components/ui/bits";
import { Btn } from "@/components/ui/Btn";
import { Metric } from "@/components/ui/Metric";
import { TableWrap, TD, TH } from "@/components/ui/Table";
import { Field, Select, TextInput } from "@/components/ui/Field";
import { ClinicalError, ClinicalLoading, ClinicalNote } from "@/components/ui/ClinicalStates";
import { useFeedback } from "@/lib/feedback";
import { formatMinor } from "@/lib/money";
import { cn } from "@/lib/cn";

function errText(e: unknown): string {
  return e instanceof AdapterError ? e.message : "Something went wrong. Try again.";
}

function fmtDate(v: string): string {
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const KIND_LABEL: Record<string, string> = {
  unmatched_internal_payment: "Payment with no processor event",
  unmatched_provider_event: "Processor event with no payment",
  amount_mismatch: "Amount disagreement",
  currency_mismatch: "Currency disagreement",
  duplicate_event: "Duplicate event",
  delayed_webhook: "Delayed webhook",
  failed_webhook: "Failed webhook",
  dispute: "Dispute",
  refund_action_required: "Refund needs action",
};

/**
 * Reconciliation: internal payments against processor events.
 *
 * Where provider settlement figures are not fetched in this phase, the screen
 * says UNAVAILABLE rather than rendering a zero — an absent fee and a fee of
 * nothing are different claims.
 */
export function ReconciliationWorkspace() {
  const { announce } = useFeedback();
  const [data, setData] = useState<LiveReconciliationWorkspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("open");
  const [resolveFor, setResolveFor] = useState<{ id: string; version: number } | null>(null);
  const [resolution, setResolution] = useState<"resolved" | "dismissed">("resolved");
  const [reason, setReason] = useState("");

  const load = useCallback(async (s: string) => {
    setError(null);
    try {
      setData(await api.plans.reconciliation(s || null));
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  useEffect(() => {
    void load(status);
  }, [status, load]);

  if (error && !data) return <ClinicalError message={error} onRetry={() => void load(status)} />;
  if (!data) return <ClinicalLoading label="Loading reconciliation…" />;

  const openCount = data.exceptions.filter((x) => x.status === "open").length;

  return (
    <div className="flex flex-col gap-4" data-testid="reconciliation-workspace">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Metric label="Open exceptions" value={openCount} />
        <Metric label="Processor events" value={data.webhookEvents.length} />
        <Metric
          label="Provider fees"
          value={data.settlementFieldsAvailable ? "—" : "Unavailable"}
          sub={data.settlementFieldsAvailable ? undefined : "not fetched in this phase"}
        />
        <Metric
          label="Net settled"
          value={data.settlementFieldsAvailable ? "—" : "Unavailable"}
          sub={data.settlementFieldsAvailable ? undefined : "not fetched in this phase"}
        />
      </div>

      {!data.settlementFieldsAvailable && (
        <ClinicalNote>
          <span data-testid="settlement-unavailable">
            Provider fee, net, and payout status are <strong>unavailable</strong> —
            balance transactions and payouts are not fetched in this phase. They
            are shown as unavailable rather than as zero, because those are
            different statements.
          </span>
        </ClinicalNote>
      )}

      <Card className="p-[14px]">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <CardTitle>Exceptions</CardTitle>
          <Select
            value={status}
            aria-label="Exception status"
            data-testid="reconciliation-status"
            className="w-[160px]"
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
            <option value="dismissed">Dismissed</option>
            <option value="">All</option>
          </Select>
        </div>

        {data.exceptions.length === 0 ? (
          <p className="mt-[10px] mb-0 text-[12.5px] text-subtle" data-testid="reconciliation-empty">
            Nothing to reconcile in this view.
          </p>
        ) : (
          <TableWrap className="mt-[10px]">
            <thead>
              <tr>
                <TH>Exception</TH>
                <TH className="text-right">Internal</TH>
                <TH className="text-right">Provider</TH>
                <TH className="text-right">Fee</TH>
                <TH className="text-right">Net</TH>
                <TH>Raised</TH>
                <TH />
              </tr>
            </thead>
            <tbody data-testid="reconciliation-rows">
              {data.exceptions.map((x) => (
                <tr key={x.id}>
                  <TD>
                    <span className="font-medium">{KIND_LABEL[x.kind] ?? x.kind}</span>
                    {x.detail && (
                      <span className="block text-[11.5px] text-muted">{x.detail}</span>
                    )}
                    {x.resolutionReason && (
                      <span className="block text-[11.5px] text-positive-deep">
                        {x.status}: {x.resolutionReason}
                      </span>
                    )}
                  </TD>
                  <TD className="text-right tabular-nums">
                    {x.internalAmountMinor == null ? "—" : formatMinor(x.internalAmountMinor)}
                  </TD>
                  <TD className="text-right tabular-nums">
                    {x.providerAmountMinor == null ? "—" : formatMinor(x.providerAmountMinor)}
                  </TD>
                  <TD className="text-right text-[11.5px] text-faint">
                    {x.providerFeeMinor == null ? "unavailable" : formatMinor(x.providerFeeMinor)}
                  </TD>
                  <TD className="text-right text-[11.5px] text-faint">
                    {x.providerNetMinor == null ? "unavailable" : formatMinor(x.providerNetMinor)}
                  </TD>
                  <TD className="text-muted">{fmtDate(x.createdAt)}</TD>
                  <TD className="text-right">
                    {x.status === "open" && (
                      <Btn
                        variant="ghost"
                        size="sm"
                        data-testid={`reconciliation-resolve-${x.id}`}
                        onClick={() => setResolveFor({ id: x.id, version: x.version })}
                      >
                        Resolve
                      </Btn>
                    )}
                  </TD>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}

        {resolveFor && (
          <div className="mt-[12px] border-t border-hairline pt-[12px]" data-testid="resolve-panel">
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Outcome" className="min-w-[150px]">
                <Select
                  value={resolution}
                  data-testid="resolve-outcome"
                  onChange={(e) => setResolution(e.target.value as "resolved" | "dismissed")}
                >
                  <option value="resolved">Resolved</option>
                  <option value="dismissed">Dismissed</option>
                </Select>
              </Field>
              <Field label="Reason" className="min-w-[260px]">
                <TextInput
                  value={reason}
                  placeholder="Required"
                  data-testid="resolve-reason"
                  onChange={(e) => setReason(e.target.value)}
                />
              </Field>
              <Btn
                variant="primary"
                disabled={busy}
                data-testid="resolve-submit"
                onClick={() => {
                  const r = reason.trim();
                  if (!r) {
                    announce("Resolving an exception needs a reason.");
                    return;
                  }
                  setBusy(true);
                  api.plans
                    .resolveException({
                      exceptionId: resolveFor.id,
                      resolution,
                      reason: r,
                      expectedVersion: resolveFor.version,
                    })
                    .then(async () => {
                      announce("Exception resolved and recorded.");
                      setResolveFor(null);
                      setReason("");
                      await load(status);
                    })
                    .catch((e: unknown) => announce(errText(e)))
                    .finally(() => setBusy(false));
                }}
              >
                Record resolution
              </Btn>
              <Btn variant="ghost" onClick={() => setResolveFor(null)}>
                Cancel
              </Btn>
            </div>
          </div>
        )}
      </Card>

      <Card className="p-[14px]">
        <CardTitle>Processor events</CardTitle>
        <ClinicalNote>
          A refused or duplicate event is a recorded row, never a silent drop.
          <strong> Signature verified</strong> shows whether the event&rsquo;s
          signature was actually checked — an unverified event is never treated
          as proof of anything.
        </ClinicalNote>
        {data.webhookEvents.length === 0 ? (
          <p className="mt-[10px] mb-0 text-[12.5px] text-subtle" data-testid="no-processor-events">
            No processor events received.
          </p>
        ) : (
          <TableWrap className="mt-[10px]">
            <thead>
              <tr>
                <TH>Event</TH>
                <TH>Outcome</TH>
                <TH>Signature</TH>
                <TH>Detail</TH>
                <TH>Received</TH>
              </tr>
            </thead>
            <tbody data-testid="processor-event-rows">
              {data.webhookEvents.map((e) => (
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
                  <TD className="text-[11.5px]">
                    {e.signatureVerified ? (
                      <span className="font-semibold text-positive-deep">verified</span>
                    ) : (
                      <span className="text-faint">not verified</span>
                    )}
                  </TD>
                  <TD className="text-muted">{e.detail ?? "—"}</TD>
                  <TD className="text-muted">{fmtDate(e.receivedAt)}</TD>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}
