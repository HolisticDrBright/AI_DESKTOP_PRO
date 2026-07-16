"use client";

import { useSyncExternalStore } from "react";
import type { ActionKind } from "./actions";
import type { InventoryProduct } from "./inventory.mock";

/**
 * Demo session store — the isolated boundary for mock, in-session state.
 *
 * Two concerns live here: the demo audit log and per-subject review outcomes.
 * Both are backed by `sessionStorage` so they survive route reloads within a
 * browser session but are cleared when the session ends — a demo, never a
 * pretend backend. Every consumer treats this as "demo — not persisted".
 *
 * This is the shape a real `api.actions.*` tRPC mutation + `audit_events`
 * table will replace: the components subscribe through the adapter facade and
 * the hooks below, not to sessionStorage directly.
 */

export type ReviewOutcome =
  | "approved"
  | "accepted"
  | "rejected"
  | "flagged"
  | "reviewed"
  | "resolved"
  | "snoozed";

export interface SessionAuditEntry {
  id: string;
  at: string;
  kind: ActionKind;
  subjectType: string;
  subjectLabel: string;
  patientName?: string;
  /** True when the action settles a review as practitioner-reviewed. */
  reviewed: boolean;
  outcome?: ReviewOutcome;
}

const AUDIT_KEY = "aidp:demo:audit";
const REVIEW_KEY = "aidp:demo:reviews";

const EMPTY_AUDIT: readonly SessionAuditEntry[] = Object.freeze([]);

let auditCache: SessionAuditEntry[] | null = null;
let reviewCache: Record<string, ReviewOutcome> | null = null;

