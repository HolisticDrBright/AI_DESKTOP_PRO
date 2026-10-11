import type { FunnelDefinition } from '../schema';

/**
 * Longevity Program funnel. DRAFT: the "what is included" section must be filled from the real
 * published program (its content was not found in this repository; Brandon has been asked for
 * it) and the exact text needs Brandon's approval before `published`. No claims of added years
 * or reversed age, and no doses, anywhere on this page.
 */
export const longevityProgram: FunnelDefinition = {
  slug: 'longevity-program',
  status: 'draft',
  title: 'Longevity Program',
  description: 'A practitioner-led program for people who want a structured, measured approach to long-term health. Starts with a consultation.',
  indexable: true,
  programLabel: 'Longevity Program',
  consultSlug: 'longevity-program',
  sections: [
    { kind: 'hero', heading: 'A structured program for long-term health, led by a practitioner',
      lead: 'The Longevity Program is built around what can be measured and reviewed over time, with a practitioner who knows your results. It begins with a consultation, not a sign-up.' },
    { kind: 'who-it-is-for', heading: 'Who this is for',
      fits: ['Adults who want a planned, reviewed approach rather than general advice.', 'People willing to track and share results over months, not days.', 'Anyone who wants a practitioner, not an app alone, deciding what comes next.'],
      notFor: ['Anyone looking for a quick fix or a promise about how they will feel.', 'Children or teenagers; this program is for adults.'] },
    { kind: 'what-is-included', heading: 'What the program includes', source: 'pending', items: [],
      note: 'This section is written from the published Longevity Program itself once it is supplied; nothing here is drafted from general knowledge.' },
    { kind: 'how-it-works', heading: 'How it works', steps: [
      { title: 'Request a consultation', detail: 'Tell us your preferred times. A practitioner reviews the request and schedules the first visit.' },
      { title: 'First visit', detail: 'The practitioner learns your history and goals and decides, with you, whether the program fits.' },
      { title: 'The program', detail: 'Phases of practitioner-authored lessons and habits, with check-ins the practitioner releases.' },
      { title: 'Review', detail: 'Progress is reviewed against what was actually measured, and the plan changes only when the practitioner changes it.' },
    ] },
    { kind: 'faq', heading: 'Questions people ask', questions: [
      { question: 'Do I pay on this page?', answer: 'No. This page only requests a consultation. Any fees are discussed with the clinic after the first visit.' },
      { question: 'Is this medical treatment?', answer: 'The program is practitioner-led and does not replace your own doctor. Nothing on this page is a diagnosis or a prescription.' },
      { question: 'What happens after I send the request?', answer: 'A practitioner reviews it and the clinic contacts you using the details you gave. Requests are accepted or declined by a person.' },
    ] },
    { kind: 'call-to-action', heading: 'Start with a consultation', detail: 'Choose preferred times and the clinic will reply. No account, no payment, no health questions on this page.', buttonLabel: 'Request a consultation' },
  ],
  approval: null,
  draftNote: 'The "what is included" section is pending the published Longevity Program, and the exact text awaits approval by Brandon.',
};
