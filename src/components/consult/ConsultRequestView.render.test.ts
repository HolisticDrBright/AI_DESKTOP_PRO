import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import { renderToMarkup, renderToText } from '@/test-support/renderToText';

import { ConsultRequestView, type Described } from './ConsultRequestView';

/**
 * What the public page actually says, rendered rather than scanned for.
 *
 * Two of these matter beyond wording. A stranger must be told, on the page, not to type
 * symptoms into a form nobody is watching. And a refusal must not read as an acceptance:
 * "we have your request" and "please try again later" are different answers and the page has
 * to give the right one.
 */
const LINK: Described = {
  action: 'describe', slug: 'fictional-longevity', label: 'New patient consult',
  clinic: 'Fictional Longevity Clinic', visitTypes: ['initial', 'follow_up'],
  reasonCodes: ['new_consultation', 'lab_review'], acceptingRequests: true,
};
const form = (over: Partial<Described> = {}) => createElement(ConsultRequestView, {
  state: {
    kind: 'form', link: { ...LINK, ...over },
    values: { name: '', email: '', phone: '', visitType: 'initial', reasonCode: 'new_consultation' },
    busy: false, failure: null, onChange: () => {}, onSubmit: () => {},
  },
});

describe('public consult page', () => {
  it('tells a visitor where not to put health information, and what sending does not do', () => {
    const text = renderToText(form());
    expect(text).toContain('Please do not describe symptoms or send health information here');
    expect(text).toContain('local emergency number');
    expect(text).toContain('does not book an appointment and does not create a patient record');
    // Only the clinic's published vocabulary is offered.
    expect(text).toContain('First consultation');
    expect(text).toContain('Follow-up visit');
    expect(text).not.toContain('Urgent question');
    expect(text).toContain('I would like to become a patient');
    expect(renderToMarkup(form())).not.toContain('textarea');
  });

  it('says when the clinic is not taking requests, and disables sending', () => {
    const markup = renderToMarkup(form({ acceptingRequests: false }));
    expect(renderToText(form({ acceptingRequests: false })))
      .toContain('not taking new requests through this link at the moment');
    expect(markup).toContain('data-testid="consult-submit"');
    expect(markup).toMatch(/data-testid="consult-submit"[^>]*disabled/);
  });

  it('distinguishes a received request from a refused one', () => {
    const received = renderToText(createElement(ConsultRequestView, {
      state: {
        kind: 'received',
        result: { action: 'submit', outcome: 'received', reference: 'ABCDEFGHJK', receivedAt: '2026-09-30T00:00:00Z', status: 'received' },
      },
    }));
    expect(received).toContain('Your request has been sent');
    expect(received).toContain('ABCDEFGHJK');
    expect(received).toContain('a request is not an appointment');
    const throttled = renderToText(createElement(ConsultRequestView, {
      state: { kind: 'received', result: { action: 'submit', outcome: 'throttled', reference: null, retryAfterSeconds: 3600 } },
    }));
    expect(throttled).toContain('Please try again later');
    expect(throttled).not.toContain('Your request has been sent');
  });

  it('answers an unavailable link without hinting whether it ever existed', () => {
    const text = renderToText(createElement(ConsultRequestView, { state: { kind: 'unavailable' } }));
    expect(text).toContain('This link is not available');
    expect(text).toContain('withdrawn or may have expired');
    expect(text).not.toMatch(/\bno such\b|\bnot found\b|does not exist/i);
  });
});
