import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

/**
 * The key that seals a visitor's contact details and a patient's typed name.
 *
 * Resolved per use and never cached in a module, so rotating or revoking the secret takes
 * effect without a deployment, and pinned to the expected account for the same reason the
 * calendar's token key is: a key from the wrong account would either make every stored
 * envelope unopenable or, worse, openable by the wrong deployment.
 */
const SECRET_ARN = /^arn:(aws|aws-us-gov|aws-cn):secretsmanager:[a-z0-9-]+:(\d{12}):secret:[A-Za-z0-9/_+=.@!-]+$/;
export const CONSULT_CONTACT_KEY_FIELD = 'CONSULT_CONTACT_KEY' as const;
const KEY_BYTES = 32;

export type ConsultKeyRefusal = 'key_arn_invalid' | 'account_boundary_refused' | 'secret_unreadable' | 'key_malformed';
export class ConsultKeyError extends Error {
  constructor(readonly refusal: ConsultKeyRefusal) { super(refusal); this.name = 'ConsultKeyError'; }
}

export function consultKeyFromSecret(secretString: string): Buffer {
  let parsed: unknown;
  try { parsed = JSON.parse(secretString.trim()); } catch { throw new ConsultKeyError('key_malformed'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ConsultKeyError('key_malformed');
  const value = (parsed as Record<string, unknown>)[CONSULT_CONTACT_KEY_FIELD];
  if (typeof value !== 'string' || value.trim().length === 0) throw new ConsultKeyError('key_malformed');
  let key: Buffer;
  try { key = Buffer.from(value.trim(), 'base64'); } catch { throw new ConsultKeyError('key_malformed'); }
  // A short key still encrypts; it just does it badly, so the length is required.
  if (key.length !== KEY_BYTES) throw new ConsultKeyError('key_malformed');
  return key;
}

export function createConsultContactKeyResolver(input: {
  environment: Record<string, string | undefined>;
  secrets: Pick<SecretsManagerClient, 'send'>;
}): () => Promise<Buffer> {
  return async () => {
    const arn = (input.environment.CONSULT_CONTACT_KEY_ARN ?? '').trim();
    const expectedAccountId = (input.environment.EXPECTED_AWS_ACCOUNT_ID ?? '').trim();
    const match = arn.match(SECRET_ARN);
    if (!match) throw new ConsultKeyError('key_arn_invalid');
    if (!expectedAccountId || match[2] !== expectedAccountId) throw new ConsultKeyError('account_boundary_refused');
    let secret: { SecretString?: string };
    try { secret = await input.secrets.send(new GetSecretValueCommand({ SecretId: arn }) as never) as { SecretString?: string }; }
    catch { throw new ConsultKeyError('secret_unreadable'); }
    if (typeof secret.SecretString !== 'string') throw new ConsultKeyError('secret_unreadable');
    return consultKeyFromSecret(secret.SecretString);
  };
}
