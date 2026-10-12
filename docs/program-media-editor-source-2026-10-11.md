# Native lesson-media editor source milestone

Branch `agent/program-media-editor-source-20261011`, based deliberately on frozen
native host `15594d883d5f5591888cd34d7b9337312d091009`. This is author-upload source
for isolated fictional qualification, not an installed service, learner delivery,
commercial acceptance or PHI approval. Claude's returned commerce/course branch
remains separate. No candidate, migration, review, mirror or custody identity was
changed here.

## Implemented path

Program Studio supplies its program, draft and workforce session to the consumer
program editor. Each lesson receives a separate upload panel keyed to its stable
phase/item identity. It does not silently populate the old HTTPS media slots or
attach a published reference to a learner curriculum.

The browser hashes the exact File incrementally, in 8 MiB chunks, using pinned
`@noble/hashes` 2.0.1. Images are at most 16 MiB and videos at most 256 MiB. No
complete video copy, provider credential, upload ID, bearer token, environment
override or browser-storage persistence is introduced. Local file checks have a
60-second deadline; rereads and each request/body have a 35-second deadline.
Dependencies that ignore cancellation cannot commit a late result.

Metadata, manifest and progress validation now share one browser-safe contract.
Responses are read under a 1 MiB received-byte limit with strict UTF-8/JSON,
Content-Length agreement, no redirects and the same elapsed deadline across
fetch/body. Paths are fixed, relative, same-origin cookie requests. The managed
host independently verifies the workforce identity and SQL authority; browser
state never grants access.

Images use raw binary upload. Video uses exactly ordered 8 MiB multipart chunks,
with a possibly smaller last chunk, and uploads only parts the service has not
confirmed. A pending writer is not replaced. Counts show returned receipts, not
bytes sent. Retrying an uncertain preparation uses the original command ID;
there is no automatic retry. Its button remains available when the file is
locally prepared but the service reply could not be confirmed.

`inspect` is an additive, read-only current-author operation implemented by the
managed host. It returns the immutable reservation or artifact only after SQL
program authorization, and the existing final authority/release fence still
applies. It opens no STS/storage credentials. This is not added as an operation
to the separate generic native request factory; that factory still refuses it.

A saved upload ID allows a fresh controller to ask the service for its status,
not to bypass authority. Resuming a reserved upload requires reselecting the
exact measured file. Held/error/retired rows cannot be shown as ready. Supplied
caption text is checked against the returned digest. Publication requires an
exact READY artifact, version, origin, bytes and caption digest.

Private author preview is bound to the exact artifact/object version, a regional
S3 HTTPS path and at most five minutes. Expiry removes the capability while
retaining the confirmed artifact. Logout/workforce changes, cross-tab withdrawal,
scope changes, backgrounding, page exit and unmount clear private UI state and
abort work. Cancellation is described as pending until the service confirms it;
it is never described as object erasure.

## Local evidence and preserved failures

- The original author editor was URL-only. The source regression now requires
  the actual upload panel and current session/draft binding.
- Controller and restricted-host composition: **43 tests passed in the normal
  two-file run**. This includes a real cryptographic Cognito verifier, restricted
  PGlite SESSION login and candidate SQL, fixed binary routes, real S3 adapter and
  signer with fictional SDK sends, a deliberately lost binary reply, recovery
  through a fresh controller, caption/publication and current MFA withdrawal.
- Actual React StrictMode/browser File tests: **14 passed, zero skipped**.
  Cases include lost preparation and binary replies, explicit same-ID retry,
  all private-state withdrawal events including a current server refusal,
  preview expiry, unmount, disabled host and
  bounded video-part receipts. Preview network requests are refused in this
  fixture; arbitrary generated video bytes prove controls, not codec playback
  or a real provider preview.
- Typecheck and changed-area lint passed. Normal full-suite, repository gates and
  clinical build results are recorded below when observed; parent results are
  not successor evidence.

The first browser attempt failed all 11 cases because its isolated bundle lacked
public framework compile-time environment defines. After correcting the harness,
three cases still waited for a caption-save button before a caption existed;
that setup was repaired without timeout or assertion removal. The resulting
12-case run passed; uncertain-preparation and current-server-refusal cases make
the final 14.

The initial composed-host case passed in isolation but failed in the normal
order. It incorrectly reused the same program/digest across separate fictional
S3 stores while SQL deliberately retained the prior committed artifact. SQL's
one-committed-artifact-per-program/digest constraint was kept unchanged; each
independent fictional host now supplies distinct fictional bytes. The normal
two-file run is the evidence, not the isolated repetition. A 15 ms wall-clock
timeout test also raced its initial hash under load; it now advances the same
15 ms clock deterministically and asserts the intended pending stage was reached.
No runtime timeout was extended.

A subsequent private-state review found that a server authorization refusal
cleared the controller but not the panel's file input, caption and saved-ID
fields. The new browser reproduction fails with the old panel (the private file
name remains); a typed authority-loss signal and pre-paint form clearing repair
it. The normal browser run passes all 14 cases. A normal full-suite run was
explicitly cancelled to make this repair before source freeze; that interrupted
run is not a pass. A fresh normal run, not a filtered repetition, is required
below.

