"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/adapters";
import { AdapterError } from "@/adapters/errors";
import type {
  LiveBillingCatalog,
  LiveBillingProduct,
  LiveBillingProductKind,
  LiveInventoryAdjustmentKind,
  LiveInventoryMovement,
  LiveInventoryReturnCondition,
} from "@/adapters/live-types";
import { Card, CardTitle } from "@/components/ui/bits";
import { Btn } from "@/components/ui/Btn";
import { TableWrap, TD, TH } from "@/components/ui/Table";
import { Field, Select, TextInput } from "@/components/ui/Field";
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

function fmtDate(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const KINDS: LiveBillingProductKind[] = [
  "service",
  "visit",
  "product",
  "supplement",
  "lab",
  "program",
  "package",
  "adjustment",
  "other",
];

const ADJUST_KINDS: { id: LiveInventoryAdjustmentKind; label: string }[] = [
  { id: "adjustment", label: "Count correction" },
  { id: "damaged", label: "Damaged" },
  { id: "expired", label: "Expired" },
];

function stockTone(available: number, threshold: number): string {
  if (available <= 0) return "bg-critical-tint text-critical";
  if (available <= threshold) return "bg-warning-tint text-warning-deep";
  return "bg-positive-tint text-positive-deep";
}

/**
 * Products, services, suppliers, locations, tax rates, and stock.
 *
 * Stock never moves by typing a new number: it moves through receipts,
 * reasoned adjustments, sales, and returns, so the ledger below always
 * explains how the current figure was reached.
 */
export function CatalogWorkspace() {
  const { announce } = useFeedback();
  const [catalog, setCatalog] = useState<LiveBillingCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [stockFilter, setStockFilter] = useState<"" | "low" | "out">("");
  const queryRef = useRef(query);

  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<LiveBillingProductKind>("supplement");
  const [newPrice, setNewPrice] = useState("");
  const [newSku, setNewSku] = useState("");
  const [newCost, setNewCost] = useState("");
  const [newTracked, setNewTracked] = useState(true);
  const [newThreshold, setNewThreshold] = useState("3");
  const [newSupplierId, setNewSupplierId] = useState("");
  const [newTaxRateId, setNewTaxRateId] = useState("");

  const [selected, setSelected] = useState<LiveBillingProduct | null>(null);
  const [history, setHistory] = useState<LiveInventoryMovement[] | null>(null);
  const [moveLocationId, setMoveLocationId] = useState("");
  const [moveQty, setMoveQty] = useState("");
  const [moveCost, setMoveCost] = useState("");
  const [adjustDelta, setAdjustDelta] = useState("");
  const [adjustKind, setAdjustKind] = useState<LiveInventoryAdjustmentKind>("adjustment");
  const [adjustReason, setAdjustReason] = useState("");
  const [returnQty, setReturnQty] = useState("");
  const [returnCondition, setReturnCondition] =
    useState<LiveInventoryReturnCondition>("resalable");
  const [returnReason, setReturnReason] = useState("");

  const [refName, setRefName] = useState("");
  const [refEntity, setRefEntity] = useState<"location" | "supplier" | "taxRate">("location");
  const [refRate, setRefRate] = useState("");

  const load = useCallback(async (q: string, filter: "" | "low" | "out") => {
    setError(null);
    try {
      setCatalog(
        await api.inventory.listProducts({
          query: q || null,
          stockFilter: filter || null,
          limit: 200,
        }),
      );
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  useEffect(() => {
    queryRef.current = query;
    const t = setTimeout(() => {
      if (queryRef.current === query) void load(query, stockFilter);
    }, query ? 250 : 0);
    return () => clearTimeout(t);
  }, [query, stockFilter, load]);

  const loadHistory = useCallback(async (productId: string) => {
    try {
      setHistory(await api.inventory.history({ productId, limit: 50 }));
    } catch (e) {
      announce(errText(e));
    }
  }, [announce]);

  const runAction = useCallback(
    async (fn: () => Promise<unknown>, message: string) => {
      if (busy) return;
      setBusy(true);
      try {
        await fn();
        announce(message);
        await load(query, stockFilter);
        if (selected) await loadHistory(selected.id);
      } catch (e) {
        announce(errText(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, announce, load, query, stockFilter, selected, loadHistory],
  );

  if (error && !catalog) {
    return <ClinicalError message={error} onRetry={() => void load(query, stockFilter)} />;
  }
  if (!catalog) return <ClinicalLoading label="Loading the catalog…" />;

  const locations = catalog.locations.filter((l) => !l.archivedAt);

  return (
    <div className="flex flex-col gap-4" data-testid="catalog-workspace">
      <Card className="p-[14px]">
        <CardTitle>Add a product or service</CardTitle>
        <div className="mt-[10px] flex flex-wrap items-end gap-2">
          <Field label="Name" className="min-w-[200px]">
            <TextInput
              value={newName}
              data-testid="product-name"
              onChange={(e) => setNewName(e.target.value)}
            />
          </Field>
          <Field label="Kind" className="min-w-[130px]">
            <Select
              value={newKind}
              data-testid="product-kind"
              onChange={(e) => setNewKind(e.target.value as LiveBillingProductKind)}
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Price" className="min-w-[110px]">
            <TextInput
              value={newPrice}
              placeholder="$0.00"
              data-testid="product-price"
              onChange={(e) => setNewPrice(e.target.value)}
            />
          </Field>
          <Field label="Cost" className="min-w-[110px]">
            <TextInput
              value={newCost}
              placeholder="$0.00"
              data-testid="product-cost"
              onChange={(e) => setNewCost(e.target.value)}
            />
          </Field>
          <Field label="SKU" className="min-w-[120px]">
            <TextInput
              value={newSku}
              data-testid="product-sku"
              onChange={(e) => setNewSku(e.target.value)}
            />
          </Field>
          <Field label="Supplier" className="min-w-[150px]">
            <Select
              value={newSupplierId}
              data-testid="product-supplier"
              onChange={(e) => setNewSupplierId(e.target.value)}
            >
              <option value="">None</option>
              {catalog.suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Tax rate" className="min-w-[150px]">
            <Select
              value={newTaxRateId}
              data-testid="product-tax-rate"
              onChange={(e) => setNewTaxRateId(e.target.value)}
            >
              <option value="">No tax</option>
              {catalog.taxRates
                .filter((t) => t.active)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({(t.rateBps / 100).toFixed(2)}%)
                  </option>
                ))}
            </Select>
          </Field>
          <label className="mb-[6px] flex items-center gap-[6px] text-[12.5px] font-medium text-body">
            <input
              type="checkbox"
              checked={newTracked}
              data-testid="product-tracked"
              onChange={(e) => setNewTracked(e.target.checked)}
            />
            Track stock
          </label>
          {newTracked && (
            <Field label="Reorder at" className="min-w-[100px]">
              <TextInput
                type="number"
                min={0}
                value={newThreshold}
                data-testid="product-threshold"
                onChange={(e) => setNewThreshold(e.target.value)}
              />
            </Field>
          )}
          <Btn
            variant="primary"
            disabled={busy}
            data-testid="product-create"
            onClick={() => {
              const price = parseToMinor(newPrice);
              if (!newName.trim() || price === null) {
                announce("A product needs a name and a price.");
                return;
              }
              void runAction(
                () =>
                  api.inventory.addProduct({
                    name: newName.trim(),
                    kind: newKind,
                    amountMinor: price,
                    sku: newSku.trim() || null,
                    costMinor: parseToMinor(newCost) ?? 0,
                    supplierId: newSupplierId || null,
                    taxRateId: newTaxRateId || null,
                    trackInventory: newTracked,
                    reorderThreshold: Number(newThreshold) || 0,
                  }),
                "Product added to the catalog.",
              ).then(() => {
                setNewName("");
                setNewPrice("");
                setNewCost("");
                setNewSku("");
              });
            }}
          >
            Add
          </Btn>
        </div>
      </Card>

      <Card className="p-[14px]">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <CardTitle>Catalog</CardTitle>
          <div className="flex flex-wrap items-end gap-2">
            <TextInput
              value={query}
              placeholder="Search name, SKU, or barcode"
              data-testid="catalog-search"
              className="w-[240px]"
              onChange={(e) => setQuery(e.target.value)}
            />
            <Select
              value={stockFilter}
              aria-label="Stock filter"
              data-testid="catalog-stock-filter"
              className="w-[150px]"
              onChange={(e) => setStockFilter(e.target.value as "" | "low" | "out")}
            >
              <option value="">All stock</option>
              <option value="low">At or below reorder</option>
              <option value="out">Out of stock</option>
            </Select>
          </div>
        </div>

        {catalog.products.length === 0 ? (
          <p className="mt-[10px] mb-0 text-[12.5px] text-subtle">
            Nothing matches this search.
          </p>
        ) : (
          <TableWrap className="mt-[10px]">
            <thead>
              <tr>
                <TH>Name</TH>
                <TH>Kind</TH>
                <TH>SKU</TH>
                <TH className="text-right">Price</TH>
                <TH>Tax</TH>
                <TH>Stock</TH>
                <TH />
              </tr>
            </thead>
            <tbody data-testid="catalog-rows">
              {catalog.products.map((p) => (
                <tr key={p.id}>
                  <TD className="font-medium">{p.name}</TD>
                  <TD className="text-muted">{p.kind}</TD>
                  <TD className="text-muted">{p.sku ?? "—"}</TD>
                  <TD className="text-right tabular-nums">{formatMinor(p.amountMinor)}</TD>
                  <TD className="text-muted">
                    {p.taxRateBps != null ? `${(p.taxRateBps / 100).toFixed(2)}%` : "—"}
                  </TD>
                  <TD>
                    {!p.trackInventory ? (
                      <span className="text-[11.5px] text-faint">not tracked</span>
                    ) : p.stock.length === 0 ? (
                      <span className="text-[11.5px] text-faint">none received</span>
                    ) : (
                      <div className="flex flex-wrap gap-[4px]">
                        {p.stock.map((s) => (
                          <span
                            key={s.locationId}
                            data-testid={`stock-${p.id}`}
                            className={cn(
                              "inline-flex items-center rounded-full px-[7px] py-px text-[11px] font-semibold",
                              stockTone(s.available, s.reorderThreshold),
                            )}
                          >
                            {s.locationName ?? "—"}: {s.available}
                          </span>
                        ))}
                      </div>
                    )}
                  </TD>
                  <TD className="text-right">
                    <Btn
                      variant="ghost"
                      size="sm"
                      data-testid={`catalog-manage-${p.id}`}
                      onClick={() => {
                        setSelected(p);
                        setHistory(null);
                        setMoveLocationId(locations[0]?.id ?? "");
                        void loadHistory(p.id);
                      }}
                    >
                      Manage
                    </Btn>
                  </TD>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>

      {selected && (
        <Card className="p-[14px]" data-testid="inventory-panel">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <CardTitle>{selected.name}</CardTitle>
            <Btn variant="ghost" size="sm" onClick={() => setSelected(null)} data-testid="inventory-close">
              Close
            </Btn>
          </div>

          {!selected.trackInventory ? (
            <ClinicalNote>
              This item does not track stock, so it has no inventory movements.
              Services and non-stocked items never touch inventory.
            </ClinicalNote>
          ) : locations.length === 0 ? (
            <ClinicalNote>
              Add a location below before receiving stock — every movement is
              recorded against the place it happened.
            </ClinicalNote>
          ) : (
            <>
              <ClinicalNote>
                Stock moves only through these actions. There is no way to type
                a new on-hand number, so the ledger always explains the current
                figure.
              </ClinicalNote>

              <div className="mt-[10px] flex flex-wrap items-end gap-2">
                <Field label="Location" className="min-w-[150px]">
                  <Select
                    value={moveLocationId}
                    data-testid="inventory-location"
                    onChange={(e) => setMoveLocationId(e.target.value)}
                  >
                    {locations.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Receive qty" className="min-w-[110px]">
                  <TextInput
                    type="number"
                    min={1}
                    value={moveQty}
                    data-testid="inventory-receive-qty"
                    onChange={(e) => setMoveQty(e.target.value)}
                  />
                </Field>
                <Field label="Unit cost" className="min-w-[110px]">
                  <TextInput
                    value={moveCost}
                    placeholder="$0.00"
                    data-testid="inventory-receive-cost"
                    onChange={(e) => setMoveCost(e.target.value)}
                  />
                </Field>
                <Btn
                  variant="primary"
                  disabled={busy}
                  data-testid="inventory-receive"
                  onClick={() => {
                    const qty = Number(moveQty);
                    if (!qty || qty <= 0) {
                      announce("Enter how many units arrived.");
                      return;
                    }
                    void runAction(
                      () =>
                        api.inventory.receiveStock({
                          locationId: moveLocationId,
                          productId: selected.id,
                          quantity: qty,
                          unitCostMinor: parseToMinor(moveCost),
                          supplierId: selected.supplierId,
                        }),
                      "Stock received.",
                    ).then(() => {
                      setMoveQty("");
                      setMoveCost("");
                    });
                  }}
                >
                  Receive
                </Btn>
              </div>

              <div className="mt-[12px] flex flex-wrap items-end gap-2 border-t border-hairline pt-[12px]">
                <Field label="Adjust by" className="min-w-[110px]">
                  <TextInput
                    type="number"
                    value={adjustDelta}
                    placeholder="-1"
                    data-testid="inventory-adjust-delta"
                    onChange={(e) => setAdjustDelta(e.target.value)}
                  />
                </Field>
                <Field label="Kind" className="min-w-[150px]">
                  <Select
                    value={adjustKind}
                    data-testid="inventory-adjust-kind"
                    onChange={(e) =>
                      setAdjustKind(e.target.value as LiveInventoryAdjustmentKind)
                    }
                  >
                    {ADJUST_KINDS.map((k) => (
                      <option key={k.id} value={k.id}>
                        {k.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Reason" className="min-w-[200px]">
                  <TextInput
                    value={adjustReason}
                    placeholder="Required"
                    data-testid="inventory-adjust-reason"
                    onChange={(e) => setAdjustReason(e.target.value)}
                  />
                </Field>
                <Btn
                  variant="outline"
                  disabled={busy}
                  data-testid="inventory-adjust"
                  onClick={() => {
                    const delta = Number(adjustDelta);
                    if (!delta) {
                      announce("An adjustment has to change the quantity.");
                      return;
                    }
                    if (!adjustReason.trim()) {
                      announce("An inventory adjustment needs a reason.");
                      return;
                    }
                    void runAction(
                      () =>
                        api.inventory.adjustStock({
                          locationId: moveLocationId,
                          productId: selected.id,
                          delta,
                          kind: adjustKind,
                          reason: adjustReason.trim(),
                        }),
                      "Stock adjusted.",
                    ).then(() => {
                      setAdjustDelta("");
                      setAdjustReason("");
                    });
                  }}
                >
                  Adjust
                </Btn>
              </div>

              <div className="mt-[12px] flex flex-wrap items-end gap-2 border-t border-hairline pt-[12px]">
                <Field label="Return qty" className="min-w-[110px]">
                  <TextInput
                    type="number"
                    min={1}
                    value={returnQty}
                    data-testid="inventory-return-qty"
                    onChange={(e) => setReturnQty(e.target.value)}
                  />
                </Field>
                <Field label="Condition" className="min-w-[150px]">
                  <Select
                    value={returnCondition}
                    data-testid="inventory-return-condition"
                    onChange={(e) =>
                      setReturnCondition(e.target.value as LiveInventoryReturnCondition)
                    }
                  >
                    <option value="resalable">Resalable — back to stock</option>
                    <option value="damaged">Damaged — not resalable</option>
                  </Select>
                </Field>
                <Field label="Reason" className="min-w-[200px]">
                  <TextInput
                    value={returnReason}
                    placeholder="Required"
                    data-testid="inventory-return-reason"
                    onChange={(e) => setReturnReason(e.target.value)}
                  />
                </Field>
                <Btn
                  variant="outline"
                  disabled={busy}
                  data-testid="inventory-return"
                  onClick={() => {
                    const qty = Number(returnQty);
                    if (!qty || qty <= 0) {
                      announce("Enter how many units came back.");
                      return;
                    }
                    if (!returnReason.trim()) {
                      announce("A return needs a reason.");
                      return;
                    }
                    void runAction(
                      () =>
                        api.inventory.returnStock({
                          locationId: moveLocationId,
                          productId: selected.id,
                          quantity: qty,
                          condition: returnCondition,
                          reason: returnReason.trim(),
                        }),
                      returnCondition === "resalable"
                        ? "Return recorded and restocked."
                        : "Damaged return recorded. Stock was not increased.",
                    ).then(() => {
                      setReturnQty("");
                      setReturnReason("");
                    });
                  }}
                >
                  Record return
                </Btn>
              </div>
            </>
          )}

          {history && history.length > 0 && (
            <TableWrap className="mt-[14px]">
              <thead>
                <tr>
                  <TH>Movement</TH>
                  <TH className="text-right">On hand</TH>
                  <TH className="text-right">Reserved</TH>
                  <TH>Reason</TH>
                  <TH>When</TH>
                </tr>
              </thead>
              <tbody data-testid="inventory-history-rows">
                {history.map((m) => (
                  <tr key={m.id}>
                    <TD className="font-medium">{m.kind}</TD>
                    <TD className="text-right tabular-nums">
                      {m.onHandDelta > 0 ? `+${m.onHandDelta}` : m.onHandDelta || "—"}
                    </TD>
                    <TD className="text-right tabular-nums">
                      {m.reservedDelta > 0 ? `+${m.reservedDelta}` : m.reservedDelta || "—"}
                    </TD>
                    <TD className="text-muted">
                      {m.reason ?? "—"}
                      {m.condition ? ` (${m.condition})` : ""}
                    </TD>
                    <TD className="text-muted">{fmtDate(m.at)}</TD>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Card>
      )}

      <Card className="p-[14px]">
        <CardTitle>Locations, suppliers &amp; tax rates</CardTitle>
        <div className="mt-[10px] flex flex-wrap items-end gap-2">
          <Field label="Add" className="min-w-[140px]">
            <Select
              value={refEntity}
              data-testid="reference-entity"
              onChange={(e) =>
                setRefEntity(e.target.value as "location" | "supplier" | "taxRate")
              }
            >
              <option value="location">Location</option>
              <option value="supplier">Supplier</option>
              <option value="taxRate">Tax rate</option>
            </Select>
          </Field>
          <Field label="Name" className="min-w-[200px]">
            <TextInput
              value={refName}
              data-testid="reference-name"
              onChange={(e) => setRefName(e.target.value)}
            />
          </Field>
          {refEntity === "taxRate" && (
            <Field label="Rate %" className="min-w-[110px]">
              <TextInput
                value={refRate}
                placeholder="8.00"
                data-testid="reference-rate"
                onChange={(e) => setRefRate(e.target.value)}
              />
            </Field>
          )}
          <Btn
            variant="outline"
            disabled={busy}
            data-testid="reference-create"
            onClick={() => {
              if (!refName.trim()) {
                announce("Enter a name.");
                return;
              }
              const rateBps =
                refEntity === "taxRate" ? Math.round((Number(refRate) || 0) * 100) : null;
              if (refEntity === "taxRate" && !rateBps) {
                announce("A tax rate needs a percentage.");
                return;
              }
              void runAction(
                () =>
                  api.inventory.upsertReference({
                    entity: refEntity,
                    name: refName.trim(),
                    rateBps,
                  }),
                "Saved.",
              ).then(() => {
                setRefName("");
                setRefRate("");
              });
            }}
          >
            Save
          </Btn>
        </div>

        <div className="mt-[12px] grid gap-3 md:grid-cols-3">
          <div>
            <div className="text-[11.5px] font-semibold text-subtle">Locations</div>
            <ul className="mt-[4px] mb-0 list-none p-0" data-testid="reference-locations">
              {catalog.locations.length === 0 ? (
                <li className="text-[12.5px] text-faint">None yet</li>
              ) : (
                catalog.locations.map((l) => (
                  <li key={l.id} className="text-[12.5px] text-body">
                    {l.name}
                  </li>
                ))
              )}
            </ul>
          </div>
          <div>
            <div className="text-[11.5px] font-semibold text-subtle">Suppliers</div>
            <ul className="mt-[4px] mb-0 list-none p-0" data-testid="reference-suppliers">
              {catalog.suppliers.length === 0 ? (
                <li className="text-[12.5px] text-faint">None yet</li>
              ) : (
                catalog.suppliers.map((s) => (
                  <li key={s.id} className="text-[12.5px] text-body">
                    {s.name}
                  </li>
                ))
              )}
            </ul>
          </div>
          <div>
            <div className="text-[11.5px] font-semibold text-subtle">Tax rates</div>
            <ul className="mt-[4px] mb-0 list-none p-0" data-testid="reference-tax-rates">
              {catalog.taxRates.length === 0 ? (
                <li className="text-[12.5px] text-faint">None yet</li>
              ) : (
                catalog.taxRates.map((t) => (
                  <li key={t.id} className="text-[12.5px] text-body">
                    {t.name} — {(t.rateBps / 100).toFixed(2)}%
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>
      </Card>
    </div>
  );
}
