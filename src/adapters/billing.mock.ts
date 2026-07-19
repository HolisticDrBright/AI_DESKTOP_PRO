"use client";

/**
 * Billing — Stripe-ORIENTED mock POS + ledger. No card data is collected or
 * stored, no processor is called; every processor-shaped affordance is
 * labeled "Stripe test-mode UI — no payment submitted". Seed invoices are
 * synthetic; checkout writes session invoices so patient ledgers, the
 * global dashboard, and reports update together this session.
 */
import { createSessionStore, newSessionId } from "./session-kv";
import { recordAuditEntry } from "./session-store";
import { testModeFeeMinor } from "@/lib/money";

export type LineKind = "service" | "product" | "program" | "membership" | "credit";
export type PaymentMethod = "card-test" | "cash" | "account-credit" | "external";
export type InvoiceStatus = "draft" | "open" | "partial" | "paid" | "refunded" | "void";

export interface InvoiceLine {
  id: string;
  kind: LineKind;
  refId?: string;
  label: string;
  qty: number;
  unitMinor: number;
  /** Negative lines (credits/discounts) allowed. */
  totalMinor: number;
  taxable?: boolean;
}

export interface InvoicePayment {
  id: string;
  method: PaymentMethod;
  amountMinor: number;
  atLabel: string;
  staff: string;
  refundedMinor?: number;
}

export interface Invoice {
  id: string;
  number: string;
  patientId?: string;
  patientName: string;
  atLabel: string;
  /** Age in days for A/R aging (seed fixture; session invoices = 0). */
  ageDays: number;
  lines: InvoiceLine[];
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  payments: InvoicePayment[];
  status: InvoiceStatus;
  staff: string;
  location: string;
  appointmentId?: string;
  sessionCreated?: boolean;
}

export interface ServiceItem {
  id: string;
  label: string;
  priceMinor: number;
  durationMin: number;
  taxable: boolean;
}

/** Bookable services (mirror the calendar's appointment types). */
export const SERVICES: ServiceItem[] = [
  { id: "svc-initial", label: "Initial consult (60 min)", priceMinor: 32500, durationMin: 60, taxable: false },
  { id: "svc-followup", label: "Follow-up visit (30 min)", priceMinor: 17500, durationMin: 30, taxable: false },
  { id: "svc-lab-review", label: "Lab review (30 min)", priceMinor: 15000, durationMin: 30, taxable: false },
  { id: "svc-supplement", label: "Supplement consult (45 min)", priceMinor: 12500, durationMin: 45, taxable: false },
  { id: "svc-telehealth", label: "Telehealth visit (30 min)", priceMinor: 16000, durationMin: 30, taxable: false },
  { id: "svc-group", label: "Group session seat", priceMinor: 4500, durationMin: 60, taxable: false },
];

export const APPOINTMENT_TYPE_SERVICE: Record<string, string> = {
  initial: "svc-initial",
  "follow-up": "svc-followup",
  "lab-review": "svc-lab-review",
  supplement: "svc-supplement",
  telehealth: "svc-telehealth",
  group: "svc-group",
};

export interface CardOnFile {
  brand: string;
  last4: string;
  status: "ok" | "expiring" | "missing";
}

const CARDS: Record<string, CardOnFile> = {
  "p-78435": { brand: "Visa (test)", last4: "4242", status: "ok" },
  "p-59318": { brand: "Mastercard (test)", last4: "4444", status: "expiring" },
  "p-64201": { brand: "—", last4: "", status: "missing" },
};

export function cardOnFile(patientId?: string): CardOnFile {
  return (patientId && CARDS[patientId]) || { brand: "—", last4: "", status: "missing" };
}

export interface Membership {
  id: string;
  patientId: string;
  patientName: string;
  name: string;
  priceMinor: number;
  interval: "month";
  status: "active" | "past_due" | "cancelled";
  startedLabel: string;
  nextChargeLabel: string;
}

export const MEMBERSHIPS: Membership[] = [
  { id: "mem-1", patientId: "p-78435", patientName: "Alexandra Morgan", name: "Longevity Membership", priceMinor: 9900, interval: "month", status: "active", startedLabel: "Mar 2", nextChargeLabel: "Aug 2" },
  { id: "mem-2", patientId: "p-64201", patientName: "Michael Johnson", name: "Longevity Membership", priceMinor: 9900, interval: "month", status: "past_due", startedLabel: "Jan 14", nextChargeLabel: "Retry Jul 21" },
  { id: "mem-3", patientId: "p-66473", patientName: "Dana Whitfield", name: "Metabolic Reset Program (plan)", priceMinor: 24900, interval: "month", status: "active", startedLabel: "Jun 1", nextChargeLabel: "Aug 1" },
];

