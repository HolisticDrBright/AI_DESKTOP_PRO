import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToMarkup, renderToText } from '@/test-support/renderToText';
import { ProgramOfferEditorView, type OfferRead } from './ProgramOfferEditor';
import { EMPTY_OFFER_FORM } from '@/lib/programs/offerAuthoring';
import { programOffer, type ProgramOffer } from '@/contracts/programOffers';

/**
 * The offer editor as rendered: "not connected", "could not be read" and "no offers" are three
 * different screens; the form offers no default billing mode; every hold is spelled out; and a
 * published offer says whether a visitor could buy it now. Interaction is proven on the controller.
 */
const id = (n: number) => '90000000-0000-4000-8000-' + String(n).padStart(12, '0');
const curriculum = { versionId: id(4), version: 2, sourceDigest: 'a'.repeat(64) };
const offer = (over: Record<string, unknown> = {}): ProgramOffer => programOffer.parse(Object.fromEntries(Object.entries({
  contract: 'program-offer/1', offerId: id(1), organizationId: id(2), programId: id(3), curriculum, revision: 3, state: 'draft', name: 'Fictional program',
  accessTermsVersion: 'education-access-terms/1', accessDurationDays: 90, authoredBy: id(5), authoredAt: '2026-10-11T12:00:00Z', mode: 'paid',
  pricing: { currency: 'USD', amountMinor: 1999, billing: { kind: 'one_time' } }, providerPrice: { provider: 'stripe', mode: 'test', priceRef: 'price_FictionalAbc123', approval: { by: id(5), at: '2026-10-11T12:00:00Z' } }, ...over,
}).filter(([, value]) => value !== undefined)));
const noop = () => undefined;
const view = (read: OfferRead, over: Partial<Parameters<typeof ProgramOfferEditorView>[0]> = {}) => createElement(ProgramOfferEditorView, {
  read, form: EMPTY_OFFER_FORM, editing: false, problems: [], notice: null, busy: false, retireReason: '',
  onForm: noop, onRetireReason: noop, onRetry: noop, onSave: noop, onEdit: noop, onCancelEdit: noop, onApprove: noop, onPublish: noop, onRetire: noop, ...over,
});

