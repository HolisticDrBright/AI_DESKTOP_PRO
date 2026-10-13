import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACTION_LIFETIME_SECONDS, fullscriptProductDestination, productActionIssued, productActionRedeemed, publicRefusal,
  type ProductActionBinding,
} from '@/contracts/fullscriptConsumerAction';
import type { GovernedCatalogProduct, GovernedCommercialOffer } from '../clinical-core/aws-governed-catalog-reader';
import {
  CONSUMER_PURCHASE_RELEASES, consumerPurchaseCandidate, createConsumerPurchaseCandidate,
  type AdmissionRecord, type ConsumerPurchasePorts, type ConsumerPurchaseRelease, type ConsumerSession, type PatientLink, type ProductActionRecord,
} from './consumer-product-action';

/**
 * The disabled consumer purchase candidate, over fictional ports. Every refusal the WP4 handoff names is
 * here: changed product or label, more than one offer, a restricted product, a revoked patient link, an
 * expired action, another account, a stale session, an arbitrary redirect and replay, plus jurisdiction
 * admission that is declared, validated on the server and never inferred. Not hosted evidence.
 */
const CLINIC = '30000000-0000-4000-8000-000000000001';
const CONNECTION = '40000000-0000-4000-8000-000000000001';
const SLUG = 'fictional-test-dispensary';
const DESTINATION = `https://us.fullscript.com/s/${SLUG}/shop/product/RklDVElPTkFMMQ==?variant=VkFSSUFOVDE=`;
const release = (patch: Partial<ConsumerPurchaseRelease> = {}): ConsumerPurchaseRelease => ({
  contract: 'consumer-purchase-release/1', environment: 'synthetic-staging', tier: 'clinician_connected', jurisdictions: ['US-TX'],
  provider: { name: 'fullscript', dispensarySlug: SLUG, organizationId: CLINIC },
  disclosure: 'FICTIONAL disclosure for tests only.', effectiveFrom: '2026-01-01T00:00:00Z', ...patch,
});
const product = (patch: Partial<GovernedCatalogProduct> = {}): GovernedCatalogProduct => ({
  stableId: 'prd_fictional_one', version: 3, displayName: 'Fictional product one', productType: 'supplement', accessTier: 'open',
  declaredRestricted: false, directOrderAllowed: true, clinical: {}, sourceRefs: ['synthetic:wp4'], reviewStatus: 'approved',
  label: { stableId: 'lbl_fictional_one', version: 2, label: {}, crosscheck: {}, reviewStatus: 'approved' }, ...patch,
});
const offer = (patch: Partial<GovernedCommercialOffer> = {}): GovernedCommercialOffer => ({
  stableId: 'off_fictional_one', version: 5, productStableId: 'prd_fictional_one', destinationUrl: DESTINATION,
  trackingMetadata: {}, reviewStatus: 'approved', ...patch,
});
const binding: ProductActionBinding = { productStableId: 'prd_fictional_one', productVersion: 3, labelStableId: 'lbl_fictional_one', labelVersion: 2,
  offerStableId: 'off_fictional_one', offerVersion: 5 };
let serial = 0;
const requestId = () => `50000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`;
const request = (patch: Record<string, unknown> = {}) => ({ contract: 'fullscript-consumer-action/2', kind: 'product_patient_action',
  purpose: 'supplement_purchase', requestId: requestId(), binding, ...patch });
const declaration = (patch: Record<string, unknown> = {}) => ({ contract: 'purchase-admission/1', jurisdiction: 'US-TX',
  practitioner: { relationship: 'connected', connectionId: CONNECTION }, ...patch });

