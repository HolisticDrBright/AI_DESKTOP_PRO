# Fullscript protocol draft delivery

Fullscript cart delivery is still incomplete. The existing protocol-cart API compiles a manifest and explicitly returns `not_implemented`; this increment does not change that contract, add a send button or create a provider cart. It implements the deterministic payload and sandbox transport needed by the future durable delivery service.

## Implemented payload and transport

`src/server/fullscript/protocol-draft.ts` accepts an existing parsed, compiled manifest and an explicit variant mapping set. It requires exact manifest identity/content binding, one mapping for every included line, no extra or duplicate line, an exact product identity, nonempty instructions and an explicit positive integer package quantity. Duplicate variants refuse instead of merging different phases or guessing quantities. Excluded lines are not in the provider payload. Catalog and mapping digests are binding inputs, not review evidence; the compiler explicitly returns `authorityVerified: false` and `providerCreated: false`.

The stable intent digest binds recipient, practitioner, manifest, catalog, mapping, variants, quantities and exact instructions. It forms the idempotency key. No purchase-link parsing, catalog search by product name, dose interpretation, package estimate, substituted product or automatic approval exists in this compiler.

`FullscriptApiClient.createSupplementDraft` is sandbox-only and requires the token's `clinic:write` scope before any request. It always specifies `state: draft`, `send_to_patient: false` and `skip_email_notification: true`. It sends supplement variants and explicit units only, retains the existing instructions as `dosage.additional_info`, and includes the same intent key in metadata, partner order identity and the idempotency header. No labs, activation, patient email, checkout or charge is introduced. `retrieveTreatmentPlan` and `findTreatmentPlanByMetadata` require `clinic:read` and provide explicit reconciliation reads; neither certifies a response as the correct cart.

The client snapshots configuration and scopes, refuses noncanonical API/OAuth origins, rejects redirects, bounds responses and makes one request per call. A failed or uncertain POST has no automatic retry. A repeated explicit call uses the same immutable input/key. The runtime passes the stored token's actual scopes; constructing a client without scopes grants no draft-write capability. The existing action route does not expose these new methods.

These behaviors follow the provider's [treatment-plan contract](https://fullscript.dev/technical-reference/treatment-plans), [idempotency rules](https://fullscript.dev/technical-reference/idempotency) and [metadata lookup](https://fullscript.dev/technical-reference/metadata). An omitted or null treatment-plan state defaults to active, so draft state must be explicit. The provider's advertised OpenAPI URL returned an HTML “Not supported” page during inspection; actual response-schema and sandbox acceptance remain unresolved, rather than being inferred from a fictional test response.

## Required durable delivery service

The next increment must obtain the cart manifest, clinic, patient, practitioner, variant mappings, package quantities, current catalog/ingredient release and provider release from same-target server authority. Neither a client JSON mapping nor a matching digest is approval. Recheck access, consent, holds/exclusions, publication and supersession before admission and settlement. Preserve all excluded lines and mixed-provider lines in the owner-facing result rather than silently dropping them.

Persist an immutable recipient-specific intent and request digest before the provider call. Use a lease/settlement state machine so concurrent requests, authorization loss, cancellation and a lost reply cannot create duplicate carts or publish a stale cart. Recover with the original idempotency key or metadata lookup under the provider's documented rules, and verify the returned plan, recipient, practitioner, draft state, metadata and exact recommendation set before recording a receipt. A response URL alone is not success.

Then implement the workforce/consumer scoped status and review controls, artifact-bound deployment, privacy/export/retention treatment for recipient-specific intents and receipts, and hosted sandbox acceptance including both race orders and lost replies. Patient delivery, activation, production use, commercial provider approval and covered agreements are separate gates. The legacy lab-checkout route is not reused as protocol-cart authority.

## Verification scope

`npm run test:fullscript-protocol-draft` covers the compiler, HTTP transport with fictional responses, existing cart contract and existing actual-SQL cart exclusions. It does not contact Fullscript or AWS, verify real OAuth scopes, prove durable deduplication, certify a provider response, deploy an endpoint or establish device acceptance. The original six commercial phases remain incomplete. PHI stays disabled, production activation blocked and paid mobile builds held.

The completed local gate passed 44 tests across five files without skips. Typecheck, focused lint and full lint passed. The initial three-file run passed 26 tests, then typecheck failed because two test environment literals omitted the required `NODE_ENV`; the corrected full gate and subsequent typecheck passed. These results are not a new complete-suite or hosted-provider verdict. The preceding identity engineering's full suite and CI belong to that earlier source.
