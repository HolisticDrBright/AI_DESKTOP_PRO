import { createHash } from 'node:crypto';

/**
 * Test support: one fictional course in the published consumer-content shape (the shape
 * clinical_private.program_content_valid admits): two phases, a lesson, a habit, a supplement step
 * (never completable here), an unreleased lesson, and a second-phase lesson. Every title and every
 * instruction says it is fictional; there is no medical claim, dose, image or video in it.
 */
export const FICTIONAL_COURSE_TITLE = 'Fictional course (test fixture)';
export const fictionalCoursePhases = [
  {
    id: 'phase-1', title: 'Fictional phase one', days: 7, transition: 'scheduled', items: [
      { id: 'lesson-a', title: 'Fictional lesson A', kind: 'lesson', instructions: 'Fictional reading for a test. Nothing here is advice.', released: true },
      { id: 'habit-b', title: 'Fictional habit B', kind: 'habit', instructions: 'Fictional practice for a test.', released: true },
      { id: 'supplement-c', title: 'Fictional supplement step C', kind: 'supplement', instructions: 'Fictional; reviewed on My programs before anything is added.', released: true,
        product: { id: 'fictional-product-1', ingredientKeys: ['fictional-ingredient'], dose: 'Fictional label dose (test fixture)', purchaseUrl: null } },
      { id: 'lesson-d', title: 'Fictional lesson D (not yet released)', kind: 'lesson', instructions: 'Fictional; not released.', released: false },
    ],
  },
  {
    id: 'phase-2', title: 'Fictional phase two', days: 7, transition: 'scheduled', items: [
      { id: 'lesson-e', title: 'Fictional lesson E', kind: 'lesson', instructions: 'Fictional reading for a test.', released: true },
    ],
  },
];
/** The digest the assignment service computes over the patient-facing phases: sha256 of their JSON as PostgreSQL renders jsonb. */
export const fictionalCourseDigest = (phases: unknown = fictionalCoursePhases, render: (value: unknown) => string = value => JSON.stringify(value)) => createHash('sha256').update(render(phases)).digest('hex');
