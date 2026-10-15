import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToMarkup, renderToText } from '@/test-support/renderToText';
import { CatalogPickerPanel, CatalogPickerView } from './CatalogPickerPanel';
import { ConsumerProgramEditor } from './ConsumerProgramEditor';
import { createCatalogPickerController, type CatalogBindingStatus, type CatalogPickerState } from '@/lib/programs/catalogPicker';
import type { ConsumerProgram } from '@/lib/programs/consumerProgramAuthoring';
import type { ObservedCatalogProduct, ProgramCatalogObservation } from '@/contracts/programCatalogObservation';

/**
 * The picker as a practitioner reads it, rendered for real in every state the controller can
 * produce. The controller tests prove the decisions; these prove the words on screen say the
 * same thing: an outage is not an empty catalog, a held product is visible and not offered, a
 * changed release is shown next to the bound one and only an explicit rebind moves it, and the
 * editor mounts this picker in place of the hand-entered binding fields.
 */
const VERSION = '11111111-1111-4111-8111-111111111111';
const binding = { stableId: 'prd_fictional_magnesium', version: 3, target: 'synthetic-staging' as const };
const product = (over: Partial<ObservedCatalogProduct> = {}): ObservedCatalogProduct => ({
  stableId: 'prd_fictional_magnesium', version: 3, displayName: 'Fictional magnesium', productType: 'supplement', accessTier: 'open',
  declaredRestricted: false, directOrderAllowed: true, labelVersion: 2, ...over,
});
const observation = (over: Partial<ProgramCatalogObservation> = {}): ProgramCatalogObservation => ({
  contractVersion: 'program-catalog-observation/2', clinic: 'clinic-a', versionId: VERSION, target: 'synthetic-staging',
  observedAt: '2026-10-11T12:00:00.000Z', query: '', products: [product()], catalogSize: 1, complete: true, ...over,
});
const noop = () => undefined;
const view = (state: CatalogPickerState, over: { binding?: typeof binding; bindingStatus?: CatalogBindingStatus; readerConnected?: boolean; refusal?: string | null; disabled?: boolean } = {}) =>
  createElement(CatalogPickerView, { label: 'Step 1.2', state, binding: over.binding, bindingStatus: over.bindingStatus ?? { status: 'unobserved' }, query: '', disabled: over.disabled ?? false,
    readerConnected: over.readerConnected ?? true, refusal: over.refusal ?? null, onQuery: noop, onSearch: noop, onSelect: noop, onUnbind: noop });

/** Render what the controller actually produced, so the words are checked against a real journey rather than a hand-built state. */
async function rendered(read: () => Promise<unknown>, bound?: typeof binding) {
  const controller = createCatalogPickerController({ read, scope: { versionId: VERSION, stepId: 'supp-1', stepRevision: 'supp-1|supplement|p1', session: '1' } });
  await controller.search('');
  const element = view(controller.state(), { binding: bound, bindingStatus: controller.bindingStatus(bound) });
  return { text: renderToText(element), markup: renderToMarkup(element) };
}

