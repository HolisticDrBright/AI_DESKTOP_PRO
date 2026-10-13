import { createHmac, timingSafeEqual } from 'node:crypto';
import { LEAD_CONSENT_VERSION, LEAD_PROGRAMS, type LeadProgram } from '@/contracts/leadCampaigns';

/**
 * The confirmation link carries a sealed, expiring statement of what the person asked for: their
 * address, optional first name, the program and the consent wording version, signed with the
 * service's own key. Nothing is stored before confirmation, so an unconfirmed sign-up leaves no
 * record anywhere: not here, not in Dittofeed.
 *
 * The lead's id in Dittofeed is a keyed hash of the normalised address, so a second confirmation (or a
 * bounce) finds the same person without this service keeping a list.
 */
export const CONFIRM_TTL_MS = 72 * 3_600_000;
export type PendingSignup = { email: string; firstName: string | null; program: LeadProgram; consentVersion: typeof LEAD_CONSENT_VERSION; issuedAt: number };

const b64 = (value: Buffer | string) => Buffer.from(value).toString('base64url');
const mac = (key: Buffer, body: string) => createHmac('sha256', key).update('lead-confirm/1\n' + body).digest();

export function sealSignup(key: Buffer, pending: PendingSignup): string {
  if (key.length < 32) throw new Error('lead_signup_key_invalid');
  const body = b64(JSON.stringify({ e: pending.email, n: pending.firstName, p: pending.program, c: pending.consentVersion, t: pending.issuedAt }));
  return `${body}.${b64(mac(key, body))}`;
}
export function openSignup(key: Buffer, token: string, now: number): { ok: true; pending: PendingSignup } | { ok: false; reason: 'invalid' | 'expired' } {
  if (typeof token !== 'string' || token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) return { ok: false, reason: 'invalid' };
  const [body, signature] = token.split('.') as [string, string];
  const expected = mac(key, body), given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'invalid' };
  let raw: { e?: unknown; n?: unknown; p?: unknown; c?: unknown; t?: unknown };
  try { raw = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return { ok: false, reason: 'invalid' }; }
  if (typeof raw.e !== 'string' || (raw.n !== null && typeof raw.n !== 'string') || !LEAD_PROGRAMS.includes(raw.p as LeadProgram)
    || raw.c !== LEAD_CONSENT_VERSION || typeof raw.t !== 'number') return { ok: false, reason: 'invalid' };
  if (raw.t > now + 60_000 || now - raw.t > CONFIRM_TTL_MS) return { ok: false, reason: 'expired' };
  return { ok: true, pending: { email: raw.e, firstName: raw.n as string | null, program: raw.p as LeadProgram, consentVersion: LEAD_CONSENT_VERSION, issuedAt: raw.t } };
}
/** The lead's id in Dittofeed: a keyed hash of the normalised address (a separate key from the link key). */
export function leadUserId(idKey: Buffer, email: string): string {
  return 'lead_' + createHmac('sha256', idKey).update('lead-id/1\n' + email.trim().toLowerCase()).digest('hex').slice(0, 40);
}
