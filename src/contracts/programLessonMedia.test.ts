import { describe, expect, it } from 'vitest';
import { programPhases } from './programAssignments';
import { courseLessons } from './programEducationProgress';
import { validateConsumerProgram } from '@/lib/programs/consumerProgramAuthoring';

const clinic = '33333333-3333-4333-8333-333333333333';
const programId = '11111111-1111-4111-8111-111111111111';
const artifactId = '44444444-4444-4444-8444-444444444444';
const digest = 'a'.repeat(64);
const reference = () => ({ contractVersion: 'program-media-reference/1', artifactId, version: 2,
  sha256: digest, kind: 'video', contentType: 'video/mp4', bytes: 8_388_608,
  origin: { clinic, programId },
  url: `https://education.example.test/program-media/${clinic}/${programId}/${artifactId}/${digest}.mp4`,
  publishedAt: '2026-10-11T12:00:00Z', caption: { source: 'supplied_by_author', sha256: 'b'.repeat(64) }, transcript: null });
const program = (refs?: unknown[]) => ({ title: 'Fictional course', phases: [{ id: 'phase-1', title: 'First phase', days: 7,
  transition: 'scheduled', items: [{ id: 'lesson-1', title: 'First lesson', kind: 'lesson', instructions: 'Read this fictional lesson.',
    released: true, ...(refs ? { nativeMedia: refs } : {}) }] }] });

describe('native lesson media is a source reference, never a preview capability', () => {
  it('admits exact native references in a separate additive field without changing legacy slots', () => {
    const value = program([reference()]);
    expect(programPhases.safeParse(value.phases).success).toBe(true);
    expect(courseLessons(value.phases).lessons[0]?.hasMedia).toBe(true);
    const legacy = program();
    expect(programPhases.parse(legacy.phases)).toEqual(legacy.phases);
    expect(courseLessons(legacy.phases).lessons[0]?.hasMedia).toBe(false);
    Object.assign(legacy.phases[0].items[0], { media: [{ kind: 'video', url: 'https://education.example.com/legacy.mp4' }] });
    expect(programPhases.parse(legacy.phases)).toEqual(legacy.phases);
  });
  it('marks a native-only lesson pending admission rather than claiming the current SQL accepts it', () => {
    const result = validateConsumerProgram(program([reference()]));
    expect(result.ok).toBe(true);
    expect(result.ok && result.pending).toEqual({ education: ['lesson-1'], catalog: [] });
    expect(result.ok && result.admittedByCurrentService).toBe(false);
  });
  it.each([
    ['a private preview token', { previewToken: 'fictional-capability' }],
    ['a query token', { url: reference().url + '?token=fictional' }],
    ['another object path', { url: reference().url.replace(artifactId, programId) }],
    ['a different extension', { url: reference().url.replace('.mp4', '.png') }],
    ['a different content type', { contentType: 'image/png' }],
    ['oversized video', { bytes: 268_435_457 }],
    ['HTTP', { url: reference().url.replace('https:', 'http:') }],
    ['a fragment', { url: reference().url + '#private' }],
    ['browser-supplied approval', { approved: true }],
    ['a generated caption', { caption: { source: 'generated', sha256: 'b'.repeat(64) } }],
  ])('refuses %s rather than downgrading it to a URL', (_label, patch) => {
    expect(programPhases.safeParse(program([{ ...reference(), ...patch }]).phases).success).toBe(false);
  });
  it('refuses duplicate native identities and more than five combined media slots', () => {
    expect(programPhases.safeParse(program([reference(), reference()]).phases).success).toBe(false);
    const value = program([reference()]);
    Object.assign(value.phases[0].items[0], { media: Array.from({ length: 5 }, (_, i) => ({ kind: 'image', url: `https://education.example.com/${i}.png` })) });
    expect(programPhases.safeParse(value.phases).success).toBe(false);
  });
});