describe('the catalog picker view', () => {
  it('starts unbound and unobserved, offering a search and no product', () => {
    const element = view({ kind: 'idle', note: 'none' });
    const text = renderToText(element);
    expect(text).toContain('Not bound to a catalog product.');
    expect(text).toContain('Nothing observed yet.');
    expect(renderToMarkup(element)).toContain('data-testid="catalog-search"');
    expect(renderToMarkup(element)).not.toContain('catalog-select-');
  });
  it('shows exact selection: the product with its observed release and target, and a bind action by stable id', async () => {
    const { text, markup } = await rendered(async () => observation());
    expect(markup).toContain('data-state="observed"');
    expect(text).toContain('Observed at 2026-10-11T12:00:00.000Z on synthetic-staging : 1 of 1 product match.');
    expect(text).toContain('Fictional magnesium · prd_fictional_magnesium · version 3 · supplement · label version 2');
    expect(text).toContain('Being listed is not purchase availability or clinical approval.');
    expect(markup).toContain('data-testid="catalog-select-prd_fictional_magnesium"');
    expect(text).toContain('Bind this product');
  });
  it('says a genuine empty result is a match result, with the observed catalog size, not an outage', async () => {
    const { text, markup } = await rendered(async () => observation({ query: 'zinc', products: [], catalogSize: 12 }));
    expect(markup).toContain('data-testid="catalog-empty"');
    expect(text).toContain('No products match "zinc" in the catalog observed at 2026-10-11T12:00:00.000Z on synthetic-staging (12 products observed). This is a match result, not an outage.');
  });
  it('says an outage is not an empty catalog, keeps the binding and offers no product', async () => {
    const { text, markup } = await rendered(async () => { throw new Error('fetch failed'); }, binding);
    expect(markup).toContain('data-testid="catalog-unavailable" data-reason="service_unavailable"');
    expect(text).toContain('The governed catalog could not be reached. This is not an empty catalog;');
    expect(text).toContain('Bound to catalog product prd_fictional_magnesium version 3 on synthetic-staging.');
    expect(text).toContain('unknown until a search observes it');
    expect(markup).not.toContain('catalog-select-');
    expect(markup).toContain('data-testid="catalog-unbind"');
  });
  it.each([
    ['reauth_required', 'Your session needs renewing'],
    ['identity_refused', 'refused this session'],
    ['catalog_unverifiable', 'could not be verified against the published contract'],
    ['catalog_target_changed', 'two different service targets'],
    ['cross_clinic', 'named a different clinic'],
    ['other_draft', 'for a different draft'],
  ] as const)('names the %s refusal without offering a product', (reason, words) => {
    const element = view({ kind: 'unavailable', reason, query: '' }, { binding });
    expect(renderToText(element)).toContain(words);
    expect(renderToMarkup(element)).not.toContain('catalog-select-');
  });
  it('shows a changed release next to the bound one and offers an explicit rebind, nothing automatic', async () => {
    const { text, markup } = await rendered(async () => observation({ products: [product({ version: 4 })] }), binding);
    expect(text).toContain('Bound to catalog product prd_fictional_magnesium version 3 on synthetic-staging. The catalog now reports version 4; the binding stays on its own version unless you rebind it.');
    expect(text).toContain('Rebind to version 4');
    expect(markup).toContain('data-testid="catalog-select-prd_fictional_magnesium"');
  });
  it('shows a different observed target and keeps the binding', async () => {
    const { text } = await rendered(async () => observation({ target: 'production-clinical',
      products: [product({ labelVersion: null, labelVersionId: '33333333-3333-4333-8333-333333333333', sourceVerified: true })],
    }), binding);
    expect(text).toContain('The catalog observed here is production-clinical, not the binding\'s target; the binding is kept unchanged.');
    expect(text).toContain('Rebind on production-clinical');
  });
  it('says when the bound product is not in the result, and whether that was the whole catalog', async () => {
    const whole = await rendered(async () => observation({ products: [product({ stableId: 'prd_fictional_zinc' })] }), binding);
    expect(whole.text).toContain('This product was not in the catalog as last observed. The binding is kept; nothing is replaced on your behalf.');
    const narrowed = await rendered(async () => observation({ query: 'zinc', products: [] }), binding);
    expect(narrowed.text).toContain('is not in the current search result; that says nothing about whether the catalog still carries it.');
  });
  it('shows a held product with its declared reason and no bind action', async () => {
    const { text, markup } = await rendered(async () => observation({ products: [product(), product({ stableId: 'prd_fictional_peptide', displayName: 'Fictional peptide', productType: 'oral_peptide', declaredRestricted: true })] }));
    expect(markup).toContain('data-testid="catalog-product-prd_fictional_peptide" data-hold="declared_restricted"');
    expect(markup).toContain('data-testid="catalog-held-prd_fictional_peptide"');
    expect(markup).not.toContain('catalog-select-prd_fictional_peptide');
    expect(text).toContain('Held: declared restricted by the catalog; add-ons of this kind are held.');
    expect(markup).toContain('data-testid="catalog-select-prd_fictional_magnesium"');
  });
  it('tells the practitioner the earlier observation no longer applies after the step or draft changed', () => {
    expect(renderToText(view({ kind: 'idle', note: 'scope_changed' }))).toContain('The step or the draft changed, so the earlier observation no longer applies.');
  });
  it('shows a reading state with the search disabled', () => {
    const markup = renderToMarkup(view({ kind: 'reading', query: 'mag' }));
    expect(markup).toContain('data-state="reading"');
    expect(renderToText(view({ kind: 'reading', query: 'mag' }))).toContain('Reading the governed catalog…');
    expect(markup).toContain('disabled="" data-testid="catalog-search"');
  });
  it('shows and keeps the binding when no reader is connected, with nothing to search', () => {
    const element = view({ kind: 'idle', note: 'none' }, { binding, readerConnected: false });
    expect(renderToText(element)).toContain('The catalog reader is not connected in this view, so the binding above can be removed but not changed.');
    expect(renderToMarkup(element)).not.toContain('data-testid="catalog-search"');
  });
  it('prints a refusal when a selection could not be bound', () => {
    expect(renderToText(view({ kind: 'idle', note: 'none' }, { refusal: 'Not bound: nothing is observed yet. Search the catalog first.' }))).toContain('Not bound: nothing is observed yet.');
  });
});