export interface Payout {
  id: string;
  dateLabel: string;
  amountMinor: number;
  feeMinor: number;
  status: "paid (test)" | "in transit (test)";
}

export const PAYOUTS: Payout[] = [
  { id: "po-1", dateLabel: "Jul 15", amountMinor: 412350, feeMinor: 12480, status: "paid (test)" },
  { id: "po-2", dateLabel: "Jul 8", amountMinor: 386900, feeMinor: 11720, status: "paid (test)" },
  { id: "po-3", dateLabel: "Jul 1", amountMinor: 441200, feeMinor: 13350, status: "paid (test)" },
  { id: "po-4", dateLabel: "Jul 18", amountMinor: 128750, feeMinor: 3890, status: "in transit (test)" },
];

const L = (
  kind: LineKind,
  label: string,
  qty: number,
  unitMinor: number,
  extra?: Partial<InvoiceLine>,
): InvoiceLine => ({
  id: newSessionId(),
  kind,
  label,
  qty,
  unitMinor,
  totalMinor: Math.round(qty * unitMinor),
  ...extra,
});

const pay = (
  method: PaymentMethod,
  amountMinor: number,
  atLabel: string,
  staff = "Front desk",
  refundedMinor?: number,
): InvoicePayment => ({ id: newSessionId(), method, amountMinor, atLabel, staff, refundedMinor });

function inv(
  number: string,
  patientId: string | undefined,
  patientName: string,
  atLabel: string,
  ageDays: number,
  lines: InvoiceLine[],
  payments: InvoicePayment[],
  status: InvoiceStatus,
  opts?: Partial<Invoice>,
): Invoice {
  const subtotal = lines.reduce((n, l) => n + (l.totalMinor > 0 ? l.totalMinor : 0), 0);
  const discount = -lines.reduce((n, l) => n + (l.totalMinor < 0 ? l.totalMinor : 0), 0);
  const tax = Math.round(lines.filter((l) => l.taxable).reduce((n, l) => n + l.totalMinor, 0) * 0.08);
  return {
    id: `inv-${number}`,
    number,
    patientId,
    patientName,
    atLabel,
    ageDays,
    lines,
    subtotalMinor: subtotal,
    discountMinor: discount,
    taxMinor: tax,
    totalMinor: subtotal - discount + tax,
    payments,
    status,
    staff: opts?.staff ?? "Front desk",
    location: opts?.location ?? "Main Studio",
    appointmentId: opts?.appointmentId,
  };
}

/** Seed ledger — synthetic history across the roster. */
export const SEED_INVOICES: Invoice[] = [
  inv("1058", "p-78435", "Alexandra Morgan", "Jul 16", 3,
    [L("service", "Follow-up visit (30 min)", 1, 17500), L("product", "Magnesium Glycinate 120 ct", 1, 3400, { taxable: true })],
    [pay("card-test", 21172, "Jul 16", "Dr. Sarah Mitchell")], "paid"),
  inv("1057", "p-59318", "Priya Sharma", "Jul 15", 4,
    [L("service", "Lab review (30 min)", 1, 15000)],
    [], "open"),
  inv("1056", "p-64201", "Michael Johnson", "Jul 12", 7,
    [L("service", "Initial consult (60 min)", 1, 32500), L("credit", "New-patient credit", 1, -5000)],
    [pay("card-test", 15000, "Jul 12")], "partial"),
  inv("1052", "p-71126", "Jessica Parker", "Jul 8", 11,
    [L("service", "Telehealth visit (30 min)", 1, 16000)],
    [pay("card-test", 16000, "Jul 8")], "paid"),
  inv("1049", "p-52984", "Marcus Webb", "Jul 2", 17,
    [L("product", "Omega-3 Triglyceride 90 ct", 2, 4200, { taxable: true }), L("service", "Supplement consult (45 min)", 1, 12500)],
    [pay("cash", 21572, "Jul 2")], "paid"),
  inv("1047", "p-66473", "Dana Whitfield", "Jun 28", 21,
    [L("program", "Metabolic Reset — 12-week program", 1, 74900)],
    [pay("card-test", 74900, "Jun 28")], "paid"),
  inv("1044", "p-64201", "Michael Johnson", "Jun 20", 29,
    [L("service", "Follow-up visit (30 min)", 1, 17500)],
    [], "open"),
  inv("1041", "p-78435", "Alexandra Morgan", "Jun 12", 37,
    [L("service", "Lab review (30 min)", 1, 15000), L("product", "Vitamin D3+K2 drops", 1, 2800, { taxable: true })],
    [pay("card-test", 18024, "Jun 12")], "paid"),
  inv("1038", "p-59318", "Priya Sharma", "Jun 3", 46,
    [L("service", "Initial consult (60 min)", 1, 32500)],
    [pay("card-test", 32500, "Jun 3", "Front desk", 15000)], "refunded"),
  inv("1033", "p-71126", "Jessica Parker", "May 22", 58,
    [L("service", "Follow-up visit (30 min)", 1, 17500)],
    [], "open"),
  inv("1029", "p-52984", "Marcus Webb", "May 12", 68,
    [L("membership", "Longevity Membership — May", 1, 9900)],
    [pay("card-test", 9900, "May 12")], "paid"),
  inv("1024", "p-66473", "Dana Whitfield", "Apr 30", 80,
    [L("service", "Group session seat", 1, 4500)],
    [], "open"),
];

