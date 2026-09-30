import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import type { ProtocolCartResponse } from '@/contracts/protocolCarts';
import { renderToMarkup, renderToText } from '@/test-support/renderToText';

import { ProtocolCartView, type ProtocolCartState } from './ProtocolCartView';

/**
 * The cart a published protocol compiles to.
 *
 * The assertions are about not misleading the practitioner: the excluded lines are shown rather
 * than dropped, each says why in words, the screen never implies anything was ordered, and a
 * superseded manifest says so.
 */
type Manifest = Extract<ProtocolCartResponse, { action: 'read' }>;
const uuid = (n: number) => 'f0000000-0000-4000-8000-' + String(n).padStart(12, '0');
const entry = (suffix: string, over: Partial<Manifest['lines'][number]> = {}): Manifest['lines'][number] => ({
  phaseId: 'phase-1', itemId: 'item-' + suffix, title: 'Fictional supplement ' + suffix,
  productId: 'prod-' + suffix, dose: '1 capsule daily', ingredientKeys: ['fictional_key'],
  purchaseUrl: 'https://fictional-dispensary.example/p/' + suffix,
  included: true, exclusionReason: null, ...over,
});
const manifest = (over: Partial<Manifest> = {}): Manifest => ({
  action: 'read', manifestId: uuid(1), programVersionId: uuid(2), programVersion: 2,
  status: 'compiled', versionContentSha256: 'a'.repeat(64), contentSha256: 'b'.repeat(64),
  lines: [entry('magnesium'),
    entry('ironblend', { included: false, exclusionReason: 'iron_requires_individual_review' }),
    entry('prenatal', { included: false, exclusionReason: 'reproductive_requires_individual_review' })],
  includedCount: 1, excludedCount: 2,
  delivery: { state: 'not_implemented', detail: 'no_cart_is_created_at_any_provider' }, ...over,
});
const view = (over: Partial<ProtocolCartState> = {}) => createElement(ProtocolCartView, {
  state: { manifest: null, busy: false, error: null, notice: null, onCompile: () => {}, ...over },
});

describe('the compiled supplement list', () => {
  it('shows the excluded lines rather than dropping them', () => {
    const markup = renderToMarkup(view({ manifest: manifest() }));
    expect(markup.match(/data-testid="cart-line-excluded"/g)).toHaveLength(2);
    expect(markup.match(/data-testid="cart-line-included"/g)).toHaveLength(1);
    expect(renderToText(view({ manifest: manifest() }))).toContain('1 to buy, 2 for you to decide');
  });

  it('says why each exclusion is out, and that the decision is the practitioner’s', () => {
    const text = renderToText(view({ manifest: manifest() }));
    expect(text).toContain('the dose depends on a ferritin a cart cannot see');
    expect(text).toContain('an individual decision');
    expect(text).toContain('The excluded ones are not refused, they are yours');
  });

  it('never implies anything was ordered', () => {
    const text = renderToText(view({ manifest: manifest() }));
    expect(text).toContain('Nothing has been sent');
    expect(text).toContain('nobody has been charged and no dispensary has been contacted');
    expect(text).not.toMatch(/sent to|added to your dispensary|order placed/i);
  });

  it('says which published version it came from, and when that version is stale', () => {
    expect(renderToText(view({ manifest: manifest() }))).toContain('From published version 2');
    expect(renderToText(view({ manifest: manifest({ status: 'superseded' }) })))
      .toContain('a newer version has since been published');
  });

  it('says nothing about exclusions when there are none', () => {
    const clean = manifest({ lines: [entry('magnesium')], includedCount: 1, excludedCount: 0 });
    expect(renderToText(view({ manifest: clean }))).not.toContain('they are yours');
    // The delivery statement is not conditional on there being exclusions.
    expect(renderToText(view({ manifest: clean }))).toContain('Nothing has been sent');
  });

  it('says up front that building a list is not ordering', () => {
    expect(renderToText(view())).toContain('Nothing is ordered and no cart is created anywhere');
  });
});