describe('the panel in the editor', () => {
  const program = (): ConsumerProgram => ({ title: 'Fictional guide', phases: [{ id: 'phase-1', title: 'Phase one', days: 7, transition: 'check_in', items: [
    { id: 'supp-1', title: 'Fictional supplement', kind: 'supplement', instructions: 'Follow the label.', released: false,
      product: { id: 'product-1', ingredientKeys: ['fictional-mineral'], dose: 'Fictional dose', purchaseUrl: null, catalog: binding } }] }] });
  it('mounts the picker for a supplement step in place of hand-entered binding fields, with the reader the Studio connects', () => {
    const markup = renderToMarkup(createElement(ConsumerProgramEditor, { value: program(), disabled: false, onChange: noop,
      catalog: { read: async () => observation(), versionId: VERSION, session: '1' } }));
    expect(markup).toContain('data-testid="catalog-picker" data-state="idle"');
    expect(markup).toContain('aria-label="Step 1.1 catalog search"');
    expect(markup).not.toContain('catalog stable id');
    expect(markup).not.toContain('catalog version');
    expect(markup).not.toContain('catalog target');
    expect(renderToText(createElement(ConsumerProgramEditor, { value: program(), disabled: false, onChange: noop, catalog: { read: async () => observation(), versionId: VERSION, session: '1' } })))
      .toContain('Bound to catalog product prd_fictional_magnesium version 3 on synthetic-staging.');
  });
  it('keeps and shows the binding when no reader is connected, and offers nothing to type a release into', () => {
    const markup = renderToMarkup(createElement(ConsumerProgramEditor, { value: program(), disabled: false, onChange: noop }));
    expect(markup).toContain('data-testid="catalog-reader-absent"');
    expect(markup).toContain('data-testid="catalog-unbind"');
    expect(markup).not.toContain('type="number" min="1" aria-label="Step 1.1 catalog version"');
  });
  it('renders the stateful panel directly with a reader, in its first state', () => {
    const markup = renderToMarkup(createElement(CatalogPickerPanel, { label: 'Step 1.1', binding, disabled: false, read: async () => observation(),
      scope: { versionId: VERSION, stepId: 'supp-1', stepRevision: 'supp-1|supplement|product-1', session: '1' }, onBind: noop, onUnbind: noop }));
    expect(markup).toContain('data-state="idle"');
    expect(markup).toContain('data-testid="catalog-search"');
  });
});
