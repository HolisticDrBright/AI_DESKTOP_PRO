"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/adapters";
import { AdapterError } from "@/adapters/errors";
import type { LivePatientBilling, LiveInvoiceStatus } from "@/adapters/live-types";
import { Card, CardTitle } from "@/components/ui/bits";
import { Btn } from "@/components/ui/Btn";
import { Metric } from "@/components/ui/Metric";
import { TableWrap, TD, TH } from "@/components/ui/Table";
import { Field, TextInput } from "@/components/ui/Field";
import {
  ClinicalEmpty,
  ClinicalError,
  ClinicalLoading,
  ClinicalNote,
} from "@/components/ui/ClinicalStates";
import { useFeedback } from "@/lib/feedback";
import { formatMinor, parseToMinor } from "@/lib/money";
import { cn } from "@/lib/cn";

function errText(e: unknown): string {
  return e instanceof AdapterError ? e.message : "Something went wrong. Try again.";
}

function fmtDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
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

/**
 * The patient's financial ledger: every invoice, the outstanding balance, and
 * the account credit — all read from persisted rows. Starting a checkout from
 * here creates a real draft invoice; nothing is charged.
 */
export function PatientBillingLive({ patientId }: { patientId: string }) {
  const { announce } = useFeedback();
  const [data, setData] = useState<LivePatientBilling | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creditAmount, setCreditAmount] = useState("");
  const [creditReason, setCreditReason] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.billing.forPatient(patientId));
    } catch (e) {
      setError(errText(e));
    }
  }, [patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !data) return <ClinicalError message={error} onRetry={() => void load()} />;
  if (!data) return <ClinicalLoading label="Loading the patient ledger…" />;

  const outstanding = data.invoices
    .filter((i) => i.status === "open" || i.status === "partially_paid")
    .reduce((sum, i) => sum + i.balanceMinor, 0);

  return (
    <div className="flex flex-col gap-4 pt-4" data-testid="patient-billing">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
        <Metric label="Outstanding balance" value={formatMinor(outstanding)} />
        <Metric label="Account credit" value={formatMinor(data.creditBalanceMinor)} />
        <Metric label="Invoices" value={data.invoices.length} />
      </div>

      <Card className="p-[14px]">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Invoices</CardTitle>
          <Btn
            variant="outline"
            disabled={busy}
            data-testid="patient-start-checkout"
            onClick={() => {
              if (busy) return;
              setBusy(true);
              api.billing
                .createDraft({ patientId })
                .then((invoice) => {
                  announce("Checkout draft created.");
                  window.location.href = `/billing/${invoice.id}`;
                })
                .catch((e: unknown) => announce(errText(e)))
                .finally(() => setBusy(false));
            }}
          >
            Start a checkout
          </Btn>
        </div>

        {data.invoices.length === 0 ? (
          <div className="mt-[10px]">
            <ClinicalEmpty
              title="No invoices yet"
              message="Nothing has been billed to this patient. Starting a checkout creates a draft invoice — it charges nothing until you finalize and take payment."
            />
          </div>
        ) : (
          <TableWrap className="mt-[10px]">
            <thead>
              <tr>
                <TH>Number</TH>
                <TH>Status</TH>
                <TH className="text-right">Total</TH>
                <TH className="text-right">Paid</TH>
                <TH className="text-right">Balance</TH>
                <TH>Date</TH>
              </tr>
            </thead>
            <tbody data-testid="patient-invoice-rows">
              {data.invoices.map((inv) => (
                <tr key={inv.id}>
                  <TD>
                    <Link
                      href={`/billing/${inv.id}`}
                      className="font-semibold text-action hover:underline"
                      data-testid={`patient-invoice-${inv.id}`}
                    >
                      {inv.number ?? "Draft"}
                    </Link>
                  </TD>
                  <TD>
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full px-[7px] py-px text-[11px] font-semibold",
                        STATUS_TONE[inv.status],
                      )}
                    >
                      {inv.status.replace("_", " ")}
                    </span>
                  </TD>
                  <TD className="text-right tabular-nums">{formatMinor(inv.totalMinor)}</TD>
                  <TD className="text-right tabular-nums">
                    {formatMinor(inv.paidMinor + inv.creditAppliedMinor)}
                  </TD>
                  <TD className="text-right tabular-nums">{formatMinor(inv.balanceMinor)}</TD>
                  <TD className="text-muted">{fmtDate(inv.finalizedAt ?? inv.createdAt)}</TD>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>

      <Card className="p-[14px]">
        <CardTitle>Account credit</CardTitle>
        <ClinicalNote>
          Credit is money the practice owes this patient — a goodwill gesture or
          an overpayment. Granting it moves no money on its own; it is applied
          against an open invoice.
        </ClinicalNote>
        <div className="mt-[10px] flex flex-wrap items-end gap-2">
          <Field label="Amount" className="min-w-[130px]">
            <TextInput
              value={creditAmount}
              placeholder="$0.00"
              data-testid="patient-credit-amount"
              onChange={(e) => setCreditAmount(e.target.value)}
            />
          </Field>
          <Field label="Reason" className="min-w-[220px]">
            <TextInput
              value={creditReason}
              placeholder="Required"
              data-testid="patient-credit-reason"
              onChange={(e) => setCreditReason(e.target.value)}
            />
          </Field>
          <Btn
            variant="outline"
            disabled={busy}
            data-testid="patient-credit-grant"
            onClick={() => {
              const minor = parseToMinor(creditAmount);
              if (!minor) {
                announce("Enter a credit amount.");
                return;
              }
              if (!creditReason.trim()) {
                announce("Granting credit needs a reason.");
                return;
              }
              setBusy(true);
              api.billing
                .grantCredit({
                  patientId,
                  amountMinor: minor,
                  reason: creditReason.trim(),
                })
                .then(async () => {
                  announce("Credit granted.");
                  setCreditAmount("");
                  setCreditReason("");
                  await load();
                })
                .catch((e: unknown) => announce(errText(e)))
                .finally(() => setBusy(false));
            }}
          >
            Grant credit
          </Btn>
        </div>
      </Card>
    </div>
  );
}