interface BillingSessionState {
  invoices: Invoice[];
}

const store = createSessionStore<BillingSessionState>("aidp:demo:billing", { invoices: [] });

export function useSessionInvoices(): Invoice[] {
  return store.use().invoices;
}

export function listInvoices(state?: BillingSessionState): Invoice[] {
  const s = state ?? store.get();
  return [...s.invoices, ...SEED_INVOICES];
}

export function getInvoice(id: string): Invoice | undefined {
  return listInvoices().find((i) => i.id === id || i.number === id);
}

export interface CheckoutInput {
  patientId?: string;
  patientName: string;
  appointmentId?: string;
  lines: Omit<InvoiceLine, "id" | "totalMinor">[];
  discountMinor: number;
  creditAppliedMinor: number;
  payments: { method: PaymentMethod; amountMinor: number }[];
  staff: string;
  location?: string;
}

/** Complete a checkout: builds the invoice + payments, audits, returns it. */
export function completeCheckout(input: CheckoutInput): Invoice {
  const lines: InvoiceLine[] = input.lines.map((l) => ({
    ...l,
    id: newSessionId(),
    totalMinor: Math.round(l.qty * l.unitMinor),
  }));
  const subtotal = lines.reduce((n, l) => n + l.totalMinor, 0);
  const tax = Math.round(
    lines.filter((l) => l.taxable).reduce((n, l) => n + l.totalMinor, 0) * 0.08,
  );
  const discount = input.discountMinor + input.creditAppliedMinor;
  const total = Math.max(0, subtotal - discount + tax);
  const paid = input.payments.reduce((n, p) => n + p.amountMinor, 0);
  // Survives reload: numbering continues from the persisted session ledger.
  const number = String(1081 + store.get().invoices.length);
  const invoice: Invoice = {
    id: `inv-${number}`,
    number,
    patientId: input.patientId,
    patientName: input.patientName,
    atLabel: "Today",
    ageDays: 0,
    lines,
    subtotalMinor: subtotal,
    discountMinor: discount,
    taxMinor: tax,
    totalMinor: total,
    payments: input.payments.map((p) => pay(p.method, p.amountMinor, "Today", input.staff)),
    status: paid >= total ? "paid" : paid > 0 ? "partial" : "open",
    staff: input.staff,
    location: input.location ?? "Main Studio",
    appointmentId: input.appointmentId,
    sessionCreated: true,
  };
  store.update((s) => ({ invoices: [invoice, ...s.invoices] }));
  recordAuditEntry({
    kind: "checkout",
    subjectType: "invoice",
    subjectLabel: `#${number} · ${lines.length} line${lines.length === 1 ? "" : "s"}`,
    patientName: input.patientName,
    reviewed: true,
  });
  return invoice;
}

/** Refund a session invoice's payment (seed invoices stay immutable). */
export function refundSessionPayment(invoiceId: string, paymentId: string, reason: string) {
  let done = false;
  store.update((s) => ({
    invoices: s.invoices.map((i) => {
      if (i.id !== invoiceId) return i;
      done = true;
      return {
        ...i,
        status: "refunded",
        payments: i.payments.map((p) =>
          p.id === paymentId ? { ...p, refundedMinor: p.amountMinor } : p,
        ),
      };
    }),
  }));
  if (done) {
    recordAuditEntry({
      kind: "refund_payment",
      subjectType: "payment",
      subjectLabel: reason || "Refund (test mode)",
      reviewed: true,
    });
  }
  return done
    ? { ok: true, message: "Refund recorded. (Stripe test-mode UI — no payment was moved)" }
    : { ok: false, message: "Only invoices created this session can be refunded in the demo." };
}

