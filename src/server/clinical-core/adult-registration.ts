/** Launch eligibility, not identity/guardian verification. No health access is granted. */
export const ADULT_REGISTRATION_POLICY = 'adult-self-service/1' as const;
export type AdultRegistrationEligibility = {
  dateOfBirth: string;
  attestsAdult: boolean;
  registrationPolicy: typeof ADULT_REGISTRATION_POLICY;
};
export function isAdultRegistrationEligible(input: unknown, today = new Date().toISOString().slice(0, 10)): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const row = input as Record<string, unknown>;
  if (row.attestsAdult !== true || row.registrationPolicy !== ADULT_REGISTRATION_POLICY
    || typeof row.dateOfBirth !== 'string' || !validDate(row.dateOfBirth) || !validDate(today)
    || row.dateOfBirth > today) return false;
  const [year, month, day] = row.dateOfBirth.split('-').map(Number);
  const [nowYear, nowMonth, nowDay] = today.split('-').map(Number);
  // For a Feb 29 birth, use March 1 in non-leap years. Never round age up.
  const age = nowYear - year - (nowMonth < month || (nowMonth === month && nowDay < day) ? 1 : 0);
  return age >= 18;
}
function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}
