import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { LEAD_CONSENT_VERSION, LEAD_PROGRAMS, type LeadProgram } from '@/contracts/leadCampaigns';

/**
 * The confirmation link carries a sealed, expiring statement of what the person asked for: their
 * address, optional first name, the program and the consent wording version, encrypted and authenticated
 * (AES-256-GCM) with the service's own key. Nothing is stored before confirmation, so an unconfirmed
 * sign-up leaves no record anywhere: not here, not in Dittofeed.
 *
 * It is encrypted, not only signed, because the link travels as a query string: a proxy or load balancer
 * access log that records it must learn neither the address nor which program the person asked about.
 *
 * The lead's id in Dittofeed is a keyed hash of the normalised address, so a second confirmation (or a
 * bounce) finds the same person without this service keeping a list.
 */
export const CONFIRM_TTL_MS = 72 * 3_600_000;
export type PendingSignup = { email: string; firstName: string | null; program: LeadProgram; consentVersion: typeof LEAD_CONSENT_VERSION; issuedAt: number };

const AAD = Buffer.from('lead-confirm/2');
const IV_BYTES = 12, TAG_BYTES = 16;

export function sealSignup(key: Buffer, pending: PendingSignup): string {
  if (key.length < 32) throw new Error('lead_signup_key_invalid');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key.subarray(0, 32), iv);
  cipher.setAAD(AAD);
  const body = Buffer.from(JSON.stringify({ e: pending.email, n: pending.firstName, p: pending.program, c: pending.consentVersion, t: pending.issuedAt }));
  const sealed = Buffer.concat([cipher.update(body), cipher.final()]);
  return Buffer.concat([iv, sealed, cipher.getAuthTag()]).toString('base64url');
}
export function openSignup(key: Buffer, token: string, now: number): { ok: true; pending: PendingSignup } | { ok: false; reason: 'invalid' | 'expired' } {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,2048}$/.test(token) || key.length < 32) return { ok: false, reason: 'invalid' };
  const raw = Buffer.from(token, 'base64url');
  if (raw.length <= IV_BYTES + TAG_BYTES) return { ok: false, reason: 'invalid' };
  let parsed: { e?: unknown; n?: unknown; p?: unknown; c?: unknown; t?: unknown };
  try {
    const decipher = createDecipheriv('aes-256-gcm', key.subarray(0, 32), raw.subarray(0, IV_BYTES));
    decipher.setAAD(AAD);
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    const body = Buffer.concat([decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), decipher.final()]);
    parsed = JSON.parse(body.toString('utf8'));
  } catch { return { ok: false, reason: 'invalid' }; }
  if (typeof parsed.e !== 'string' || (parsed.n !== null && typeof parsed.n !== 'string') || !LEAD_PROGRAMS.includes(parsed.p as LeadProgram)
    || parsed.c !== LEAD_CONSENT_VERSION || typeof parsed.t !== 'number') return { ok: false, reason: 'invalid' };
  if (parsed.t > now + 60_000 || now - parsed.t > CONFIRM_TTL_MS) return { ok: false, reason: 'expired' };
  return { ok: true, pending: { email: parsed.e, firstName: parsed.n as string | null, program: parsed.p as LeadProgram, consentVersion: LEAD_CONSENT_VERSION, issuedAt: parsed.t } };
}
/** The lead's id in Dittofeed: a keyed hash of the normalised address (a separate key from the link key). */
export function leadUserId(idKey: Buffer, email: string): string {
  return 'lead_' + createHmac('sha256', idKey).update('lead-id/1\n' + email.trim().toLowerCase()).digest('hex').slice(0, 40);
}
