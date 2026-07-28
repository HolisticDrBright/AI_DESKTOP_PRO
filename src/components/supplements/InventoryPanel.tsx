"use client";

import { useMemo, useState } from "react";
import { Boxes, History, Package, Plus, Search, X } from "lucide-react";
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
import { useInventoryMovements } from "@/adapters/session-store";
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
  const [query, setQuery] = useState("");
  const [stockFilter, setStockFilter] = useState<"all" | "attention">("all");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products.filter((p) => {
      const matchesQuery = !q || [p.name, p.brand, p.sku, p.supplier, p.category]
        .some((value) => value.toLowerCase().includes(q));
      const matchesStock = stockFilter === "all" || stockLevel(p.stock, p.reorderPoint) !== "ok";
      return matchesQuery && matchesStock;
    });
  }, [products, query, stockFilter]);

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
            <h2 className="m-0 text-[17px] font-bold tracking-[-0.015em]">Products &amp; inventory</h2>
          </div>
          <p className="mt-[3px] mb-0 text-[11.5px] text-subtle">
            Practice-wide catalog for checkout, supplement dispensing, suppliers, pricing, and stock.
            Product explanations follow the item onto the patient invoice. Session demo — not persisted.
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

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-card p-2">
        <label className="relative min-w-[260px] flex-1">
          <span className="sr-only">Search products</span>
          <Search size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search product, SKU, supplier, or category"
            className="h-9 w-full rounded-lg border border-line bg-card pr-3 pl-9 text-[12.5px] outline-none focus-visible:outline-2 focus-visible:outline-action"
          />
        </label>
        <div className="flex h-9 rounded-lg border border-line bg-sunken p-[3px]" aria-label="Stock filter">
          {(["all", "attention"] as const).map((value) => (
            <button
              key={value}
              onClick={() => setStockFilter(value)}
              className={cn(
                "rounded-md px-3 text-[11.5px] font-semibold",
                stockFilter === value ? "bg-card text-ink shadow-sm" : "text-subtle hover:text-ink",
              )}
            >
              {value === "all" ? "All products" : "Needs attention"}
            </button>
          ))}
        </div>
      </div>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <caption className="sr-only">Supplement inventory with stock, price and cost</caption>
            <thead>
              <tr>
                {["Product", "Supplier", "Invoice explanation", "On hand", "Price", "Margin", ""].map((h) => (
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
              {filtered.map((p) => {
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
                      <div className="font-medium text-body">{p.supplier}</div>
                      <Pill tone={CATEGORY_TONE[p.category] ?? "slate"}>{p.category}</Pill>
                    </td>
                    <td className="max-w-[300px] px-[11px] py-[9px]">
                      <p className="m-0 line-clamp-2 text-[11px] leading-[1.4] text-subtle">{p.invoiceDescription}</p>
                      <span className="text-[10px] font-semibold text-faint">{p.taxable ? "Taxable" : "Non-taxable"}</span>
                    </td>
                    <td className="px-[11px] py-[9px]">
                      <div className="flex items-center gap-[7px]">
                        <span className="text-[14px] font-bold tabular-nums text-ink">{p.stock}</span>
                        <Pill tone={STOCK_TONE[lvl]}>{STOCK_LABEL[lvl]}</Pill>
                      </div>
                      <div className="text-[10px] text-faint">reorder at {p.reorderPoint}</div>
                    </td>
                    <td className="px-[11px] py-[9px] font-semibold tabular-nums text-ink">{money(p.priceMinor)}</td>
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
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-[12px] text-faint">
                    No products match this search and stock filter.
                  </td>
                </tr>
              )}
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
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-[95] flex items-center justify-center bg-[rgba(24,42,61,0.34)] p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <Card className="animate-fade-up max-h-[90vh] w-[640px] max-w-full overflow-y-auto p-0">
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
  const movements = useInventoryMovements().filter((m) => m.productId === product.id).slice(0, 5);
  const [qty, setQty] = useState("12");
  const [exact, setExact] = useState(String(product.stock));
  const [name, setName] = useState(product.name);
  const [brand, setBrand] = useState(product.brand);
  const [supplier, setSupplier] = useState(product.supplier);
  const [sku, setSku] = useState(product.sku);
  const [unitLabel, setUnitLabel] = useState(product.unitLabel);
  const [category, setCategory] = useState(product.category);
  const [price, setPrice] = useState((product.priceMinor / 100).toFixed(2));
  const [cost, setCost] = useState((product.costMinor / 100).toFixed(2));
  const [reorder, setReorder] = useState(String(product.reorderPoint));
  const [description, setDescription] = useState(product.invoiceDescription);
  const [taxable, setTaxable] = useState(product.taxable);

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

  const save = () => {
    const priceMinor = Math.round(Number(price) * 100);
    if (name.trim().length < 2 || !Number.isFinite(priceMinor) || priceMinor < 0) return;
    void api.inventory.updateProduct({
      ...product,
      name: name.trim(),
      brand: brand.trim() || "—",
      supplier: supplier.trim() || "Not set",
      sku: sku.trim() || product.sku,
      unitLabel: unitLabel.trim() || "each",
      category,
      priceMinor,
      costMinor: Math.max(0, Math.round(Number(cost) * 100) || 0),
      reorderPoint: Math.max(0, Math.round(Number(reorder)) || 0),
      invoiceDescription: description.trim() || "No patient-facing explanation has been added.",
      taxable,
    }).then((r) => announce(r.message));
    onClose();
  };

  return (
    <ModalShell title={`Manage · ${product.name}`} onClose={onClose}>
      <div className="mb-4 grid grid-cols-2 gap-2">
        <label className="col-span-2 block">
          <span className={labelCls}>Product name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
        </label>
        <label className="block">
          <span className={labelCls}>Brand</span>
          <input value={brand} onChange={(e) => setBrand(e.target.value)} className={inputCls} />
        </label>
        <label className="block">
          <span className={labelCls}>Supplier</span>
          <input value={supplier} onChange={(e) => setSupplier(e.target.value)} className={inputCls} />
        </label>
        <label className="block">
          <span className={labelCls}>SKU</span>
          <input value={sku} onChange={(e) => setSku(e.target.value)} className={inputCls} />
        </label>
        <label className="block">
          <span className={labelCls}>Package / unit</span>
          <input value={unitLabel} onChange={(e) => setUnitLabel(e.target.value)} className={inputCls} />
        </label>
        <label className="block">
          <span className={labelCls}>Category</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)} className={cn(inputCls, "cursor-pointer")}>
            {INVENTORY_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
        <label className="block">
          <span className={labelCls}>Reorder at</span>
          <input value={reorder} onChange={(e) => setReorder(e.target.value)} inputMode="numeric" className={inputCls} />
        </label>
        <label className="block">
          <span className={labelCls}>Retail price ($)</span>
          <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" className={inputCls} />
        </label>
        <label className="block">
          <span className={labelCls}>Cost ($)</span>
          <input value={cost} onChange={(e) => setCost(e.target.value)} inputMode="decimal" className={inputCls} />
        </label>
        <label className="col-span-2 block">
          <span className={labelCls}>Patient-facing invoice explanation</span>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className="w-full resize-y rounded-lg border border-line bg-card px-[9px] py-2 text-[12px] leading-[1.45] outline-none focus-visible:outline-2 focus-visible:outline-action" />
        </label>
        <label className="col-span-2 flex items-center gap-2 text-[12px] font-medium text-body">
          <input type="checkbox" checked={taxable} onChange={(e) => setTaxable(e.target.checked)} />
          Taxable at checkout
        </label>
        <button onClick={save} className="col-span-2 h-9 rounded-lg border-none bg-action text-[12.5px] font-semibold text-white hover:bg-action-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
          Save product details
        </button>
      </div>

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

      <div className="mt-4 border-t border-line pt-3">
        <div className="mb-2 flex items-center gap-2 text-[11px] font-bold tracking-[0.04em] text-faint uppercase">
          <History size={13} aria-hidden /> Recent inventory history
        </div>
        {movements.length === 0 ? (
          <p className="m-0 text-[11.5px] text-faint">No movements recorded this session.</p>
        ) : movements.map((movement) => (
          <div key={movement.id} className="flex items-center justify-between border-b border-hairline py-[5px] text-[11.5px] last:border-0">
            <span className="text-body">{movement.note}</span>
            <span className={cn("font-bold tabular-nums", movement.delta > 0 ? "text-positive" : "text-critical")}>{movement.delta > 0 ? "+" : ""}{movement.delta}</span>
          </div>
        ))}
      </div>
    </ModalShell>
  );
}

/* ----------------------------------------------------------- add-product modal */

function AddProductModal({ onClose }: { onClose: () => void }) {
  const { announce } = useFeedback();
  const [name, setName] = useState("");
  const [brand, setBrand] = useState("");
  const [supplier, setSupplier] = useState("");
  const [unitLabel, setUnitLabel] = useState("60 ct bottle");
  const [category, setCategory] = useState<string>(INVENTORY_CATEGORIES[0]);
  const [price, setPrice] = useState("");
  const [cost, setCost] = useState("");
  const [stock, setStock] = useState("10");
  const [reorder, setReorder] = useState("6");
  const [description, setDescription] = useState("");
  const [taxable, setTaxable] = useState(true);

  const priceMinor = Math.round(Number(price) * 100);
  const valid = name.trim().length > 1 && Number.isFinite(priceMinor) && priceMinor > 0;

  const submit = () => {
    if (!valid) return;
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24);
    const product: InventoryProduct = {
      id: `sup-custom-${slug}-${Math.random().toString(36).slice(2, 6)}`,
      name: name.trim(),
      brand: brand.trim() || "—",
      supplier: supplier.trim() || brand.trim() || "Not set",
      sku: (slug || "custom").toUpperCase().slice(0, 12),
      category,
      unitLabel: unitLabel.trim() || "each",
      invoiceDescription: description.trim() || "No patient-facing explanation has been added.",
      taxable,
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
            <span className={labelCls}>Supplier</span>
            <input value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="e.g. Fullscript or direct" className={inputCls} />
          </label>
          <label className="block">
            <span className={labelCls}>Package / unit</span>
            <input value={unitLabel} onChange={(e) => setUnitLabel(e.target.value)} className={inputCls} />
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
        <label className="block">
          <span className={labelCls}>Patient-facing invoice explanation</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="Why this product was selected and what it supports. This follows the item onto the invoice."
            className="w-full resize-y rounded-lg border border-line bg-card px-[9px] py-2 text-[12px] leading-[1.45] outline-none focus-visible:outline-2 focus-visible:outline-action"
          />
        </label>
        <label className="flex items-center gap-2 text-[12px] font-medium text-body">
          <input type="checkbox" checked={taxable} onChange={(e) => setTaxable(e.target.checked)} />
          Taxable at checkout
        </label>
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
