/** Coverage of the expanded local source diagnostic, never deployment approval. */
export const REQUIRED_NATIVE_AUTHORITY_SCENARIOS = Object.freeze([
  'private_key_read_denied', 'private_receipt_read_denied', 'fresh_admission_positive',
  'expiry_during_advisory_lock', 'membership_revoked_during_advisory_lock', 'key_retired_during_advisory_lock',
  'expiry_during_destination_row_lock', 'key_retired_during_destination_row_lock',
  'membership_revoked_during_destination_row_lock', 'patient_deactivated_during_destination_row_lock',
  'identity_disabled_during_destination_row_lock', 'person_disabled_during_destination_row_lock',
  'organization_suspended_during_destination_row_lock',
  ...['membership', 'patient', 'identity', 'person', 'organization'].map(action => action + '_revocation_waits_for_admitted_writer'),
  'concurrent_replay_one_destination', 'exact_replay_same_destination',
  'repeatable_read_refused_before_transfer', 'serializable_refused_before_transfer',
  'repeatable_read_withdrawal_during_wait', 'serializable_withdrawal_during_wait',
  'unrelated_clinic_transfers_share_fence', 'ordinary_patient_update_does_not_take_authority_fence',
  'queued_other_clinic_withdrawal_refuses_later_transfer',
  'mixed_lock_order_revoker_deadlock_rolls_back_atomically', 'mixed_lock_order_actor_deadlock_rolls_back_atomically',
]);

export function completeNativeAuthorityCoverage(results) {
  if (!Array.isArray(results) || results.length !== REQUIRED_NATIVE_AUTHORITY_SCENARIOS.length) return false;
  const expected = new Set(REQUIRED_NATIVE_AUTHORITY_SCENARIOS), observed = new Set();
  for (const result of results) {
    if (!result || typeof result !== 'object' || !expected.has(result.id)
      || observed.has(result.id) || result.passed !== true) return false;
    observed.add(result.id);
  }
  return observed.size === expected.size;
}
