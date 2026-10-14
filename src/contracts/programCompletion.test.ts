import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { PROGRAM_BOUND_COMPLETION, PROGRAM_BOUND_COMPLETION_ACCEPTED, boundCompletionFor, pinnedCompletionOf, programBoundCompletionRequest } from './programCompletion';
import { programAssignmentRequest } from './programAssignments';

/**
 * Cross-repository pin. expo/contracts/programCompletion.ts in AI_LONGEVITY_PRO_V2 is a byte-identical mirror of this
 * file, and the V2 suite (__tests__/program-completion-contract-pin.test.ts) pins the SAME digest.
 */
const PATH = 'src/contracts/programCompletion.ts';
it('Git preserves LF on checkout for the byte-pinned mirror', () => {
  const attributes = execFileSync('git', ['check-attr', 'text', 'eol', '--', PATH], { encoding: 'utf8', timeout: 10_000 });
  expect(attributes).toContain(`${PATH}: text: set`);
  expect(attributes).toContain(`${PATH}: eol: lf`);
});
it('carries the pinned bytes, is not yet accepted by the service the app reaches, and makes the plan revision mandatory', () => {
  expect(createHash('sha256').update(readFileSync(PATH)).digest('hex')).toBe('a002ec092dfb4798f81bb009609d1caddb46e63b00b2ca7983947f774074e477');
  expect(PROGRAM_BOUND_COMPLETION).toBe('program-bound-completion/1');
  expect(PROGRAM_BOUND_COMPLETION_ACCEPTED).toBe(false);
  const owned = { action: 'complete', enrollmentId: '11111111-1111-4111-8111-111111111111', sourceDigest: 'a'.repeat(64), expectedRevision: '3', itemId: 'lesson-a' };
  expect(programBoundCompletionRequest.safeParse(owned).success).toBe(false);
  expect(programBoundCompletionRequest.safeParse({ ...owned, planRevision: '' }).success).toBe(false);
  const bound = programBoundCompletionRequest.parse({ ...owned, planRevision: 'plan:1:labs:abc' });
  // The pinned request is unchanged: it still has no plan revision, so the successor is what carries one.
  expect(programAssignmentRequest.safeParse(bound).success).toBe(false);
  expect(pinnedCompletionOf(bound)).toEqual(owned);
  for (const extra of [{ purchaseUrl: 'https://shop.example.test/x' }, { completedAt: '2026-10-14T00:00:00Z' }])
    expect(programBoundCompletionRequest.safeParse({ ...bound, ...extra }).success).toBe(false);
});
it('binds a completion to exactly the read the person is looking at', () => {
  const read = { action: 'read', assignment: { enrollmentId: '11111111-1111-4111-8111-111111111111', sourceDigest: 'b'.repeat(64), revision: '7' },
    review: { planRevision: 'plan:7:labs:def' } } as unknown as Parameters<typeof boundCompletionFor>[0];
  expect(boundCompletionFor(read, 'lesson-c')).toEqual({ action: 'complete', enrollmentId: '11111111-1111-4111-8111-111111111111',
    sourceDigest: 'b'.repeat(64), expectedRevision: '7', planRevision: 'plan:7:labs:def', itemId: 'lesson-c' });
});
