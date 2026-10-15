import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Keys and sealed tokens. One 32-byte master secret (a Secrets Manager value, never an environment variable in
 * plain text) derives two keys:
 *
 * - **seal**: AES-256-GCM for every link and form token. The purpose is bound in as additional data, so a
 *   confirmation token cannot be used as an unsubscribe token, or the reverse.
 * - **address**: HMAC-SHA256 of a lowercased address, the id of a contact. A list can be looked up by address
 *   without the store being a dictionary of addresses keyed by their plain text.
 */
export type TokenPurpose = 'join-form' | 'confirm' | 'unsubscribe';
export type CampaignKeys = { seal: Buffer; address: Buffer };

export function deriveCampaignKeys(master: Buffer): CampaignKeys {
  if (master.length !== 32) throw new Error('campaign_key_invalid');
  const derive = (info: string) => Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), `alp-campaign/${info}`, 32));
  return { seal: derive('seal/1'), address: derive('address/1') };
}

export function addressHash(keys: CampaignKeys, email: string): string {
  return createHmac('sha256', keys.address).update(email.trim().toLowerCase()).digest('hex');
}

export function seal(keys: CampaignKeys, purpose: TokenPurpose, payload: Record<string, unknown>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keys.seal, iv);
  cipher.setAAD(Buffer.from(`campaign-token/1:${purpose}`));
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

export function unseal<T extends Record<string, unknown>>(keys: CampaignKeys, purpose: TokenPurpose, token: string): T | null {
  if (typeof token !== 'string' || token.length < 40 || token.length > 600 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  try {
    const raw = Buffer.from(token, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', keys.seal, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(`campaign-token/1:${purpose}`));
    decipher.setAuthTag(raw.subarray(12, 28));
    const value = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as T : null;
  } catch { return null; }
}
