import { describe, expect, it } from 'vitest';
import { consultDescriptionOutcome, postConsultRequest } from './ConsultRequestForm';
import type { Described } from './ConsultRequestView';

const LINK: Described = { action: 'describe', slug: 'fictional-longevity', label: 'Consult', clinic: 'Fictional clinic', visitTypes: ['initial'], reasonCodes: ['program_question'], acceptingRequests: true };
describe('consult description and transport failures', () => {
  it('turns a rejected network request into a retryable result, not an unhandled rejection or indefinite spinner', async () => {
    const result = await postConsultRequest({ action: 'describe', slug: LINK.slug }, async () => { throw new Error('fictional_network_failure'); });
    expect(result).toEqual({ error: 'service_unavailable', status: 503 });
    expect(consultDescriptionOutcome(result)).toEqual({ kind: 'failed' });
  });
  it.each([429, 500, 503])('does not present HTTP %s as an expired link', async status => {
    const result = await postConsultRequest({}, async () => new Response(JSON.stringify({ error: 'consult_request_refused' }), { status }));
    expect(consultDescriptionOutcome(result)).toEqual({ kind: 'failed' });
  });
  it('keeps refused links indistinguishable', () => {
    for (const status of [400, 403, 409]) expect(consultDescriptionOutcome({ status, error: 'consult_request_refused' })).toEqual({ kind: 'unavailable' });
  });
  it('a malformed successful response cannot reveal a form', async () => {
    const result = await postConsultRequest({}, async () => new Response('not JSON', { status: 200 }));
    expect(consultDescriptionOutcome(result)).toEqual({ kind: 'failed' });
  });
  it('validates described fields and binds the response action before exposing the form', async () => {
    const body = { action: 'describe', slug: LINK.slug };
    for (const data of [{ action: 'describe' }, { action: 'submit', outcome: 'throttled', reference: null, retryAfterSeconds: 3600 }]) {
      const result = await postConsultRequest(body, async () => new Response(JSON.stringify({ data }), { status: 200 }));
      expect(consultDescriptionOutcome(result)).toEqual({ kind: 'failed' });
    }
    const valid = await postConsultRequest(body, async () => new Response(JSON.stringify({ data: LINK }), { status: 200 }));
    expect(consultDescriptionOutcome(valid)).toEqual({ kind: 'ready', link: LINK });
  });
  it('admits only the described link from the successful action', () => {
    expect(consultDescriptionOutcome({ status: 200, data: LINK })).toEqual({ kind: 'ready', link: LINK });
    expect(consultDescriptionOutcome({ status: 200, data: { action: 'submit', outcome: 'throttled', reference: null, retryAfterSeconds: 3600 } })).toEqual({ kind: 'failed' });
  });
});
