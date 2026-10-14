import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { PROGRAM_STEP_PURCHASE, PROGRAM_STEP_PURCHASE_RELEASED, programStepPurchaseRequest } from './programStepPurchase';

/**
 * Cross-repository pin. expo/contracts/programStepPurchase.ts in AI_LONGEVITY_PRO_V2 is a byte-identical mirror of this
 * file, and the V2 suite (__tests__/program-step-purchase-contract-pin.test.ts) pins the SAME digest.
 */
const PATH = 'src/contracts/programStepPurchase.ts';
it('Git preserves LF on checkout for the byte-pinned mirror', () => {
  const attributes = execFileSync('git', ['check-attr', 'text', 'eol', '--', PATH], { encoding: 'utf8' });
  expect(attributes).toContain(`${PATH}: text: set`);
  expect(attributes).toContain(`${PATH}: eol: lf`);
});
it('carries the pinned bytes, is not released, and binds the action to the step’s own catalog product', () => {
  expect(createHash('sha256').update(readFileSync(PATH)).digest('hex')).toBe('417d0573c241262b4356a625627e2bf83e3db94468cdd0547f4e0891597d92a1');
  expect(PROGRAM_STEP_PURCHASE).toBe('program-step-purchase/1');
  expect(PROGRAM_STEP_PURCHASE_RELEASED).toBe(false);
  const step = { enrollmentId: '11111111-1111-4111-8111-111111111111', itemId: 'supp-iron', assignmentRevision: '2', planRevision: 'plan:1:labs:abc',
    sourceDigest: 'a'.repeat(64), connectionId: '22222222-2222-4222-8222-222222222222', catalog: { stableId: 'prd_fictional_iron', version: 1, target: 'production-clinical' } };
  const action = { contract: 'fullscript-consumer-action/2', kind: 'product_patient_action', purpose: 'supplement_purchase', requestId: '33333333-3333-4333-8333-333333333333',
    binding: { productStableId: 'prd_fictional_iron', productVersion: 1, labelStableId: 'lbl_fictional_iron', labelVersion: 1, offerStableId: 'off_fictional_iron', offerVersion: 1 } };
  expect(programStepPurchaseRequest.safeParse({ contract: PROGRAM_STEP_PURCHASE, step, action }).success).toBe(true);
  for (const wrong of [{ ...action, binding: { ...action.binding, productStableId: 'prd_fictional_other' } }, { ...action, binding: { ...action.binding, productVersion: 2 } }])
    expect(programStepPurchaseRequest.safeParse({ contract: PROGRAM_STEP_PURCHASE, step, action: wrong }).success).toBe(false);
  for (const extra of [{ purchaseUrl: 'https://us.fullscript.com/s/x/shop/product/RklDVElPTkFM' }, { orderingLink: 'x' }, { destinationUrl: 'x' }])
    expect(programStepPurchaseRequest.safeParse({ contract: PROGRAM_STEP_PURCHASE, step: { ...step, ...extra }, action }).success).toBe(false);
});
