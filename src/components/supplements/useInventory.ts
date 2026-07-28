"use client";

import { useMemo } from "react";
import { SEED_PRODUCTS, type InventoryProduct } from "@/adapters/inventory.mock";
import { useCustomProducts, useInventoryAdjustments } from "@/adapters/session-store";

/**
 * Live dispensary inventory: seed + session-added products, each with EFFECTIVE
 * stock (seed adjusted by this session's sales/restocks). Reactive — updates as
 * soon as a sale or restock happens.
 */
export function useInventory(): InventoryProduct[] {
  const adj = useInventoryAdjustments();
  const custom = useCustomProducts();
  return useMemo(() => {
    const editedIds = new Set(custom.map((p) => p.id));
    return [...custom, ...SEED_PRODUCTS.filter((p) => !editedIds.has(p.id))].map((p) => ({
        ...p,
        stock: Math.max(0, p.stock + (adj[p.id] ?? 0)),
      }));
  }, [adj, custom]);
}
