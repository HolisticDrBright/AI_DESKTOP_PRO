// Cognito sub is an opaque, immutable issuer-local identifier, NOT an RFC
// UUID. AWS explicitly documents this:
// https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-attributes.html
//
// This is the bounded transport alphabet for the qualification manifest,
// comma-separated stack binding and subject-addressed CLI, not proof of an
// identity. Callers must still observe the exact sub under the reviewed pool,
// compare immutable person/org attributes, and verify current authorization.
// Do not trim, case-fold, parse UUID bits or convert a sub into a clinical ID.
// Clinical person/organization/row IDs retain their separate UUID validators.
export function isInventoryCognitoSubject(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$/.test(value);
}
