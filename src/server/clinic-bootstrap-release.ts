/**
 * The Desktop's own switch for the new-clinic door (src/app/api/onboarding/clinic-bootstrap). It is a second, separate
 * hold beside the bootstrap service's `WORKFORCE_CLINIC_BOOTSTRAP_RELEASE` and the candidate's owner-only release row:
 * while it is `blocked` the route answers `workforce_clinic_bootstrap_not_released` before it reads a session, counts
 * an attempt or asks any service. Changing it is a reviewed change made only after the production security, agreement,
 * privacy and PHI reviews; nothing in this repository changes it.
 */
export const DESKTOP_CLINIC_BOOTSTRAP_RELEASE: 'blocked' | 'qualification' = 'blocked';
