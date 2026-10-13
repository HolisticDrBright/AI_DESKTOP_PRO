# Ask ALP provider response bounds and qualification

Ask ALP now enforces its existing 512 KiB response limit during download,
rather than after materializing the complete body. Its shared provider reader
also refuses without waiting for a provider's cancellation acknowledgement.
This is transport hardening, not a release of production chat, recommendations
or real patient data.

## Source and scope

The repair branch is `agent/ask-alp-response-bounds-20261013`, starting at
Desktop `bfeed9cf347a61ac0e7717d9fc8c49c78a24e43b`. That parent already contains
the separate, disabled care-connections qualification source. Claude's
overnight source assignment still starts at Desktop `c3f044b` and V2
`92a750c`; integrate these independent commits deliberately after comparing
the overlap report.

Changed runtime files are `src/server/clinical-core/aws-ask-alp-openai.ts`
and `src/server/clinical-core/bounded-provider-json.ts`. No SQL, reviewed
clinical release, catalog label, feature flag, signed prompt, model selection,
provider authority or credential content changes are part of this repair.
The V2 catalog transport and recommendation work remain Claude's lane.

## Reproductions and repair

The unchanged parent with the new transport tests had 22 failures and 21
passes across 43 tests. These are failing assertions covering several related
defects, not 22 independently discovered clinical defects.

| Boundary | Failing observation | Repair |
| --- | --- | --- |
| Actual received bytes | An over-limit reply was completely drained before refusal | Use the existing bounded reader; stop at the first byte overrun and cancel the remaining stream |
| Declared length | Oversized, malformed and disagreeing lengths could authorize a response | Reject invalid declarations before reading and compare identity-encoded bodies with actual byte counts |
| HTTP and media type | Error bodies were read, redirects were not cancelled, and substring matching admitted false JSON media types | Refuse and cancel before reading unless the response is successful and its media type is exactly application/json |
| UTF-8 | Replacement decoding could accept malformed bytes | Preserve the bounded reader's fatal incremental UTF-8 decoding |
| Request deadline | A fictional stalled body remained pending past the existing 30-second deadline | Pass the same abort signal through bounded reading and the AWS secret read; abort failed requests |
| Cancellation | A refusal waited indefinitely for a provider's cancellation promise | Initiate best-effort cancellation without waiting for an acknowledgement |

Compression keeps wire length distinct from decoded length: declared wire bytes
and actual decoded bytes are both bounded, but are not assumed equal. Errors
remain sanitized as `provider_unavailable`. Cancellation is a transport action,
not evidence of deletion of a provider copy.

The OpenAI request remains model-pinned, tool-free, strict-schema and
`store:false`. The signed prompt and compiled clinical boundary are unchanged.
The [official OpenAI structured-output documentation](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses)
describes the existing Responses API schema interface; the byte and time bounds
here are ALP application limits, not claims about OpenAI's platform limits.

## Observed source verification

The focused run passed all 369 tests in seven files, including the 43 transport
tests, Ask ALP authority tests, reviewed knowledge, telehealth requests,
appointment provider recovery and Zoom host observation. The shared-reader
callers are included because cancellation behaviour changed in that utility.
Type checking, targeted lint and whitespace checks passed.

The Ask ALP, Core launch scope, synthetic clinical-core, identity/consent,
Desktop compatibility, operation inventory, production clinical-core and
mock-import gates passed. The inventory still reports 228 implemented,
activation-blocked operations and zero enabled operations. The production
artifact gate still builds 106 migrations with no seeded rows; no migration
was applied by running those source gates.

The full local Desktop unit suite completed successfully: 531 files passed,
8,443 tests passed and 11 pre-existing skips, exit 0. The clinical production
build and strict bundle scan passed; the scan found no server-only markers in
327 client chunks. The Ask ALP Lambda artifact build passed. Source push and CI
on this repair's own head still need terminal results before deployment. The
focused tests use fictional HTTP
streams and a mocked secret store; they do not make an OpenAI request or
establish physical-device behaviour.

## Hosted baseline and deployment admission

Read-only AWS inspection on October 13 UTC found the synthetic member role in
account `588966314750`, region `us-east-2`. The existing Ask ALP stack is
`ai-clinical-core-synthetic-staging-ask-alp`, API `wxv734oi12`, function
`wxv734oi12-synthetic-ask-alp`. It is Active and the stack is UPDATE_COMPLETE,
but the Lambda's last modification is September 4 and its code predates this
repair. Its runtime is synthetic, PHI is false and its model is
`gpt-5.4-mini-2026-03-17`. It references the existing AWS OpenAI secret; only
secret metadata was inspected, not its value.

Do not confuse that staging service with qualification API `6zt8e9qz04` and
database `clinical_core_qualification`. The care-connections stack installed
there remains disabled and is not part of an Ask ALP end-to-end pass.

After exact-source verification and CI, Codex can prepare a versioned,
hash-verified synthetic code artifact and inspect a CloudFormation change set.
Preserve the existing template and every parameter except the artifact key for
a code-only update. Recheck the member account, source, exact uploaded bytes,
template, parameter set, model, prompt identity and PHI-off posture before
execution. Refuse unexpected resource or permission changes. Verify the
deployed Lambda's digest and update status after execution; a deployment is
not a positive chat or consent journey.

## Remaining full flow evidence

The intended flow is V2 chat screen to the general backend, through signed
configuration, deterministic safety screening and consented context, to the
AWS generation boundary, OpenAI and the returned message. This transport suite
proves only the generation response boundary with fictional dependencies.

Positive hosted qualification still needs an attested fictional consumer,
the exact already-reviewed prompt, a successful authenticated request and
negative prompt/identity cases. It must then prove the matched general backend
path, actual owned-context provenance, consent withdrawal, red-flag/refusal
behaviour and response rendering. A direct Lambda invocation bypasses JWT
verification and cannot stand in for those observations. Do not invent a
prompt approval or mark a refused or skipped case as accepted.

Physical iOS and Android journeys, store/provider acceptance, reviewed privacy
and intended-use copy, exact agreement/runtime coverage, operational review
and separate PHI activation remain open. The paid mobile-build hold remains
in force. All six original commercial-readiness phases remain partial.
