import { describe, it, expect } from 'vitest';
import { compileFullscriptProtocolDraft, fullscriptSupplementDraftInput } from './protocol-draft';
const id = (n: number) => 'e0000000-0000-4000-8000-' + String(n).padStart(12, '0');
const line = (n: number, included = true) => ({phaseId: 'phase-1', itemId: 'item-' + n, title: 'Fictional product',
  productId: 'product-' + n, dose: 'Fictional existing directions ' + n, ingredientKeys: [included ? 'magnesium' : 'iron'],
  purchaseUrl: 'https://fictional.example.test/item/' + n, included,
  exclusionReason: included ? null : 'iron_requires_individual_review'});
const fixture = () => ({manifest: {action: 'read', manifestId: id(1), programVersionId: id(2), programVersion: 1,
  status: 'compiled', versionContentSha256: 'a'.repeat(64), contentSha256: 'b'.repeat(64),
  lines: [line(1), line(2, false)], includedCount: 1, excludedCount: 1,
  delivery: {state: 'not_implemented', detail: 'no_cart_is_created_at_any_provider'}},
  mappings: {manifestId: id(1), manifestContentSha256: 'b'.repeat(64), catalogReleaseSha256: 'c'.repeat(64),
    mappingReleaseSha256: 'd'.repeat(64), fullscriptPatientId: id(3), practitionerId: id(4),
    lines: [{phaseId: 'phase-1', itemId: 'item-1', productId: 'product-1', variantId: id(5), unitsToPurchase: '2'}]}});
describe('Fullscript protocol draft payload compiler, not delivery authority', () => {
  it('preserves exact instructions and explicit units, excludes held lines and makes no authority claim', () => {
    const {manifest, mappings} = fixture();
    const compiled = compileFullscriptProtocolDraft(manifest, mappings);
    expect(compiled).toMatchObject({includedCount: 1, excludedCount: 1, authorityVerified: false, providerCreated: false, phiAllowed: false});
    expect(compiled.input.recommendations).toEqual([{variantId: id(5), unitsToPurchase: '2', instructions: manifest.lines[0].dose}]);
    expect(compiled.input.idempotencyKey).toBe('alp-cart-' + compiled.intentSha256);
    expect(JSON.stringify(compiled.input)).not.toMatch(/product-2|iron|fictional\.example/);
    expect(compileFullscriptProtocolDraft(manifest, mappings)).toEqual(compiled);
  });
  it('binds recipient, practitioner, catalog, mapping and instructions into the stable key', () => {
    const original = fixture(), first = compileFullscriptProtocolDraft(original.manifest, original.mappings);
    for (const key of ['manifestContentSha256', 'catalogReleaseSha256', 'mappingReleaseSha256'] as const) {
      const f = fixture(); f.mappings[key] = 'e'.repeat(64);
      if (key === 'manifestContentSha256') f.manifest.contentSha256 = f.mappings[key];
      expect(compileFullscriptProtocolDraft(f.manifest, f.mappings).intentSha256).not.toBe(first.intentSha256);
    }
    for (const key of ['fullscriptPatientId', 'practitionerId'] as const) {
      const f = fixture(); f.mappings[key] = id(20);
      expect(compileFullscriptProtocolDraft(f.manifest, f.mappings).intentSha256).not.toBe(first.intentSha256);
    }
    const changed = fixture(); changed.manifest.lines[0].dose = 'Other exact fictional instructions';
    expect(compileFullscriptProtocolDraft(changed.manifest, changed.mappings).intentSha256).not.toBe(first.intentSha256);
  });
  it('refuses partial, extra, duplicated, excluded, superseded, misbound and malformed rows', () => {
    const mutations: ((f: ReturnType<typeof fixture>) => void)[] = [
      f => {f.manifest.status = 'superseded';}, f => {f.manifest.manifestId = id(99);},
      f => {f.manifest.contentSha256 = 'e'.repeat(64);}, f => {f.manifest.includedCount = 2;},
      f => {f.mappings.lines = [];}, f => {f.mappings.lines.push({...f.mappings.lines[0]});},
      f => {f.mappings.lines[0].itemId = 'item-2';}, f => {f.mappings.lines[0].phaseId = 'unknown';},
      f => {f.mappings.lines[0].productId = 'wrong-product';}, f => {f.mappings.lines[0].variantId = '../unsafe';},
      f => {f.manifest.lines[0].dose = '';}, f => {f.manifest.lines[0].dose = '   ';}, f => {f.manifest.lines[0].dose = 'x'.repeat(2001);},
      f => {f.manifest.lines[0].dose = 'unsafe\u0000instruction';},
      f => {f.mappings.catalogReleaseSha256 = '';}, f => {f.mappings.catalogReleaseSha256 = '0'.repeat(64);},
      f => {f.mappings.mappingReleaseSha256 = 'not-reviewed';},
      f => {f.mappings.lines[0].unitsToPurchase = '';}, f => {f.mappings.lines[0].unitsToPurchase = '0';},
      f => {f.mappings.lines[0].unitsToPurchase = '1.5';}, f => {f.mappings.lines[0].unitsToPurchase = '101';},
      f => {f.mappings.lines[0].unitsToPurchase = '01';}, f => {f.mappings.practitionerId = '';},
    ];
    for (const mutate of mutations) {const f = fixture(); mutate(f); expect(() => compileFullscriptProtocolDraft(f.manifest, f.mappings)).toThrow('protocol_draft_refused');}
    const f = fixture();
    for (const extra of ['state', 'send_to_patient', 'labs', 'accessToken', 'approved'])
      expect(() => compileFullscriptProtocolDraft(f.manifest, {...f.mappings, [extra]: true})).toThrow('protocol_draft_refused');
  });
  it('refuses repeated variants rather than merging phase doses or guessing package counts', () => {
    const f = fixture(); f.manifest.lines = [line(1), line(3)]; f.manifest.includedCount = 2; f.manifest.excludedCount = 0;
    f.mappings.lines.push({...f.mappings.lines[0], itemId: 'item-3', productId: 'product-3'});
    expect(() => compileFullscriptProtocolDraft(f.manifest, f.mappings)).toThrow('protocol_draft_refused');
    f.mappings.lines[1].variantId = id(6); expect(compileFullscriptProtocolDraft(f.manifest, f.mappings).includedCount).toBe(2);
  });
  it('does not admit patient-send, dose interpretation or unspecified quantity fields through transport input', () => {
    const f = fixture(), {input} = compileFullscriptProtocolDraft(f.manifest, f.mappings);
    expect(fullscriptSupplementDraftInput.safeParse({...input, state: 'active'}).success).toBe(false);
    expect(fullscriptSupplementDraftInput.safeParse({...input, recommendations: [{...input.recommendations[0], dosage: {amount: '10'}}]}).success).toBe(false);
    expect(fullscriptSupplementDraftInput.safeParse({...input, recommendations: []}).success).toBe(false);
  });
});
