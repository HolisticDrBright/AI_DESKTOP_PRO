import { CAMPAIGN_PROGRAM_LABEL, CAMPAIGN_PROGRAMS, type CampaignProgram, type TemplateDraft } from './contract';

/**
 * Starter content, ALL DRAFT: for each program, a three-email welcome sequence and one broadcast template. A
 * practice installs them as drafts from the Campaigns screen; each email stays a draft until a named staff member
 * approves it (and, for Brandon's practice, the weight loss and diabetes emails also need his attorney's
 * sign-off). Nothing here is ever sent as written in this file.
 *
 * The reviewable copy is `docs/campaign-starter-sequences-DRAFT-2026-10-15.md`, generated from this file and
 * checked against it by a test, so the markup and the source cannot drift apart.
 *
 * The funnel content rules apply: no outcome guarantee, no claim to treat, cure or reverse anything, no drug or
 * brand name, no dose, no promised amount or pace of change, nothing about the reader beyond the program they
 * asked to hear about. Each email's one button leads to that program's page (`?via=email`); the footer and the
 * unsubscribe link are added to every email by the renderer. The broadcast keeps a `[[…]]` slot that the content
 * check refuses until it is written for a particular send.
 */
export const STARTER_STATUS = 'draft' as const;
export type StarterEmail = {
  id: string; kind: 'welcome' | 'broadcast'; step: 1 | 2 | 3 | null;
  /** Days after confirmation for the welcome steps; null for a broadcast, which is sent when scheduled. */
  sendAfterDays: number | null;
  subject: string; paragraphs: readonly string[]; linkText: string;
};
export type StarterSequence = { program: CampaignProgram; status: typeof STARTER_STATUS; reviewers: readonly ('Brandon' | 'attorney')[]; emails: readonly StarterEmail[] };

const CONFIRMED = (label: string) =>
  `Thank you for confirming. You will receive two more short emails about the ${label} over the next week, and occasional updates after that. You can stop at any time.`;
const CONSULTATION_FIRST = 'The first step is a consultation request. You choose a few times that suit you, and a practitioner reviews the request and replies.';
const BROADCAST_SLOT = '[[UPDATE: one or two short paragraphs written for this send and approved before it is scheduled]]';

function broadcast(program: CampaignProgram): StarterEmail {
  return { id: `${program}-broadcast`, kind: 'broadcast', step: null, sendAfterDays: null,
    subject: `An update about the ${CAMPAIGN_PROGRAM_LABEL[program]}`, paragraphs: [BROADCAST_SLOT], linkText: 'Read about the program' };
}

export const STARTER_SEQUENCES: readonly StarterSequence[] = [
  {
    program: 'longevity-program', status: STARTER_STATUS, reviewers: ['Brandon'],
    emails: [
      { id: 'longevity-program-welcome-1', kind: 'welcome', step: 1, sendAfterDays: 0, subject: 'Welcome: about the Longevity Program', linkText: 'Read about the program', paragraphs: [
        CONFIRMED('Longevity Program'),
        'The Longevity Program is led by a practitioner and built around what can be measured and reviewed over time. It is not a set of general tips: what comes next is decided by a practitioner who knows your results.',
        'Nothing in these emails is medical advice, and none of it replaces your own doctor.',
      ] },
      { id: 'longevity-program-welcome-2', kind: 'welcome', step: 2, sendAfterDays: 3, subject: 'How the Longevity Program is structured', linkText: 'See how it works', paragraphs: [
        'The program starts with a consultation. At the first visit, the practitioner learns your history and goals and decides, with you, whether the program fits.',
        'If it does, the program runs in phases of practitioner-authored lessons and habits, with check-ins the practitioner releases. Progress is reviewed against what was actually measured, and the plan changes only when the practitioner changes it.',
      ] },
      { id: 'longevity-program-welcome-3', kind: 'welcome', step: 3, sendAfterDays: 7, subject: 'Starting with a consultation', linkText: 'Request a consultation from the program page', paragraphs: [
        CONSULTATION_FIRST,
        'The request page asks no health questions and takes no payment. Whether the program is right for you is decided together at the first visit.',
      ] },
      broadcast('longevity-program'),
    ],
  },
  {
    program: 'weight-loss-program', status: STARTER_STATUS, reviewers: ['Brandon', 'attorney'],
    emails: [
      { id: 'weight-loss-program-welcome-1', kind: 'welcome', step: 1, sendAfterDays: 0, subject: 'Welcome: about the weight loss program', linkText: 'Read about the program', paragraphs: [
        CONFIRMED('weight loss program'),
        'The program is practitioner-led and supervised. It begins with an evaluation by a clinician, who reviews your history and goals.',
        'Whether any prescription is appropriate is the clinician\'s decision after that evaluation, and it is not guaranteed. These emails are not an offer of any medication, and nothing in them is medical advice.',
      ] },
      { id: 'weight-loss-program-welcome-2', kind: 'welcome', step: 2, sendAfterDays: 3, subject: 'How the weight loss program works', linkText: 'See how it works', paragraphs: [
        'After the evaluation, if the program fits, it proceeds in phases with check-ins the practitioner releases.',
        'Progress is reviewed against what was measured. Results differ from person to person, and no amount or pace of change is promised.',
      ] },
      { id: 'weight-loss-program-welcome-3', kind: 'welcome', step: 3, sendAfterDays: 7, subject: 'Starting with a consultation', linkText: 'Request a consultation from the program page', paragraphs: [
        CONSULTATION_FIRST,
        'The request page asks no health questions and takes no payment. Any decision about your care is made by a clinician after an evaluation.',
      ] },
      broadcast('weight-loss-program'),
    ],
  },
  {
    program: 'diabetes-program', status: STARTER_STATUS, reviewers: ['Brandon', 'attorney'],
    emails: [
      { id: 'diabetes-program-welcome-1', kind: 'welcome', step: 1, sendAfterDays: 0, subject: 'Welcome: about the diabetes program', linkText: 'Read about the program', paragraphs: [
        CONFIRMED('diabetes program'),
        'The diabetes program is practitioner-led and runs alongside the care you already receive. Your own doctor remains responsible for your diabetes care; the program adds to that care and never alters it.',
        'Nothing in these emails is medical advice, and nothing in them suggests changing any medication. Please keep following your own doctor\'s instructions.',
      ] },
      { id: 'diabetes-program-welcome-2', kind: 'welcome', step: 2, sendAfterDays: 3, subject: 'How the diabetes program works', linkText: 'See how it works', paragraphs: [
        'It starts with a consultation. At the first visit, the practitioner learns about your situation and the care you already receive, and decides with you whether the program fits.',
        'If it does, the program runs in phases of practitioner-authored lessons and habits, with check-ins the practitioner releases.',
      ] },
      { id: 'diabetes-program-welcome-3', kind: 'welcome', step: 3, sendAfterDays: 7, subject: 'Starting with a consultation', linkText: 'Request a consultation from the program page', paragraphs: [
        CONSULTATION_FIRST,
        'The request page asks no health questions and takes no payment. The program does not replace your own doctor.',
      ] },
      broadcast('diabetes-program'),
    ],
  },
];
if (STARTER_SEQUENCES.map(s => s.program).join() !== CAMPAIGN_PROGRAMS.join()) throw new Error('one starter sequence per program, in list order');

