import { describe, expect, it } from 'vitest';
import { boundedProviderJson } from './bounded-provider-json';

function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  let reads = 0, cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[reads++];
      if (next) controller.enqueue(next); else controller.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  return { response: new Response(body, { headers }), observations: () => ({ reads, cancelled }) };
}
const bytes = (s: string) => new TextEncoder().encode(s);

describe('bounded provider JSON', () => {
  it('accepts absent length and split UTF-8 without using text()', async () => {
    const encoded = bytes('{"text":"é"}');
    const fixture = streamed([encoded.slice(0, 10), encoded.slice(10)]);
    fixture.response.text = async () => { throw Error('must not materialize'); };
    expect(await boundedProviderJson(fixture.response, encoded.length)).toEqual({ text: 'é' });
  });
  it('accepts an exact declared byte length', async () => {
    expect(await boundedProviderJson(new Response('{"a":1}', { headers: { 'content-length': '7' } }), 7)).toEqual({ a: 1 });
  });
  it.each(['-1', 'NaN', '1.5', '01', '9007199254740992', '99999'])('refuses invalid or over-limit declaration %s before reading', async length => {
    const fixture = streamed([bytes('{}')], { 'content-length': length });
    await expect(boundedProviderJson(fixture.response, 20)).rejects.toThrow('provider_body_refused');
    expect(fixture.observations().reads).toBe(0);
    expect(fixture.observations().cancelled).toBe(true);
  });
  it('cancels at the first overrun without draining later chunks', async () => {
    const fixture = streamed([bytes('123456'), bytes('789012'), bytes('never-read')]);
    await expect(boundedProviderJson(fixture.response, 10)).rejects.toThrow('provider_body_refused');
    expect(fixture.observations()).toEqual({ reads: 2, cancelled: true });
  });
  it.each(['1', '3'])('refuses dishonest or truncated identity length %s', async length => {
    const fixture = streamed([bytes('{}')], { 'content-length': length });
    await expect(boundedProviderJson(fixture.response, 20)).rejects.toThrow('provider_body_refused');
    expect(fixture.observations().cancelled || fixture.observations().reads === 2).toBe(true);
  });
  it('bounds decoded compressed bytes without equating wire and decoded lengths', async () => {
    const fixture = streamed([bytes('{"text":"already decoded"}')], { 'content-length': '2', 'content-encoding': 'gzip' });
    expect(await boundedProviderJson(fixture.response, 100)).toEqual({ text: 'already decoded' });
  });
  it('refuses malformed UTF-8 and malformed JSON', async () => {
    await expect(boundedProviderJson(new Response(new Uint8Array([0xff])), 20)).rejects.toThrow('provider_body_refused');
    await expect(boundedProviderJson(new Response('{'), 20)).rejects.toThrow('provider_body_refused');
  });
  it('does not leak stream errors', async () => {
    const response = new Response(new ReadableStream({ start(c) { c.error(Error('private provider payload')); } }));
    await expect(boundedProviderJson(response, 20)).rejects.toThrow(/^provider_body_refused$/);
  });
});
