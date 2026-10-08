# Desktop product list integrity

The Desktop supplement list now checks the compiled receipt against the selected program version and the returned manifest before displaying products. Refreshing clears the previous list, and leaving the version aborts its requests and prevents late results from reopening it. These repairs do not add provider ordering or authorize real patient data.

## Repaired behavior

- Read responses must name the requested manifest. Their actual rows must match the included and excluded counts, with no duplicate phase and item pair.
- Included rows require an HTTPS purchase destination without embedded credentials and no exclusion reason. Excluded rows require a reason. Iron and reproductive-health exclusions remain unchanged.
- The selected program version, version number, content digest and both counts must agree across compilation and reading. A failed refresh drops the previous products and replay notice; the screen shows a generic error instead of server details.
- A selected version owns its request lifetime. Changing versions immediately replaces the panel with an empty scope. Cleanup aborts pending requests, and late responses cannot publish into a departed scope. Double clicks cannot start parallel compilations.
- React StrictMode setup and cleanup are supported. The session is created inside the effect so StrictMode's development probe cannot leave the panel using a disposed controller.
- Same-tab and cross-tab workforce session changes, and a hidden document, clear the list and abort its requests. The assignment parent also drops both patient and program selections, removing the product, revision and outcome panels until fresh selections are made.

## Verification

Six response-integrity tests cover consistent manifests, identity mismatch, incorrect counts, contradictory inclusion flags, duplicates and unsafe links. Five of those tests failed against the original contract and all six pass after the repair. Eight session tests exercise version and receipt mismatch, authorization failure, pending compilation and reading, disposal, repeated clicks and malformed responses. The existing twelve real-SQL cart tests retain the compilation and exclusion behavior.

The Chromium suite bundles the actual React product and assignment panels and runs thirteen lifecycle tests using fictional in-memory responses. It covers StrictMode, failed refresh, changing version during compilation and reading, a wrong manifest, unmounting during a read, session changes, cross-tab invalidation and hiding the document. Four product-panel invalidation tests failed before adding the lifecycle subscriptions; three assignment-selection tests failed with the original parent clear function. All thirteen pass with both repairs. External browser requests are blocked. CI runs the suite in the existing Chromium job after browser installation; no new dependency or paid build is required.

Run `npm run test:protocol-cart-browser` for the browser suite. Run the contract, session, database and existing rendered-view tests together with Vitest for the corresponding source and SQL checks.

## Program sharing outcomes

An additional actual-panel check reproduced three assignment UI defects: recursive refresh was suppressed by the held busy flag after a confirmed share, a subsequent status-read failure could not be distinguished from the accepted mutation, and a lost reply was incorrectly described as unchanged. The panel now performs one explicit status read after a verified share or phase-release receipt. A failed read preserves the confirmed mutation notice, while an authorization refusal clears the clinic context.

An unverified share response is uncertain, not a successful or unchanged assignment. Its content digest must match the selected preview. An uncertain result clears the preview and requires a status check before another attempt; there is no automatic mutation retry. Five additional browser cases cover confirmed share, unavailable status read, lost reply, mismatched receipt and authorization loss during the follow-up read. The final Chromium suite contains eighteen tests. Fictional lost-reply fixtures qualify the UI behavior only; real concurrent delivery and cross-device recovery remain hosted acceptance requirements.

GitHub unit verification on `fca55f6` found an older source assertion requiring the removed “Nothing was changed” catch message. That assertion now refuses the misleading message and requires the uncertain-outcome disclosure and no automatic retry. A nineteenth actual-panel browser case separately proves an explicit HTTP 409 is reported as a refusal with no assignment or follow-up mutation. This distinction preserves refusal coverage rather than restoring false certainty for a lost reply. The failing hosted runs remain failures; the correction requires fresh verification.

## Remaining provider delivery requirements

The manifest still returns `delivery.state: not_implemented`. No Fullscript cart, order or charge is created. Provider delivery needs governed catalog resolution, patient and clinic binding, reviewed quantities, patient-specific safety checks, durable idempotency and reconciliation of uncertain outcomes before synthetic hosted acceptance. Component tests do not substitute for those checks, matched release deployment, physical mobile testing, or PHI approval.
