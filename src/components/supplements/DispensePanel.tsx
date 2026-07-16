"use client";

import { useMemo, useState } from "react";
import { Minus, Plus, Receipt, Search, ShoppingCart, Trash2 } from "lucide-react";
import { api } from "@/adapters";
import {
  CATEGORY_TONE,
  STOCK_LABEL,
  STOCK_TONE,
  money,
  stockLevel,
  type InventoryProduct,
} from "@/adapters/inventory.mock";
import { useSales, type SaleLine } from "@/adapters/session-store";
import type { Tone } from "@/adapters/types";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Card } from "@/components/ui/bits";
import { cn } from "@/lib/cn";
import { useFeedback } from "@/lib/feedback";
import { toneText, toneTint } from "@/lib/tones";
import { useInventory } from "./useInventory";

function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span
      className="w-fit rounded-full px-[7px] py-px text-[9.5px] font-semibold whitespace-nowrap"
      style={{ color: toneText[tone], background: toneTint[tone] }}
    >
      {children}
    </span>
  );
}

export function DispensePanel({ patientId, patientName }: { patientId: string; patientName: string }) {
  const { announce } = useFeedback();
  const products = useInventory();
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const sales = useSales();
  const patientSales = useMemo(() => sales.filter((s) => s.patientId === patientId), [sales, patientId]);

  const [cart, setCart] = useState<Record<string, number>>({});
  const [query, setQuery] = useState("");
  const [discountPct, setDiscountPct] = useState("0");
  const [taxPct, setTaxPct] = useState("0");
  const [confirming, setConfirming] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products.filter((p) => !q || p.name.toLowerCase().includes(q) || p.brand.toLowerCase().includes(q) || p.category.toLowerCase().includes(q));
  }, [products, query]);

  const add = (p: InventoryProduct) => {
    setCart((c) => {
      const cur = c[p.id] ?? 0;
      if (cur >= p.stock) return c; // never oversell
      return { ...c, [p.id]: cur + 1 };
    });
  };
  const setQty = (id: string, qty: number) => {
    setCart((c) => {
      const p = byId.get(id);
      const max = p?.stock ?? 0;
      const clamped = Math.max(0, Math.min(qty, max));
      if (clamped === 0) {
        const rest = { ...c };
        delete rest[id];
        return rest;
      }
      return { ...c, [id]: clamped };
    });
  };

  const lines: SaleLine[] = useMemo(
    () =>
      Object.entries(cart)
        .map(([id, qty]) => {
          const p = byId.get(id);
          if (!p) return null;
          return { productId: id, name: p.name, qty, unitPriceMinor: p.priceMinor, lineTotalMinor: p.priceMinor * qty };
        })
        .filter((l): l is SaleLine => l !== null),
    [cart, byId],
  );

  const subtotalMinor = lines.reduce((n, l) => n + l.lineTotalMinor, 0);
  const discPct = Math.max(0, Math.min(Number(discountPct) || 0, 100));
  const taxRate = Math.max(0, Math.min(Number(taxPct) || 0, 100));
  const discountMinor = Math.round((subtotalMinor * discPct) / 100);
  const taxableMinor = subtotalMinor - discountMinor;
  const taxMinor = Math.round((taxableMinor * taxRate) / 100);
  const totalMinor = taxableMinor + taxMinor;
  const itemCount = lines.reduce((n, l) => n + l.qty, 0);

  const completeSale = () => {
    setConfirming(false);
    void api.inventory
      .recordSale({ patientId, patientName, lines, subtotalMinor, discountMinor, taxMinor, totalMinor })
      .then((r) => announce(r.message));
    setCart({});
    setDiscountPct("0");
    setTaxPct("0");
  };

  return (
    <section data-screen-label="Dispense supplements" className="relative pb-6">
      <div className="mb-3 flex items-center gap-[7px]">
        <ShoppingCart size={17} strokeWidth={2} className="text-brand" aria-hidden />
        <h2 className="m-0 text-[17px] font-bold tracking-[-0.015em]">Dispense &amp; checkout</h2>
      </div>
      <p className="mt-0 mb-3 text-[11.5px] text-subtle">
        Add supplements to <strong className="font-semibold text-body">{patientName}</strong>&rsquo;s
        order and charge them at checkout. Completing a sale counts stock down. Demo — no real payment
        is taken and nothing is persisted.
      </p>

      <div className="grid grid-cols-[minmax(0,1fr)_360px] items-start gap-4">
        {/* product picker */}
        <Card className="overflow-hidden">
          <div className="flex items-center gap-2 border-b border-hairline px-3 py-[9px]">
            <Search size={14} strokeWidth={2} className="text-faint" aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search supplements to add…"
              aria-label="Search supplements"
              className="h-7 flex-1 border-none bg-transparent text-[12.5px] text-body outline-none placeholder:text-ghost"
            />
          </div>
          <ul className="m-0 max-h-[calc(100vh-320px)] list-none overflow-y-auto p-0">
            {filtered.map((p) => {
              const lvl = stockLevel(p.stock, p.reorderPoint);
              const inCart = cart[p.id] ?? 0;
              const disabled = p.stock <= 0 || inCart >= p.stock;
              return (
                <li key={p.id} className="flex items-center gap-3 border-b border-[#F3F7FA] px-3 py-[9px]">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-[6px]">
                      <span className="truncate text-[12.5px] font-semibold text-ink">{p.name}</span>
                      <Pill tone={CATEGORY_TONE[p.category] ?? "slate"}>{p.category}</Pill>
                    </div>
                    <div className="mt-[1px] flex items-center gap-[6px] text-[10.5px] text-faint">
                      <span>{p.brand}</span>
                      <span aria-hidden>·</span>
                      <Pill tone={STOCK_TONE[lvl]}>
                        {p.stock} {STOCK_LABEL[lvl] === "In stock" ? "in stock" : STOCK_LABEL[lvl].toLowerCase()}
                      </Pill>
                    </div>
                  </div>
                  <span className="shrink-0 text-[12.5px] font-bold tabular-nums text-ink">{money(p.priceMinor)}</span>
                  <button
                    onClick={() => add(p)}
                    disabled={disabled}
                    className="flex h-[30px] shrink-0 items-center gap-[5px] rounded-lg border border-line bg-card px-[10px] text-[11.5px] font-semibold text-action hover:border-action focus-visible:outline-2 focus-visible:outline-action disabled:cursor-not-allowed disabled:text-faint disabled:opacity-60"
                  >
                    <Plus size={12} strokeWidth={2.5} aria-hidden />
                    Add
                  </button>
                </li>
              );
            })}
            {filtered.length === 0 && (
              <li className="px-3 py-[26px] text-center text-[12px] text-subtle">No products match “{query}”.</li>
            )}
          </ul>
        </Card>

        {/* order / cart */}
        <div className="sticky top-[6px] flex flex-col gap-3">
          <Card className="overflow-hidden">
            <div className="border-b border-hairline px-4 py-[11px]">
              <h3 className="m-0 text-[13px] font-bold">Order · {patientName}</h3>
              <p className="m-0 text-[11px] text-subtle">{itemCount} item{itemCount === 1 ? "" : "s"}</p>
            </div>

            {lines.length === 0 ? (
              <div className="flex flex-col items-center gap-[7px] px-4 py-[36px] text-center">
                <ShoppingCart size={20} strokeWidth={1.6} className="text-ghost" aria-hidden />
                <p className="m-0 text-[12px] text-subtle">No items yet. Add supplements from the list.</p>
              </div>
            ) : (
              <ul className="m-0 max-h-[280px] list-none overflow-y-auto p-0">
                {lines.map((l) => (
                  <li key={l.productId} className="flex items-center gap-2 border-b border-[#F3F7FA] px-3 py-[8px]">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12px] font-semibold text-ink">{l.name}</div>
                      <div className="text-[10.5px] text-faint">{money(l.unitPriceMinor)} each</div>
                    </div>
                    <div className="flex items-center rounded-lg border border-line">
                      <button
                        onClick={() => setQty(l.productId, l.qty - 1)}
                        aria-label={`Decrease ${l.name}`}
                        className="flex h-[26px] w-[26px] items-center justify-center rounded-l-lg text-muted hover:bg-sunken focus-visible:outline-2 focus-visible:outline-action"
                      >
                        <Minus size={12} strokeWidth={2.5} aria-hidden />
                      </button>
                      <span className="w-[26px] text-center text-[12px] font-bold tabular-nums">{l.qty}</span>
                      <button
                        onClick={() => setQty(l.productId, l.qty + 1)}
                        aria-label={`Increase ${l.name}`}
                        disabled={l.qty >= (byId.get(l.productId)?.stock ?? 0)}
                        className="flex h-[26px] w-[26px] items-center justify-center rounded-r-lg text-muted hover:bg-sunken focus-visible:outline-2 focus-visible:outline-action disabled:opacity-40"
                      >
                        <Plus size={12} strokeWidth={2.5} aria-hidden />
                      </button>
                    </div>
                    <span className="w-[54px] shrink-0 text-right text-[12px] font-bold tabular-nums text-ink">
                      {money(l.lineTotalMinor)}
                    </span>
                    <button
                      onClick={() => setQty(l.productId, 0)}
                      aria-label={`Remove ${l.name}`}
                      className="flex h-[26px] w-[24px] items-center justify-center rounded-lg text-faint hover:text-critical focus-visible:outline-2 focus-visible:outline-action"
                    >
                      <Trash2 size={13} strokeWidth={2} aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {/* totals */}
            <div className="border-t border-hairline px-4 py-[10px]">
              <div className="mb-[8px] flex gap-2">
                <label className="flex-1">
                  <span className="mb-[2px] block text-[9.5px] font-bold tracking-[0.04em] text-faint uppercase">Discount %</span>
                  <input
                    value={discountPct}
                    onChange={(e) => setDiscountPct(e.target.value)}
                    inputMode="decimal"
                    className="h-8 w-full rounded-lg border border-line bg-card px-[8px] text-[12px] text-body outline-none focus-visible:outline-2 focus-visible:outline-action"
                  />
                </label>
                <label className="flex-1">
                  <span className="mb-[2px] block text-[9.5px] font-bold tracking-[0.04em] text-faint uppercase">Tax %</span>
                  <input
                    value={taxPct}
                    onChange={(e) => setTaxPct(e.target.value)}
                    inputMode="decimal"
                    className="h-8 w-full rounded-lg border border-line bg-card px-[8px] text-[12px] text-body outline-none focus-visible:outline-2 focus-visible:outline-action"
                  />
                </label>
              </div>
              <TotalRow label="Subtotal" value={money(subtotalMinor)} />
              {discountMinor > 0 && <TotalRow label={`Discount (${discPct}%)`} value={`−${money(discountMinor)}`} muted />}
              {taxMinor > 0 && <TotalRow label={`Tax (${taxRate}%)`} value={money(taxMinor)} muted />}
              <div className="mt-[6px] flex items-baseline justify-between border-t border-hairline-2 pt-[7px]">
                <span className="text-[13px] font-bold">Total</span>
                <span className="text-[18px] font-bold tabular-nums text-ink">{money(totalMinor)}</span>
              </div>
              <button
                onClick={() => setConfirming(true)}
                disabled={lines.length === 0}
                className="mt-[10px] flex h-10 w-full items-center justify-center gap-[7px] rounded-lg border-none bg-action text-[13px] font-semibold text-white hover:bg-action-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Receipt size={15} strokeWidth={2} aria-hidden />
                Complete sale · {money(totalMinor)}
              </button>
            </div>
          </Card>

          {patientSales.length > 0 && (
            <Card className="p-[11px]">
              <h3 className="m-0 mb-[6px] text-[11.5px] font-bold">This session&rsquo;s sales</h3>
              <ul className="m-0 flex list-none flex-col gap-[5px] p-0">
                {patientSales.map((s) => (
                  <li key={s.id} className="flex items-center justify-between text-[11.5px]">
                    <span className="text-body">
                      {s.lines.reduce((n, l) => n + l.qty, 0)} item
                      {s.lines.reduce((n, l) => n + l.qty, 0) === 1 ? "" : "s"} ·{" "}
                      <span className="text-faint">{new Date(s.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
                    </span>
                    <span className="font-bold tabular-nums text-ink">{money(s.totalMinor)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>

      {confirming && (
        <ConfirmDialog
          open
          title={`Charge ${patientName} ${money(totalMinor)}?`}
          body={`${itemCount} item${itemCount === 1 ? "" : "s"} will be dispensed and stock counted down. Demo boundary: no real payment is taken and nothing is persisted to a backend.`}
          confirmLabel={`Complete sale · ${money(totalMinor)}`}
          onCancel={() => setConfirming(false)}
          onConfirm={completeSale}
        />
      )}
    </section>
  );
}

function TotalRow({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between py-[2px] text-[12px]">
      <span className={muted ? "text-subtle" : "text-body"}>{label}</span>
      <span className={cn("tabular-nums", muted ? "text-muted" : "font-semibold text-ink")}>{value}</span>
    </div>
  );
}
