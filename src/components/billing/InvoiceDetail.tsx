"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/adapters";
import { AdapterError } from "@/adapters/errors";
import type {
  LiveBillingCatalog,
  LiveInvoice,
  LiveInvoiceLineInput,
  LiveInvoiceStatus,
  LiveManualPaymentMethod,
} from "@/adapters/live-types";
import { Card, CardTitle } from "@/components/ui/bits";
import { Btn } from "@/components/ui/Btn";
import { Metric } from "@/components/ui/Metric";
import { TableWrap, TD, TH } from "@/components/ui/Table";
import { Field, Select, TextInput } from "@/components/ui/Field";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
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

function isConflict(e: unknown): boolean {
  return e instanceof AdapterError && e.code === "conflict";
}

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

/** A line being edited. Note there is no tax field — the server prices tax. */
interface DraftLine {
  productId: string;
  quantity: number;
  discountMinor: number;
  discountReason: string;
}

const MANUAL_METHODS: { id: LiveManualPaymentMethod; label: string }[] = [
  { id: "cash", label: "Cash" },
  { id: "check", label: "Check" },
  { id: "bank_transfer", label: "Bank transfer" },
  { id: "external", label: "External terminal" },
];

/**
 * One invoice: checkout while it is a draft, then the payment, credit, and
 * refund surface once it is finalized.
 *
 * The screen asserts nothing about money. Totals, tax, balances, and payment
 * outcomes are always the values the server returned from the last call — the
 * component never adds a line total, computes tax, or marks a card payment
 * paid on its own.
 */
