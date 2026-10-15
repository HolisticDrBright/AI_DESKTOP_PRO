import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { CareMessagesPanel } from './CareMessagesPanel';

describe('CareMessagesPanel hydration boundary', () => {
  it('does not offer a clickable refresh button before client handlers are mounted', () => {
    const html = renderToStaticMarkup(createElement(CareMessagesPanel));
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Load \/ refresh app messages<\/button>/);
  });
});
