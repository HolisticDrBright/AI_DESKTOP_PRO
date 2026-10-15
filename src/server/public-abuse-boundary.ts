import { createHash } from 'node:crypto';

/**
 * The shared rate-limit and bot-abuse boundary for the public practitioner journey: account sign-up and code resend,
 * application submission, withdrawal and status polling. INACTIVE: no reviewed backing service exists, so
 * `sharedAbuseBoundary()` returns the inactive boundary and the per-process throttles in each route stay the only limit.
 * A per-process counter is not a shared limit (each instance counts alone) and is not bot protection.
 *
 * What activating it means, recorded here so it is reviewed as code rather than invented at deploy time:
 * - One atomic, shared counter service (`AbuseCounterStore`): an increment-and-read within a fixed window, on keys
 *   that are SHA-256 digests only. Never a raw email address, a code, a name or a clinic proposal.
 * - The limits below, per surface and per key kind. Each request is counted against every key it carries.
 * - Fail closed: when the boundary is active and the counter cannot answer, the request is refused as unavailable,
 *   not admitted. An inactive boundary admits, because the route's own throttle still applies.
 * - Edge bot protection (a managed challenge in front of the sign-up and application routes) is a separate reviewed
 *   service and is not represented here.
 */
export const ABUSE_SURFACES = ['workforce_signup_start', 'workforce_signup_confirm', 'workforce_signup_code_resend',
  'workforce_application_submit', 'workforce_application_withdraw', 'workforce_application_status'] as const;
export type AbuseSurface = typeof ABUSE_SURFACES[number];
export type AbuseKeyKind = 'client' | 'email' | 'subject';
export type AbuseDecision = 'admitted' | 'limited' | 'unavailable';

/** Requests allowed per key per window. A key kind a surface does not list is not counted for it. */
export const SHARED_ABUSE_LIMITS: Readonly<Record<AbuseSurface, { windowSeconds: number; limits: Partial<Record<AbuseKeyKind, number>> }>> = {
  workforce_signup_start: { windowSeconds: 900, limits: { client: 20, email: 3 } },
  workforce_signup_confirm: { windowSeconds: 900, limits: { client: 30, email: 10 } },
  workforce_signup_code_resend: { windowSeconds: 900, limits: { client: 10, email: 3 } },
  workforce_application_submit: { windowSeconds: 3600, limits: { client: 20, subject: 5 } },
  workforce_application_withdraw: { windowSeconds: 3600, limits: { client: 20, subject: 5 } },
  // A person checking their own status, by hand or by a page that refreshes politely; not a scraper.
  workforce_application_status: { windowSeconds: 900, limits: { client: 120, subject: 60 } },
};

export interface AbuseCounterStore {
  /** Atomically increments `key` in the window that starts at `windowStart` and returns the new count. */
  increment(key: string, windowStart: number, windowSeconds: number): Promise<number>;
}
export interface PublicAbuseBoundary {
  readonly active: boolean;
  decide(surface: AbuseSurface, keys: Partial<Record<AbuseKeyKind, string>>): Promise<AbuseDecision>;
}

export const INACTIVE_ABUSE_BOUNDARY: PublicAbuseBoundary = Object.freeze({ active: false, decide: async () => 'admitted' as const });

/** Digest of a key value; the boundary is never given, and never stores, the value itself. */
export function abuseKey(kind: AbuseKeyKind, value: string): string {
  return createHash('sha256').update(`${kind}:${kind === 'email' ? value.trim().toLowerCase() : value}`).digest('hex');
}

/** The reviewed boundary over a counter store. Used only by tests until a backing service is reviewed. */
export function createSharedAbuseBoundary(store: AbuseCounterStore, now: () => number = Date.now): PublicAbuseBoundary {
  return {
    active: true,
    async decide(surface, keys) {
      const policy = SHARED_ABUSE_LIMITS[surface];
      if (!policy) return 'unavailable';
      const windowStart = Math.floor(now() / 1000 / policy.windowSeconds) * policy.windowSeconds;
      try {
        for (const [kind, limit] of Object.entries(policy.limits) as Array<[AbuseKeyKind, number]>) {
          const digest = keys[kind];
          if (digest === undefined) continue;
          if (!/^[a-f0-9]{64}$/.test(digest)) return 'unavailable';
          if (await store.increment(`${surface}:${kind}:${digest}`, windowStart, policy.windowSeconds) > limit) return 'limited';
        }
        return 'admitted';
      } catch {
        return 'unavailable';
      }
    },
  };
}

/** The boundary this build uses: inactive, because no reviewed shared counter service exists. */
export function sharedAbuseBoundary(): PublicAbuseBoundary {
  return INACTIVE_ABUSE_BOUNDARY;
}