describe('the offer editor', () => {
  it('keeps "not connected", "could not be read" and "no offers" apart', () => {
    const disabled = view({ state: 'disabled', reason: 'commerce_disabled' });
    expect(renderToMarkup(disabled)).toContain('data-testid="offer-disabled"');
    expect(renderToText(disabled)).toContain('Program commerce is not connected for this deployment. Offers cannot be saved here; nothing shown is a saved offer.');
    expect(renderToMarkup(disabled)).not.toContain('offer-form');
    const failed = view({ state: 'failed', message: 'The offer service could not be reached. Nothing was saved.' });
    expect(renderToMarkup(failed)).toContain('data-testid="offer-failed"');
    expect(renderToText(failed)).toContain('This is not the same as having no offer.');
    expect(renderToMarkup(failed)).not.toContain('offer-empty');
    const empty = view({ state: 'read', offers: [], curriculum });
    expect(renderToMarkup(empty)).toContain('data-testid="offer-empty"');
    expect(renderToMarkup(empty)).not.toContain('offer-failed');
    expect(renderToText(empty)).toContain('Published version 2 is what an offer binds to.');
  });
  it('offers no form when nothing is published, and a form with no default billing mode when something is', () => {
    const unpublished = view({ state: 'read', offers: [], curriculum: null });
    expect(renderToText(unpublished)).toContain('an offer cannot be written until it does');
    expect(renderToMarkup(unpublished)).not.toContain('data-testid="offer-form"');
    const markup = renderToMarkup(view({ state: 'read', offers: [], curriculum }));
    expect(markup).toContain('data-testid="offer-form"');
    expect(markup).toMatch(/<select[^>]*data-testid="offer-billing"[^>]*>\s*<option value="" selected="">Choose…<\/option>/);
    for (const field of ['offer-mode', 'offer-name', 'offer-amount', 'offer-billing', 'offer-price-ref', 'offer-terms', 'offer-duration', 'offer-save']) expect(markup).toContain(`data-testid="${field}"`);
    expect(renderToText(view({ state: 'read', offers: [], curriculum }))).toContain('Saving never publishes.');
    expect(renderToText(view({ state: 'read', offers: [], curriculum }, { form: { ...EMPTY_OFFER_FORM, mode: 'complimentary' } }))).toContain('Reason for complimentary access');
  });
  it('spells out every hold on a draft and shows the approve step only while the reference is unapproved', () => {
    const draft = offer({ pricing: null, providerPrice: { provider: 'stripe', mode: 'test', priceRef: 'price_FictionalAbc123', approval: null }, accessTermsVersion: null });
    const element = view({ state: 'read', offers: [draft], curriculum });
    const text = renderToText(element);
    expect(text).toContain('Fictional program: no price set; 90 days of access; bound to version 2; revision 3; draft.');
    expect(text).toContain('No price is set.');
    expect(text).toContain('has not been approved. Approval is a separate recorded act.');
    expect(text).toContain('No access terms version is named.');
    const markup = renderToMarkup(element);
    expect(markup).toContain('data-testid="offer-approve"');
    expect(markup).toContain('data-testid="offer-publish"');
    expect(markup).toContain('data-purchasable="false"');
    expect(renderToMarkup(view({ state: 'read', offers: [offer()], curriculum }))).not.toContain('data-testid="offer-approve"');
  });
  it('a published offer says whether a visitor could buy it now, and a retired one offers nothing', () => {
    const live = view({ state: 'read', offers: [offer({ state: 'published' })], curriculum });
    expect(renderToMarkup(live)).toContain('data-purchasable="true"');
    expect(renderToText(live)).toContain('Visitors may buy this program on these exact terms.');
    expect(renderToMarkup(live)).not.toContain('data-testid="offer-publish"');
    const moved = view({ state: 'read', offers: [offer({ state: 'published' })], curriculum: { ...curriculum, sourceDigest: 'b'.repeat(64) } });
    expect(renderToMarkup(moved)).toContain('data-purchasable="false"');
    expect(renderToText(moved)).toContain('Visitors read: This program was updated after it was priced');
    const retired = renderToMarkup(view({ state: 'read', offers: [offer({ state: 'retired' })], curriculum }));
    expect(retired).not.toMatch(/offer-(edit|approve|publish|retire)"/);
  });
  it('shows problems and notices as what they are', () => {
    const element = view({ state: 'read', offers: [], curriculum }, { problems: ['Choose how the program is billed: one payment, monthly or yearly. No billing mode is assumed.'], notice: 'Saved as a draft (revision 1). A draft cannot be bought.' });
    const markup = renderToMarkup(element);
    expect(markup).toContain('data-testid="offer-problems"');
    expect(markup).toContain('data-testid="offer-notice"');
    expect(renderToText(element)).toContain('No billing mode is assumed.');
  });
});

describe('the Studio and the offer editor', () => {
  const studio = readFileSync('src/components/programs/ProgramStudio.tsx', 'utf8').replace(/\r\n?/g, '\n');
  it('mounts the editor from the real component, bound to the Studio load, beside the legacy terms panel', () => {
    expect(studio).toContain('import { ProgramOfferEditor } from "@/components/programs/ProgramOfferEditor";');
    expect(studio).toContain('<ProgramOfferEditor programId={studio.program.id} session={String(studioSession)} />');
  });
  it('reaches the ledger only through the facade and the authoring route, with the command as the whole body', () => {
    const editor = readFileSync('src/components/programs/ProgramOfferEditor.tsx', 'utf8');
    expect(editor).toContain('api.programs.offers({ action: "list", programId })');
    expect(editor).not.toMatch(/fetch\(/);
    const facade = readFileSync('src/adapters/index.ts', 'utf8');
    expect(facade).toContain('offers: async (command: ProgramOfferCommand) => liveClient.programOffers(command),');
    const client = readFileSync('src/adapters/live-client.ts', 'utf8');
    expect(client).toContain('liveFetch<ProgramOfferResult>("commerce/offers", { method: "POST", body: command })');
  });
  it('the legacy panel converts the typed amount exactly or refuses, and sends every term', () => {
    expect(studio).toContain('const priceCents = priceMatch ? Number(priceMatch[1]) * 100 + Number((priceMatch[2] ?? "").padEnd(2, "0")) : null;');
    expect(studio).not.toContain('Math.max(0, Math.round(Number(price) * 100) || 0)');
    for (const term of ['offerId: null,', 'currency: "usd",', 'enrollmentOpen: true,', 'status: "active",']) expect(studio).toContain(term);
  });
});
