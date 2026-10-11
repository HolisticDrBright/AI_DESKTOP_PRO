import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Source assertions for the Studio wiring the editor render test cannot reach (the Studio loads in an
 * effect). What matters: the patient program round-trips through the save payload only when the service
 * returned it, submission is gated on the shared contract, and the publish dialog states the admission
 * dependency rather than implying the version reaches a patient.
 */
const source = readFileSync('src/components/programs/ProgramStudio.tsx', 'utf8').replace(/\r\n?/g, '\n');
const types = readFileSync('src/adapters/live-types.ts', 'utf8').replace(/\r\n?/g, '\n');

describe('the Program Studio and the patient program', () => {
  it('mounts the editor and the preview from the real components', () => {
    expect(source).toContain('from "@/components/programs/ConsumerProgramEditor"');
    expect(source).toContain('<ConsumerProgramEditor');
    expect(source).toContain('<ConsumerProgramPreview program={previewValidation.program} />');
  });
  it('sends the patient program only when the service returned the key, so unseen content is never overwritten', () => {
    expect(source).toContain('consumerProgram: consumerProgramFromDetail(v.consumerProgram)');
    expect(source).toContain('...(d.consumerProgram !== undefined ? { consumerProgram: d.consumerProgram } : {})');
    expect(types).toContain('consumerProgram?: unknown;');
  });
  it('gates submission on the shared contract and edits only a draft', () => {
    expect(source).toContain('const consumerProgramInvalid = draft?.consumerProgram ? !validateConsumerProgram(draft.consumerProgram).ok : false;');
    expect(source).toContain('disabled={busy || consumerProgramInvalid}');
    expect(source).toContain('disabled={editable.status !== "draft" || busy}');
  });
  it('states the admission dependency where publishing is confirmed, and what authoring is not', () => {
    expect(source).toContain('refuses to assign the version until the reviewed admission candidate is applied');
    expect(source).toContain('none is a dose, a claim or an approval');
    expect(source).toContain('their plan is unchanged until they do');
  });
});
