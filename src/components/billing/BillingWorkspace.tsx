"use client";

import { useEffect, useState } from "react";
import { CreditCard, Minus, Plus, Printer, ShoppingCart, Trash2 } from "lucide-react";
import {
  billingSummary,
  cardOnFile,
  completeCheckout,
  listInvoices,
  MEMBERSHIPS,
  PAYOUTS,
  SERVICES,
  refundSessionPayment,
  useSessionInvoices,
  type Invoice,
  type LineKind,
  type PaymentMethod,
} from "@/adapters/billing.mock";
import { api } from "@/adapters";
import { listPatients } from "@/adapters/patients.mock";
import { listPrograms } from "@/adapters/programs-studio.mock";
import { linkCheckoutInvoice } from "@/adapters/appointments.session";
import { adjustInventory } from "@/adapters/session-store";
import type { InventoryProduct } from "@/adapters/inventory.mock";
import { useFeedback } from "@/lib/feedback";
import { formatMinor, parseToMinor, testModeFeeMinor } from "@/lib/money";
import { cn } from "@/lib/cn";
import { Card, CardTitle } from "@/components/ui/bits";
import { Btn } from "@/components/ui/Btn";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field, Select, TextInput } from "@/components/ui/Field";
import { Metric } from "@/components/ui/Metric";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pill, Tag } from "@/components/ui/Pill";
import { SegTabs } from "@/components/ui/SegTabs";
import { TableWrap, TD, TH } from "@/components/ui/Table";
import { DemoNote } from "@/components/ui/DemoNote";

const TEST_MODE_LABEL = "Stripe test-mode UI — no payment submitted";

const INVOICE_TONE: Record<Invoice["status"], "positive" | "warning" | "critical" | "slate"> = {
  paid: "positive",
  partial: "warning",
  open: "warning",
  refunded: "critical",
  draft: "slate",
  void: "slate",
};

/* ----------------------------------------------------------------- overview */

function Overview() {
  useSessionInvoices();
  const s = billingSummary();
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <Metric label="Invoiced" value={formatMinor(s.invoicedMinor)} sub="All time (demo)" />
        <Metric label="Collected" value={formatMinor(s.collectedMinor)} sub="All methods" />
        <Metric label="Refunded" value={formatMinor(s.refundedMinor)} subTone={s.refundedMinor ? "critical" : undefined} sub="Test-mode refunds" />
        <Metric label="Fees (test)" value={formatMinor(s.feesMinor)} sub="2.9% + 30¢ card math" />
        <Metric label="Net" value={formatMinor(s.netMinor)} sub="Collected − refunds − fees" />
        <Metric label="Outstanding" value={formatMinor(s.openMinor)} subTone={s.openMinor ? "warning" : undefined} sub="Open + partial invoices" />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="px-4 py-[14px]">
          <CardTitle className="mb-2">A/R aging</CardTitle>
          {s.arAging.map((b) => (
            <div key={b.bucket} className="flex items-center justify-between border-b border-hairline py-[6px] text-[12.5px] last:border-b-0">
              <span className="text-body">{b.bucket}</span>
              <span className="text-subtle">{b.count} inv</span>
              <span className="font-semibold text-ink tabular-nums">{formatMinor(b.amountMinor)}</span>
            </div>
          ))}
        </Card>
        <Card className="px-4 py-[14px]">
          <CardTitle className="mb-2">Sales by category</CardTitle>
          {s.byKind.map((k) => (
            <div key={k.kind} className="flex items-center justify-between border-b border-hairline py-[6px] text-[12.5px] last:border-b-0">
              <span className="text-body">{k.label}</span>
              <span className="font-semibold text-ink tabular-nums">{formatMinor(k.amountMinor)}</span>
            </div>
          ))}
        </Card>
        <Card className="px-4 py-[14px]">
          <CardTitle className="mb-2">Collected by staff</CardTitle>
          {s.byStaff.map((r) => (
            <div key={r.staff} className="flex items-center justify-between border-b border-hairline py-[6px] text-[12.5px] last:border-b-0">
              <span className="text-body">{r.staff}</span>
              <span className="font-semibold text-ink tabular-nums">{formatMinor(r.amountMinor)}</span>
            </div>
          ))}
        </Card>
      </div>
      <DemoNote>
        Demo ledger — seed invoices plus this session&apos;s checkouts. Reconciliation, payouts,
        and fees use synthetic test-mode math. {TEST_MODE_LABEL}.
      </DemoNote>
    </div>
  );
}

