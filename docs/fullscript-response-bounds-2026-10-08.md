# Fullscript response size and deadline safeguards

Token exchange and API reads previously buffered the complete provider body
before enforcing their existing 64,000-byte and 2,000,000-byte limits. They
now enforce those same limits while reading decoded stream bytes, reject
oversized or malformed declared lengths early, and cancel the body on refusal.
One request deadline covers both fetching and a stalled body. Split multibyte
JSON remains supported. Provider payloads are not included in refusal errors.

Three regressions fail against the original reader and pass after the repair.
All 14 Fullscript client tests pass, including malformed-length, multibyte,
stalled-body cancellation, OAuth, token, catalog, webhook and existing lab
request cases. The original catalog/lab paths and clinical/provider activation
gates are unchanged. These tests use fictional transports, not provider access.

This is source engineering, not hosted Fullscript qualification. No credential
was read or rotated, OAuth completed, provider cart sent, purchase made, or
clinical approval granted. Governed variant mapping, patient/clinic authority,
structured reviewed quantities, durable duplicate-safe delivery and uncertain
outcome reconciliation still need implementation and test-mode acceptance.
The current protocol cart continues to report `not_implemented` honestly.
The exposed sandbox secret still requires owner rotation.
