import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { FULLSCRIPT_CONSUMER_ACTION, PURCHASE_ADMISSION, productActionIssued } from './fullscriptConsumerAction';

/**
 * Cross-repository pin. expo/contracts/fullscriptConsumerAction.ts in AI_LONGEVITY_PRO_V2 is a byte-identical
 * mirror of this file, and the V2 suite (__tests__/fullscript-consumer-action-contract-pin.test.ts) pins the
 * SAME digest. A change on either side without the other fails both.
 */
const PATH = 'src/contracts/fullscriptConsumerAction.ts';
it('Git preserves LF on checkout for the byte-pinned mirror', () => {
  const attributes = execFileSync('git', ['check-attr', 'text', 'eol', '--', PATH], { encoding: 'utf8' });
  expect(attributes).toContain(`${PATH}: text: set`);
  expect(attributes).toContain(`${PATH}: eol: lf`);
});
it('carries the pinned bytes and the versions both apps speak', () => {
  expect(createHash('sha256').update(readFileSync(PATH)).digest('hex')).toBe('585fe3f560da04a6d9c57a2a5a1e92f0168446d89f2a8ce4af61884d63f20ee8');
  expect(FULLSCRIPT_CONSUMER_ACTION).toBe('fullscript-consumer-action/2');
  expect(PURCHASE_ADMISSION).toBe('purchase-admission/1');
  // An issued action names what it binds and never where it goes; only redemption returns an address.
  const issued = { contractVersion: FULLSCRIPT_CONSUMER_ACTION, environment: 'synthetic-staging', provider: 'fullscript',
    data: { actionId: `act_${'a'.repeat(32)}`, kind: 'product_patient_action', purpose: 'supplement_purchase',
      binding: { productStableId: 'prd_fictional', productVersion: 1, labelStableId: 'lbl_fictional', labelVersion: 1, offerStableId: 'off_fictional', offerVersion: 1 },
      issuedAt: '2026-10-13T12:00:00Z', expiresAt: '2026-10-13T12:10:00Z', syntheticOnly: true, disclosure: 'FICTIONAL.' } };
  expect(productActionIssued.safeParse(issued).success).toBe(true);
  expect(productActionIssued.safeParse({ ...issued, data: { ...issued.data, destinationUrl: 'https://us.fullscript.com/s/fictional/shop/product/RklDVElPTkFM' } }).success).toBe(false);
});