## Remaining engineering and execution

1. Admit a native media-reference successor to the consumer-program contract,
   preserve its complete provenance and mirror it byte-identically to V2. Do not
   copy an original-author signed preview URL into a patient lesson.
2. Implement independently authorized learner reads of pinned reference versions,
   with enrollment/entitlement and current curriculum authority, withdrawal,
   expiry and bounded private delivery. Purchaser access is not clinic membership.
   Preserve caption/transcript text as an immutable publication snapshot: the
   current native table keeps only current text, while publications retain its
   digest and events retain only the event name. A changed caption cannot be
   substituted for the text a purchased curriculum pinned. Existing publications
   without a provable snapshot must remain unavailable, not be backfilled with
   whichever text is current.
3. Port media authorization deliberately to canonical production program records.
   The current native SQL family uses historical synthetic desktop programs; it
   cannot become production by setting an enable flag.
4. Register the exact BLOCKED candidates and provision reviewed host/storage/login
   authority under separately approved preserving upgrades. Install a read-only
   target mount and matched source identity. None exists from this increment.
5. Run the real AWS/S3/KMS/STS and PostgreSQL race matrix, multipart reconciliation,
   cleanup and author-preview acceptance, then the learner and physical-device
   journeys. Generated local envelopes are not hosted acceptance.

All five candidate hashes and inherited security limits remain those in
`docs/program-media-host-source-2026-10-11.md`. That host head's exact CI
38207463897 failed at the Public ECR Node base-image pull with HTTP 429 before
container validation; it is not accepted image evidence. PHI remains off, paid
mobile builds held, source-verification/clinical holds preserved and program
prices/terms unset. Neither this upload milestone nor Claude's parallel text
course work completes the original six commercial-readiness scopes.

## Final successor verification

Typecheck and changed-area lint passed after the server-refusal repair. The
clinical production build passed, including compilation, typechecking and all
250 generated static pages. Strict bundle scan passed over 314 client chunks;
no synthetic identity, demo-only copy or 17 server-only SDK/secret markers were
found. This is a local build, not a deployed container or operating provider.

Repository lint and the identity, authenticated API, clinical core, mock import,
compatibility, operation inventory, production clinical core, container source,
Core launch-scope and stub-reset gates passed. Operation inventory verifies 228
activation-blocked operations and zero enabled. This branch still prints the old
140-provider-rewrite wording: that number counts historical dependency flags,
not a proven current engineering backlog. The separate reporting correction
`3b3ed85c03a22d701408698b15f2303f6b2c7012` must be preserved during final
integration. Current provider acceptance is not verified by this source gate.
The container check is a source-definition check, not the Linux image that the
parent's CI could not pull.

AST-only Graphify completed with 18,467 nodes, 42,330 edges and 1,112 communities.
It reported the existing 88 zero-node files and omitted oversized HTML rendering;
neither limitation is broader source acceptance. The shared vault note and canvas
were not changed by that local graph rebuild.

Fresh normal `npm run test:unit` completed successfully in 709.73 seconds:
484 files passed, 7,919 tests passed and the same 11 existing tests skipped.
No assertion, worker limit or test deadline was removed or extended. This is the
complete successor run after the cancelled pre-repair run, not a filtered
substitute. Exact-head CI will be recorded separately after pushing.

Nothing has been deployed, activated, submitted or device verified. The native
upload controls remain source for an explicitly installed, reviewed fictional
host; a local successful form is not proof that the running Desktop has it.

## CI observation and synchronous withdrawal repair

Exact CI 38213509677 at `894d4182ec4f5f8586ab8979ba124ff87e525aaa`
completed **failure**: ten jobs succeeded and the native editor browser step
failed three of its 14 cases. Workforce, cross-tab and hidden-page withdrawal
aborted transport immediately but the DOM still exposed the selected file name.
The successful deployed-backend job withheld its actual checks for missing
secrets; it does not establish hosted acceptance.

Three added, deterministic browser cases read file, caption and saved-ID fields
inside the same withdrawal event. All three fail against the old component,
including locally. The repair synchronously flushes only external withdrawal
event updates, not render or lifecycle code. This ensures private form state is
removed before the event returns rather than merely scheduling a concurrent
render. React documents this external-event use and its performance limits in
[flushSync](https://react.dev/reference/react-dom/flushSync); it is not used for
routine progress or file-hashing updates.

The full mounted browser script now has 17 cases, preserving all original
assertions and deadlines, and also refuses React warnings about invalid
synchronous flushing or cross-component updates. It passes locally. The normal
unit suite passed 484 files and 7,919 tests, with 11 existing skips. The
clinical production build passed with 250 generated pages, and its strict
bundle scan passed all 314 client chunks. Exact-source CI remains required for
the repair; the prior
14-case local run does not override the failed Linux result.

The next reference-contract work was preserved separately before this repair:
Desktop stash `1cda9f3ff7be89532751964660b6f1d096062afd` on the lesson-reference
branch contains only its four owned source/test files. V2's unpublished mirror
work remains on its separate lesson-reference branch. Neither is part of the
editor's frozen source or deployment evidence.
