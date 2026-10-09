import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

/**
 * The key that seals a practitioner's refresh token at rest.
 *
 * It is resolved per use and never cached in a module, so revoking or rotating the
 * secret takes effect without a deployment. The ARN is pinned to the expected account
 * for the same reason every other secret here is: a key from the wrong account would
 * silently make every stored token unopenable, or worse, openable.
 */
const SECRET_ARN = /^arn:(aws|aws-us-gov|aws-cn):secretsmanager:[a-z0-9-]+:(\d{12}):secret:[A-Za-z0-9/_+=.@!-]+$/;
export const CALENDAR_TOKEN_KEY_FIELD = 'EXTERNAL_CALENDAR_TOKEN_KEY' as const;
const KEY_BYTES = 32;

export type CalendarKeyRefusal = 'key_arn_invalid' | 'account_boundary_refused' | 'secret_unreadable' | 'key_malformed';
export class CalendarKeyError extends Error {
  constructor(readonly refusal: CalendarKeyRefusal) { super(refusal); this.name = 'CalendarKeyError'; }
}

/** Parse the secret's contents into a key. Exported so the shape is testable without AWS. */
export function calendarKeyFromSecret(secretString: string): Buffer {
  let parsed: unknown;
  try { parsed = JSON.parse(secretString.trim()); } catch { throw new CalendarKeyError('key_malformed'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CalendarKeyError('key_malformed');
  const value = (parsed as Record<string, unknown>)[CALENDAR_TOKEN_KEY_FIELD];
  if (typeof value !== 'string' || value.trim().length === 0) throw new CalendarKeyError('key_malformed');
  let key: Buffer;
  try { key = Buffer.from(value.trim(), 'base64'); } catch { throw new CalendarKeyError('key_malformed'); }
  // A short key would still encrypt; it would just do it badly, so the length is required.
  if (key.length !== KEY_BYTES) throw new CalendarKeyError('key_malformed');
  return key;
}

export function createCalendarTokenKeyResolver(input: {
  environment: Record<string, string | undefined>;
  secrets: Pick<SecretsManagerClient, 'send'>;
}): () => Promise<Buffer> {
  return async () => {
    const arn = (input.environment.EXTERNAL_CALENDAR_TOKEN_KEY_ARN ?? '').trim();
    const expectedAccountId = (input.environment.EXPECTED_AWS_ACCOUNT_ID ?? '').trim();
    const match = arn.match(SECRET_ARN);
    if (!match) throw new CalendarKeyError('key_arn_invalid');
    if (!expectedAccountId || match[2] !== expectedAccountId) throw new CalendarKeyError('account_boundary_refused');
    let secret: { SecretString?: string };
    try { secret = await input.secrets.send(new GetSecretValueCommand({ SecretId: arn }) as never) as { SecretString?: string }; }
    catch { throw new CalendarKeyError('secret_unreadable'); }
    if (typeof secret.SecretString !== 'string') throw new CalendarKeyError('secret_unreadable');
    return calendarKeyFromSecret(secret.SecretString);
  };
}