/* ----------------------------------------------------------------- checkout */

interface CartLine {
  key: string;
  kind: LineKind;
  refId?: string;
  label: string;
  qty: number;
  unitMinor: number;
  taxable?: boolean;
  stock?: number;
}

function Checkout({
  initialPatientId,
  apptId,
  initialServiceId,
}: {
  initialPatientId?: string;
  apptId?: string;
  initialServiceId?: string;
}) {
  const { announce } = useFeedback();
  const patients = listPatients();
  const [patientId, setPatientId] = useState(initialPatientId ?? patients[0]?.id ?? "");
  const patient = patients.find((p) => p.id === patientId);
  const card = cardOnFile(patientId);
  const [products, setProducts] = useState<InventoryProduct[]>([]);
  const programs = listPrograms().filter((p) => p.status === "published");
  const [lines, setLines] = useState<CartLine[]>(() => {
    const svc = SERVICES.find((s) => s.id === initialServiceId);
    return svc
      ? [{ key: svc.id, kind: "service", refId: svc.id, label: svc.label, qty: 1, unitMinor: svc.priceMinor, taxable: svc.taxable }]
      : [];
  });
  const [discountStr, setDiscountStr] = useState("");
  const [creditStr, setCreditStr] = useState("");
  const [staff, setStaff] = useState("Front desk");
  const [split, setSplit] = useState(false);
  const [cashStr, setCashStr] = useState("");
  const [receipt, setReceipt] = useState<Invoice | null>(null);
  const [confirmPay, setConfirmPay] = useState(false);

  useEffect(() => {
    let alive = true;
    api.inventory.listProducts().then((p) => alive && setProducts(p));
    return () => {
      alive = false;
    };
  }, []);

  const addLine = (l: Omit<CartLine, "key">) => {
    setLines((prev) => {
      const existing = prev.find((x) => x.kind === l.kind && x.refId === l.refId);
      if (existing) {
        return prev.map((x) => (x === existing ? { ...x, qty: x.qty + 1 } : x));
      }
      return [...prev, { ...l, key: `${l.kind}-${l.refId}-${Date.now()}` }];
    });
  };

  const subtotal = lines.reduce((n, l) => n + l.qty * l.unitMinor, 0);
  const tax = Math.round(lines.filter((l) => l.taxable).reduce((n, l) => n + l.qty * l.unitMinor, 0) * 0.08);
  const discount = parseToMinor(discountStr) ?? 0;
  const credit = parseToMinor(creditStr) ?? 0;
  const total = Math.max(0, subtotal - discount - credit + tax);
  const cash = split ? Math.min(parseToMinor(cashStr) ?? 0, total) : 0;
  const cardAmount = total - cash;
  const fee = testModeFeeMinor(cardAmount);

  const complete = () => {
    for (const l of lines) {
      if (l.kind === "product" && l.refId) adjustInventory(l.refId, -l.qty);
    }
    const payments: { method: PaymentMethod; amountMinor: number }[] = [];
    if (cash > 0) payments.push({ method: "cash", amountMinor: cash });
    if (cardAmount > 0) payments.push({ method: "card-test", amountMinor: cardAmount });
    const invoice = completeCheckout({
      patientId: patient?.id,
      patientName: patient?.name ?? "Walk-in",
      appointmentId: apptId,
      lines: lines.map((l) => ({ kind: l.kind, refId: l.refId, label: l.label, qty: l.qty, unitMinor: l.unitMinor, taxable: l.taxable })),
      discountMinor: discount,
      creditAppliedMinor: credit,
      payments,
      staff,
    });
    if (apptId) linkCheckoutInvoice(apptId, invoice.id);
    setReceipt(invoice);
    setLines([]);
    setDiscountStr("");
    setCreditStr("");
    setCashStr("");
    announce(`Invoice #${invoice.number} recorded — ${TEST_MODE_LABEL}.`);
  };

  const catalogBtn =
    "flex w-full cursor-pointer items-center gap-2 rounded-lg border border-line bg-card px-3 py-[7px] text-left text-[12px] hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action";

  return (
    <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="flex min-w-0 flex-col gap-4">
        <Card className="px-4 py-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Patient" className="min-w-[220px]">
              <Select value={patientId} onChange={(e) => setPatientId(e.target.value)} aria-label="Checkout patient">
                {patients.map((p) => (
                  <option key={p.id} value={p.id}>{p.name} · {p.mrn}</option>
                ))}
              </Select>
            </Field>
            <Field label="Staff attribution">
              <Select value={staff} onChange={(e) => setStaff(e.target.value)}>
                <option>Front desk</option>
                <option>Dr. Sarah Mitchell</option>
                <option>Dr. James Okafor</option>
                <option>Rachel Nguyen, RD</option>
              </Select>
            </Field>
            <div className="ml-auto text-right text-[11.5px] text-subtle">
              Card on file:{" "}
              {card.status === "missing" ? (
                <span className="font-semibold text-warning-deep">none</span>
              ) : (
                <span className="font-semibold text-ink">{card.brand} ····{card.last4}</span>
              )}
              {apptId && <span className="block">Linked to appointment</span>}
            </div>
          </div>
        </Card>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card className="px-3 py-[10px]">
            <CardTitle className="mb-2">Services</CardTitle>
            <div className="flex flex-col gap-[6px]">
              {SERVICES.map((s) => (
                <button key={s.id} className={catalogBtn} onClick={() => addLine({ kind: "service", refId: s.id, label: s.label, qty: 1, unitMinor: s.priceMinor, taxable: s.taxable })}>
                  <span className="min-w-0 flex-1 truncate">{s.label}</span>
                  <span className="font-semibold tabular-nums">{formatMinor(s.priceMinor)}</span>
                </button>
              ))}
            </div>
          </Card>
          <Card className="px-3 py-[10px]">
            <CardTitle className="mb-2">Supplements & products</CardTitle>
            <div className="flex max-h-[300px] flex-col gap-[6px] overflow-y-auto">
              {products.map((p) => (
                <button
                  key={p.id}
                  className={cn(catalogBtn, p.stock === 0 && "cursor-not-allowed opacity-45")}
                  disabled={p.stock === 0}
                  onClick={() => addLine({ kind: "product", refId: p.id, label: `${p.name} (${p.unitLabel})`, qty: 1, unitMinor: p.priceMinor, taxable: true, stock: p.stock })}
                >
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  <span className="text-[10.5px] text-faint">{p.stock === 0 ? "out" : `${p.stock} in stock`}</span>
                  <span className="font-semibold tabular-nums">{formatMinor(p.priceMinor)}</span>
                </button>
              ))}
            </div>
          </Card>
          <Card className="px-3 py-[10px]">
            <CardTitle className="mb-2">Programs & memberships</CardTitle>
            <div className="flex flex-col gap-[6px]">
              {programs.map((pr) =>
                pr.offers.map((o) => (
                  <button key={o.id} className={catalogBtn} onClick={() => addLine({ kind: o.kind === "subscription" ? "membership" : "program", refId: pr.id, label: `${pr.title} — ${o.label}`, qty: 1, unitMinor: o.amountMinor })}>
                    <span className="min-w-0 flex-1 truncate">{pr.title} <Tag>{o.kind}</Tag></span>
                    <span className="font-semibold tabular-nums">{formatMinor(o.amountMinor)}</span>
                  </button>
                )),
              )}
            </div>
          </Card>
        </div>
      </div>

      <Card className="px-4 py-[14px]">
        <div className="mb-2 flex items-center gap-2">
          <ShoppingCart size={14} className="text-action" aria-hidden />
          <CardTitle className="flex-1">Cart</CardTitle>
          <span className="text-[10.5px] font-semibold text-subtle">{TEST_MODE_LABEL}</span>
        </div>
        {lines.length === 0 ? (
          <p className="m-0 py-4 text-center text-[12px] text-faint">Add services, products, or programs.</p>
        ) : (
          <div className="flex flex-col gap-[6px]">
            {lines.map((l) => (
              <div key={l.key} className="flex items-center gap-2 rounded-lg border border-hairline bg-sunken px-2 py-[6px]">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-medium text-ink">{l.label}</span>
                  <span className="block text-[10.5px] text-faint">{formatMinor(l.unitMinor)} each{l.taxable ? " · taxable" : ""}</span>
                </span>
                <Btn size="sm" variant="ghost" aria-label={`Decrease ${l.label}`} onClick={() => setLines((prev) => prev.map((x) => (x.key === l.key ? { ...x, qty: Math.max(1, x.qty - 1) } : x)))}>
                  <Minus size={11} aria-hidden />
                </Btn>
                <span className="w-5 text-center text-[12px] font-semibold tabular-nums">{l.qty}</span>
                <Btn
                  size="sm"
                  variant="ghost"
                  aria-label={`Increase ${l.label}`}
                  disabled={l.kind === "product" && l.stock != null && l.qty >= l.stock}
                  onClick={() => setLines((prev) => prev.map((x) => (x.key === l.key ? { ...x, qty: x.qty + 1 } : x)))}
                >
                  <Plus size={11} aria-hidden />
                </Btn>
                <span className="w-[64px] text-right text-[12px] font-semibold tabular-nums">{formatMinor(l.qty * l.unitMinor)}</span>
                <Btn size="sm" variant="ghost" aria-label={`Remove ${l.label}`} onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}>
                  <Trash2 size={11} aria-hidden />
                </Btn>
              </div>
            ))}
          </div>
        )}

        <div className="mt-3 grid grid-cols-2 gap-2">
          <Field label="Discount ($)"><TextInput value={discountStr} onChange={(e) => setDiscountStr(e.target.value)} placeholder="0.00" inputMode="decimal" /></Field>
          <Field label="Account credit ($)"><TextInput value={creditStr} onChange={(e) => setCreditStr(e.target.value)} placeholder="0.00" inputMode="decimal" /></Field>
        </div>

        <div className="mt-3 border-t border-line pt-2 text-[12.5px]">
          <p className="m-0 flex justify-between py-[2px]"><span>Subtotal</span><span className="tabular-nums">{formatMinor(subtotal)}</span></p>
          <p className="m-0 flex justify-between py-[2px] text-subtle"><span>Discount + credit</span><span className="tabular-nums">−{formatMinor(discount + credit)}</span></p>
          <p className="m-0 flex justify-between py-[2px]"><span>Tax (8%)</span><span className="tabular-nums">{formatMinor(tax)}</span></p>
          <p className="m-0 flex justify-between py-[3px] text-[14px] font-bold"><span>Total</span><span className="tabular-nums">{formatMinor(total)}</span></p>
        </div>

        <label className="mt-2 flex cursor-pointer items-center gap-[7px] text-[12px] font-medium text-body-2">
          <input type="checkbox" checked={split} onChange={(e) => setSplit(e.target.checked)} />
          Split payment (cash + card)
        </label>
        {split && (
          <Field label="Cash portion ($)" className="mt-2">
            <TextInput value={cashStr} onChange={(e) => setCashStr(e.target.value)} placeholder="0.00" inputMode="decimal" />
          </Field>
        )}
        <p className="m-0 mt-2 text-[11px] text-subtle">
          {split && cash > 0 ? `Cash ${formatMinor(cash)} + ` : ""}Card (test) {formatMinor(cardAmount)} · est. fee {formatMinor(fee)}
        </p>

        <Btn variant="primary" className="mt-3 w-full" disabled={lines.length === 0 || total === 0} onClick={() => setConfirmPay(true)}>
          <CreditCard size={13} aria-hidden /> Take payment (test mode)
        </Btn>
      </Card>

      <ConfirmDialog
        open={confirmPay}
        title={`Charge ${formatMinor(total)} for ${patient?.name ?? "Walk-in"}?`}
        body={`Records the invoice and payment in the demo ledger and decrements product stock. ${TEST_MODE_LABEL}.`}
        confirmLabel="Record payment"
        onCancel={() => setConfirmPay(false)}
        onConfirm={() => {
          setConfirmPay(false);
          complete();
        }}
      />

      {receipt && (
        <div className="fixed inset-0 z-[150] flex items-center justify-center bg-[rgba(24,42,61,0.32)] px-4" onClick={() => setReceipt(null)}>
          <div role="dialog" aria-modal="true" aria-label="Receipt" onClick={(e) => e.stopPropagation()} className="w-[380px] max-w-full rounded-2xl border border-line bg-card p-5 shadow-[0_24px_64px_rgba(24,42,61,0.22)]">
            <div className="mb-2 flex items-center gap-2">
              <Printer size={15} className="text-action" aria-hidden />
              <h2 className="m-0 flex-1 text-[15px] font-bold">Receipt · Invoice #{receipt.number}</h2>
              <Pill tone={INVOICE_TONE[receipt.status]}>{receipt.status}</Pill>
            </div>
            <p className="m-0 text-[12px] text-subtle">{receipt.patientName} · Today · {receipt.staff}</p>
            <div className="mt-2 border-t border-hairline pt-2 text-[12.5px]">
              {receipt.lines.map((l) => (
                <p key={l.id} className="m-0 flex justify-between py-[2px]"><span>{l.label} × {l.qty}</span><span className="tabular-nums">{formatMinor(l.totalMinor)}</span></p>
              ))}
              <p className="m-0 flex justify-between border-t border-hairline py-[3px] font-bold"><span>Total</span><span className="tabular-nums">{formatMinor(receipt.totalMinor)}</span></p>
              {receipt.payments.map((p) => (
                <p key={p.id} className="m-0 flex justify-between py-[2px] text-subtle"><span>{p.method === "card-test" ? "Card (test)" : p.method}</span><span className="tabular-nums">{formatMinor(p.amountMinor)}</span></p>
              ))}
            </div>
            <p className="mt-2 mb-0 text-center text-[10.5px] text-faint">{TEST_MODE_LABEL}. Demo receipt — this session only.</p>
            <Btn className="mt-3 w-full" onClick={() => setReceipt(null)}>Done</Btn>
          </div>
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- invoices */

function Invoices() {
  useSessionInvoices();
  const { announce } = useFeedback();
  const [refunding, setRefunding] = useState<{ invoiceId: string; paymentId: string } | null>(null);
  const invoices = listInvoices();
  return (
    <>
      <TableWrap>
        <thead>
          <tr>
            <TH>Invoice</TH><TH>Patient</TH><TH>Date</TH><TH>Staff</TH><TH>Location</TH>
            <TH className="text-right">Total</TH><TH>Status</TH><TH aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {invoices.map((i) => (
            <tr key={i.id}>
              <TD className="font-semibold text-ink">#{i.number}{i.sessionCreated && <Tag className="ml-1">session</Tag>}</TD>
              <TD>{i.patientName}</TD>
              <TD>{i.atLabel}</TD>
              <TD>{i.staff}</TD>
              <TD>{i.location}</TD>
              <TD className="text-right tabular-nums">{formatMinor(i.totalMinor)}</TD>
              <TD><Pill tone={INVOICE_TONE[i.status]}>{i.status}</Pill></TD>
              <TD>
                {i.sessionCreated && i.payments[0] && !i.payments[0].refundedMinor && (
                  <Btn size="sm" variant="ghost" onClick={() => setRefunding({ invoiceId: i.id, paymentId: i.payments[0].id })}>
                    Refund
                  </Btn>
                )}
              </TD>
            </tr>
          ))}
        </tbody>
      </TableWrap>
      <ConfirmDialog
        open={refunding != null}
        title="Refund this payment?"
        body={`Full refund recorded on the session invoice and in the audit log. ${TEST_MODE_LABEL}.`}
        confirmLabel="Refund"
        destructive
        onCancel={() => setRefunding(null)}
        onConfirm={() => {
          if (refunding) announce(refundSessionPayment(refunding.invoiceId, refunding.paymentId, "Front-desk refund").message);
          setRefunding(null);
        }}
      />
    </>
  );
}

/* ------------------------------------------------------------ subscriptions */

function Subscriptions() {
  return (
    <TableWrap>
      <thead>
        <tr>
          <TH>Member</TH><TH>Plan</TH><TH className="text-right">Price</TH><TH>Started</TH><TH>Next charge</TH><TH>Status</TH>
        </tr>
      </thead>
      <tbody>
        {MEMBERSHIPS.map((m) => (
          <tr key={m.id}>
            <TD className="font-medium text-ink">{m.patientName}</TD>
            <TD>{m.name}</TD>
            <TD className="text-right tabular-nums">{formatMinor(m.priceMinor)}/mo</TD>
            <TD>{m.startedLabel}</TD>
            <TD>{m.nextChargeLabel}</TD>
            <TD><Pill tone={m.status === "active" ? "positive" : m.status === "past_due" ? "critical" : "slate"}>{m.status.replace("_", " ")}</Pill></TD>
          </tr>
        ))}
      </tbody>
    </TableWrap>
  );
}

/* ---------------------------------------------------------------- payouts */

function Payouts() {
  return (
    <div className="flex flex-col gap-3">
      <TableWrap>
        <thead>
          <tr><TH>Payout</TH><TH>Date</TH><TH className="text-right">Amount</TH><TH className="text-right">Fees</TH><TH>Status</TH></tr>
        </thead>
        <tbody>
          {PAYOUTS.map((p) => (
            <tr key={p.id}>
              <TD className="font-medium text-ink">{p.id.toUpperCase()}</TD>
              <TD>{p.dateLabel}</TD>
              <TD className="text-right tabular-nums">{formatMinor(p.amountMinor)}</TD>
              <TD className="text-right tabular-nums">{formatMinor(p.feeMinor)}</TD>
              <TD><Pill tone={p.status.startsWith("paid") ? "positive" : "navy"}>{p.status}</Pill></TD>
            </tr>
          ))}
        </tbody>
      </TableWrap>
      <DemoNote>Synthetic payout schedule for reconciliation practice. {TEST_MODE_LABEL}.</DemoNote>
    </div>
  );
}

/* ------------------------------------------------------------------- claims */

function Claims() {
  return (
    <Card className="px-5 py-8 text-center">
      <p className="m-0 text-[14px] font-bold text-ink">Insurance claims fold into Billing</p>
      <p className="mx-auto mt-1 mb-0 max-w-[460px] text-[12.5px] leading-[1.55] text-subtle">
        /claims now lands here. Claim preparation and clearinghouse submission need a real
        clearinghouse integration — nothing is simulated to avoid implying claims can be filed.
        Superbill-style invoice exports live under Reports → Billing when needed.
      </p>
    </Card>
  );
}

/* -------------------------------------------------------------------- shell */

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "checkout", label: "Checkout (POS)" },
  { id: "invoices", label: "Invoices" },
  { id: "subscriptions", label: "Subscriptions" },
  { id: "payouts", label: "Payouts & fees" },
  { id: "claims", label: "Claims" },
];

export function BillingWorkspace({
  tab,
  patientId,
  apptId,
  serviceId,
}: {
  tab: string;
  patientId?: string;
  apptId?: string;
  serviceId?: string;
}) {
  const active = TABS.some((t) => t.id === tab) ? tab : "overview";
  return (
    <section data-screen-label="Billing" className="mx-auto max-w-[1560px] px-[22px] pt-[18px] pb-6">
      <PageHeader
        crumb="Business / Billing"
        title="Billing"
        sub={TEST_MODE_LABEL + " — the demo collects no card data and calls no processor."}
      />
      <SegTabs
        basePath="/billing"
        value={active}
        ariaLabel="Billing sections"
        options={TABS}
        preserve={{ patient: patientId, appt: apptId, service: serviceId }}
      />
      {active === "overview" && <Overview />}
      {active === "checkout" && <Checkout initialPatientId={patientId} apptId={apptId} initialServiceId={serviceId} />}
      {active === "invoices" && <Invoices />}
      {active === "subscriptions" && <Subscriptions />}
      {active === "payouts" && <Payouts />}
      {active === "claims" && <Claims />}
    </section>
  );
}
