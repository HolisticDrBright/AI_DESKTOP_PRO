import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToMarkup, renderToText } from '@/test-support/renderToText';
import { ProgramPurchasesView, type PurchasesRead } from './ProgramPurchasesPanel';
import type { PurchaseRow } from '@/lib/programs/purchaseStatus';

/**
 * The purchases panel as rendered: "not connected", "could not be read" and "no purchases" are three
 * screens; each row names its kind and says what it means; a claimed purchase shows clinical
 * delivery as not started; the exact purchased version is shown read-only, or withheld with its reason.
 */
const row = (over: Partial<PurchaseRow> = {}): PurchaseRow => ({ orderId: '92000000-0000-4000-8000-000000000001', kind: 'access_active', summary: 'Claimed: the purchaser has education access to the exact version shown. This is not clinic membership, a chart, a consent or a protocol.', terms: '19.99 USD, one payment; 30 days of access; offer revision 3', curriculumVersion: 2, entitlementId: '92000000-0000-4000-8000-000000000101', clinicalDelivery: 'pending_review', updatedAt: '2026-10-11T13:00:00Z', ...over });
const noop = () => undefined;
const view = (read: PurchasesRead, curriculum: Parameters<typeof ProgramPurchasesView>[0]['curriculum'] = null) => createElement(ProgramPurchasesView, { read, curriculum, onRetry: noop, onOpen: noop });

describe('the purchases panel', () => {
  it('keeps disabled, failed and empty apart', () => {
    expect(renderToMarkup(view({ state: 'disabled' }))).toContain('data-testid="purchases-disabled"');
    expect(renderToText(view({ state: 'disabled' }))).toContain('This is not the same as having none.');
    const failed = view({ state: 'failed', message: 'commerce_unverifiable' });
    expect(renderToMarkup(failed)).toContain('data-testid="purchases-failed"');
    expect(renderToText(failed)).toContain('This is not the same as having no purchases.');
    expect(renderToMarkup(failed)).not.toContain('purchases-empty');
    expect(renderToMarkup(view({ state: 'read', rows: [], readAt: '2026-10-12T00:00:00Z' }))).toContain('data-testid="purchases-empty"');
  });
  it('names every kind distinctly and keeps clinical delivery separate from access', () => {
    const rows = [row(), row({ orderId: '92000000-0000-4000-8000-000000000002', kind: 'paid_not_fulfilled', summary: 'Payment verified by the processor, but no access has been prepared yet.', entitlementId: null, clinicalDelivery: 'not_applicable' }), row({ orderId: '92000000-0000-4000-8000-000000000003', kind: 'held_dispute', summary: 'Held: a dispute or chargeback was recorded.' })];
    const element = view({ state: 'read', rows, readAt: '2026-10-12T00:00:00Z' });
    const markup = renderToMarkup(element);
    expect(markup).toContain('data-kind="access_active" data-clinical-delivery="pending_review"');
    expect(markup).toContain('data-kind="paid_not_fulfilled" data-clinical-delivery="not_applicable"');
    expect(markup).toContain('data-kind="held_dispute"');
    const text = renderToText(element);
    expect(text).toContain('1 access active · 1 paid not fulfilled · 1 held dispute');
    expect(text).toContain('Clinical delivery: not started.');
    expect(text).toContain('a purchase does not do it');
    expect(markup.match(/purchase-open-curriculum/g)).toHaveLength(2);
  });
  it('shows the exact purchased version read-only, or why it is withheld', () => {
    const served = view({ state: 'read', rows: [row()], readAt: '2026-10-12T00:00:00Z' }, { entitlementId: '92000000-0000-4000-8000-000000000101', read: { outcome: 'served', entitlementId: '92000000-0000-4000-8000-000000000101', curriculum: { versionId: '92000000-0000-4000-8000-000000000004', version: 2, sourceDigest: 'a'.repeat(64) }, title: 'Fictional guide', phases: [{ title: 'Phase one' }, { title: 'Phase two' }] } });
    expect(renderToMarkup(served)).toContain('data-testid="purchased-curriculum"');
    expect(renderToText(served)).toContain('Fictional guide (version 2) Phase one Phase two');
    const withheld = view({ state: 'read', rows: [row()], readAt: '2026-10-12T00:00:00Z' }, { entitlementId: '92000000-0000-4000-8000-000000000101', read: { outcome: 'withheld', entitlementId: '92000000-0000-4000-8000-000000000101', reason: 'digest_mismatch' } });
    expect(renderToMarkup(withheld)).toContain('data-reason="digest_mismatch"');
    expect(renderToText(withheld)).toContain('cannot be shown from the current store');
    expect(renderToText(view({ state: 'read', rows: [row()], readAt: '2026-10-12T00:00:00Z' }, { entitlementId: '92000000-0000-4000-8000-000000000101', read: 'failed' }))).toContain('This does not mean it is missing.');
  });
  it('is mounted in the Studio and reaches the commercial read only through the facade, under its own key', () => {
    const studio = readFileSync('src/components/programs/ProgramStudio.tsx', 'utf8');
    expect(studio).toContain('<ProgramPurchasesPanel programId={studio.program.id} session={String(studioSession)} />');
    const client = readFileSync('src/adapters/live-client.ts', 'utf8');
    expect(client).toContain('liveFetch<{ commercial: CommercialStatus }>("commerce/status", { method: "POST", body: { action: "status", programId } })).commercial');
    const panel = readFileSync('src/components/programs/ProgramPurchasesPanel.tsx', 'utf8');
    expect(panel).not.toMatch(/fetch\(/);
    // The panel imports nothing clinical: no patient, encounter or consent adapter reaches the commercial boundary.
    expect([...panel.matchAll(/from "([^"]+)"/g)].map(m => m[1])).not.toContainEqual(expect.stringMatching(/patient|encounter|consent|clinical/i));
  });
});
