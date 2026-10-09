# Explicit recording resume and microphone replacement

September 17, 2026. Original phases 2/6 source increment. No deployed service,
provider activation, PHI boundary, clinical approval or paid mobile build changed.

## Defects and repair

Previously a successful background heartbeat promoted the UI from paused to
recording without resuming the actual MediaRecorder. Explicit Resume also called
recorder.resume and displayed recording even when its new heartbeat failed.
A disconnected microphone was not replaced; Resume could therefore display a
running recording with ended input tracks.

- Background heartbeat now rotates authorization only. It cannot resume a
  practitioner pause. Requests are single-flight, bounded to eight seconds,
  and invalidated when capture ownership/state changes. A stale response cannot
  publish after pause, stop, resume preparation, device loss or unmount.
- Resume requires an explicit click, successful server resume, then an active
  heartbeat with a nonempty fresh token. Missing/malformed/refused/late replies
  never authorize local resume. The combined authorization deadline is eight
  seconds; Cancel resume preserves the paused recorder and ignores late replies.
- Missing heartbeat authorization pauses local recording instead of presenting
  it as running. Server consent/token checks remain authoritative for every
  upload. Periodic validation is not instantaneous remote consent propagation.
- A Web Audio destination provides one stable output stream to one MediaRecorder.
  Reconnecting obtains a newly permitted microphone, checks fresh authorization,
  then replaces its input node while the recorder is paused. It does not append
  a second independently initialized container to this same-page recording.
  There is no connection to the speakers. Ended input is detached and stopped;
  deliberate close detaches event handlers before stopping tracks.
- Audio-context activation is bounded to four seconds and must actually reach
  running state. Stop, failed attachment and unmount close microphone, destination
  tracks and context. The existing microphone permission bound remains30seconds.

Implementation uses the browser's [MediaStream recording model](https://www.w3.org/TR/mediastream-recording/)
and [MediaStreamAudioDestinationNode](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/createMediaStreamDestination).
This changes local capture, not the transcription vendor or data-storage policy.

## Evidence and limits

The original full recording run initially failed again at automatic encounter
navigation, before capture; nine following tests did not run. The ready recovery
link was present, but that alone did not repair the normal workflow. Evidence
is preserved in local evidence/local-scribe-20260917-1120. StartEncounterButton
now uses normal document navigation to the server-returned, UUID-validated
same-origin path instead of the intermittently stalled client router. It performs
no additional creation, retains the direct link if the user cancels beforeunload,
and preserves timeline reconciliation for uncertain creation.

The final combined browser run passed **16/16**: the unchanged10case original
scribe suite, three pause/device tests and three encounter-opening tests. Normal
automatic handoff, unavailable client navigation, user-cancelled navigation and
uncertain creation are exercised. No existing assertion or timeout was weakened.
This removes that client-router dependency from creation; it does not claim to
diagnose or fix every framework navigation issue elsewhere in the application.
Typecheck and changed-file lint pass. Local full unit suite:2044passed/11existing
skips across185files; final commit CI is a separate release check.

- Fourteen new helper tests cover fresh authorization, missing/invalid tokens,
  server refusal, combined deadline, cancellation/late success, stable output
  across input replacement, ended-input refusal, cleanup and activation timeout.
  Together with the existing preparation helper:20targeted cases passed.
- Three synthetic Playwright cases passed: pause persists through a real periodic
  heartbeat and failed resume authorization; an actually ended input track plus
  permission refusal then successful explicit replacement; cancellation after
  server resume commit with a withheld response. No automatic replay was observed.
- The reconnection case asserts one MediaRecorder and an unchanged output track,
  collects real Chromium synthetic-audio chunks before and after reconnection,
  decodes the combined audio successfully, and verifies stopped microphones at
  completion. The screenshot was inspected; no page errors occurred in that case.
- These tests create a real local fixture encounter through the API and navigate
  directly to its document URL to isolate capture. They do NOT conceal or close
  the previously documented intermittent client-router stall. The separate
  full-flow qualification and document-navigation repair above cover normal
  encounter creation on the final source, not just direct test entry.

Physical microphone changes/permissions, Safari/iOS formats and interruptions,
production provider transcription, load and actual deployed consent races remain
required. Cross-page refresh recovery starts a new MediaRecorder and still needs
explicit audio-part/container continuity qualification; the same-page replacement
test is not proof of that separate path. Existing long-running upload queue,
transcription polling and completion/retry durability also remain engineering
work. In particular, the existing Blob-only upload queue needs explicit recording/
authorization-epoch binding, stale-pump fencing, disposition of chunks whose
capture authorization cannot be established, bounded buffering and server-side
chunk idempotency. Current happy-path network/revocation tests do not prove those
adversarial queue cases; this is an activation blocker, not completed processing.
All six original commercial-readiness phase scopes remain incomplete.

Follow-up: [recording upload ownership](recording-upload-ownership.md) repairs
recording/session ownership and stale-pump/event fencing. It does not complete
the remaining authorization-epoch, bounded-buffer or durable-retry requirements.
