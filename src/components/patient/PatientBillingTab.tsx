"use client";

import { useState } from "react";
import { CreditCard } from "lucide-react";
import {
  MEMBERSHIPS,
  patientLedger,
  refundSessionPayment,
  useSessionInvoices,
  type Invoice,
} from "@/adapters/billing.mock";
import { useFeedback } from "@/lib/feedback";
import { formatMinor } from "@/lib/money";
import { Btn, BtnLink } from "@/components/ui/Btn";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Metric } from "@/components/ui/Metric";
import { Pill } from "@/components/ui/Pill";
import { TableWrap, TD, TH } from "@/components/ui/Table";
import { DemoNote } from "@/components/ui/DemoNote";

const STATUS_TONE: Record<Invoice["status"], "positive" | "warning" | "critical" | "slate" | "action"> = {
  paid: "positive",
  partial: "warning",
  open: "warning",
  refunded: "critical",
  draft: "slate",
  void: "slate",
};

export function PatientBillingTab({
  patientId,
  patientName,
}: {
  patientId: string;
  patientName: string;
}) {
  useSessionInvoices();
  const { announce } = useFeedback();
  const ledger = patientLedger(patientId);
  const memberships = MEMBERSHIPS.filter((m) => m.patientId === patientId);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [refunding, setRefunding] = useState<{ invoiceId: string; paymentId: string } | null>(null);

  return (
    <div data-screen-label="Patient Billing" className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Balance due" value={formatMinor(ledger.balanceMinor)} subTone={ledger.balanceMinor > 0 ? "warning" : undefined} sub={ledger.balanceMinor > 0 ? "Open invoices below" : "Settled"} />
        <Metric label="Card on file" value={ledger.card.status === "missing" ? "None" : `····${ledger.card.last4}`} sub={ledger.card.status === "missing" ? "Collect at next visit" : `${ledger.card.brand} · ${ledger.card.status === "expiring" ? "expiring soon" : "ok"}`} subTone={ledger.card.status === "ok" ? undefined : "warning"} />
        <Metric label="Invoices" value={ledger.invoices.length} sub="All time (demo ledger)" />
        <Metric label="Memberships" value={memberships.length} sub={memberships[0]?.status === "past_due" ? "Past due — retrying" : memberships[0] ? "Active" : "None"} subTone={memberships[0]?.status === "past_due" ? "critical" : undefined} href="/billing?tab=subscriptions" />
      </div>

      <div className="flex items-center gap-2">
        <BtnLink variant="primary" href={`/billing?tab=checkout&patient=${patientId}`}>
          <CreditCard size={13} aria-hidden /> New checkout
        </BtnLink>
        <BtnLink href="/billing">Practice billing</BtnLink>
        <span className="ml-auto text-[11px] font-semibold text-subtle">
          Stripe test-mode UI — no payment submitted
        </span>
      </div>

      <TableWrap>
        <thead>
          <tr>
            <TH>Invoice</TH>
            <TH>Date</TH>
            <TH>Lines</TH>
            <TH className="text-right">Total</TH>
            <TH className="text-right">Paid</TH>
            <TH>Status</TH>
            <TH aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {ledger.invoices.map((inv) => {
            const paid = inv.payments.reduce((n, p) => n + p.amountMinor, 0);
            const open = expanded === inv.id;
            return (
              <>
                <tr key={inv.id}>
                  <TD className="font-semibold text-ink">#{inv.number}{inv.sessionCreated ? " · this session" : ""}</TD>
                  <TD>{inv.atLabel}</TD>
                  <TD className="max-w-[280px] truncate">{inv.lines.map((l) => l.label).join(" · ")}</TD>
                  <TD className="text-right tabular-nums">{formatMinor(inv.totalMinor)}</TD>
                  <TD className="text-right tabular-nums">{formatMinor(paid)}</TD>
                  <TD><Pill tone={STATUS_TONE[inv.status]}>{inv.status}</Pill></TD>
                  <TD>
                    <Btn size="sm" variant="ghost" onClick={() => setExpanded(open ? null : inv.id)} aria-expanded={open}>
                      {open ? "Hide" : "Details"}
                    </Btn>
                  </TD>
                </tr>
                {open && (
                  <tr key={`${inv.id}-detail`}>
                    <TD colSpan={7} className="bg-sunken">
                      <div className="grid grid-cols-1 gap-3 py-1 lg:grid-cols-2">
                        <div>
                          <p className="m-0 mb-1 text-[11px] font-bold tracking-[0.05em] text-faint uppercase">Lines</p>
                          {inv.lines.map((l) => (
                            <p key={l.id} className="m-0 flex justify-between py-[2px] text-[12px]">
                              <span>{l.label} × {l.qty}</span>
                              <span className="tabular-nums">{formatMinor(l.totalMinor)}</span>
                            </p>
                          ))}
                          <p className="m-0 flex justify-between border-t border-line pt-1 text-[12px]">
                            <span>Subtotal / discount / tax</span>
                            <span className="tabular-nums">{formatMinor(inv.subtotalMinor)} / −{formatMinor(inv.discountMinor)} / {formatMinor(inv.taxMinor)}</span>
                          </p>
                        </div>
                        <div>
                          <p className="m-0 mb-1 text-[11px] font-bold tracking-[0.05em] text-faint uppercase">Payments · staff {inv.staff}</p>
                          {inv.payments.length === 0 && <p className="m-0 text-[12px] text-faint">No payments yet.</p>}
                          {inv.payments.map((p) => (
                            <p key={p.id} className="m-0 flex items-center justify-between gap-2 py-[2px] text-[12px]">
                              <span>{p.method === "card-test" ? "Card (test)" : p.method} · {p.atLabel} · {p.staff}</span>
                              <span className="flex items-center gap-2 tabular-nums">
                                {formatMinor(p.amountMinor)}
                                {p.refundedMinor ? <Pill tone="critical">refunded</Pill> : inv.sessionCreated ? (
                                  <Btn size="sm" variant="ghost" onClick={() => setRefunding({ invoiceId: inv.id, paymentId: p.id })}>
                                    Refund
                                  </Btn>
                                ) : null}
                              </span>
                            </p>
                          ))}
                          <p className="m-0 mt-1 text-[11px] text-faint">Receipt: generated at checkout (demo) · Location {inv.location}</p>
                        </div>
                      </div>
                    </TD>
                  </tr>
                )}
              </>
            );
          })}
          {ledger.invoices.length === 0 && (
            <tr>
              <TD colSpan={7} className="py-6 text-center text-faint">No invoices for {patientName} yet.</TD>
            </tr>
          )}
        </tbody>
      </TableWrap>

      <DemoNote>
        Demo ledger — seed invoices plus anything checked out this session. Refunds are only
        available on session invoices and never move real money (Stripe test-mode UI — no
        payment submitted).
      </DemoNote>

      <ConfirmDialog
        open={refunding != null}
        title="Refund this payment?"
        body="Records a full refund on the session invoice and in the audit log. Test-mode UI — no real payment is moved."
        confirmLabel="Refund"
        destructive
        onCancel={() => setRefunding(null)}
        onConfirm={() => {
          if (refunding) {
            const r = refundSessionPayment(refunding.invoiceId, refunding.paymentId, `Refund · ${patientName}`);
            announce(r.message);
          }
          setRefunding(null);
        }}
      />
    </div>
  );
}
