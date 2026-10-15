/**
 * Header names of the stale-tab clinic fence (see src/server/clinic-fence.ts). Shared by the server and the browser:
 * the names carry no authority, and the token in them is only compared with the session's own selection.
 */
export const EXPECTED_CLINIC_HEADER = "x-aidp-expected-clinic";
export const CLINIC_BINDING_HEADER = "x-aidp-clinic-binding";
