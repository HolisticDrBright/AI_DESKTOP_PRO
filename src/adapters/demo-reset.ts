"use client";

/**
 * RESET DEMO — return the demo edition to its shipped fixtures.
 *
 * Everything a visitor changes in the demo lives in `sessionStorage` under the
 * `aidp:demo:` prefix: review outcomes, the session audit log, front-desk
 * appointment overlays, inventory movements, sales, custom products, lab-order
 * drafts, and every store created through `session-kv`. Reset clears all of it
 * and drops the in-memory caches, so the next render reads the original
 * synthetic dataset.
 *
 * This is deliberately blunt — prefix-sweep plus store registry — because the
 * failure mode to avoid is a *partial* reset that leaves one domain carrying a
 * previous visitor's edits while every other screen looks fresh.
 *
 * Demo-only by construction: the clinical edition has no session fixtures to
 * restore, and calling this there is a programming error.
 */

import { assertDemoEdition } from "@/lib/edition";
import { resetAllSessionStores } from "./session-kv";
import { resetLegacySessionState } from "./session-store";

/** Storage prefix shared by every demo session key. */
export const DEMO_STORAGE_PREFIX = "aidp:demo:";

export interface DemoResetResult {
  /** Number of `aidp:demo:` keys removed from sessionStorage. */
  clearedKeys: number;
}

export function resetDemoState(): DemoResetResult {
  assertDemoEdition("Reset Demo");

  let clearedKeys = 0;

  if (typeof window !== "undefined") {
    try {
      const doomed: string[] = [];
      for (let i = 0; i < window.sessionStorage.length; i += 1) {
        const key = window.sessionStorage.key(i);
        if (key && key.startsWith(DEMO_STORAGE_PREFIX)) doomed.push(key);
      }
      for (const key of doomed) {
        window.sessionStorage.removeItem(key);
        clearedKeys += 1;
      }
    } catch {
      /* storage disabled — the in-memory resets below still apply */
    }
  }

  // Drop in-memory caches and notify subscribers so open screens re-render
  // from the fixtures rather than from a stale cache.
  resetLegacySessionState();
  resetAllSessionStores();

  return { clearedKeys };
}
