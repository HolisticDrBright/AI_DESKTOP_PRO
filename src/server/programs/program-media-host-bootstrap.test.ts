import { beforeEach, describe, expect, it, vi } from 'vitest';

// Constructors and the bootstrap credential resolver are fictional. These
// tests never resolve ambient credentials, contact metadata or call AWS.
const harness = vi.hoisted(() => ({
  credentials: vi.fn(), failCognito: false,
  sts: [] as { options: Record<string, unknown>; destroy: ReturnType<typeof vi.fn> }[],
  cognito: [] as { options: Record<string, unknown>; destroy: ReturnType<typeof vi.fn> }[],
}));
vi.mock('@aws-sdk/client-sts', async original => ({ ...await original<Record<string, unknown>>(),
  STSClient: class {
    config: { credentials: () => Promise<Record<string, unknown>> };
    destroy = vi.fn();
    constructor(options: Record<string, unknown>) {
      harness.sts.push({ options, destroy: this.destroy });
      this.config = { credentials: options.credentials as (() => Promise<Record<string, unknown>>) ?? harness.credentials };
    }
  },
}));
vi.mock('@aws-sdk/client-cognito-identity-provider', async original => ({ ...await original<Record<string, unknown>>(),
  CognitoIdentityProviderClient: class {
    destroy = vi.fn();
    constructor(options: Record<string, unknown>) {
      if (harness.failCognito) throw new Error('fictional constructor refusal');
      harness.cognito.push({ options, destroy: this.destroy });
    }
  },
}));
import { openNativeProgramMediaHostClients } from './program-media-host-authority';

const temporary = () => ({ accessKeyId: 'ASIA' + 'A'.repeat(16), secretAccessKey: 'x'.repeat(40),
  sessionToken: 'fictional-session-token', expiration: new Date(Date.now() + 900000) });
beforeEach(() => {
  harness.credentials.mockReset(); harness.credentials.mockResolvedValue(temporary());
  harness.sts.length = 0; harness.cognito.length = 0; harness.failCognito = false;
});
describe('native host bootstrap with fictional credential resolver and SDK constructors', () => {
  it('captures one credential copy for fixed-endpoint clients without resolving again', async () => {
    const admitted = temporary(); harness.credentials.mockResolvedValue(admitted);
    const clients = await openNativeProgramMediaHostClients(new AbortController().signal);
    expect(harness.credentials).toHaveBeenCalledTimes(1);
    expect(harness.sts).toHaveLength(2); expect(harness.cognito).toHaveLength(1);
    expect(harness.sts[0].options).toEqual({ region: 'us-east-2', endpoint: 'https://sts.us-east-2.amazonaws.com', maxAttempts: 1 });
    expect(harness.sts[1].options).toMatchObject({ region: 'us-east-2', endpoint: 'https://sts.us-east-2.amazonaws.com', maxAttempts: 1 });
    expect(harness.cognito[0].options).toMatchObject({ region: 'us-east-2', endpoint: 'https://cognito-idp.us-east-2.amazonaws.com', maxAttempts: 1 });
    expect(harness.sts[1].options.credentials).toBe(clients.credential);
    expect(harness.cognito[0].options.credentials).toBe(clients.credential);
    const first = await clients.credential(); admitted.secretAccessKey = 'changed'; admitted.expiration.setTime(0);
    first.secretAccessKey = 'also changed'; first.expiration.setTime(0);
    const next = await clients.credential(); expect(next.secretAccessKey).toBe('x'.repeat(40));
    expect(next.expiration.getTime()).toBeGreaterThan(Date.now());
    expect(harness.credentials).toHaveBeenCalledTimes(1);
    expect(harness.sts[0].destroy).toHaveBeenCalledTimes(1); clients.close();
    expect(harness.sts[1].destroy).toHaveBeenCalledTimes(1); expect(harness.cognito[0].destroy).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['permanent key', { ...temporary(), accessKeyId: 'AKIA' + 'A'.repeat(16) }],
    ['missing expiry', { ...temporary(), expiration: undefined }],
    ['nearly expired', { ...temporary(), expiration: new Date(Date.now() + 1000) }],
    ['missing secret', { ...temporary(), secretAccessKey: undefined }],
    ['short secret', { ...temporary(), secretAccessKey: 'short' }],
    ['empty token', { ...temporary(), sessionToken: '' }],
  ])('refuses %s before constructing service clients', async (_name, credentials) => {
    harness.credentials.mockResolvedValue(credentials);
    await expect(openNativeProgramMediaHostClients(new AbortController().signal)).rejects.toThrow('storage_unverified');
    expect(harness.sts).toHaveLength(1); expect(harness.cognito).toHaveLength(0);
    expect(harness.sts[0].destroy).toHaveBeenCalledTimes(1);
  });
  it('does not resolve credentials for a request already withdrawn', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(openNativeProgramMediaHostClients(controller.signal)).rejects.toThrow('access_refused');
    expect(harness.credentials).not.toHaveBeenCalled(); expect(harness.sts).toHaveLength(0);
  });
  it('closes the partially constructed service client on constructor failure', async () => {
    harness.failCognito = true;
    await expect(openNativeProgramMediaHostClients(new AbortController().signal)).rejects.toThrow('fictional constructor refusal');
    expect(harness.sts).toHaveLength(2);
    expect(harness.sts[0].destroy).toHaveBeenCalledTimes(1); expect(harness.sts[1].destroy).toHaveBeenCalledTimes(1);
  });
  it('withdraws an ignored credential wait and observes its late rejection', async () => {
    let reject!: (reason: unknown) => void;
    harness.credentials.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    const controller = new AbortController(), work = openNativeProgramMediaHostClients(controller.signal);
    const refused = expect(work).rejects.toThrow('access_refused'); controller.abort(); await refused;
    reject(new Error('fictional late credential refusal')); await Promise.resolve();
    expect(harness.sts).toHaveLength(1); expect(harness.sts[0].destroy).toHaveBeenCalledTimes(1);
    expect(harness.cognito).toHaveLength(0);
  });
});
