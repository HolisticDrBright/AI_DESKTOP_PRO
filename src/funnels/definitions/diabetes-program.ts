import type { FunnelDefinition } from '../schema';

/**
 * Diabetes program funnel. DRAFT until the "what is included" section is filled from the real
 * published program (none was found in this repository) and Brandon's attorney approves the
 * exact text. The page says who the program is for. It does not claim to cure, reverse or treat
 * diabetes, does not suggest changing or stopping any medication, and states that the program
 * does not replace the visitor's own doctor.
 */
export const diabetesProgram: FunnelDefinition = {
  slug: 'diabetes-program',
  status: 'draft',
  title: 'Diabetes Program',
  description: 'A practitioner-led lifestyle program for adults living with diabetes, alongside the care of their own doctor. Starts with a consultation.',
  indexable: true,
  programLabel: 'Diabetes program',
  consultSlug: 'diabetes-program',
  programBinding: null,
  sections: [
    { kind: 'hero', heading: 'A structured lifestyle program for adults living with diabetes',
      lead: 'This program works alongside the care you already receive. It does not replace your own doctor, and it changes nothing about your medication; it adds structure, lessons and check-ins with a practitioner.' },
    { kind: 'who-it-is-for', heading: 'Who this is for',
      fits: ['Adults living with diabetes who want structured support for daily habits.', 'People who already have a doctor managing their condition and want to add a reviewed program alongside that care.', 'Anyone willing to track and share what they measure over time.'],
      notFor: ['Anyone looking to replace their doctor or their current treatment; this program is not that.', 'Children or teenagers; this program is for adults.'] },
    { kind: 'what-is-included', heading: 'What the program includes', source: 'pending', items: [],
      note: 'This section is written from the published program itself once it is supplied; nothing here is drafted from general knowledge.' },
    { kind: 'how-it-works', heading: 'How it works', steps: [
      { title: 'Request a consultation', detail: 'Tell us your preferred times. A practitioner reviews the request and schedules the first visit.' },
      { title: 'First visit', detail: 'The practitioner learns about your situation and the care you already receive, and decides with you whether the program fits.' },
      { title: 'The program', detail: 'Phases of practitioner-authored lessons and habits, with check-ins the practitioner releases.' },
      { title: 'Alongside your doctor', detail: 'Your own doctor remains responsible for your diabetes care. The program adds to that care and never alters it.' },
    ] },
    { kind: 'faq', heading: 'Questions people ask', questions: [
      { question: 'Does this replace my doctor?', answer: 'No. Your own doctor stays responsible for your diabetes care. This program runs alongside that care.' },
      { question: 'Will the program change my treatment?', answer: 'No. Nothing in the program alters what your doctor has prescribed. Questions about treatment belong with your doctor.' },
      { question: 'Do I have to pay to start?', answer: 'No. Requesting a consultation costs nothing on this page. Buying the program directly is a separate choice; when it is available, the exact price and terms are shown before anything is charged, and payment is taken on a separate secure checkout page, never on this one.' },
      { question: 'Does buying the program change my care?', answer: 'No. Buying the program gives you access to lessons and habits that run alongside the care you already receive. It changes nothing about your treatment and your own doctor stays responsible for your diabetes care.' },
    ] },
    { kind: 'call-to-action', heading: 'Two ways to start', detail: 'Request a consultation: choose preferred times and the clinic will reply, with no account, no payment and no health questions on this page. Or buy the program when it is available; price and terms are shown before anything is charged, and nothing about your treatment changes.', buttonLabel: 'Request a consultation' },
  ],
  approval: null,
  draftNote: 'Not published until the "what is included" section is filled from the published program and the exact text is approved by Brandon and his attorney.',
};