const listeners = new Set<() => void>();
function emit() {
  for (const l of listeners) l();
}
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `id-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  }
}

/* ------------------------------------------------------------------ audit */

function readAudit(): SessionAuditEntry[] {
  if (auditCache) return auditCache;
  if (typeof window === "undefined") return auditCache = [];
  try {
    auditCache = JSON.parse(window.sessionStorage.getItem(AUDIT_KEY) ?? "[]");
  } catch {
    auditCache = [];
  }
  return auditCache!;
}

function persistAudit(next: SessionAuditEntry[]) {
  auditCache = next;
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.setItem(AUDIT_KEY, JSON.stringify(next));
    } catch {
      /* quota / disabled storage — keep the in-memory mirror */
    }
  }
  emit();
}

/** Prepend an audit entry (newest first). Returns the stored entry. */
export function recordAuditEntry(
  e: Omit<SessionAuditEntry, "id" | "at"> & { at?: string },
): SessionAuditEntry {
  const entry: SessionAuditEntry = {
    id: newId(),
    at: e.at ?? new Date().toISOString(),
    kind: e.kind,
    subjectType: e.subjectType,
    subjectLabel: e.subjectLabel,
    patientName: e.patientName,
    reviewed: e.reviewed,
    outcome: e.outcome,
  };
  persistAudit([entry, ...readAudit()]);
  return entry;
}

export function listAuditEntries(): SessionAuditEntry[] {
  return readAudit();
}

export function clearAuditEntries() {
  persistAudit([]);
}

/* --------------------------------------------------------------- reviews */

function readReviews(): Record<string, ReviewOutcome> {
  if (reviewCache) return reviewCache;
  if (typeof window === "undefined") return reviewCache = {};
  try {
    reviewCache = JSON.parse(window.sessionStorage.getItem(REVIEW_KEY) ?? "{}");
  } catch {
    reviewCache = {};
  }
  return reviewCache!;
}

function persistReviews(next: Record<string, ReviewOutcome>) {
  reviewCache = next;
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.setItem(REVIEW_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }
  emit();
}

/** Record a review outcome for a stable subject key (e.g. "snapshot:p-78435"). */
export function setReviewOutcome(key: string, outcome: ReviewOutcome) {
  persistReviews({ ...readReviews(), [key]: outcome });
}

export function getReviewOutcome(key: string): ReviewOutcome | undefined {
  return readReviews()[key];
}

/** Remove a single review outcome (used to roll back an optimistic update). */
export function removeReviewOutcome(key: string) {
  const next = { ...readReviews() };
  delete next[key];
  persistReviews(next);
}

export function getReviewSnapshot(): Record<string, ReviewOutcome> {
  return readReviews();
}

export function clearReviewOutcomes() {
  persistReviews({});
}

const EMPTY_REVIEWS: Readonly<Record<string, ReviewOutcome>> = Object.freeze({});

/* -------------------------------------------------- session queue items */

/**
 * Queue items ADDED during this demo session (e.g. "convert to task" from the
 * reasoning workspace). Merged into the tasks queue on render. Session-only.
 */
export interface SessionQueueItem {
  id: string;
  title: string;
  patientName: string;
  patientId: string;
  category: string;
  priority: "High" | "Medium" | "Low";
  createdAt: string;
  seeds: string[];
}

const QUEUE_ADD_KEY = "aidp:demo:queue-added";
let queueCache: SessionQueueItem[] | null = null;
const EMPTY_QUEUE: readonly SessionQueueItem[] = Object.freeze([]);

function readQueue(): SessionQueueItem[] {
  if (queueCache) return queueCache;
  if (typeof window === "undefined") return queueCache = [];
  try {
    queueCache = JSON.parse(window.sessionStorage.getItem(QUEUE_ADD_KEY) ?? "[]");
  } catch {
    queueCache = [];
  }
  return queueCache!;
}

export function addSessionQueueItem(
  item: Omit<SessionQueueItem, "id" | "createdAt">,
): SessionQueueItem {
  const entry: SessionQueueItem = { ...item, id: newId(), createdAt: new Date().toISOString() };
  queueCache = [entry, ...readQueue()];
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.setItem(QUEUE_ADD_KEY, JSON.stringify(queueCache));
    } catch { /* ignore */ }
  }
  emit();
  return entry;
}

export function listSessionQueueItems(): SessionQueueItem[] {
  return readQueue();
}

export function useSessionQueueItems(): SessionQueueItem[] {
  return useSyncExternalStore(
    subscribe,
    listSessionQueueItems,
    () => EMPTY_QUEUE as SessionQueueItem[],
  );
}

/* ----------------------------------------------------------------- hooks */

export function useAuditEntries(): SessionAuditEntry[] {
  return useSyncExternalStore(
    subscribe,
    listAuditEntries,
    () => EMPTY_AUDIT as SessionAuditEntry[],
  );
}

export function useReviewOutcome(key: string): ReviewOutcome | undefined {
  return useSyncExternalStore(
    subscribe,
    () => getReviewOutcome(key),
    () => undefined,
  );
}

export function useReviewOutcomes(): Record<string, ReviewOutcome> {
  return useSyncExternalStore(
    subscribe,
    getReviewSnapshot,
    () => EMPTY_REVIEWS as Record<string, ReviewOutcome>,
  );
}

/* ---------------------------------------------------- dispensary inventory */

/**
 * Supplement dispensary state (demo/session): net inventory movements and the
 * sales log. Effective stock = seed + net movement, so selling counts stock
 * down and restocking counts it up — all session-only, cleared with the tab.
 */

export interface SaleLine {
  productId: string;
  name: string;
  qty: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
}

export interface Sale {
  id: string;
  at: string;
  patientId: string;
  patientName: string;
  lines: SaleLine[];
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
}

const INV_ADJ_KEY = "aidp:demo:inventory-adj";
const SALES_KEY = "aidp:demo:sales";
const EMPTY_ADJ: Readonly<Record<string, number>> = Object.freeze({});
const EMPTY_SALES: readonly Sale[] = Object.freeze([]);

let invAdjCache: Record<string, number> | null = null;
let salesCache: Sale[] | null = null;

function readInvAdj(): Record<string, number> {
  if (invAdjCache) return invAdjCache;
  if (typeof window === "undefined") return (invAdjCache = {});
  try {
    invAdjCache = JSON.parse(window.sessionStorage.getItem(INV_ADJ_KEY) ?? "{}");
  } catch {
    invAdjCache = {};
  }
  return invAdjCache!;
}

function persistInvAdj(next: Record<string, number>) {
  invAdjCache = next;
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.setItem(INV_ADJ_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }
  emit();
}

/** Net session movement for a product (negative = sold, positive = restocked). */
export function getInventoryAdjustments(): Record<string, number> {
  return readInvAdj();
}

export function adjustInventory(productId: string, delta: number) {
  const cur = readInvAdj();
  persistInvAdj({ ...cur, [productId]: (cur[productId] ?? 0) + delta });
}

/** Set the net adjustment so effective stock becomes `target`, given `seed`. */
export function setInventoryLevel(productId: string, seed: number, target: number) {
  const cur = readInvAdj();
  persistInvAdj({ ...cur, [productId]: target - seed });
}

export function useInventoryAdjustments(): Record<string, number> {
  return useSyncExternalStore(
    subscribe,
    getInventoryAdjustments,
    () => EMPTY_ADJ as Record<string, number>,
  );
}

function readSales(): Sale[] {
  if (salesCache) return salesCache;
  if (typeof window === "undefined") return (salesCache = []);
  try {
    salesCache = JSON.parse(window.sessionStorage.getItem(SALES_KEY) ?? "[]");
  } catch {
    salesCache = [];
  }
  return salesCache!;
}

function persistSales(next: Sale[]) {
  salesCache = next;
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.setItem(SALES_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }
  emit();
}

export function recordSale(sale: Omit<Sale, "id" | "at"> & { at?: string }): Sale {
  const entry: Sale = { ...sale, id: newId(), at: sale.at ?? new Date().toISOString() };
  persistSales([entry, ...readSales()]);
  return entry;
}

export function listSales(): Sale[] {
  return readSales();
}

export function useSales(): Sale[] {
  return useSyncExternalStore(subscribe, listSales, () => EMPTY_SALES as Sale[]);
}

/* ------------------------------------------- dispensary: added products */

const CUSTOM_PRODUCTS_KEY = "aidp:demo:custom-products";
const EMPTY_PRODUCTS: readonly InventoryProduct[] = Object.freeze([]);
let customProductsCache: InventoryProduct[] | null = null;

function readCustomProducts(): InventoryProduct[] {
  if (customProductsCache) return customProductsCache;
  if (typeof window === "undefined") return (customProductsCache = []);
  try {
    customProductsCache = JSON.parse(window.sessionStorage.getItem(CUSTOM_PRODUCTS_KEY) ?? "[]");
  } catch {
    customProductsCache = [];
  }
  return customProductsCache!;
}

function persistCustomProducts(next: InventoryProduct[]) {
  customProductsCache = next;
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.setItem(CUSTOM_PRODUCTS_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }
  emit();
}

/** Add a product to inventory this session (prepended, newest first). */
export function addCustomProduct(product: InventoryProduct) {
  persistCustomProducts([product, ...readCustomProducts()]);
}

export function listCustomProducts(): InventoryProduct[] {
  return readCustomProducts();
}

export function useCustomProducts(): InventoryProduct[] {
  return useSyncExternalStore(
    subscribe,
    listCustomProducts,
    () => EMPTY_PRODUCTS as InventoryProduct[],
  );
}
