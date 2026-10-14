import type { FunnelDefinition } from '../schema';

/**
 * Weight loss program funnel. DRAFT, and it stays a draft until two things happen: the "what is
 * included" section is filled from the real published program (none was found in this
 * repository), and Brandon's attorney approves the exact text. The copy names no drug or brand,
 * promises no amount or speed of weight loss, shows no before-and-after figures, and says that
 * any prescription is a clinician's decision after an evaluation and is not guaranteed.
 */
export const weightLossPeptideProgram: FunnelDefinition = {
  slug: 'weight-loss-program',
  status: 'draft',
  title: 'Weight Loss Program',
  description: 'A clinician-supervised weight loss program that begins with an evaluation. Whether any prescription is appropriate is decided by a clinician, individually.',
  indexable: true,
  programLabel: 'Weight loss program',
  consultSlug: 'weight-loss-program',
  channelConsultSlugs: { email: 'weight-loss-program-email' },
  updates: { programKey: 'weight-loss-program' },
  programBinding: null,
  sections: [
    { kind: 'hero', heading: 'Weight loss with a clinician, not a checkout page',
      lead: 'This program starts with an evaluation. A clinician decides, with you, what is appropriate; nothing is prescribed from a form and nothing is promised in advance.' },
    { kind: 'who-it-is-for', heading: 'Who this is for',
      fits: ['Adults who want supervised, reviewed weight loss rather than a product.', 'People prepared to attend follow-up visits and report how things are going.', 'Anyone who wants a clinician to decide whether medication is appropriate for them at all.'],
      notFor: ['Anyone seeking a specific medicine by name; that is not how this program works.', 'Children or teenagers; this program is for adults.'] },
    { kind: 'what-is-included', heading: 'What the program includes', source: 'pending', items: [],
      note: 'This section is written from the published program itself once it is supplied; nothing here is drafted from general knowledge.' },
    { kind: 'how-it-works', heading: 'How it works', steps: [
      { title: 'Request a consultation', detail: 'Tell us your preferred times. A practitioner reviews the request and schedules the first visit.' },
      { title: 'Evaluation', detail: 'A clinician reviews your history and goals. Whether any prescription is appropriate is their decision after this evaluation, and it is not guaranteed.' },
      { title: 'Supervised program', detail: 'If the program fits, it proceeds in phases with check-ins the practitioner releases.' },
      { title: 'Review', detail: 'Progress is reviewed against what was measured. Results differ from person to person and no amount or pace is promised.' },
    ] },
    { kind: 'faq', heading: 'Questions people ask', questions: [
      { question: 'Will I be prescribed medication?', answer: 'Only a clinician can decide that, after an evaluation, and only if it is appropriate for you. Requesting a consultation does not mean a prescription.' },
      { question: 'How much weight will I lose?', answer: 'Nobody can promise an amount or a pace. The program is reviewed over time against what is actually measured.' },
      { question: 'Do I have to pay to start?', answer: 'No. Requesting a consultation costs nothing on this page. Buying the program directly is a separate choice; when it is available, the exact price and terms are shown before anything is charged, and payment is taken on a separate secure checkout page, never on this one.' },
      { question: 'Does buying the program include a prescription?', answer: 'No. Buying the program gives you access to the program lessons and habits only. Whether any prescription is appropriate is a clinician\'s decision after an evaluation, and it is not guaranteed by any purchase.' },
    ] },
    { kind: 'call-to-action', heading: 'Two ways to start', detail: 'Request an evaluation: choose preferred times and the clinic will reply, with no account, no payment and no health questions on this page. Or buy the program when it is available; price and terms are shown before anything is charged, and a purchase includes no prescription.', buttonLabel: 'Request a consultation' },
  ],
  approval: null,
  draftNote: 'Not published until the "what is included" section is filled from the published program and the exact text is approved by Brandon and his attorney.',
};