function world(options: { releases?: ConsumerPurchaseRelease[] } = {}) {
  let now = new Date('2026-10-13T12:00:00Z');
  const state = {
    product: product() as GovernedCatalogProduct | null, offers: [offer()] as GovernedCommercialOffer[],
    links: new Map<string, PatientLink[]>([['account-a', [{ connectionId: CONNECTION, organizationId: CLINIC, state: 'verified' }]]]),
    verified: new Map<string, string[]>([[CLINIC, ['US-TX']]]),
    admissions: new Map<string, AdmissionRecord>(), actions: new Map<string, ProductActionRecord>(), requestIds: new Set<string>(),
  };
  const ports: ConsumerPurchasePorts = {
    catalog: { current: async id => state.product && state.product.stableId === id ? { product: state.product, offers: state.offers } : null },
    patientLinks: { forAccount: async account => state.links.get(account) ?? [] },
    practitionerAuthority: { verifiedJurisdictions: async org => state.verified.get(org) ?? [] },
    admissions: { current: async account => state.admissions.get(account) ?? null, record: async r => { state.admissions.set(r.accountId, r); } },
    actions: {
      insertIfNew: async r => { if (state.requestIds.has(r.requestId)) return false; state.requestIds.add(r.requestId); state.actions.set(r.actionId, { ...r }); return true; },
      get: async id => { const r = state.actions.get(id); return r ? { ...r } : null; },
      spend: async (id, at) => { const r = state.actions.get(id); if (!r || r.redeemedAt !== null) return false; r.redeemedAt = at; return true; },
    },
    clock: { now: () => now },
  };
  const candidate = createConsumerPurchaseCandidate(ports, 'synthetic-staging', options.releases ?? [release()]);
  const session = (account = 'account-a', patch: Partial<ConsumerSession> = {}): ConsumerSession =>
    ({ accountId: account, sessionId: `session-${account}`, authenticatedAt: new Date(now.getTime() - 60_000).toISOString(), revoked: false, ...patch });
  return { candidate, state, ports, session, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}
async function admitted(w = world(), account = 'account-a') {
  expect(await w.candidate.declare(w.session(account), declaration())).toMatchObject({ ok: true, status: { state: 'admitted' } });
  return w;
}
async function issued(w: ReturnType<typeof world>) {
  const result = await w.candidate.issue(w.session(), request());
  if (!result.ok) throw new Error(result.refused);
  return result.issued.data.actionId;
}

describe('disabled by default', () => {
  it('has no release, and with none every call refuses before reading anything', async () => {
    expect(CONSUMER_PURCHASE_RELEASES).toEqual([]);
    expect(Object.isFrozen(CONSUMER_PURCHASE_RELEASES)).toBe(true);
    const touched: string[] = [];
    const trap = new Proxy({}, { get: (_t, key) => { touched.push(String(key)); return new Proxy({}, { get: () => async () => { throw new Error('read'); } }); } }) as ConsumerPurchasePorts;
    const off = consumerPurchaseCandidate({ ...trap, clock: { now: () => new Date('2030-01-01T00:00:00Z') } }, 'synthetic-staging');
    const session: ConsumerSession = { accountId: 'a', sessionId: 's', authenticatedAt: '2029-12-31T23:59:00Z', revoked: false };
    for (const call of [off.declare(session, declaration()), off.admissionStatus(session), off.issue(session, request()), off.redeem(session, { contract: 'fullscript-consumer-action/2', actionId: `act_${'a'.repeat(32)}` })])
      expect(await call).toEqual({ ok: false, refused: 'commerce_disabled' });
    expect(touched.filter(k => k !== 'clock')).toEqual([]);
  });
  it('is constructed by nothing outside this module and its tests: no route reaches it', () => {
    const files: string[] = [];
    const walk = (dir: string) => { for (const name of readdirSync(dir)) { const path = join(dir, name);
      if (statSync(path).isDirectory()) { if (name !== 'node_modules') walk(path); } else if (/\.(ts|tsx|mjs)$/.test(name)) files.push(path); } };
    walk('src'); walk('scripts');
    const users = files.filter(f => !f.endsWith('consumer-product-action.ts') && !/\.test\.(ts|tsx|mjs)$/.test(f))
      .filter(f => /consumer-product-action|createConsumerPurchaseCandidate|consumerPurchaseCandidate/.test(readFileSync(f, 'utf8')));
    expect(users).toEqual([]);
  });
  it('refuses a release that is not yet in effect, covers a wildcard, has no reviewed disclosure, or is ambiguous', async () => {
    for (const releases of [[release({ effectiveFrom: '2027-01-01T00:00:00Z' })], [release({ jurisdictions: ['*'] })], [release({ jurisdictions: [] })],
      [release({ disclosure: ' ' })], [release(), release({ jurisdictions: ['US-CA'] })], [release({ environment: 'production-clinical' })]]) {
      const w = world({ releases });
      expect(await w.candidate.declare(w.session(), declaration()), JSON.stringify(releases)).toEqual({ ok: false, refused: 'commerce_disabled' });
    }
  });
});

describe('purchase admission is declared by the person and validated by the server', () => {
  it('records the declaration and admits it only once server records confirm it', async () => {
    const w = world();
    expect(await w.candidate.admissionStatus(w.session())).toMatchObject({ ok: true, status: { state: 'not_declared', jurisdiction: null, reason: null } });
    expect(await w.candidate.declare(w.session(), declaration())).toMatchObject({ ok: true,
      status: { state: 'admitted', jurisdiction: 'US-TX', practitioner: 'connected', reason: null, recordedAt: '2026-10-13T12:00:00.000Z' } });
  });
  it('refuses a context it was never told rather than guessing one', async () => {
    const w = world();
    expect(await w.candidate.issue(w.session(), request())).toEqual({ ok: false, refused: 'admission_required' });
    for (const extra of [{ ipCountry: 'US' }, { locale: 'en-US' }, { timeZone: 'America/Chicago' }, { region: 'TX' }, { inferred: true }])
      expect(await w.candidate.declare(w.session(), declaration(extra)), JSON.stringify(extra)).toEqual({ ok: false, refused: 'request_invalid' });
    for (const jurisdiction of [undefined, null, '', 'TX', 'us-tx', 'US', '*', 'US-*'])
      expect(await w.candidate.declare(w.session(), declaration({ jurisdiction })), String(jurisdiction)).toEqual({ ok: false, refused: 'request_invalid' });
    expect(await w.candidate.declare(w.session(), declaration({ practitioner: { relationship: 'unknown' } }))).toEqual({ ok: false, refused: 'request_invalid' });
    expect(w.state.admissions.size).toBe(0);
  });
  it('never reads where a request came from: no header, address, locale or zone in the code', () => {
    const code = readFileSync('src/server/fullscript/consumer-product-action.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const forbidden of ['headers', 'x-forwarded', 'ipcountry', 'remoteAddress', 'locale', 'timeZone', 'Intl.', 'geo', 'accept-language'])
      expect(code.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase());
    const contract = readFileSync('src/contracts/fullscriptConsumerAction.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const forbidden of ['locale', 'timeZone', 'Intl.', 'geo']) expect(contract, forbidden).not.toContain(forbidden);
  });
  it.each([
    ['a jurisdiction the release does not cover', (w: ReturnType<typeof world>) => w.candidate.declare(w.session(), declaration({ jurisdiction: 'US-CA' })), 'jurisdiction_not_supported'],
    ['no verified practitioner authority there', (w: ReturnType<typeof world>) => { w.state.verified.set(CLINIC, []); return w.candidate.declare(w.session(), declaration()); }, 'practitioner_jurisdiction_unverified'],
    ['no relationship on the clinician-connected tier', (w: ReturnType<typeof world>) => w.candidate.declare(w.session(), declaration({ practitioner: { relationship: 'none' } })), 'practitioner_relationship_required'],
    ['a connection this account never held', (w: ReturnType<typeof world>) => w.candidate.declare(w.session(), declaration({ practitioner: { relationship: 'connected', connectionId: '40000000-0000-4000-8000-000000000009' } })), 'patient_link_not_found'],
    ['an invitation not yet claimed', (w: ReturnType<typeof world>) => { w.state.links.set('account-a', [{ connectionId: CONNECTION, organizationId: CLINIC, state: 'invitation_pending' }]); return w.candidate.declare(w.session(), declaration()); }, 'patient_link_not_found'],
    ['a revoked patient link', (w: ReturnType<typeof world>) => { w.state.links.set('account-a', [{ connectionId: CONNECTION, organizationId: CLINIC, state: 'revoked' }]); return w.candidate.declare(w.session(), declaration()); }, 'patient_link_revoked'],
    ['a paused patient link', (w: ReturnType<typeof world>) => { w.state.links.set('account-a', [{ connectionId: CONNECTION, organizationId: CLINIC, state: 'paused' }]); return w.candidate.declare(w.session(), declaration()); }, 'patient_link_paused'],
    ['a link to a different clinic', (w: ReturnType<typeof world>) => { w.state.links.set('account-a', [{ connectionId: CONNECTION, organizationId: '30000000-0000-4000-8000-000000000002', state: 'verified' }]); return w.candidate.declare(w.session(), declaration()); }, 'patient_link_other_clinic'],
  ] as const)('refuses %s', async (_name, act, reason) => {
    const w = world();
    expect(await act(w)).toMatchObject({ ok: true, status: { state: 'refused', reason } });
    expect(await w.candidate.issue(w.session(), request())).toEqual({ ok: false, refused: reason });
  });
  it('checks a declared relationship on the consumer tier too, and admits none declared there', async () => {
    const w = world({ releases: [release({ tier: 'consumer' })] });
    w.state.links.set('account-a', [{ connectionId: CONNECTION, organizationId: CLINIC, state: 'revoked' }]);
    expect(await w.candidate.declare(w.session(), declaration())).toMatchObject({ status: { state: 'refused', reason: 'patient_link_revoked' } });
    expect(await w.candidate.declare(w.session(), declaration({ practitioner: { relationship: 'none' } }))).toMatchObject({ status: { state: 'admitted', practitioner: 'none' } });
  });
  it('refuses a stored declaration that no longer matches its digest', async () => {
    const w = await admitted();
    const record = w.state.admissions.get('account-a')!;
    w.state.admissions.set('account-a', { ...record, declaration: { ...record.declaration, jurisdiction: 'US-CA' } });
    expect(await w.candidate.issue(w.session(), request())).toEqual({ ok: false, refused: 'admission_required' });
  });
});

describe('an action is one current product, label and offer for one account and session', () => {
  it('issues an expiring action without an address, then redeems it once for the reviewed destination', async () => {
    const w = await admitted();
    const result = await w.candidate.issue(w.session(), request());
    if (!result.ok) throw new Error(result.refused);
    expect(productActionIssued.safeParse(result.issued).success).toBe(true);
    expect(JSON.stringify(result.issued)).not.toContain('fullscript.com');
    expect(result.issued.data).toMatchObject({ binding, purpose: 'supplement_purchase', syntheticOnly: true });
    expect(Date.parse(result.issued.data.expiresAt) - Date.parse(result.issued.data.issuedAt)).toBe(ACTION_LIFETIME_SECONDS * 1000);
    const redeemed = await w.candidate.redeem(w.session(), { contract: 'fullscript-consumer-action/2', actionId: result.issued.data.actionId });
    expect(redeemed).toMatchObject({ ok: true, redeemed: { data: { destinationUrl: DESTINATION, binding } } });
    if (redeemed.ok) expect(productActionRedeemed.safeParse(redeemed.redeemed).success).toBe(true);
  });
  it.each([
    ['a changed product version', (w: ReturnType<typeof world>) => { w.state.product = product({ version: 4 }); }, 'product_changed'],
    ['a changed label version', (w: ReturnType<typeof world>) => { w.state.product = product({ label: { ...product().label!, version: 3 } }); }, 'label_changed'],
    ['a different label', (w: ReturnType<typeof world>) => { w.state.product = product({ label: { ...product().label!, stableId: 'lbl_fictional_other' } }); }, 'label_changed'],
    ['no label at all', (w: ReturnType<typeof world>) => { w.state.product = product({ label: undefined }); }, 'label_missing'],
    ['a second active offer', (w: ReturnType<typeof world>) => { w.state.offers = [offer(), offer({ stableId: 'off_fictional_two', destinationUrl: DESTINATION.replace('MQ==', 'Mg==') })]; }, 'multiple_offers'],
    ['a changed offer version', (w: ReturnType<typeof world>) => { w.state.offers = [offer({ version: 6 })]; }, 'offer_changed'],
    ['no offer', (w: ReturnType<typeof world>) => { w.state.offers = []; }, 'offer_unavailable'],
    ['ordering withdrawn', (w: ReturnType<typeof world>) => { w.state.product = product({ directOrderAllowed: false }); }, 'offer_unavailable'],
    ['a declared-restricted product', (w: ReturnType<typeof world>) => { w.state.product = product({ declaredRestricted: true }); }, 'product_restricted'],
    ['a practitioner-gated product', (w: ReturnType<typeof world>) => { w.state.product = product({ accessTier: 'practitioner_gated' }); }, 'product_restricted'],
    ['an injectable peptide', (w: ReturnType<typeof world>) => { w.state.product = product({ productType: 'injectable_peptide', accessTier: 'injectable' }); }, 'product_restricted'],
    ['a product the consumer catalog does not return', (w: ReturnType<typeof world>) => { w.state.product = null; }, 'product_unavailable'],
  ] as const)('refuses %s, at issue and again at redemption', async (_name, change, reason) => {
    const atIssue = await admitted();
    change(atIssue);
    expect(await atIssue.candidate.issue(atIssue.session(), request())).toEqual({ ok: false, refused: reason });
    expect(atIssue.state.actions.size).toBe(0);
    const later = await admitted();
    const actionId = await issued(later);
    change(later);
    expect(await later.candidate.redeem(later.session(), { contract: 'fullscript-consumer-action/2', actionId })).toEqual({ ok: false, refused: reason });
    expect(later.state.actions.get(actionId)?.redeemedAt).toBeNull();
  });
  it('refuses a patient link revoked after the action was issued', async () => {
    const w = await admitted();
    const actionId = await issued(w);
    w.state.links.set('account-a', [{ connectionId: CONNECTION, organizationId: CLINIC, state: 'revoked' }]);
    expect(await w.candidate.redeem(w.session(), { contract: 'fullscript-consumer-action/2', actionId })).toEqual({ ok: false, refused: 'patient_link_revoked' });
  });
  it('refuses an expired action, and accepts it one second before', async () => {
    const early = await admitted();
    const ok = await issued(early);
    early.advance(ACTION_LIFETIME_SECONDS * 1000 - 1000);
    expect(await early.candidate.redeem(early.session(), { contract: 'fullscript-consumer-action/2', actionId: ok })).toMatchObject({ ok: true });
    const late = await admitted();
    const expired = await issued(late);
    late.advance(ACTION_LIFETIME_SECONDS * 1000);
    expect(await late.candidate.redeem(late.session(), { contract: 'fullscript-consumer-action/2', actionId: expired })).toEqual({ ok: false, refused: 'action_expired' });
  });
  it("refuses another account's action, and tells that caller it does not exist", async () => {
    const w = await admitted();
    w.state.links.set('account-b', [{ connectionId: CONNECTION, organizationId: CLINIC, state: 'verified' }]);
    await admitted(w, 'account-b');
    const actionId = await issued(w);
    const result = await w.candidate.redeem(w.session('account-b'), { contract: 'fullscript-consumer-action/2', actionId });
    expect(result).toEqual({ ok: false, refused: 'other_account' });
    expect(publicRefusal('other_account')).toBe('action_not_found');
    expect(w.state.actions.get(actionId)?.redeemedAt).toBeNull();
  });
  it('refuses a stale, revoked, future-dated or different session', async () => {
    const w = await admitted();
    const stale = w.session('account-a', { authenticatedAt: new Date(Date.parse('2026-10-13T12:00:00Z') - 901_000).toISOString() });
    expect(await w.candidate.issue(stale, request())).toEqual({ ok: false, refused: 'session_stale' });
    expect(await w.candidate.declare(stale, declaration())).toEqual({ ok: false, refused: 'session_stale' });
    expect(await w.candidate.issue(w.session('account-a', { revoked: true }), request())).toEqual({ ok: false, refused: 'session_stale' });
    expect(await w.candidate.issue(w.session('account-a', { authenticatedAt: '2026-10-13T12:05:00Z' }), request())).toEqual({ ok: false, refused: 'session_stale' });
    expect(await w.candidate.issue(w.session('account-a', { authenticatedAt: 'yesterday' }), request())).toEqual({ ok: false, refused: 'session_stale' });
    const actionId = await issued(w);
    expect(await w.candidate.redeem(w.session('account-a', { sessionId: 'session-other' }), { contract: 'fullscript-consumer-action/2', actionId }))
      .toEqual({ ok: false, refused: 'session_mismatch' });
    // A sign-in that was recent at issue and is no longer recent at redemption, inside the action's lifetime.
    const signedIn = { authenticatedAt: new Date(Date.parse('2026-10-13T12:00:00Z') - 850_000).toISOString() };
    const late = await w.candidate.issue(w.session('account-a', signedIn), request());
    if (!late.ok) throw new Error(late.refused);
    w.advance(100_000);
    expect(await w.candidate.redeem(w.session('account-a', signedIn), { contract: 'fullscript-consumer-action/2', actionId: late.issued.data.actionId }))
      .toEqual({ ok: false, refused: 'session_stale' });
  });
  it.each([
    ['an open redirect parameter', `${DESTINATION}&redirect=https://evil.example`],
    ['a return_to parameter', `https://us.fullscript.com/s/${SLUG}/shop/product/RklDVElPTkFMMQ==?return_to=%2F%2Fevil.example`],
    ['a generic dispensary sign-up page', `https://us.fullscript.com/welcome/${SLUG}/signup`],
    ['another dispensary', DESTINATION.replace(SLUG, 'someone-else')],
    ['another Fullscript host', DESTINATION.replace('us.fullscript.com', 'ca.fullscript.com')],
    ['a look-alike host', DESTINATION.replace('us.fullscript.com', 'us.fullscript.com.evil.example')],
    ['credentials before the host', DESTINATION.replace('https://', 'https://us.fullscript.com@')],
    ['plain http', DESTINATION.replace('https:', 'http:')],
    ['a port', DESTINATION.replace('us.fullscript.com', 'us.fullscript.com:8443')],
    ['a fragment', `${DESTINATION}#next=https://evil.example`],
    ['an encoded path separator', `https://us.fullscript.com/s/${SLUG}/shop/product/RklD%2F..%2F..%2Fx`],
    ['a non-canonical spelling', DESTINATION.replace('us.fullscript.com', 'US.fullscript.com')],
    ['a javascript address', 'javascript:alert(1)'],
  ])('refuses an offer whose address is %s', async (name, destinationUrl) => {
    // The shape check cannot know which dispensary was reviewed; the server compares it with the release.
    if (name === 'another dispensary') expect(fullscriptProductDestination(destinationUrl)).toMatchObject({ dispensarySlug: 'someone-else' });
    else expect(fullscriptProductDestination(destinationUrl)).toBeNull();
    const w = await admitted();
    w.state.offers = [offer({ destinationUrl })];
    expect(await w.candidate.issue(w.session(), request())).toEqual({ ok: false, refused: 'destination_unverified' });
    if (name !== 'another dispensary') expect(productActionRedeemed.safeParse({ contractVersion: 'fullscript-consumer-action/2', environment: 'synthetic-staging', provider: 'fullscript',
      data: { actionId: `act_${'a'.repeat(32)}`, binding, destinationUrl, expiresAt: '2026-10-13T12:10:00Z', syntheticOnly: true } }).success).toBe(false);
  });
  it('accepts the reviewed product page shape, with or without a variant', () => {
    expect(fullscriptProductDestination(DESTINATION)).toEqual({ dispensarySlug: SLUG, productRef: 'RklDVElPTkFMMQ==', variantRef: 'VkFSSUFOVDE=' });
    expect(fullscriptProductDestination(DESTINATION.split('?')[0]!)).toMatchObject({ variantRef: null });
  });
  it('never takes an address, a price or another purpose from the client', async () => {
    const w = await admitted();
    for (const patch of [{ destinationUrl: DESTINATION }, { purpose: 'lab_checkout' }, { kind: 'lab_checkout' }, { price: 1 },
      { binding: { ...binding, offerVersion: undefined } }, { binding: { ...binding, destinationUrl: DESTINATION } }, { contract: 'fullscript-consumer-action/1' }])
      expect(await w.candidate.issue(w.session(), request(patch)), JSON.stringify(patch)).toEqual({ ok: false, refused: 'request_invalid' });
    expect(w.state.actions.size).toBe(0);
  });
  it('refuses a replayed request id, whoever sends it and whatever it binds', async () => {
    const w = await admitted();
    w.state.links.set('account-b', [{ connectionId: CONNECTION, organizationId: CLINIC, state: 'verified' }]);
    await admitted(w, 'account-b');
    const first = request();
    expect(await w.candidate.issue(w.session(), first)).toMatchObject({ ok: true });
    expect(await w.candidate.issue(w.session(), first)).toEqual({ ok: false, refused: 'request_replayed' });
    expect(await w.candidate.issue(w.session('account-b'), { ...first })).toEqual({ ok: false, refused: 'request_replayed' });
    expect(w.state.actions.size).toBe(1);
  });
  it('spends an action exactly once, including under concurrent redemption', async () => {
    const w = await admitted();
    const actionId = await issued(w);
    const redemption = { contract: 'fullscript-consumer-action/2', actionId };
    const results = await Promise.all([w.candidate.redeem(w.session(), redemption), w.candidate.redeem(w.session(), redemption), w.candidate.redeem(w.session(), redemption)]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.filter(r => !r.ok)).toEqual([{ ok: false, refused: 'action_used' }, { ok: false, refused: 'action_used' }]);
    expect(await w.candidate.redeem(w.session(), redemption)).toEqual({ ok: false, refused: 'action_used' });
  });
  it('refuses an unknown or malformed action id', async () => {
    const w = await admitted();
    expect(await w.candidate.redeem(w.session(), { contract: 'fullscript-consumer-action/2', actionId: `act_${'b'.repeat(32)}` })).toEqual({ ok: false, refused: 'action_not_found' });
    expect(await w.candidate.redeem(w.session(), { contract: 'fullscript-consumer-action/2', actionId: 'act_short' })).toEqual({ ok: false, refused: 'request_invalid' });
  });
});

describe('the mirrored contract holds its own boundaries', () => {
  const issuedEnvelope = (patch: Record<string, unknown> = {}, data: Record<string, unknown> = {}) => ({ contractVersion: 'fullscript-consumer-action/2',
    environment: 'synthetic-staging', provider: 'fullscript', ...patch,
    data: { actionId: `act_${'a'.repeat(32)}`, kind: 'product_patient_action', purpose: 'supplement_purchase', binding,
      issuedAt: '2026-10-13T12:00:00Z', expiresAt: '2026-10-13T12:10:00Z', syntheticOnly: true, disclosure: 'FICTIONAL.', ...data } });
  it('refuses an action that outlives ten minutes, expires before it is issued, or carries an address', () => {
    expect(productActionIssued.safeParse(issuedEnvelope()).success).toBe(true);
    expect(productActionIssued.safeParse(issuedEnvelope({}, { expiresAt: '2026-10-13T12:10:01Z' })).success).toBe(false);
    expect(productActionIssued.safeParse(issuedEnvelope({}, { expiresAt: '2026-10-13T12:00:00Z' })).success).toBe(false);
    expect(productActionIssued.safeParse(issuedEnvelope({}, { destinationUrl: DESTINATION })).success).toBe(false);
  });
  it('keeps synthetic actions synthetic and production actions real', () => {
    expect(productActionIssued.safeParse(issuedEnvelope({}, { syntheticOnly: false })).success).toBe(false);
    expect(productActionIssued.safeParse(issuedEnvelope({ environment: 'production-clinical' })).success).toBe(false);
  });
});
