import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { ConsultIntakeRequest, PublicConsultBrowserRequest } from '@/contracts/consultRequests';

/**
 * Contact details for a consult request, and the typed name on a signature.
 *
 * Both are sealed here and stored as opaque bytes, for the same reason the calendar's
 * refresh tokens are: the row is not the place for something that only the service is ever
 * meant to read. The binding is passed as additional authenticated data, so an envelope
 * lifted from one request and pasted into another fails to open rather than opening as
 * somebody else's name.
 *
 * The digest exists for two jobs and no others: counting repeat submissions for the
 * throttle, and letting a visitor prove which request is theirs when they withdraw it. It
 * is taken over a normalised address, because a person who typed `A@Example.test` on Monday
 * will type `a@example.test` on Tuesday and means the same inbox.
 */
const KEY_BYTES = 32;
export type SealedEnvelope = { ciphertext: string; iv: string; tag: string };
export type EnvelopeRefusal = 'key_invalid' | 'binding_absent' | 'value_absent' | 'envelope_malformed' | 'not_authentic';
export class ConsultEnvelopeError extends Error {
  constructor(readonly refusal: EnvelopeRefusal) { super(refusal); this.name = 'ConsultEnvelopeError'; }
}

export function seal(key: Buffer, binding: string, value: string): SealedEnvelope {
  if (key.length !== KEY_BYTES) throw new ConsultEnvelopeError('key_invalid');
  if (binding.trim().length === 0) throw new ConsultEnvelopeError('binding_absent');
  if (value.length === 0) throw new ConsultEnvelopeError('value_absent');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(binding));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export function open(key: Buffer, binding: string, sealed: SealedEnvelope): string {
  if (key.length !== KEY_BYTES) throw new ConsultEnvelopeError('key_invalid');
  if (binding.trim().length === 0) throw new ConsultEnvelopeError('binding_absent');
  let iv: Buffer; let tag: Buffer; let ciphertext: Buffer;
  try {
    iv = Buffer.from(sealed.iv, 'base64'); tag = Buffer.from(sealed.tag, 'base64');
    ciphertext = Buffer.from(sealed.ciphertext, 'base64');
  } catch { throw new ConsultEnvelopeError('envelope_malformed'); }
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) throw new ConsultEnvelopeError('envelope_malformed');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(binding));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch { throw new ConsultEnvelopeError('not_authentic'); }
}

/** The normalised address a digest is taken over. Case and surrounding space only. */
export const normaliseAddress = (email: string) => email.trim().toLowerCase();
export const contactDigestFor = (email: string) =>
  createHash('sha256').update(normaliseAddress(email)).digest('hex');
export const consultContactBinding = (slug: string, contactDigest: string) =>
  `consult-contact:${slug}:${contactDigest}`;
/** The digest recorded beside a signature's typed name, over the same normalisation. */
export const typedNameDigestFor = (typedName: string) =>
  createHash('sha256').update(typedName.trim().replace(/\s+/g, ' ')).digest('hex');

export type VisitorContact = { name: string; email: string; phone: string | null };

/**
 * A browser's submission, turned into what the database accepts. The plaintext contact
 * stops here: what leaves is an envelope and a digest.
 */
export function prepareConsultSubmission(key: Buffer, body: PublicConsultBrowserRequest): ConsultIntakeRequest {
  if (body.action === 'describe') return body;
  if (body.action === 'withdraw') {
    return { action: 'withdraw', reference: body.reference, contactDigest: contactDigestFor(body.email) };
  }
  const contactDigest = contactDigestFor(body.email);
  const contact: VisitorContact = {
    name: body.name.trim(), email: normaliseAddress(body.email),
    phone: body.phone?.trim() ? body.phone.trim() : null,
  };
  return {
    action: 'submit', slug: body.slug, contactDigest,
    contact: seal(key, consultContactBinding(body.slug, contactDigest), JSON.stringify(contact)),
    visitType: body.visitType, reasonCode: body.reasonCode,
    preferredWindows: body.preferredWindows, timeZone: body.timeZone?.trim() ? body.timeZone.trim() : null,
  };
}

/** The contact behind a request the clinic has chosen to open. */
export function openVisitorContact(
  key: Buffer, opened: { slug: string; contactDigest: string; contact: SealedEnvelope },
): VisitorContact {
  const raw = open(key, consultContactBinding(opened.slug, opened.contactDigest), opened.contact);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new ConsultEnvelopeError('envelope_malformed'); }
  if (!parsed || typeof parsed !== 'object') throw new ConsultEnvelopeError('envelope_malformed');
  const record = parsed as Record<string, unknown>;
  if (typeof record.name !== 'string' || typeof record.email !== 'string') {
    throw new ConsultEnvelopeError('envelope_malformed');
  }
  // The envelope authenticated against this row's digest; that the address inside also
  // hashes to it is the second half of the same claim, and it is cheap to check.
  const expected = Buffer.from(opened.contactDigest, 'hex');
  const actual = Buffer.from(contactDigestFor(record.email), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new ConsultEnvelopeError('not_authentic');
  }
  return {
    name: record.name, email: record.email,
    phone: typeof record.phone === 'string' && record.phone.length > 0 ? record.phone : null,
  };
}
