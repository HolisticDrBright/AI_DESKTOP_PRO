import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  SQL_ADMISSION_CURRENT, consumerProgramFromDetail, emptyConsumerProgram, governedMediaIssue, newItem, pendingAdmission,
  readingGrade, readingLevelNote, validateConsumerProgram,
} from './consumerProgramAuthoring';

const program = () => ({ title: 'Fictional guide', phases: [{ id: 'phase-1', title: 'Phase one', days: 7, transition: 'scheduled', items: [
  { id: 'lesson-1', title: 'Fictional lesson', kind: 'lesson', instructions: 'Read this short lesson.', released: true },
  { id: 'supp-1', title: 'Fictional supplement', kind: 'supplement', instructions: 'Follow the label.', released: true,
    product: { id: 'product-1', ingredientKeys: ['fictional-mineral'], dose: 'Fictional dose', purchaseUrl: null } }] }] });

describe('consumer program validation is the shared contract', () => {
  it('accepts a plain program and reports it admitted by the current service', () => {
    const result = validateConsumerProgram(program());
    expect(result.ok && result.admittedByCurrentService).toBe(true);
    expect(result.ok && result.pending).toEqual({ education: [], catalog: [] });
  });
  it('accepts education fields and a catalog binding, and names the steps pending admission', () => {
    const value = program();
    Object.assign(value.phases[0]!.items[0]!, { rationale: 'Why it matters.', authorship: 'practitioner_authored', sources: [{ title: 'Source', url: 'https://education.example.com/a' }] });
    Object.assign(value.phases[0]!.items[1]!.product!, { catalog: { stableId: 'prd_fictional_magnesium', version: 3, target: 'synthetic-staging' } });
    const result = validateConsumerProgram(value);
    expect(result.ok && result.pending).toEqual({ education: ['lesson-1'], catalog: ['supp-1'] });
    expect(result.ok && result.admittedByCurrentService).toBe(false);
  });
  it.each([
    ['a blank title', (v: ReturnType<typeof program>) => { v.title = '   '; }, 'title'],
    ['a supplement without a product', (v: ReturnType<typeof program>) => { delete (v.phases[0]!.items[1] as { product?: unknown }).product; }, 'needs a governed product'],
    ['a product on a lesson', (v: ReturnType<typeof program>) => { Object.assign(v.phases[0]!.items[0]!, { product: { id: 'x', ingredientKeys: ['a'], dose: 'd', purchaseUrl: null } }); }, 'only a supplement step may carry one'],
    ['a duplicate step id', (v: ReturnType<typeof program>) => { v.phases[0]!.items[1]!.id = 'lesson-1'; }, 'used twice'],
    ['an insecure source', (v: ReturnType<typeof program>) => { Object.assign(v.phases[0]!.items[0]!, { sources: [{ title: 'x', url: 'http://education.example.com/a' }] }); }, 'https'],
    ['an unknown field', (v: ReturnType<typeof program>) => { Object.assign(v.phases[0]!.items[0]!, { dosingAdvice: 'two' }); }, 'dosingAdvice'],
    ['a free-text catalog stable id', (v: ReturnType<typeof program>) => { Object.assign(v.phases[0]!.items[1]!.product!, { catalog: { stableId: 'Magnesium', version: 1, target: 'synthetic-staging' } }); }, 'stableId'],
    ['no phases', (v: ReturnType<typeof program>) => { v.phases = []; }, 'phases'],
  ])('refuses %s with a readable issue', (_name, mutate, word) => {
    const value = program(); mutate(value);
    const result = validateConsumerProgram(value);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues.join('\n')).toContain(word);
  });
  it('holds the current SQL admission equal to the deployed migration text', () => {
    const sql = readFileSync('infra/aws-clinical-core/migrations/20260929120000_synthetic_program_assignments.sql', 'utf8');
    const array = (name: string) => sql.match(new RegExp(name + String.raw` text\[\]:=array\[([^\]]+)\]`))?.[1]?.split(',').map(s => s.trim().replace(/^'|'$/g, ''));
    expect(array('_item_keys')).toEqual([...SQL_ADMISSION_CURRENT.itemKeys]);
    expect(array('_product_keys')).toEqual([...SQL_ADMISSION_CURRENT.productKeys]);
    const candidate = readFileSync('infra/aws-clinical-core/source-candidates/program-education-catalog-admission.sql', 'utf8');
    expect(candidate).toContain("_education_keys text[]:=array['rationale','sources','media','authorship']");
    expect(candidate).toContain("_catalog_keys text[]:=array['stableId','version','target']");
  });
  it('pendingAdmission counts a step once however many wider fields it uses', () => {
    const value = program();
    Object.assign(value.phases[0]!.items[0]!, { rationale: 'r', authorship: 'unreviewed', media: [{ kind: 'image', url: 'https://media.example.com/a.png' }] });
    expect(pendingAdmission(value as never)).toEqual({ education: ['lesson-1'], catalog: [] });
  });
});

describe('governed media addresses', () => {
  it('accepts a plain https address on a public host', () => { expect(governedMediaIssue('https://media.example.com/clinic/fictional.mp4')).toBeNull(); });
  it.each([
    ['http://media.example.com/a.mp4', 'https'],
    ['https://user:secret@media.example.com/a.mp4', 'credentials'],
    ['https://media.example.com/a.mp4?token=abc', 'query string'],
    ['https://media.example.com/a.mp4#patient-7', 'query string or fragment'],
    ['https://localhost/a.mp4', 'public host'],
    ['https://media.example.test/a.mp4', 'public host'],
    ['not a url', 'complete https address'],
    ['https://media.example.com/' + 'x'.repeat(2048), '2048'],
  ])('refuses %s', (value, word) => { expect(governedMediaIssue(value)).toContain(word); });
});

describe('reading level hint', () => {
  it('says nothing for short or plain text and hints above about sixth grade', () => {
    expect(readingGrade('Take a walk.')).toBeNull();
    expect(readingLevelNote('Walk after dinner. Drink water. Sleep by ten. Keep it up each day.')).toBeNull();
    const dense = 'The physiological consequences of inadequate micronutrient bioavailability necessitate comprehensive individualized supplementation strategies.';
    expect(readingGrade(dense)!).toBeGreaterThan(12);
    expect(readingLevelNote(dense)).toContain('about grade 6');
  });
});

describe('editor helpers', () => {
  it('a new program starts with one phase and nothing released', () => {
    const value = emptyConsumerProgram('Fictional');
    expect(value.phases).toHaveLength(1);
    expect(newItem('supplement', 1)).toMatchObject({ released: false, product: { purchaseUrl: null, ingredientKeys: [] } });
    expect(newItem('lesson', 2)).not.toHaveProperty('product');
  });
  it('distinguishes a service that does not return the key from one that returns null', () => {
    expect(consumerProgramFromDetail(undefined)).toBeUndefined();
    expect(consumerProgramFromDetail(null)).toBeNull();
    expect(consumerProgramFromDetail({ title: 'T', phases: [] })).toEqual({ title: 'T', phases: [] });
    expect(consumerProgramFromDetail('junk')).toEqual({ title: '', phases: [] });
  });
});
