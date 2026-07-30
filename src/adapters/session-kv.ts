"use client";

import { useSyncExternalStore } from "react";

/**
 * Generic demo session store factory — the same boundary as
 * `session-store.ts` (sessionStorage-backed, per-browser-session, never a
 * pretend backend), packaged so each new mock domain (inbox, billing,
 * programs, automations…) gets `get/set/update/use` without re-implementing
 * caching, persistence, or subscription. Every consumer labels state from
 * here as "demo — this session only".
 */
export interface SessionStore<T> {
  get(): T;
  set(next: T): void;
  update(fn: (current: T) => T): void;
  /** React subscription (useSyncExternalStore). SSR sees `initial`. */
  use(): T;
  reset(): void;
}

export function createSessionStore<T>(storageKey: string, initial: T): SessionStore<T> {
  let cache: T | null = null;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const l of listeners) l();
  };
  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  };

  const read = (): T => {
    if (cache !== null) return cache;
    if (typeof window === "undefined") return initial;
    try {
      const raw = window.sessionStorage.getItem(storageKey);
      cache = raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      cache = initial;
    }
    return cache;
  };

  const write = (next: T) => {
    cache = next;
    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* quota / disabled storage — keep the in-memory mirror */
      }
    }
    emit();
  };

  return {
    get: read,
    set: write,
    update: (fn) => write(fn(read())),
    use: () =>
      useSyncExternalStore(subscribe, read, () => initial),
    reset: () => write(initial),
  };
}

export function newSessionId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `id-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  }
}
