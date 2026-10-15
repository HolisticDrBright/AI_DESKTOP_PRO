import { LEAD_PROGRAM_LABEL, LEAD_PROGRAMS, type LeadProgram } from '@/contracts/leadCampaigns';

/**
 * Starter email sequences, ALL DRAFT. For each program: a three-email welcome sequence for someone who
 * has just confirmed, and one broadcast template.
 *
 * Nothing here is sent by this repository. When Brandon (and, for the weight loss and diabetes programs,
 * his attorney) has approved the exact text, it is entered into Dittofeed as templates and a journey. The
 * reviewable copy is `docs/campaign-starter-sequences-DRAFT-2026-10-14.md`, which is generated from this
 * file and checked against it by a test, so the markup and the source cannot drift apart.
 *
 * The funnel content rules apply:
 * - no outcome guarantees, no claim to treat, cure or reverse anything;
 * - no drug or brand names, no doses, no promised amount or pace of change;
 * - nothing about the reader beyond the program they asked to hear about.
 *
 * Every email links to that program's page with `?via=email` and to the unsubscribe page, and nowhere
 * else. A broadcast template keeps a `[[…]]` slot that the content check refuses until it is written and
 * approved for a particular send.
 */
export const STARTER_SEQUENCES_STATUS = 'draft' as const;
export type StarterEmail = {
  id: string; kind: 'welcome' | 'broadcast'; step: 1 | 2 | 3 | null;
  /** Days after confirmation for the welcome steps; null for a broadcast, which is sent when scheduled. */
  sendAfterDays: number | null;
  subject: string; paragraphs: readonly string[]; linkText: string;
};
export type StarterSequence = { program: LeadProgram; status: typeof STARTER_SEQUENCES_STATUS; reviewers: readonly ('Brandon' | 'attorney')[]; emails: readonly StarterEmail[] };

const CONFIRMED = (label: string) =>
  `Thank you for confirming. You will receive two more short emails about the ${label} over the next week, and occasional updates after that. You can stop at any time.`;
const CONSULTATION_FIRST = 'The first step is a consultation request. You choose a few times that suit you, and a practitioner reviews the request and replies.';
const BROADCAST_SLOT = '[[UPDATE: one or two short paragraphs written for this send and approved before it is scheduled]]';

function broadcast(program: LeadProgram): StarterEmail {
  return { id: `${program}-broadcast`, kind: 'broadcast', step: null, sendAfterDays: null,
    subject: `An update about the ${LEAD_PROGRAM_LABEL[program]}`, paragraphs: [BROADCAST_SLOT], linkText: 'Read about the program' };
}

export const STARTER_SEQUENCES: readonly StarterSequence[] = [
  {
    program: 'longevity-program', status: STARTER_SEQUENCES_STATUS, reviewers: ['Brandon'],
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
    program: 'weight-loss-program', status: STARTER_SEQUENCES_STATUS, reviewers: ['Brandon', 'attorney'],
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
    program: 'diabetes-program', status: STARTER_SEQUENCES_STATUS, reviewers: ['Brandon', 'attorney'],
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
if (STARTER_SEQUENCES.map(s => s.program).join() !== LEAD_PROGRAMS.join()) throw new Error('one starter sequence per program, in list order');

/**
 * One email as it would be entered into Dittofeed: plain text with Dittofeed's own unsubscribe tag, the
 * first name as the only value filled in from the reader, and the sending settings' name and address.
 */
export function renderStarterEmail(program: LeadProgram, email: StarterEmail, settings: { programPageUrl: string; senderName: string; mailingAddress: string }) {
  const label = LEAD_PROGRAM_LABEL[program];
  const body = [
    "Hello {{ user.firstName | default: 'there' }},",
    ...email.paragraphs,
    `${email.linkText}: ${settings.programPageUrl}`,
    `${settings.senderName}\n${settings.mailingAddress}`,
    `You are receiving this because you asked for email updates about the ${label} and confirmed your address. {% unsubscribe_link %}`,
  ].join('\n\n');
  return { subject: email.subject, body };
}

/** The reviewable file: every email in full, with placeholders where the sending settings will go. */
export function renderStarterSequencesMarkdown(): string {
  const placeholders = { programPageUrl: '[[PUBLIC SITE ADDRESS]]/learn/<program>?via=email', senderName: '[[FROM NAME]]', mailingAddress: '[[MAILING ADDRESS]]' };
  const out: string[] = [
    '# Campaign starter sequences: DRAFT for review (2026-10-14)',
    '',
    'Generated from `src/lead-signup/starter-sequences.ts`; a test fails if the two differ. Mark up this file;',
    'the source is then changed to match. **Nothing here has been sent or scheduled.** Each email is a draft until',
    'Brandon approves its exact text, and the weight loss and diabetes emails also need his attorney\'s approval.',
    '',
    'Each email links only to its own program page (`?via=email`) and the unsubscribe page. `{{ user.firstName }}`',
    'is the only value filled in from the reader. `[[…]]` marks a value supplied at send time: the public site',
    'address, the "from" name and the mailing address come from the sending settings, and a broadcast\'s',
    'update text is written and approved for each send.',
  ];
  for (const sequence of STARTER_SEQUENCES) {
    out.push('', `## ${LEAD_PROGRAM_LABEL[sequence.program]}`, '', `Status: **${sequence.status}**. Approval needed from: ${sequence.reviewers.join(' and ')}.`);
    for (const email of sequence.emails) {
      const rendered = renderStarterEmail(sequence.program, email, { ...placeholders, programPageUrl: placeholders.programPageUrl.replace('<program>', sequence.program) });
      const when = email.kind === 'welcome' ? `Welcome email ${email.step}, sent ${email.sendAfterDays === 0 ? 'on confirmation' : `${email.sendAfterDays} days after confirmation`}` : 'Broadcast template, sent only when scheduled';
      out.push('', `### ${when}`, '', `Subject: ${rendered.subject}`, '', '```text', rendered.body, '```');
    }
  }
  return out.join('\n') + '\n';
}
