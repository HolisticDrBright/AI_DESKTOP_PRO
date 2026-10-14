/**
 * BLOCKED: production tokens require immutable person, organization and
 * production-bound claims. A public SignUp with only an email cannot be
 * approved into a clinic after creation. Do not enable registration until a
 * reviewed server-bound identity path and the clinic approval journey exist.
 */
export const WORKFORCE_SELF_SIGNUP_READY = false;