/* ------------------------------------------------------------ aggregation */

export interface BillingSummary {
  invoicedMinor: number;
  collectedMinor: number;
  refundedMinor: number;
  feesMinor: number;
  netMinor: number;
  openMinor: number;
  arAging: { bucket: string; amountMinor: number; count: number }[];
  byKind: { kind: LineKind; label: string; amountMinor: number }[];
  byStaff: { staff: string; amountMinor: number }[];
}

export function billingSummary(invoices = listInvoices()): BillingSummary {
  const active = invoices.filter((i) => i.status !== "void" && i.status !== "draft");
  const invoiced = active.reduce((n, i) => n + i.totalMinor, 0);
  const collected = active.reduce(
    (n, i) => n + i.payments.reduce((m, p) => m + p.amountMinor, 0),
    0,
  );
  const refunded = active.reduce(
    (n, i) => n + i.payments.reduce((m, p) => m + (p.refundedMinor ?? 0), 0),
    0,
  );
  const fees = active.reduce(
    (n, i) =>
      n +
      i.payments
        .filter((p) => p.method === "card-test")
        .reduce((m, p) => m + testModeFeeMinor(p.amountMinor), 0),
    0,
  );
  const open = active
    .filter((i) => i.status === "open" || i.status === "partial")
    .reduce((n, i) => n + i.totalMinor - i.payments.reduce((m, p) => m + p.amountMinor, 0), 0);

  const buckets: [string, (d: number) => boolean][] = [
    ["0–30 d", (d) => d <= 30],
    ["31–60 d", (d) => d > 30 && d <= 60],
    ["61–90 d", (d) => d > 60 && d <= 90],
    ["90+ d", (d) => d > 90],
  ];
  const openInvoices = active.filter((i) => i.status === "open" || i.status === "partial");
  const arAging = buckets.map(([bucket, match]) => {
    const rows = openInvoices.filter((i) => match(i.ageDays));
    return {
      bucket,
      count: rows.length,
      amountMinor: rows.reduce(
        (n, i) => n + i.totalMinor - i.payments.reduce((m, p) => m + p.amountMinor, 0),
        0,
      ),
    };
  });

  const kindLabels: Record<LineKind, string> = {
    service: "Services",
    product: "Products & supplements",
    program: "Programs",
    membership: "Memberships",
    credit: "Credits",
  };
  const byKindMap = new Map<LineKind, number>();
  for (const i of active) {
    for (const l of i.lines) {
      if (l.kind === "credit") continue;
      byKindMap.set(l.kind, (byKindMap.get(l.kind) ?? 0) + l.totalMinor);
    }
  }
  const byKind = [...byKindMap.entries()]
    .map(([kind, amountMinor]) => ({ kind, label: kindLabels[kind], amountMinor }))
    .sort((a, b) => b.amountMinor - a.amountMinor);

  const byStaffMap = new Map<string, number>();
  for (const i of active) {
    const paid = i.payments.reduce((m, p) => m + p.amountMinor, 0);
    byStaffMap.set(i.staff, (byStaffMap.get(i.staff) ?? 0) + paid);
  }
  const byStaff = [...byStaffMap.entries()]
    .map(([staff, amountMinor]) => ({ staff, amountMinor }))
    .sort((a, b) => b.amountMinor - a.amountMinor);

  return {
    invoicedMinor: invoiced,
    collectedMinor: collected,
    refundedMinor: refunded,
    feesMinor: fees,
    netMinor: collected - refunded - fees,
    openMinor: open,
    arAging,
    byKind,
    byStaff,
  };
}

/** Patient ledger rollup for the Billing tab + profile header. */
export function patientLedger(patientId: string) {
  const invoices = listInvoices().filter((i) => i.patientId === patientId);
  const balance = invoices
    .filter((i) => i.status === "open" || i.status === "partial")
    .reduce((n, i) => n + i.totalMinor - i.payments.reduce((m, p) => m + p.amountMinor, 0), 0);
  return { invoices, balanceMinor: balance, card: cardOnFile(patientId) };
}
