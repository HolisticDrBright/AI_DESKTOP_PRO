"use client";

import { useSyncExternalStore } from "react";
import type { ChartEntry, ChartTemplate, ChartValues } from "./charting.mock";

/**
 * Demo chart store — in-session chart entries, one isolated boundary.
 *
 * Entries autosave to `sessionStorage` so a note survives a route reload but is
 * cleared when the browser session ends. This is a demo surface, never a real
 * record: every consumer treats it as "demo — not persisted". The live path
 * will replace these writes with `api.charting.*` mutations against a
 * `chart_entries` table, subscribed through the same hooks below.
 */

const KEY = "aidp:demo:charts";

const listeners = new Set<() => void>();
function emit() {
  for (const l of listeners) l();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

type Store = Record<string, ChartEntry[]>;

let cache: Store | null = null;

function read(): Store {
  if (cache) return cache;
  if (typeof window === "undefined") return {};
  try {
    cache = JSON.parse(window.sessionStorage.getItem(KEY) ?? "{}") as Store;
  } catch {
    cache = {};
  }
  return cache;
}

function write(next: Store) {
  cache = next;
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* quota / private mode — demo only, ignore */
    }
  }
  emit();
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.round(Math.random() * 1e6).toString(36)}`;
}

/** Empty entry seeded from a template — a fresh draft ready to edit. */
export function draftFromTemplate(
  template: ChartTemplate,
  patientId: string,
  author: string,
): ChartEntry {
  const now = new Date().toISOString();
  return {
    id: newId("chart"),
    patientId,
    templateId: template.id,
    title: template.name,
    date: now.slice(0, 10),
    author,
    status: "draft",
    values: {},
    createdAt: now,
    updatedAt: now,
  };
}

export function listChartEntries(patientId: string): ChartEntry[] {
  return read()[patientId] ?? [];
}

export function upsertChartEntry(entry: ChartEntry) {
  const store = read();
  const list = store[entry.patientId] ?? [];
  const idx = list.findIndex((e) => e.id === entry.id);
  const next = { ...entry, updatedAt: new Date().toISOString() };
  const updated = idx >= 0 ? list.map((e, i) => (i === idx ? next : e)) : [next, ...list];
  write({ ...store, [entry.patientId]: updated });
}

export function patchChartValues(
  patientId: string,
  entryId: string,
  values: ChartValues,
) {
  const store = read();
  const list = store[patientId] ?? [];
  const idx = list.findIndex((e) => e.id === entryId);
  if (idx < 0) return;
  const now = new Date().toISOString();
  const updated = list.map((e, i) =>
    i === idx ? { ...e, values, updatedAt: now } : e,
  );
  write({ ...store, [patientId]: updated });
}

export function signChartEntry(patientId: string, entryId: string) {
  const store = read();
  const list = store[patientId] ?? [];
  const now = new Date().toISOString();
  const updated = list.map((e) =>
    e.id === entryId ? { ...e, status: "signed" as const, signedAt: now, updatedAt: now } : e,
  );
  write({ ...store, [patientId]: updated });
}

export function reopenChartEntry(patientId: string, entryId: string) {
  const store = read();
  const list = store[patientId] ?? [];
  const now = new Date().toISOString();
  const updated = list.map((e) =>
    e.id === entryId ? { ...e, status: "draft" as const, signedAt: undefined, updatedAt: now } : e,
  );
  write({ ...store, [patientId]: updated });
}

export function deleteChartEntry(patientId: string, entryId: string) {
  const store = read();
  const list = store[patientId] ?? [];
  write({ ...store, [patientId]: list.filter((e) => e.id !== entryId) });
}

const EMPTY: readonly ChartEntry[] = Object.freeze([]);

export function useChartEntries(patientId: string): ChartEntry[] {
  return useSyncExternalStore(
    subscribe,
    () => listChartEntries(patientId),
    () => EMPTY as ChartEntry[],
  );
}