export function InvoiceDetail({ invoiceId }: { invoiceId: string }) {
  const { announce } = useFeedback();
  const [invoice, setInvoice] = useState<LiveInvoice | null>(null);
  const [catalog, setCatalog] = useState<LiveBillingCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);

  const [lines, setLines] = useState<DraftLine[]>([]);
  const [addProductId, setAddProductId] = useState("");
  const [locationId, setLocationId] = useState("");

  const [payMethod, setPayMethod] = useState<LiveManualPaymentMethod>("cash");
  const [payAmount, setPayAmount] = useState("");
  const [payReference, setPayReference] = useState("");
  const [creditAmount, setCreditAmount] = useState("");
  const [refundPaymentId, setRefundPaymentId] = useState("");
  const [refundAmount, setRefundAmount] = useState("");
  const [refundReason, setRefundReason] = useState("");
  const [cardStarted, setCardStarted] = useState<string | null>(null);
  const [voidOpen, setVoidOpen] = useState(false);
  const [confirmVoid, setConfirmVoid] = useState(false);
  const [voidReason, setVoidReason] = useState("");

  /** Adopt a server invoice as the single source of truth for the screen. */
  const adopt = useCallback((next: LiveInvoice) => {
    setInvoice(next);
    setConflict(false);
    setLocationId(next.locationId ?? "");
    setLines(
      next.lines.map((l) => ({
        productId: l.productId ?? "",
        quantity: l.quantity,
        discountMinor: l.discountMinor,
        discountReason: l.discountReason ?? "",
      })),
    );
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [inv, cat] = await Promise.all([
        api.billing.invoice(invoiceId),
        api.inventory.listProducts({ limit: 200 }),
      ]);
      adopt(inv);
      setCatalog(cat);
    } catch (e) {
      setError(errText(e));
    }
  }, [invoiceId, adopt]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Run a mutation that returns the authoritative invoice. */
  const run = useCallback(
    async (fn: () => Promise<LiveInvoice>, message: string) => {
      if (busy) return;
      setBusy(true);
      try {
        adopt(await fn());
        announce(message);
      } catch (e) {
        if (isConflict(e)) {
          setConflict(true);
          announce("This invoice changed elsewhere. Reload before saving again.");
        } else {
          announce(errText(e));
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, adopt, announce],
  );

  if (error && !invoice) return <ClinicalError message={error} onRetry={() => void load()} />;
  if (!invoice) return <ClinicalLoading label="Loading the invoice…" />;

  const isDraft = invoice.status === "draft";
  const canTakeMoney = invoice.status === "open" || invoice.status === "partially_paid";
  const products = catalog?.products ?? [];
  const productById = new Map(products.map((p) => [p.id, p]));

  const saveDraft = () => {
    const payload: LiveInvoiceLineInput[] = lines.map((l) => ({
      productId: l.productId,
      quantity: l.quantity,
      discountMinor: l.discountMinor || undefined,
      discountReason: l.discountReason || null,
    }));
    void run(
      () =>
        api.billing.saveDraft({
          invoiceId,
          expectedVersion: invoice.version,
          locationId: locationId || null,
          lines: payload,
        }),
      "Draft saved.",
    );
  };

  return (
    <div className="flex flex-col gap-4" data-testid="invoice-detail">
      <Card className="p-[14px]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[11.5px] font-semibold text-faint">
              {invoice.patientName ?? "Patient"}
            </div>
            <h2 className="m-0 text-[17px] font-bold" data-testid="invoice-number">
              {invoice.number ?? "Draft invoice"}
            </h2>
            <p className="mt-[3px] mb-0 text-[12.5px] text-subtle">
              <span data-testid="invoice-status">{STATUS_LABEL[invoice.status]}</span>
              {invoice.locationName ? ` · ${invoice.locationName}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {isDraft && (
              <>
                <Btn
                  variant="outline"
                  onClick={saveDraft}
                  disabled={busy}
                  data-testid="invoice-save"
                >
                  Save draft
                </Btn>
                <Btn
                  variant="primary"
                  onClick={() =>
                    void run(
                      () =>
                        api.billing.finalize({
                          invoiceId,
                          expectedVersion: invoice.version,
                        }),
                      "Invoice finalized. Tracked stock is reserved.",
                    )
                  }
                  disabled={busy || lines.length === 0}
                  data-testid="invoice-finalize"
                >
                  Finalize
                </Btn>
              </>
            )}
            {(isDraft || invoice.status === "open") &&
              invoice.paidMinor === 0 &&
              invoice.creditAppliedMinor === 0 && (
                <Btn
                  variant="danger"
                  onClick={() => setVoidOpen(true)}
                  disabled={busy}
                  data-testid="invoice-void"
                >
                  Void
                </Btn>
              )}
          </div>
        </div>

        <div className="mt-[14px] grid grid-cols-2 gap-2 md:grid-cols-5">
          <Metric label="Subtotal" value={formatMinor(invoice.subtotalMinor)} />
          <Metric label="Discount" value={formatMinor(invoice.discountMinor)} />
          <Metric label="Tax" value={formatMinor(invoice.taxMinor)} />
          <Metric label="Total" value={formatMinor(invoice.totalMinor)} />
          <Metric label="Balance" value={formatMinor(invoice.balanceMinor)} />
        </div>

        {conflict && (
          <p
            className="mt-[10px] mb-0 text-[12.5px] font-semibold text-critical"
            data-testid="invoice-conflict"
          >
            This invoice changed in another tab or session. Reload to see the
            latest version before saving again.
          </p>
        )}
      </Card>

      <Card className="p-[14px]">
        <CardTitle>Line items</CardTitle>
        {isDraft ? (
          <ClinicalNote>
            Tax is priced by the server from the organization&rsquo;s configured
            rates — it is not entered here and cannot be overridden from this
            screen. A discount always needs a reason.
          </ClinicalNote>
        ) : (
          <ClinicalNote>
            These lines are the snapshot taken when the invoice was finalized.
            Later catalog edits never rewrite a finalized invoice.
          </ClinicalNote>
        )}

        {isDraft && (
          <div className="mt-[10px] flex flex-wrap items-end gap-2">
            <Field label="Add an item" className="min-w-[240px]">
              <Select
                value={addProductId}
                onChange={(e) => setAddProductId(e.target.value)}
                data-testid="line-product-select"
              >
                <option value="">Choose a product or service…</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {formatMinor(p.amountMinor)}
                  </option>
                ))}
              </Select>
            </Field>
            <Btn
              variant="outline"
              disabled={!addProductId}
              data-testid="line-add"
              onClick={() => {
                if (!addProductId) return;
                setLines((prev) => [
                  ...prev,
                  { productId: addProductId, quantity: 1, discountMinor: 0, discountReason: "" },
                ]);
                setAddProductId("");
              }}
            >
              Add
            </Btn>
            {catalog && catalog.locations.length > 0 && (
              <Field label="Location" className="min-w-[180px]">
                <Select
                  value={locationId}
                  onChange={(e) => setLocationId(e.target.value)}
                  data-testid="invoice-location"
                >
                  <option value="">No location</option>
                  {catalog.locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
        )}

        <TableWrap className="mt-[10px]">
          <thead>
            <tr>
              <TH>Item</TH>
              <TH className="text-right">Qty</TH>
              <TH className="text-right">Unit</TH>
              <TH className="text-right">Discount</TH>
              <TH>Discount reason</TH>
              <TH className="text-right">Tax</TH>
              <TH className="text-right">Amount</TH>
              {isDraft && <TH />}
            </tr>
          </thead>
          <tbody data-testid="invoice-line-rows">
            {isDraft
              ? lines.map((line, i) => {
                  const product = productById.get(line.productId);
                  return (
                    <tr key={`${line.productId}-${i}`}>
                      <TD className="font-medium">{product?.name ?? "—"}</TD>
                      <TD className="text-right">
                        <TextInput
                          type="number"
                          min={1}
                          max={999}
                          value={line.quantity}
                          data-testid={`line-qty-${i}`}
                          className="h-7 w-[70px] text-right"
                          onChange={(e) =>
                            setLines((prev) =>
                              prev.map((l, j) =>
                                j === i
                                  ? { ...l, quantity: Math.max(1, Number(e.target.value) || 1) }
                                  : l,
                              ),
                            )
                          }
                        />
                      </TD>
                      <TD className="text-right tabular-nums text-muted">
                        {product ? formatMinor(product.amountMinor) : "—"}
                      </TD>
                      <TD className="text-right">
                        <TextInput
                          value={line.discountMinor ? formatMinor(line.discountMinor) : ""}
                          placeholder="$0.00"
                          data-testid={`line-discount-${i}`}
                          className="h-7 w-[90px] text-right"
                          onChange={(e) => {
                            const minor = parseToMinor(e.target.value);
                            setLines((prev) =>
                              prev.map((l, j) =>
                                j === i ? { ...l, discountMinor: minor ?? 0 } : l,
                              ),
                            );
                          }}
                        />
                      </TD>
                      <TD>
                        <TextInput
                          value={line.discountReason}
                          placeholder={line.discountMinor ? "Required" : "—"}
                          data-testid={`line-discount-reason-${i}`}
                          className="h-7"
                          onChange={(e) =>
                            setLines((prev) =>
                              prev.map((l, j) =>
                                j === i ? { ...l, discountReason: e.target.value } : l,
                              ),
                            )
                          }
                        />
                      </TD>
                      <TD className="text-right text-[11.5px] text-faint">server</TD>
                      <TD className="text-right text-[11.5px] text-faint">server</TD>
                      <TD className="text-right">
                        <Btn
                          variant="ghost"
                          size="sm"
                          data-testid={`line-remove-${i}`}
                          onClick={() => setLines((prev) => prev.filter((_, j) => j !== i))}
                        >
                          Remove
                        </Btn>
                      </TD>
                    </tr>
                  );
                })
              : invoice.lines.map((l) => (
                  <tr key={l.id}>
                    <TD className="font-medium">{l.name ?? "—"}</TD>
                    <TD className="text-right tabular-nums">{l.quantity}</TD>
                    <TD className="text-right tabular-nums">{formatMinor(l.unitAmountMinor)}</TD>
                    <TD className="text-right tabular-nums">{formatMinor(l.discountMinor)}</TD>
                    <TD className="text-muted">{l.discountReason ?? "—"}</TD>
                    <TD className="text-right tabular-nums">{formatMinor(l.taxMinor)}</TD>
                    <TD className="text-right tabular-nums">{formatMinor(l.amountMinor)}</TD>
                  </tr>
                ))}
          </tbody>
        </TableWrap>
      </Card>

      {canTakeMoney && (
        <Card className="p-[14px]" data-testid="invoice-payment-panel">
          <CardTitle>Take payment</CardTitle>
          <div className="mt-[10px] flex flex-wrap items-end gap-2">
            <Field label="Method" className="min-w-[150px]">
              <Select
                value={payMethod}
                data-testid="payment-method"
                onChange={(e) => setPayMethod(e.target.value as LiveManualPaymentMethod)}
              >
                {MANUAL_METHODS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Amount" className="min-w-[130px]">
              <TextInput
                value={payAmount}
                placeholder={formatMinor(invoice.balanceMinor)}
                data-testid="payment-amount"
                onChange={(e) => setPayAmount(e.target.value)}
              />
            </Field>
            <Field label="Reference" className="min-w-[150px]">
              <TextInput
                value={payReference}
                placeholder="Optional"
                data-testid="payment-reference"
                onChange={(e) => setPayReference(e.target.value)}
              />
            </Field>
            <Btn
              variant="primary"
              disabled={busy}
              data-testid="payment-record"
              onClick={() => {
                const minor = parseToMinor(payAmount) ?? invoice.balanceMinor;
                void run(
                  () =>
                    api.billing.recordPayment({
                      invoiceId,
                      expectedVersion: invoice.version,
                      amountMinor: minor,
                      method: payMethod,
                      reference: payReference || null,
                    }),
                  "Payment recorded.",
                ).then(() => {
                  setPayAmount("");
                  setPayReference("");
                });
              }}
            >
              Record payment
            </Btn>
          </div>

          <div className="mt-[14px] border-t border-hairline pt-[12px]">
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Apply patient credit" className="min-w-[150px]">
                <TextInput
                  value={creditAmount}
                  placeholder="$0.00"
                  data-testid="credit-amount"
                  onChange={(e) => setCreditAmount(e.target.value)}
                />
              </Field>
              <Btn
                variant="outline"
                disabled={busy}
                data-testid="credit-apply"
                onClick={() => {
                  const minor = parseToMinor(creditAmount);
                  if (!minor) {
                    announce("Enter a credit amount to apply.");
                    return;
                  }
                  void run(
                    () =>
                      api.billing.applyCredit({
                        invoiceId,
                        expectedVersion: invoice.version,
                        amountMinor: minor,
                      }),
                    "Credit applied.",
                  ).then(() => setCreditAmount(""));
                }}
              >
                Apply credit
              </Btn>
            </div>
          </div>

          <div className="mt-[14px] border-t border-hairline pt-[12px]">
            <ClinicalNote>
              Card payments run in Stripe TEST MODE. Starting one records a
              pending payment and nothing more — no card is charged, and this
              screen will never show it as paid. Settlement appears only after
              the processor webhook confirms it.
            </ClinicalNote>
            <div className="mt-[10px] flex flex-wrap items-center gap-2">
              <Btn
                variant="outline"
                disabled={busy || invoice.balanceMinor <= 0}
                data-testid="card-start"
                onClick={() => {
                  if (busy) return;
                  setBusy(true);
                  api.billing
                    .startCardPayment({
                      invoiceId,
                      expectedVersion: invoice.version,
                      idempotencyKey: `${invoiceId}:${invoice.version}:${invoice.balanceMinor}`,
                    })
                    .then(async (intent) => {
                      setCardStarted(
                        `Test-mode payment started for ${formatMinor(intent.amountMinor)}. ` +
                          `Awaiting processor settlement — this is not a completed charge.`,
                      );
                      announce("Test-mode card payment started. Not yet settled.");
                      await load();
                    })
                    .catch((e: unknown) => {
                      if (isConflict(e)) setConflict(true);
                      announce(errText(e));
                    })
                    .finally(() => setBusy(false));
                }}
              >
                Start test-mode card payment
              </Btn>
              {cardStarted && (
                <p
                  className="m-0 text-[12.5px] font-medium text-warning-deep"
                  data-testid="card-started-note"
                >
                  {cardStarted}
                </p>
              )}
            </div>
          </div>
        </Card>
      )}

      {invoice.payments.length > 0 && (
        <Card className="p-[14px]">
          <CardTitle>Payments &amp; refunds</CardTitle>
          <TableWrap className="mt-[10px]">
            <thead>
              <tr>
                <TH>Method</TH>
                <TH>Status</TH>
                <TH className="text-right">Amount</TH>
                <TH className="text-right">Refunded</TH>
              </tr>
            </thead>
            <tbody data-testid="invoice-payment-rows">
              {invoice.payments.map((p) => {
                const refunded = p.refunds.reduce((sum, r) => sum + r.amountMinor, 0);
                return (
                  <tr key={p.id}>
                    <TD className="font-medium">
                      {p.method === "card_test" ? "Card (test mode)" : p.method.replace("_", " ")}
                    </TD>
                    <TD>
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-[7px] py-px text-[11px] font-semibold",
                          p.status === "succeeded"
                            ? "bg-positive-tint text-positive-deep"
                            : p.status === "pending"
                              ? "bg-warning-tint text-warning-deep"
                              : "bg-critical-tint text-critical",
                        )}
                        data-testid={`payment-status-${p.id}`}
                      >
                        {p.status === "pending" ? "awaiting settlement" : p.status}
                      </span>
                    </TD>
                    <TD className="text-right tabular-nums">{formatMinor(p.amountMinor)}</TD>
                    <TD className="text-right tabular-nums">
                      {refunded ? formatMinor(refunded) : "—"}
                    </TD>
                  </tr>
                );
              })}
            </tbody>
          </TableWrap>

          {invoice.payments.some((p) => p.status === "succeeded" && p.method !== "card_test") && (
            <div className="mt-[14px] border-t border-hairline pt-[12px]">
              <ClinicalNote>
                A refund returns money. It does not put stock back: if the
                patient returned goods, record that separately in Settings →
                Catalog so the condition is on the record.
              </ClinicalNote>
              <div className="mt-[10px] flex flex-wrap items-end gap-2">
                <Field label="Payment" className="min-w-[190px]">
                  <Select
                    value={refundPaymentId}
                    data-testid="refund-payment"
                    onChange={(e) => setRefundPaymentId(e.target.value)}
                  >
                    <option value="">Choose a payment…</option>
                    {invoice.payments
                      .filter((p) => p.status === "succeeded" && p.method !== "card_test")
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.method.replace("_", " ")} — {formatMinor(p.amountMinor)}
                        </option>
                      ))}
                  </Select>
                </Field>
                <Field label="Amount" className="min-w-[130px]">
                  <TextInput
                    value={refundAmount}
                    placeholder="$0.00"
                    data-testid="refund-amount"
                    onChange={(e) => setRefundAmount(e.target.value)}
                  />
                </Field>
                <Field label="Reason" className="min-w-[190px]">
                  <TextInput
                    value={refundReason}
                    placeholder="Required"
                    data-testid="refund-reason"
                    onChange={(e) => setRefundReason(e.target.value)}
                  />
                </Field>
                <Btn
                  variant="danger"
                  disabled={busy}
                  data-testid="refund-submit"
                  onClick={() => {
                    const minor = parseToMinor(refundAmount);
                    if (!refundPaymentId || !minor) {
                      announce("Choose a payment and an amount to refund.");
                      return;
                    }
                    if (!refundReason.trim()) {
                      announce("A refund needs a reason.");
                      return;
                    }
                    void run(
                      () =>
                        api.billing.refund({
                          paymentId: refundPaymentId,
                          amountMinor: minor,
                          reason: refundReason.trim(),
                        }),
                      "Refund recorded. Stock was not changed.",
                    ).then(() => {
                      setRefundAmount("");
                      setRefundReason("");
                      setRefundPaymentId("");
                    });
                  }}
                >
                  Refund
                </Btn>
              </div>
            </div>
          )}
        </Card>
      )}

      {invoice.history.length > 0 && (
        <Card className="p-[14px]">
          <CardTitle>History</CardTitle>
          <ul className="mt-[10px] mb-0 flex list-none flex-col gap-[6px] p-0" data-testid="invoice-history">
            {invoice.history.map((h, i) => (
              <li key={`${h.at}-${i}`} className="text-[12.5px] text-subtle">
                <span className="font-semibold text-body">{h.kind}</span>
                {h.from && h.to ? ` · ${h.from} → ${h.to}` : h.to ? ` · ${h.to}` : ""}
                {h.detail ? ` · ${h.detail}` : ""}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {voidOpen && (
        <Card className="border-critical/40 p-[14px]" data-testid="invoice-void-panel">
          <CardTitle>Void this invoice</CardTitle>
          <ClinicalNote>
            Voiding releases any reserved stock and keeps the invoice on the
            record for audit. It cannot be undone, and a paid invoice must be
            refunded instead of voided.
          </ClinicalNote>
          <div className="mt-[10px] flex flex-wrap items-end gap-2">
            <Field label="Reason for voiding" className="min-w-[260px]">
              <TextInput
                value={voidReason}
                placeholder="Required"
                data-testid="void-reason"
                onChange={(e) => setVoidReason(e.target.value)}
              />
            </Field>
            <Btn
              variant="danger"
              disabled={busy}
              data-testid="void-confirm"
              onClick={() => {
                if (!voidReason.trim()) {
                  announce("Voiding an invoice needs a reason.");
                  return;
                }
                setConfirmVoid(true);
              }}
            >
              Void invoice
            </Btn>
            <Btn variant="ghost" onClick={() => setVoidOpen(false)} data-testid="void-cancel">
              Cancel
            </Btn>
          </div>
        </Card>
      )}

      <ConfirmDialog
        open={confirmVoid}
        title="Void this invoice?"
        body="This releases any reserved stock and cannot be undone. The invoice stays on the record with its reason."
        confirmLabel="Void invoice"
        destructive
        onCancel={() => setConfirmVoid(false)}
        onConfirm={() => {
          setConfirmVoid(false);
          setVoidOpen(false);
          void run(
            () =>
              api.billing.voidInvoice({
                invoiceId,
                expectedVersion: invoice.version,
                reason: voidReason.trim(),
              }),
            "Invoice voided. Reservations released.",
          );
        }}
      />
    </div>
  );
}
