import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToMarkup, renderToText } from '@/test-support/renderToText';
import { CONSUMER_PROGRAM_HELD_TEXT, ConsumerProgramEditor, ConsumerProgramPreview } from './ConsumerProgramEditor';
import type { ConsumerProgram } from '@/lib/programs/consumerProgramAuthoring';

/**
 * Rendered for real (first render, no effects). What matters: the held state when the service does
 * not return the patient program, validation that names the issue, the admission notice when a field
 * the contract accepts is not yet admitted, and a preview that labels authorship, withholds held
 * steps and never prints a purchase destination as something to open.
 */
const program = (): ConsumerProgram => ({ title: 'Fictional guide', phases: [{ id: 'phase-1', title: 'Phase one', days: 7, transition: 'check_in', items: [
  { id: 'lesson-1', title: 'Fictional lesson', kind: 'lesson', instructions: 'Read this short lesson.', released: true, rationale: 'It helps you see why.', authorship: 'practitioner_authored',
    sources: [{ title: 'Fictional source', url: 'https://education.example.com/a' }], media: [{ kind: 'video', url: 'https://media.example.com/a.mp4', caption: 'Fictional clinician video' }] },
  { id: 'supp-1', title: 'Fictional supplement', kind: 'supplement', instructions: 'Follow the label.', released: false,
    product: { id: 'product-1', ingredientKeys: ['fictional-mineral'], dose: 'Fictional dose', purchaseUrl: 'https://shop.example.com/product', catalog: { stableId: 'prd_fictional_magnesium', version: 3, target: 'synthetic-staging' } } }] }] });
const noop = () => undefined;

describe('the consumer program editor', () => {
  it('is held, with the dependency named, when the service does not return the patient program', () => {
    const text = renderToText(createElement(ConsumerProgramEditor, { value: undefined, disabled: false, onChange: noop }));
    expect(text).toContain(CONSUMER_PROGRAM_HELD_TEXT);
    expect(text).toContain('program-education-catalog-admission');
    expect(text).not.toContain('Patient program title');
  });
  it('offers to add a program when the service returned none, and says what the absence means', () => {
    const text = renderToText(createElement(ConsumerProgramEditor, { value: null, disabled: false, onChange: noop }));
    expect(text).toContain('assigns nothing to a patient');
    expect(renderToMarkup(createElement(ConsumerProgramEditor, { value: null, disabled: false, onChange: noop }))).toContain('data-testid="consumer-program-add"');
  });
  it('reports a valid program and names the steps pending admission by the deployed service', () => {
    const markup = renderToMarkup(createElement(ConsumerProgramEditor, { value: program(), disabled: false, onChange: noop }));
    expect(markup).toContain('data-testid="consumer-program-validation" data-state="valid"');
    const text = renderToText(createElement(ConsumerProgramEditor, { value: program(), disabled: false, onChange: noop }));
    expect(text).toContain('Valid against the shared program contract: 1 phase, 2 steps.');
    expect(text).toContain('1 step uses education fields (lesson-1); 1 supplement step carries a catalog binding (supp-1).');
    expect(text).toContain('does not admit them yet');
    expect(text).toContain('never computed here');
  });
  it('names the issue when the contract refuses the program, and flags a media address that carries a token', () => {
    const bad = program();
    bad.phases[0]!.items[1]!.id = 'lesson-1';
    bad.phases[0]!.items[0]!.media = [{ kind: 'video', url: 'https://media.example.com/a.mp4?token=abc' }];
    const markup = renderToMarkup(createElement(ConsumerProgramEditor, { value: bad, disabled: false, onChange: noop }));
    expect(markup).toContain('data-state="invalid"');
    const text = renderToText(createElement(ConsumerProgramEditor, { value: bad, disabled: false, onChange: noop }));
    expect(text).toContain('The service would refuse to assign it.');
    expect(text).toContain('used twice');
    expect(text).toContain('Media address must not carry a query string or fragment');
  });
  it('hints when instructions read well above sixth grade', () => {
    const dense = program();
    dense.phases[0]!.items[0]!.instructions = 'The physiological consequences of inadequate micronutrient bioavailability necessitate comprehensive individualized supplementation strategies.';
    expect(renderToText(createElement(ConsumerProgramEditor, { value: dense, disabled: false, onChange: noop }))).toContain('aims for about grade 6');
  });
});

describe('the patient preview', () => {
  it('shows phase windows, authorship labels, education and media slots, withholds held steps and prints no purchase destination to open', () => {
    const text = renderToText(createElement(ConsumerProgramPreview, { program: program() }));
    expect(text).toContain('Days 1 to 7 of the program · this phase lasts 7 days · needs your check-in.');
    expect(text).toContain('Practitioner-authored');
    expect(text).toContain('Why this step matters. It helps you see why.');
    expect(text).toContain('Sources: Fictional source — https://education.example.com/a');
    expect(text).toContain('Video slot: Fictional clinician video — https://media.example.com/a.mp4');
    expect(text).toContain('Instructions withheld until reviewed.');
    expect(text).toContain('Unreviewed content — not practitioner-approved');
    expect(text).toContain('bound to catalog product prd_fictional_magnesium version 3 (synthetic-staging)');
    expect(text).not.toContain('shop.example.com');
    expect(text).toContain('Adding a guide does not buy products or change your doses.');
  });
  it('says plainly when a supplement step has no catalog binding', () => {
    const unbound = program();
    delete unbound.phases[0]!.items[1]!.product!.catalog;
    expect(renderToText(createElement(ConsumerProgramPreview, { program: unbound }))).toContain('not bound to a reviewed catalog product: the app offers no purchase link');
  });
});
