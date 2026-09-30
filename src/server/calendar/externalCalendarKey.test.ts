import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CALENDAR_TOKEN_KEY_FIELD, calendarKeyFromSecret, createCalendarTokenKeyResolver } from './externalCalendarKey';

const ARN = 'arn:aws:secretsmanager:us-east-2:588966314750:secret:external-calendar/token-key-abc123';
const key = randomBytes(32);
const secretString = JSON.stringify({ [CALENDAR_TOKEN_KEY_FIELD]: key.toString('base64') });

const resolver = (environment: Record<string, string | undefined>, SecretString?: string) =>
  createCalendarTokenKeyResolver({
    environment,
    secrets: { send: async () => (SecretString === undefined ? {} : { SecretString }) } as never,
  });

describe('calendar token key', () => {
  it('returns the key when the ARN is in the expected account', async () => {
    const resolve = resolver({ EXTERNAL_CALENDAR_TOKEN_KEY_ARN: ARN, EXPECTED_AWS_ACCOUNT_ID: '588966314750' }, secretString);
    await expect(resolve()).resolves.toEqual(key);
  });

  it('refuses an ARN from another account, including the production one', async () => {
    const production = ARN.replace('588966314750', '173535830222');
    const resolve = resolver({ EXTERNAL_CALENDAR_TOKEN_KEY_ARN: production, EXPECTED_AWS_ACCOUNT_ID: '588966314750' }, secretString);
    await expect(resolve()).rejects.toMatchObject({ refusal: 'account_boundary_refused' });
  });

  it('refuses a missing or malformed ARN and an unset expected account', async () => {
    await expect(resolver({ EXPECTED_AWS_ACCOUNT_ID: '588966314750' }, secretString)()).rejects.toMatchObject({ refusal: 'key_arn_invalid' });
    await expect(resolver({ EXTERNAL_CALENDAR_TOKEN_KEY_ARN: 'a-key-in-plain-text', EXPECTED_AWS_ACCOUNT_ID: '588966314750' }, secretString)())
      .rejects.toMatchObject({ refusal: 'key_arn_invalid' });
    await expect(resolver({ EXTERNAL_CALENDAR_TOKEN_KEY_ARN: ARN }, secretString)()).rejects.toMatchObject({ refusal: 'account_boundary_refused' });
  });

  it('refuses a secret that cannot be read', async () => {
    const resolve = createCalendarTokenKeyResolver({
      environment: { EXTERNAL_CALENDAR_TOKEN_KEY_ARN: ARN, EXPECTED_AWS_ACCOUNT_ID: '588966314750' },
      secrets: { send: async () => { throw new Error('AccessDenied'); } } as never,
    });
    await expect(resolve()).rejects.toMatchObject({ refusal: 'secret_unreadable' });
    await expect(resolver({ EXTERNAL_CALENDAR_TOKEN_KEY_ARN: ARN, EXPECTED_AWS_ACCOUNT_ID: '588966314750' })())
      .rejects.toMatchObject({ refusal: 'secret_unreadable' });
  });

  it('refuses a key of the wrong length or shape rather than padding it', () => {
    for (const bad of [
      'not json',
      JSON.stringify({}),
      JSON.stringify({ [CALENDAR_TOKEN_KEY_FIELD]: '' }),
      JSON.stringify({ [CALENDAR_TOKEN_KEY_FIELD]: randomBytes(16).toString('base64') }),
      JSON.stringify([key.toString('base64')]),
    ]) {
      expect(() => calendarKeyFromSecret(bad), bad).toThrowError(expect.objectContaining({ refusal: 'key_malformed' }));
    }
  });

  it('holds no key material and no account of its own', () => {
    const source = readFileSync('src/server/calendar/externalCalendarKey.ts', 'utf8');
    expect(source).not.toMatch(/console\./);
    // The expected account is supplied by configuration; this file names no account.
    expect(source).not.toMatch(/\b\d{12}\b/);
  });
});
