import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LEAD_PROGRAMS } from '@/contracts/leadCampaigns';
import { campaignEmailProblems, programPageEmailUrl } from './campaign-content';
import { renderStarterEmail, renderStarterSequencesMarkdown, STARTER_SEQUENCES } from './starter-sequences';

/**
 * The starter sequences are drafts that obey the content rules as written: each welcome email passes the
 * campaign content check once rendered with (fictional) sending settings and links only to its own program
 * page; each broadcast template is refused for exactly one reason, its unfilled update slot. The reviewable
 * file is generated from the source and must match it.
 */
const DRAFT_FILE = 'docs/campaign-starter-sequences-DRAFT-2026-10-14.md';
const settings = (program: (typeof LEAD_PROGRAMS)[number]) => ({
  programPageUrl: programPageEmailUrl('https://clinic.fictional.example', program), senderName: 'Fictional Clinic', mailingAddress: '1 Fictional Way, Testville, CA 90000',
});

describe('the starter sequences', () => {
  it('are drafts: three welcome emails and one broadcast template per program, with the attorney named for weight loss and diabetes', () => {
    expect(STARTER_SEQUENCES.map(s => s.program)).toEqual([...LEAD_PROGRAMS]);
    for (const sequence of STARTER_SEQUENCES) {
      expect(sequence.status).toBe('draft');
      expect(sequence.emails.map(e => [e.kind, e.step, e.sendAfterDays])).toEqual([['welcome', 1, 0], ['welcome', 2, 3], ['welcome', 3, 7], ['broadcast', null, null]]);
      expect(sequence.reviewers).toEqual(sequence.program === 'longevity-program' ? ['Brandon'] : ['Brandon', 'attorney']);
    }
  });
  it('every welcome email passes the content check, linking only to its own program page with ?via=email and the unsubscribe tag', () => {
    for (const sequence of STARTER_SEQUENCES) {
      for (const email of sequence.emails.filter(e => e.kind === 'welcome')) {
        const rendered = renderStarterEmail(sequence.program, email, settings(sequence.program));
        expect(campaignEmailProblems(rendered, settings(sequence.program)), email.id).toEqual([]);
        const urls = [...rendered.body.matchAll(/https?:\/\/[^\s]+/g)].map(m => m[0]);
        expect(new Set(urls), email.id).toEqual(new Set([`https://clinic.fictional.example/learn/${sequence.program}?via=email`]));
        expect(rendered.body, email.id).toContain('{% unsubscribe_link %}');
      }
    }
  });
  it('a broadcast template is not sendable until its update slot is written and approved', () => {
    for (const sequence of STARTER_SEQUENCES) {
      const template = sequence.emails.find(e => e.kind === 'broadcast')!;
      expect(campaignEmailProblems(renderStarterEmail(sequence.program, template, settings(sequence.program)), settings(sequence.program))).toEqual(['an unfilled placeholder']);
    }
  });
  it('name no drug, brand, dose, amount, cure, treatment or guarantee, and the weight loss and diabetes emails carry their required statements', () => {
    const text = (program: string) => JSON.stringify(STARTER_SEQUENCES.find(s => s.program === program));
    for (const sequence of STARTER_SEQUENCES) expect(text(sequence.program)).not.toMatch(/semaglutide|tirzepatide|ozempic|wegovy|mounjaro|metformin|insulin|\bcure|\breverse|\btreat|\d+\s?(lb|lbs|kg|%)|\d+\s?mg/i);
    expect(text('weight-loss-program')).toContain('it is not guaranteed');
    expect(text('weight-loss-program')).toContain('no amount or pace of change is promised');
    expect(text('diabetes-program')).toContain('does not replace your own doctor');
    expect(text('diabetes-program')).toContain('nothing in them suggests changing any medication');
  });
  it('the reviewable file is generated from this source and matches it', () => {
    const generated = renderStarterSequencesMarkdown();
    if (process.env.UPDATE_CAMPAIGN_DRAFTS === '1') writeFileSync(DRAFT_FILE, generated);
    expect(existsSync(DRAFT_FILE)).toBe(true);
    expect(readFileSync(DRAFT_FILE, 'utf8')).toBe(generated);
  });
});
