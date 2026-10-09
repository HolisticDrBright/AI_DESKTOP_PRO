# Recording-owned buffered audio

September 17, 2026. Original phases 2/6 increment, not phase completion.

## Repair

The inherited browser queue contained bare Blobs and looked up the current
recording ID on each upload. A delayed success blindly shifted the current queue.
This could mix old captured audio into a later recording or consume its first
chunk. The global pumping flag also allowed an old pump's cleanup to unlock a
replacement pump. Recorder stop emits asynchronous final data events, including
after cleanup, so clearing only the recorder reference was insufficient.

`CaptureUploadBuffer` now owns a recording ID, capture-session ID, ordered chunks,
transport cancellation signal and pumping flag. The recording component captures
that exact buffer for every upload loop, recorder event and completion flow.
Sending requires matching current ownership; a receipt can acknowledge only the
exact head Blob. A cancelled or replaced buffer cannot publish UI changes, consume
new audio, unlock a new pump or advance upload completion. Stop/revocation/unmount
abort transport and release abandoned in-memory audio before stopping the recorder.
Normal user Stop still flushes and drains its final chunk before completion.

This is a browser ownership guarantee, NOT a durable server receipt or proof that
aborting an HTTP request rolled back a server write. Nothing is persisted locally.
Per-chunk backend token/consent checks remain unchanged. No production provider,
PHI boundary, clinical approval, mobile build or deployment was activated.

## Verification

- Five helper cases: required owner identity, exact in-order acknowledgment,
  cancellation/late events, old completion versus a new same-ID buffer, empty data.
- Full Desktop unit suite: 2,049 passed, 11 existing skips, 186 files; required
  America/Los_Angeles timezone. Typecheck and changed-file lint passed.
- Initial combined browser run: 14/14 passed (the unchanged ten original scribe
  workflows and four resume/ownership cases). Consent withdrawal while a
  server-committed chunk response is withheld stops microphones; delivering a
  late recorder event produces no further upload. Screenshot inspected, no page
  errors in that case. Final withdrawal wording distinguishes cleared unsent
  audio from remote audio that is not automatically deleted.

### Additional scenario exposed a separate workflow gap

An expanded test initially assumed that granting consent again after revocation
would permit a new recording. It failed: the server retains the old recording
as paused while its capture session is revoked, and correctly rejects a competing
begin. The UI still exposes Start after re-consent, which leads to an unconfirmed
state. Evidence is preserved outside the repository at
`evidence/recording-reconsent-20260917` (trace and error context).

No server rule was loosened and no timeout was increased. The new test now
explicitly verifies refusal of that competing start; it is not evidence of a
working re-consent/restart flow. A separate case uses a valid completed-recording
then new-recording sequence to check that an old recorder cannot inject late
audio into the new queue. The in-flight old-response/new-buffer race is also
covered by the helper test, including identical server IDs. Designing a governed
disposition/restart path for a revoked recording remains open engineering.
The final two focused browser cases both passed after correcting that new
scenario's assumption; the original ten workflow tests were not changed.
Three resume/device cases also passed on the final component wording. Final
typecheck, changed-file lint and diff checks passed. This is local synthetic
Chromium/contract-fixture evidence, not deployed or physical-device acceptance.

## Still open — do not activate on this evidence

Authorization-epoch disposition (especially chunks spanning a consent change),
bounded total buffering, stalled upload/completion deadlines, durable chunk IDs
and server-side retry deduplication, distributed receipt reconciliation and
cross-page audio-part/container continuity remain required engineering. Current
retry behavior is not certified duplicate-safe. A late response is fenced locally
but cannot undo bytes already accepted remotely.

The inspected Desktop upload adapter proxies to the clinical scribe backend.
The local contract fixture implements that route; fixture success does not prove
an equivalent production implementation or deployment. Physical microphones,
Safari/iOS formats, real provider transcription, load, restore and consent races
still require separate acceptance. All six original phase scopes stay open.
