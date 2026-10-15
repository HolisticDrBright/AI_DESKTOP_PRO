import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToMarkup, renderToText } from '@/test-support/renderToText';
import { allFunnels } from '@/funnels';
import { outreachRows } from '@/server/outreach-status';
import { OutreachStatusView } from './OutreachStatusView';

/**
 * The Outreach status screen as it renders: one row per setting with On, Off or Can't tell, the reading and what it is
 * waiting for, and no control of any kind. With every setting off, nothing reads On.
 */
const allOff = () => outreachRows({ env: {}, funnels: allFunnels(), engine: { kind: 'switched_off' }, signup: { kind: 'not_set' }, offers: { kind: 'disabled', reason: 'commerce_disabled' } });

describe('the Outreach status screen', () => {
  it('renders every row with its state, and nothing reads On with every setting off', () => {
    const rows = allOff();
    const markup = renderToMarkup(createElement(OutreachStatusView, { rows }));
    expect([...markup.matchAll(/data-testid="outreach-row" data-row="([^"]+)" data-state="([^"]+)"/g)].map(m => [m[1], m[2]])).toEqual(rows.map(r => [r.id, r.state]));
    expect(markup).not.toContain('data-state="on"');
    const text = renderToText(createElement(OutreachStatusView, { rows }));
    expect(text).toContain(`0 on · ${rows.filter(r => r.state === 'off').length} off · ${rows.filter(r => r.state === 'unknown').length} can't tell`);
    expect(text).toContain('It is not the same as off.');
    expect(text).toContain('Brandon lifts the Core-launch withholding');
  });
  it('labels each state in words, not colour alone', () => {
    const [first] = allOff();
    const label = (state: 'on' | 'off' | 'unknown') => renderToText(createElement(OutreachStatusView, { rows: [{ ...first!, state }] }));
    expect(label('on')).toContain('On');
    expect(label('off')).toContain('Off');
    expect(label('unknown')).toContain('Can\'t tell');
  });
  it('is read-only: no button, form, input or link', () => {
    const markup = renderToMarkup(createElement(OutreachStatusView, { rows: allOff() }));
    expect(markup).not.toMatch(/<button|<form|<input|<select|<textarea|<a\s/);
  });
});
