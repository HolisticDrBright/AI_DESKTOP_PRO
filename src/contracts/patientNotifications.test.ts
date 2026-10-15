import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { defaultNotificationPreferences, NOTICE_KINDS } from './patientNotifications';

/**
 * Cross-repository pin. AI_LONGEVITY_PRO_V2 expo/contracts/patientNotifications.ts is the byte-identical mirror, and its suite
 * (__tests__/patient-notifications-contract-pin.test.ts) pins the SAME digest. LF-normalized so a Windows checkout reads the same bytes.
 */
it('is the contract the patient app mirrors byte for byte', () => {
  const contract = readFileSync('src/contracts/patientNotifications.ts', 'utf8').replace(/\r\n/g, '\n');
  expect(createHash('sha256').update(contract).digest('hex')).toBe('0e9a6098757693d5948c10bffdc5f2dcbb07651cb7067def0b08ad00ebe250d6');
});
it('keeps the decided defaults: email on, texts off, push fixed off, all five kinds', () => {
  const defaults = defaultNotificationPreferences();
  expect(NOTICE_KINDS).toEqual(['lab_result', 'protocol', 'message', 'form', 'program_lesson']);
  expect(defaults.appointmentReminders).toEqual({ email: true, sms: false });
  for (const kind of NOTICE_KINDS) expect(defaults.notices[kind]).toEqual({ email: true, sms: false, push: false });
});
