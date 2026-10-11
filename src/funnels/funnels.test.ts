import { describe, expect, it } from 'vitest';
import { FUNNELS, allFunnels, funnelDefinition, funnelTextIssue, publishedFunnel, type FunnelDefinition } from '@/funnels';
import { longevityProgram } from './definitions/longevity-program';

/**
 * The funnel definitions and the rules their shape enforces: no address, markup, dose, drug or
 * brand name, promised amount, cure or guarantee anywhere in the copy; "what is included" only
 * from the real program; publication only with recorded approval; and a draft that answers the
 * same absence as an unknown slug.
 */
const published = (): FunnelDefinition => ({
  ...structuredClone(longevityProgram), status: 'published', draftNote: null,
  approval: { by: 'Brandon Bright', on: '2026-10-11', attorneyReview: false },
  sections: longevityProgram.sections.map(s => s.kind === 'what-is-included' ? { ...s, source: 'published_program' as const, items: ['Fictional lesson one', 'Fictional habit two'] } : s),
});

describe('the three funnels', () => {
  it('exist in the decided order, are drafts, are indexable by decision, and each hands off to one consult slug', () => {
    expect(FUNNELS.map(f => f.slug)).toEqual(['longevity-program', 'weight-loss-program', 'diabetes-program']);
    for (const funnel of FUNNELS) {
      expect(funnel.status).toBe('draft');
      expect(funnel.indexable).toBe(true);
      expect(funnel.draftNote).toMatch(/approv/);
      expect(funnel.sections.find(s => s.kind === 'what-is-included')).toMatchObject({ source: 'pending', items: [] });
      expect(funnel.sections.map(s => s.kind)).toContain('call-to-action');
    }
    expect(allFunnels()).toBe(FUNNELS);
  });
  it('a draft and an unknown slug are the same absence to the public route', () => {
    expect(publishedFunnel('longevity-program')).toBeNull();
    expect(publishedFunnel('no-such-program')).toBeNull();
  });
  it('the weight loss and diabetes drafts record the attorney condition and carry no drug, brand, amount or cure language', () => {
    for (const slug of ['weight-loss-program', 'diabetes-program']) {
      const funnel = FUNNELS.find(f => f.slug === slug)!;
      expect(funnel.draftNote).toContain('attorney');
      const text = JSON.stringify(funnel.sections);
      expect(text).not.toMatch(/semaglutide|tirzepatide|ozempic|wegovy|mounjaro|zepbound|metformin|insulin/i);
      expect(text).not.toMatch(/\b(cure|reverse)/i);
      expect(text).not.toMatch(/(?<!not )\bguarantee/i);
      expect(text).not.toMatch(/\d+\s?(lb|lbs|pounds|kg|%)/i);
    }
    const diabetes = FUNNELS.find(f => f.slug === 'diabetes-program')!;
    expect(JSON.stringify(diabetes.sections)).toMatch(/does not replace your own doctor/);
    const weight = FUNNELS.find(f => f.slug === 'weight-loss-program')!;
    expect(JSON.stringify(weight.sections)).toMatch(/not guaranteed/);
  });
});

describe('the text rules', () => {
  it.each([
    ['an address', 'Visit https://example.com for more'],
    ['a bare domain', 'See clinic.example.com'],
    ['markup', 'Bold <b>claims</b>'],
    ['a dose', 'Take 500 mg daily'],
    ['a cure claim', 'This cures diabetes'],
    ['a reversal claim', 'Reverse your age'],
    ['a guarantee', 'Results guaranteed'],
    ['a promised amount', 'Lose 20 pounds'],
    ['a promised percentage', 'Lose 10% of body weight'],
    ['added years', 'Add years to your life: live longer'],
    ['a drug name', 'We prescribe semaglutide'],
    ['a brand name', 'Ask about Ozempic'],
    ['stopping medication', 'You may stop your medication'],
  ])('refuses %s', (_name, text) => {
    expect(funnelTextIssue(text)).not.toBeNull();
  });
  it('accepts plain descriptive copy', () => {
    expect(funnelTextIssue('A practitioner reviews the request and schedules the first visit.')).toBeNull();
  });
  it('refuses a definition whose copy breaks a rule anywhere, section by section', () => {
    const bad = structuredClone(longevityProgram);
    (bad.sections[0] as { lead: string }).lead = 'Results guaranteed in 30 days';
    expect(funnelDefinition.safeParse(bad).success).toBe(false);
    const faq = structuredClone(longevityProgram);
    (faq.sections.find(s => s.kind === 'faq') as { questions: { answer: string }[] }).questions[0]!.answer = 'See https://example.com';
    expect(funnelDefinition.safeParse(faq).success).toBe(false);
  });
});

describe('publication', () => {
  it('needs recorded approval, a "what is included" section from the published program, and no draft note', () => {
    expect(funnelDefinition.safeParse(published()).success).toBe(true);
    expect(funnelDefinition.safeParse({ ...published(), approval: null }).success).toBe(false);
    expect(funnelDefinition.safeParse({ ...published(), draftNote: 'still a draft' }).success).toBe(false);
    const pending = published();
    pending.sections = pending.sections.map(s => s.kind === 'what-is-included' ? { ...s, source: 'pending', items: [] } : s);
    expect(funnelDefinition.safeParse(pending).success).toBe(false);
    const invented = published();
    invented.sections = invented.sections.map(s => s.kind === 'what-is-included' ? { ...s, source: 'pending', items: ['A lesson written from general knowledge'] } : s);
    expect(funnelDefinition.safeParse(invented).success).toBe(false);
  });
  it('a draft says why it is a draft, and sections are unique with a hero and a call to action', () => {
    expect(funnelDefinition.safeParse({ ...longevityProgram, draftNote: null }).success).toBe(false);
    const doubled = structuredClone(longevityProgram);
    doubled.sections = [...doubled.sections, doubled.sections[0]!];
    expect(funnelDefinition.safeParse(doubled).success).toBe(false);
    const headless = structuredClone(longevityProgram);
    headless.sections = headless.sections.filter(s => s.kind !== 'hero');
    expect(funnelDefinition.safeParse(headless).success).toBe(false);
  });
  it('has no form, embed, testimonial or image section kind to put on a page', () => {
    const kinds = ['form', 'embed', 'testimonial', 'image', 'video', 'script'];
    for (const kind of kinds) {
      const funnel = structuredClone(longevityProgram) as unknown as { sections: unknown[] };
      funnel.sections.push({ kind, heading: 'x' });
      expect(funnelDefinition.safeParse(funnel).success, kind).toBe(false);
    }
  });
});
