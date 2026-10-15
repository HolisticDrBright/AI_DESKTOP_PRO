import { describe, expect, it } from 'vitest';
import { createCatalogPickerController, type CatalogPickerScope, type CatalogPickerState } from './catalogPicker';
import { catalogHold, type ObservedCatalogProduct, type ProgramCatalogObservation } from '@/contracts/programCatalogObservation';

/**
 * The picker's journeys as plain sequences, with a reader the test controls: exact selection, a
 * genuine empty result, each way the catalog cannot be observed, a changed release, a reply for
 * another clinic or another draft, a reply that arrives after the step was edited or deleted, a
 * superseded search, held products and a single result that is never selected on its own.
 */
const VERSION = '11111111-1111-4111-8111-111111111111';
const OTHER_VERSION = '22222222-2222-4222-8222-222222222222';
const scope = (over: Partial<CatalogPickerScope> = {}): CatalogPickerScope =>
  ({ versionId: VERSION, stepId: 'supp-1', stepRevision: 'supp-1|supplement|product-1', session: '1', ...over });
const product = (over: Partial<ObservedCatalogProduct> = {}): ObservedCatalogProduct => ({
  stableId: 'prd_fictional_magnesium', version: 3, displayName: 'Fictional magnesium', productType: 'supplement', accessTier: 'open',
  declaredRestricted: false, directOrderAllowed: true, labelVersion: 2, ...over,
});
const observation = (over: Partial<ProgramCatalogObservation> = {}): ProgramCatalogObservation => ({
  contractVersion: 'program-catalog-observation/2', clinic: 'clinic-a', versionId: VERSION, target: 'synthetic-staging',
  observedAt: '2026-10-11T12:00:00.000Z', query: '', products: [product()], catalogSize: 1, complete: true, ...over,
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('exact selection', () => {
  it('binds the exact stable id, the observed release and the observed target, and only from the observation on screen', async () => {
    const states: CatalogPickerState[] = [];
    const controller = createCatalogPickerController({ read: async () => observation(), scope: scope(), onChange: s => states.push(s) });
    expect(controller.select('prd_fictional_magnesium')).toEqual({ ok: false, reason: 'no_observation' });
    const outcome = await controller.search('');
    expect(outcome.applied).toBe(true);
    expect(controller.state().kind).toBe('observed');
    expect(states.map(s => s.kind)).toEqual(['reading', 'observed']);
    const selected = controller.select('prd_fictional_magnesium');
    expect(selected).toMatchObject({ ok: true, binding: { stableId: 'prd_fictional_magnesium', version: 3, target: 'synthetic-staging' } });
    expect(controller.select('prd_fictional_zinc')).toEqual({ ok: false, reason: 'not_observed' });
    expect(controller.clinic()).toBe('clinic-a');
  });
  it('never selects on its own, even when one product is observed', async () => {
    const controller = createCatalogPickerController({ read: async () => observation(), scope: scope() });
    await controller.search('magnes');
    expect(controller.state().kind).toBe('observed');
    expect(controller.bindingStatus(undefined)).toEqual({ status: 'unobserved' });
  });
  it('binds nothing to a stale observation: a reply for a different draft is refused', async () => {
    const controller = createCatalogPickerController({ read: async () => observation({ versionId: OTHER_VERSION }), scope: scope() });
    await controller.search('');
    expect(controller.state()).toMatchObject({ kind: 'unavailable', reason: 'other_draft' });
    expect(controller.select('prd_fictional_magnesium')).toEqual({ ok: false, reason: 'no_observation' });
  });
});

describe('empty and unavailable are different claims', () => {
  it('a genuine empty result is a match result with the observed catalog size, not an outage', async () => {
    const controller = createCatalogPickerController({ read: async () => observation({ query: 'zinc', products: [], catalogSize: 12 }), scope: scope() });
    await controller.search('zinc');
    expect(controller.state()).toMatchObject({ kind: 'empty', observation: { catalogSize: 12, query: 'zinc' } });
  });
  it.each([
    ['a thrown adapter error with no code', new Error('fetch failed'), 'service_unavailable'],
    ['an expired session', Object.assign(new Error('x'), { code: 'unauthenticated' }), 'reauth_required'],
    ['a refused identity', Object.assign(new Error('x'), { code: 'forbidden' }), 'identity_refused'],
    ['an unverifiable catalog named by the route', Object.assign(new Error('catalog_unverifiable'), { code: 'unavailable' }), 'catalog_unverifiable'],
    ['a target that changed mid-read', Object.assign(new Error('catalog_target_changed'), { code: 'unavailable' }), 'catalog_target_changed'],
  ])('%s blocks selection and keeps the binding: %s', async (_name, error, reason) => {
    const controller = createCatalogPickerController({ read: async () => { throw error; }, scope: scope() });
    await controller.search('');
    expect(controller.state()).toMatchObject({ kind: 'unavailable', reason });
    expect(controller.select('prd_fictional_magnesium')).toEqual({ ok: false, reason: 'no_observation' });
    expect(controller.bindingStatus({ stableId: 'prd_fictional_magnesium', version: 3, target: 'synthetic-staging' })).toEqual({ status: 'unobserved' });
  });
  it('a reply that is not the published observation contract is unverifiable, whatever it contains', async () => {
    const controller = createCatalogPickerController({ read: async () => ({ products: [product()] }), scope: scope() });
    await controller.search('');
    expect(controller.state()).toMatchObject({ kind: 'unavailable', reason: 'catalog_unverifiable' });
  });
});

describe('a changed release is shown, never applied', () => {
  const binding = { stableId: 'prd_fictional_magnesium', version: 3, target: 'synthetic-staging' as const };
  it('reports the observed release next to the bound one and rebinds only on an explicit selection', async () => {
    const controller = createCatalogPickerController({ read: async () => observation({ products: [product({ version: 4 })] }), scope: scope() });
    await controller.search('');
    expect(controller.bindingStatus(binding)).toMatchObject({ status: 'release_changed', observedVersion: 4 });
    expect(controller.select('prd_fictional_magnesium')).toMatchObject({ ok: true, binding: { ...binding, version: 4 } });
  });
  it('reports a different observed target and keeps the binding', async () => {
    const controller = createCatalogPickerController({ read: async () => observation({ target: 'production-clinical',
      products: [product({ labelVersion: null, labelVersionId: '33333333-3333-4333-8333-333333333333', sourceVerified: true })],
    }), scope: scope() });
    await controller.search('');
    expect(controller.bindingStatus(binding)).toMatchObject({ status: 'target_differs', observedTarget: 'production-clinical' });
  });
  it('distinguishes "not in this search" from "not in the whole observed catalog"', async () => {
    const narrowed = createCatalogPickerController({ read: async () => observation({ query: 'zinc', products: [] }), scope: scope() });
    await narrowed.search('zinc');
    expect(narrowed.bindingStatus(binding)).toEqual({ status: 'not_in_result', wholeCatalog: false });
    const whole = createCatalogPickerController({ read: async () => observation({ products: [product({ stableId: 'prd_fictional_zinc' })] }), scope: scope() });
    await whole.search('');
    expect(whole.bindingStatus(binding)).toEqual({ status: 'not_in_result', wholeCatalog: true });
    const prefix = createCatalogPickerController({ read: async () => observation({ products: [product({ stableId: 'prd_fictional_zinc' })], complete: false }), scope: scope() });
    await prefix.search('');
    expect(prefix.bindingStatus(binding)).toEqual({ status: 'not_in_result', wholeCatalog: false });
  });
  it('says current only when stable id, release and target all match', async () => {
    const controller = createCatalogPickerController({ read: async () => observation(), scope: scope() });
    await controller.search('');
    expect(controller.bindingStatus(binding)).toMatchObject({ status: 'current' });
  });
});

describe('cross-clinic and stale replies', () => {
  it('refuses a reply naming a different clinic from the first accepted one, and keeps the first clinic', async () => {
    let clinic = 'clinic-a';
    const controller = createCatalogPickerController({ read: async () => observation({ clinic }), scope: scope() });
    await controller.search('');
    clinic = 'clinic-b';
    await controller.search('');
    expect(controller.state()).toMatchObject({ kind: 'unavailable', reason: 'cross_clinic' });
    expect(controller.clinic()).toBe('clinic-a');
  });
  it('learns the clinic again after a new Studio session, so a re-sign-in into another clinic is not a cross-clinic refusal', async () => {
    let clinic = 'clinic-a';
    const controller = createCatalogPickerController({ read: async () => observation({ clinic }), scope: scope() });
    await controller.search('');
    controller.rebind(scope({ session: '2' }));
    expect(controller.state()).toEqual({ kind: 'idle', note: 'scope_changed' });
    clinic = 'clinic-b';
    await controller.search('');
    expect(controller.state().kind).toBe('observed');
    expect(controller.clinic()).toBe('clinic-b');
  });
  it('discards a reply that arrives after the session changed during the read', async () => {
    const pending = deferred<ProgramCatalogObservation>();
    const controller = createCatalogPickerController({ read: () => pending.promise, scope: scope() });
    const search = controller.search('');
    controller.rebind(scope({ session: '2' }));
    pending.resolve(observation());
    expect(await search).toEqual({ applied: false, discarded: 'scope_changed' });
    expect(controller.state()).toEqual({ kind: 'idle', note: 'scope_changed' });
  });
  it('discards an earlier reply when a later search was started, whichever order they settle in', async () => {
    const first = deferred<ProgramCatalogObservation>(), second = deferred<ProgramCatalogObservation>();
    let calls = 0;
    const controller = createCatalogPickerController({ read: () => (calls++ === 0 ? first.promise : second.promise), scope: scope() });
    const a = controller.search('magnes');
    const b = controller.search('zinc');
    second.resolve(observation({ query: 'zinc', products: [], catalogSize: 3 }));
    expect(await b).toMatchObject({ applied: true, state: { kind: 'empty' } });
    first.resolve(observation({ query: 'magnes' }));
    expect(await a).toEqual({ applied: false, discarded: 'superseded' });
    expect(controller.state().kind).toBe('empty');
  });
});

describe('the target step changes during the read', () => {
  it('discards the reply when the step was edited (its identity changed) while the catalog was being read', async () => {
    const pending = deferred<ProgramCatalogObservation>();
    const controller = createCatalogPickerController({ read: () => pending.promise, scope: scope() });
    const search = controller.search('');
    controller.rebind(scope({ stepRevision: 'supp-1|supplement|product-2' }));
    pending.resolve(observation());
    expect(await search).toEqual({ applied: false, discarded: 'scope_changed' });
    expect(controller.select('prd_fictional_magnesium')).toEqual({ ok: false, reason: 'no_observation' });
  });
  it('discards the reply when the panel now shows a different step', async () => {
    const pending = deferred<ProgramCatalogObservation>();
    const controller = createCatalogPickerController({ read: () => pending.promise, scope: scope() });
    const search = controller.search('');
    controller.rebind(scope({ stepId: 'supp-2', stepRevision: 'supp-2|supplement|product-9' }));
    pending.resolve(observation());
    expect(await search).toEqual({ applied: false, discarded: 'scope_changed' });
  });
  it('discards the reply when the step was deleted (the panel disposed) during the read', async () => {
    const pending = deferred<ProgramCatalogObservation>();
    const states: CatalogPickerState[] = [];
    const controller = createCatalogPickerController({ read: () => pending.promise, scope: scope(), onChange: s => states.push(s) });
    const search = controller.search('');
    controller.dispose();
    pending.resolve(observation());
    expect(await search).toEqual({ applied: false, discarded: 'disposed' });
    expect(states.map(s => s.kind)).toEqual(['reading']);
    expect(await controller.search('')).toEqual({ applied: false, discarded: 'disposed' });
  });
  it('discards the reply when the draft version changed during the read', async () => {
    const pending = deferred<ProgramCatalogObservation>();
    const controller = createCatalogPickerController({ read: () => pending.promise, scope: scope() });
    const search = controller.search('');
    controller.rebind(scope({ versionId: OTHER_VERSION }));
    pending.resolve(observation());
    expect(await search).toEqual({ applied: false, discarded: 'scope_changed' });
  });
  it('a rebind to the same scope changes nothing', async () => {
    const controller = createCatalogPickerController({ read: async () => observation(), scope: scope() });
    await controller.search('');
    controller.rebind(scope());
    expect(controller.state().kind).toBe('observed');
  });
});

describe('held products', () => {
  it('holds production products until the exact UUID label has source-V proof, even when direct ordering is declared', async () => {
    const unverified = product({ labelVersion: null, labelVersionId: '33333333-3333-4333-8333-333333333333', sourceVerified: false });
    const controller = createCatalogPickerController({ read: async () => observation({ target: 'production-clinical', products: [unverified] }), scope: scope() });
    await controller.search('');
    expect(controller.select(unverified.stableId)).toEqual({ ok: false, reason: 'held', hold: 'source_unverified' });
    const verified = product({ ...unverified, sourceVerified: true });
    const allowed = createCatalogPickerController({ read: async () => observation({ target: 'production-clinical', products: [verified] }), scope: scope() });
    await allowed.search('');
    expect(allowed.select(verified.stableId)).toMatchObject({ ok: true, binding: { stableId: verified.stableId, version: 3,
      target: 'production-clinical' } });
    expect(catalogHold(product({ ...verified, productType: 'other' }), 'production-clinical')).toBe('unsupported_product_type');
  });

  it.each([
    ['declared restricted', product({ declaredRestricted: true }), 'declared_restricted'],
    ['practitioner-gated', product({ accessTier: 'practitioner_gated' }), 'access_tier'],
    ['injectable', product({ accessTier: 'injectable', productType: 'injectable_peptide' }), 'access_tier'],
    ['not direct-order', product({ directOrderAllowed: false }), 'not_direct_order'],
    ['without an approved label', product({ labelVersion: null }), 'no_approved_label'],
  ])('a %s product is observed but cannot be bound', async (_name, held, reason) => {
    expect(catalogHold(held)).toBe(reason);
    const controller = createCatalogPickerController({ read: async () => observation({ products: [held] }), scope: scope() });
    await controller.search('');
    expect(controller.state().kind).toBe('observed');
    expect(controller.select(held.stableId)).toEqual({ ok: false, reason: 'held', hold: reason });
  });
  it('a hold is a declared catalog value, never a word in the name', () => {
    expect(catalogHold(product({ displayName: 'Fictional peptide blend' }))).toBeNull();
  });
});
