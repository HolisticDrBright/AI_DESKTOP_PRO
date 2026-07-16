"use client";

import { useMemo, useState } from "react";
import { Boxes, Package, Plus, X } from "lucide-react";
import { api } from "@/adapters";
import {
  CATEGORY_TONE,
  INVENTORY_CATEGORIES,
  STOCK_LABEL,
  STOCK_TONE,
  money,
  stockLevel,
  type InventoryProduct,
} from "@/adapters/inventory.mock";
import type { Tone } from "@/adapters/types";
import { Card } from "@/components/ui/bits";
import { cn } from "@/lib/cn";
import { useFeedback } from "@/lib/feedback";
import { toneText, toneTint } from "@/lib/tones";
import { useInventory } from "./useInventory";

function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span
      className="w-fit rounded-full px-[8px] py-px text-[10px] font-semibold whitespace-nowrap"
      style={{ color: toneText[tone], background: toneTint[tone] }}
    >
      {children}
    </span>
  );
}

export function InventoryPanel() {
  const products = useInventory();
  const [manage, setManage] = useState<InventoryProduct | null>(null);
  const [adding, setAdding] = useState(false);

  const summary = useMemo(() => {
    let low = 0;
    let out = 0;
    let retailValue = 0;
    for (const p of products) {
      const lvl = stockLevel(p.stock, p.reorderPoint);
      if (lvl === "low") low += 1;
      if (lvl === "out") out += 1;
      retailValue += p.stock * p.priceMinor;
    }
    return { skus: products.length, low, out, retailValue };
  }, [products]);

  return (
    <section data-screen-label="Supplement Inventory" className="relative flex flex-col gap-3 pb-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="flex items-center gap-[7px]">
            <Boxes size={17} strokeWidth={2} className="text-brand" aria-hidden />
            <h2 className="m-0 text-[17px] font-bold tracking-[-0.015em]">Dispensary inventory</h2>
          </div>
          <p className="mt-[3px] mb-0 text-[11.5px] text-subtle">
            Practice-wide supplement stock. Selling to a patient (Dispense tab) counts stock down.
            Session demo — not persisted to a backend.
          </p>
        </div>
        <button
          onClick={() => setAdding(true)}
          className="flex h-9 items-center gap-[6px] rounded-lg border-none bg-action px-4 text-[12.5px] font-semibold text-white hover:bg-action-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          <Plus size={14} strokeWidth={2.5} aria-hidden />
          Add product
        </button>
      </div>

      {/* summary chips */}
      <div className="flex flex-wrap gap-2">
        <SummaryChip label="Products" value={String(summary.skus)} tone="slate" />
        <SummaryChip label="Low stock" value={String(summary.low)} tone="warning" />
        <SummaryChip label="Out of stock" value={String(summary.out)} tone="critical" />
        <SummaryChip label="Retail value on hand" value={money(summary.retailValue)} tone="positive" />
      </div>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <caption className="sr-only">Supplement inventory with stock, price and cost</caption>
            <thead>
              <tr>
                {["Product", "Category", "On hand", "Price", "Cost", "Margin", ""].map((h) => (
                  <th
                    key={h}
                    scope="col"
                    className="whitespace-nowrap border-b border-hairline bg-[#F6F9FC] px-[11px] py-[8px] text-left text-[9.5px] font-bold tracking-[0.03em] text-faint uppercase"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {products.map((p) => {
                const lvl = stockLevel(p.stock, p.reorderPoint);
                const margin = p.priceMinor > 0 ? Math.round(((p.priceMinor - p.costMinor) / p.priceMinor) * 100) : 0;
                return (
                  <tr key={p.id} className="border-b border-[#F3F7FA] hover:bg-sunken">
                    <td className="px-[11px] py-[9px]">
                      <div className="font-semibold text-ink">{p.name}</div>
                      <div className="text-[10.5px] text-faint">
                        {p.brand} · {p.sku} · {p.unitLabel}
                      </div>
                    </td>
                    <td className="px-[11px] py-[9px]">
                      <Pill tone={CATEGORY_TONE[p.category] ?? "slate"}>{p.category}</Pill>
                    </td>
                    <td className="px-[11px] py-[9px]">
                      <div className="flex items-center gap-[7px]">
                        <span className="text-[14px] font-bold tabular-nums text-ink">{p.stock}</span>
                        <Pill tone={STOCK_TONE[lvl]}>{STOCK_LABEL[lvl]}</Pill>
                      </div>
                      <div className="text-[10px] text-faint">reorder at {p.reorderPoint}</div>
                    </td>
                    <td className="px-[11px] py-[9px] font-semibold tabular-nums text-ink">{money(p.priceMinor)}</td>
                    <td className="px-[11px] py-[9px] tabular-nums text-muted">{money(p.costMinor)}</td>
                    <td className="px-[11px] py-[9px] tabular-nums text-muted">{margin}%</td>
                    <td className="px-[11px] py-[9px] text-right">
                      <button
                        onClick={() => setManage(p)}
                        className="h-[28px] rounded-lg border border-line bg-card px-[10px] text-[11.5px] font-semibold text-body hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action"
                      >
                        Manage
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {manage && <RestockModal product={manage} onClose={() => setManage(null)} />}
      {adding && <AddProductModal onClose={() => setAdding(false)} />}
    </section>
  );
}

function SummaryChip({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div className="flex items-baseline gap-[7px] rounded-lg border border-line bg-card px-[11px] py-[7px]">
      <span className="text-[15px] font-bold tabular-nums" style={{ color: toneText[tone] }}>
        {value}
      </span>
      <span className="text-[11px] text-subtle">{label}</span>
    </div>
  );
}

/* -------------------------------------------------------------- restock modal */

function ModalShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center bg-[rgba(24,42,61,0.34)] p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <Card className="animate-fade-up w-[380px] max-w-full p-0">
        <div className="flex items-center justify-between border-b border-hairline px-4 py-[12px]">
          <h3 className="m-0 text-[14px] font-bold">{title}</h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-faint hover:bg-[rgba(90,107,126,0.1)] hover:text-ink focus-visible:outline-2 focus-visible:outline-action"
          >
            <X size={14} strokeWidth={2} aria-hidden />
          </button>
        </div>
        <div className="p-4">{children}</div>
      </Card>
    </div>
  );
}

const inputCls =
  "h-9 w-full rounded-lg border border-line bg-card px-[9px] text-[12.5px] text-body outline-none focus-visible:outline-2 focus-visible:outline-action";
const labelCls = "mb-[3px] block text-[10px] font-bold tracking-[0.04em] text-faint uppercase";

function RestockModal({ product, onClose }: { product: InventoryProduct; onClose: () => void }) {
  const { announce } = useFeedback();
  const [qty, setQty] = useState("12");
  const [exact, setExact] = useState(String(product.stock));

  const receive = () => {
    const n = Number(qty);
    if (!Number.isFinite(n) || n <= 0) return;
    void api.inventory.receiveStock(product.id, n, product.name).then((r) => announce(r.message));
    onClose();
  };
  const setTo = () => {
    const n = Number(exact);
    if (!Number.isFinite(n) || n < 0) return;
    void api.inventory.setStock(product.id, product.stock, n, product.name).then((r) => announce(r.message));
    onClose();
  };

  return (
    <ModalShell title={`Manage · ${product.name}`} onClose={onClose}>
      <div className="mb-3 flex items-center gap-[8px] rounded-lg bg-sunken px-3 py-[8px]">
        <Package size={15} strokeWidth={2} className="text-muted" aria-hidden />
        <span className="text-[12px] text-body">
          On hand now: <strong className="font-bold text-ink">{product.stock}</strong> · reorder at {product.reorderPoint}
        </span>
      </div>

      <label className="mb-3 block">
        <span className={labelCls}>Receive stock (add)</span>
        <div className="flex gap-2">
          <input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="numeric" className={inputCls} aria-label="Quantity to receive" />
          <button
            onClick={receive}
            className="h-9 shrink-0 rounded-lg border-none bg-positive px-4 text-[12.5px] font-semibold text-white hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            Receive
          </button>
        </div>
      </label>

      <label className="block">
        <span className={labelCls}>Correct on-hand count (set exact)</span>
        <div className="flex gap-2">
          <input value={exact} onChange={(e) => setExact(e.target.value)} inputMode="numeric" className={inputCls} aria-label="Exact on-hand count" />
          <button
            onClick={setTo}
            className="h-9 shrink-0 rounded-lg border border-line bg-card px-4 text-[12.5px] font-semibold text-body hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action"
          >
            Set
          </button>
        </div>
      </label>
    </ModalShell>
  );
}

/* ----------------------------------------------------------- add-product modal */

function AddProductModal({ onClose }: { onClose: () => void }) {
  const { announce } = useFeedback();
  const [name, setName] = useState("");
  const [brand, setBrand] = useState("");
  const [category, setCategory] = useState<string>(INVENTORY_CATEGORIES[0]);
  const [price, setPrice] = useState("");
  const [cost, setCost] = useState("");
  const [stock, setStock] = useState("10");
  const [reorder, setReorder] = useState("6");

  const priceMinor = Math.round(Number(price) * 100);
  const valid = name.trim().length > 1 && Number.isFinite(priceMinor) && priceMinor > 0;

  const submit = () => {
    if (!valid) return;
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24);
    const product: InventoryProduct = {
      id: `sup-custom-${slug}-${Math.random().toString(36).slice(2, 6)}`,
      name: name.trim(),
      brand: brand.trim() || "—",
      sku: (slug || "custom").toUpperCase().slice(0, 12),
      category,
      unitLabel: "each",
      priceMinor,
      costMinor: Math.max(0, Math.round(Number(cost) * 100) || 0),
      stock: Math.max(0, Math.round(Number(stock)) || 0),
      reorderPoint: Math.max(0, Math.round(Number(reorder)) || 0),
    };
    void api.inventory.addProduct(product).then((r) => announce(r.message));
    onClose();
  };

  return (
    <ModalShell title="Add product to inventory" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <label className="block">
          <span className={labelCls}>Product name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Vitamin C 1000mg" className={inputCls} />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className={labelCls}>Brand</span>
            <input value={brand} onChange={(e) => setBrand(e.target.value)} className={inputCls} />
          </label>
          <label className="block">
            <span className={labelCls}>Category</span>
            <select value={category} onChange={(e) => setCategory(e.target.value)} className={cn(inputCls, "cursor-pointer")}>
              {INVENTORY_CATEGORIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className={labelCls}>Retail price ($)</span>
            <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="0.00" className={inputCls} />
          </label>
          <label className="block">
            <span className={labelCls}>Cost ($)</span>
            <input value={cost} onChange={(e) => setCost(e.target.value)} inputMode="decimal" placeholder="0.00" className={inputCls} />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className={labelCls}>Initial stock</span>
            <input value={stock} onChange={(e) => setStock(e.target.value)} inputMode="numeric" className={inputCls} />
          </label>
          <label className="block">
            <span className={labelCls}>Reorder at</span>
            <input value={reorder} onChange={(e) => setReorder(e.target.value)} inputMode="numeric" className={inputCls} />
          </label>
        </div>
        <button
          onClick={submit}
          disabled={!valid}
          className="mt-1 h-9 rounded-lg border-none bg-action text-[12.5px] font-semibold text-white hover:bg-action-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          Add to inventory
        </button>
      </div>
    </ModalShell>
  );
}