const GREETING = 'Hello {{first_name|there}},';

/** One starter email as a block template: a greeting, the paragraphs, and one button to the program page. */
export function starterTemplate(program: CampaignProgram, email: StarterEmail): TemplateDraft {
  return {
    programKey: program, kind: email.kind === 'welcome' ? 'sequence' : 'broadcast',
    name: email.kind === 'welcome' ? `Welcome ${email.step}` : 'Update (broadcast)', subject: email.subject,
    blocks: [{ type: 'paragraph', text: GREETING }, ...email.paragraphs.map(text => ({ type: 'paragraph' as const, text })), { type: 'button', label: email.linkText }],
  };
}

/** The welcome steps as waits between steps: on confirmation, then the gaps between the sendAfterDays values. */
export function starterWaits(sequence: StarterSequence): number[] {
  const days = sequence.emails.filter(e => e.kind === 'welcome').map(e => e.sendAfterDays ?? 0);
  return days.map((day, index) => day - (index === 0 ? 0 : days[index - 1]!));
}

/** The reviewable file: every email in full, as the renderer lays it out, with placeholders for the practice's settings. */
export function renderStarterMarkdown(): string {
  const out: string[] = [
    '# Campaign starter sequences: DRAFT for review (2026-10-15)',
    '',
    'Generated from `src/campaigns/starter-content.ts`; a test fails if the two differ. Mark up this file; the source',
    'is then changed to match. **Nothing here has been sent or scheduled.** A practice installs these as drafts, and',
    'each email stays a draft until a named staff member approves it. For Brandon\'s practice, the weight loss and',
    'diabetes emails also need his attorney\'s sign-off before approval.',
    '',
    'Each email\'s one button leads to its own program page (`?via=email`). `{{first_name|there}}` is the only value',
    'filled in from the reader. The footer is added to every email: why the reader is receiving it, the practice\'s',
    'sender name and mailing address, and the unsubscribe link (plus one-click unsubscribe headers). A broadcast\'s',
    '`[[…]]` slot is written and approved for each send.',
  ];
  for (const sequence of STARTER_SEQUENCES) {
    out.push('', `## ${CAMPAIGN_PROGRAM_LABEL[sequence.program]}`, '', `Status: **${sequence.status}**. Approval needed from: ${sequence.reviewers.join(' and ')}.`);
    for (const email of sequence.emails) {
      const when = email.kind === 'welcome' ? `Welcome email ${email.step}, sent ${email.sendAfterDays === 0 ? 'on confirmation' : `${email.sendAfterDays} days after confirmation`}` : 'Broadcast template, sent only when scheduled';
      const body = [GREETING, ...email.paragraphs, `[${email.linkText}] -> [[PUBLIC SITE ADDRESS]]/learn/${sequence.program}?via=email`,
        '--', `You are receiving this because you asked [[SENDER NAME]] for email updates about the ${CAMPAIGN_PROGRAM_LABEL[sequence.program]}.`,
        '[[SENDER NAME]]', '[[MAILING ADDRESS]]', 'Unsubscribe: [[UNSUBSCRIBE LINK]]'];
      out.push('', `### ${when}`, '', `Subject: ${email.subject}`, '', '```text', body.join('\n\n'), '```');
    }
  }
  return out.join('\n') + '\n';
}
