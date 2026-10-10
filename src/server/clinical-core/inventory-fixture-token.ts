if (typeof window !== 'undefined') throw Error('fictional token verification is server-only');
import { createHmac, createPublicKey, verify, type JsonWebKey } from 'node:crypto';
import { inventoryRecord, inventoryRefuse } from './inventory-qualification-artifacts';
import { fixtureIdentity, type FixtureIntent, type FixtureRole } from './inventory-qualification-fixtures';

const refuse = (): never => inventoryRefuse('fictional_token_authority_refused');
function decode(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 22000) return refuse();
  const b = Buffer.from(value, 'base64url');
  if (b.toString('base64url') !== value) return refuse();
  return b;
}
export function fixtureTokenAuthority(role: FixtureRole) {
  return role === 'workforce' ? { issuer: fixtureIdentity.workforceIssuer, audience: fixtureIdentity.workforceAudience }
    : { issuer: fixtureIdentity.consumerIssuer, audience: fixtureIdentity.consumerAudience };
}

/** Deliberately private, fixed RS256 Cognito verifier, not a general JWT API.
 * JWKS are fetched only from the pinned issuer, never a JWT jku/x5u value. */
export function verifyFixtureToken(token: unknown, jwks: unknown, role: FixtureRole, kind: 'id' | 'access',
  subject: string, intent: FixtureIntent, now: number): void {
  if (typeof token !== 'string' || token.length > 16384 || !Number.isSafeInteger(now)) return refuse();
  const parts = token.split('.'); if (parts.length !== 3) return refuse();
  let header: unknown, claims: unknown;
  try { header = JSON.parse(decode(parts[0]).toString('utf8')); claims = JSON.parse(decode(parts[1]).toString('utf8')); }
  catch { return refuse(); }
  if (!inventoryRecord(header) || !inventoryRecord(claims) || header.alg !== 'RS256'
    || typeof header.kid !== 'string' || header.kid.length < 1 || header.kid.length > 256
    || Object.keys(header).some(k => !['alg', 'kid', 'typ'].includes(k))
    || header.typ !== undefined && header.typ !== 'JWT'
    || !inventoryRecord(jwks) || !Array.isArray(jwks.keys) || !jwks.keys.length || jwks.keys.length > 32) return refuse();
  const keys = new Map<string, Record<string, unknown>>();
  for (const k of jwks.keys) {
    if (!inventoryRecord(k) || typeof k.kid !== 'string' || keys.has(k.kid) || k.kty !== 'RSA'
      || k.alg !== 'RS256' || k.use !== 'sig' || typeof k.n !== 'string' || typeof k.e !== 'string'
      || Object.keys(k).some(name => !['kid', 'kty', 'alg', 'use', 'n', 'e'].includes(name))) return refuse();
    keys.set(k.kid, k);
  }
  const key = keys.get(header.kid); if (!key) return refuse();
  try {
    decode(key.n as string); decode(key.e as string);
    const publicKey = createPublicKey({ key: key as JsonWebKey, format: 'jwk' });
    const bits = publicKey.asymmetricKeyDetails?.modulusLength;
    if (!bits || bits < 2048 || bits > 4096 || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, decode(parts[2]))) return refuse();
  } catch { return refuse(); }
  const a = fixtureTokenAuthority(role), seconds = Math.floor(now / 1000);
  if (claims.iss !== a.issuer || claims.token_use !== kind || claims.sub !== subject
    || !Number.isSafeInteger(claims.exp) || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.auth_time)
    || Number(claims.exp) <= seconds || Number(claims.iat) > seconds + 30 || Number(claims.auth_time) > seconds + 30
    || Number(claims.iat) < seconds - 120 || Number(claims.auth_time) < seconds - 120
    || Number(claims.exp) - Number(claims.iat) > 900 || Number(claims.exp) <= Number(claims.iat)
    || claims['custom:production_bound'] !== undefined) return refuse();
  if (kind === 'id') {
    if (claims.aud !== a.audience || claims.email !== intent.fixtures[role].email || claims.email_verified !== true
      || claims['custom:person_id'] !== intent.fixtures[role].personId
      || claims['custom:organization_id'] !== intent.organizationId || claims['custom:synthetic_attested'] !== 'true') return refuse();
  } else if (claims.client_id !== a.audience || claims.username !== subject || typeof claims.scope !== 'string'
    || !claims.scope.split(' ').includes('aws.cognito.signin.user.admin')) return refuse();
}

export function fictionalTotp(seed: string, now: number): string {
  if (!/^[A-Z2-7]{16,128}$/.test(seed) || !Number.isSafeInteger(now) || now < 0) return refuse();
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, value = 0; const bytes: number[] = [];
  for (const c of seed) { value = (value << 5) | alphabet.indexOf(c); bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); } }
  if (bits && (value & ((1 << bits) - 1))) return refuse();
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(now / 30000)));
  const mac = createHmac('sha1', Buffer.from(bytes)).update(counter).digest(), offset = mac.at(-1)! & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}
