# Bounded recording preparation and encounter-opening recovery

September 17, 2026. Source candidate; no deployment, provider activation or PHI
enablement. This advances original phase2 processing/recovery and phase6 release
qualification, not a new or completed commercial-readiness phase.

## Evidence and change

Desktop CI35248491371 failed before its refresh-recovery step: Start Recording
remained idle, and the retained browser trace shows its POST still pending at
the 10-second assertion. That trace does not establish why the upstream stalled.
Inspection did establish an unbounded wait in both the browser helper and the
server begin adapter, with the microphone opened before the response arrived.

The browser now shows preparation explicitly, with a cancel control. Microphone
permission has a30-second bound and server authorization an8-second bound. Late
permission grants are stopped, not attached to an abandoned component. Cancel,
timeout and navigation dispose the attempt; stale responses cannot start audio.
The recording panel is keyed to the encounter, so changing encounter unmounts
the prior capture owner. Initial discovery cannot overwrite a newly started
capture. Start and refresh recovery share the bounded preparation helper; fresh
authorization is still required before constructing a MediaRecorder.

The server's begin tRPC fetch now has a7-second AbortSignal, without changing
other tRPC callers' deadlines. Neither side automatically retries a mutation.
A timeout can occur after server commit, so the UI displays an unconfirmed state,
stops the microphone and replaces Start with Check recording status. An existing
active/paused session exposes explicit recovery, which gets a fresh token. A
confirmed empty active-session read permits a manual new start; server consent
and competing-session checks remain authoritative. Aborting a request is not
represented as rolling back server state or deleting a recording.

## Verification

- Eight helper/adapter tests pass: successful handoff; stalled authorization;
  microphone denial/timeout; late grants and late authorization after cancellation;
  safe upstream failure; no automatic replay. Real browser capture is verified
  separately, not inferred from fake timers.
- Ten Playwright recording cases passed against the committed synthetic local
  contract fixture, including lost-response recovery, cancellation before commit,
  normal consent/record/transcribe/review/sign/delete flow, withdrawal, late join,
  upload interruption, device loss, refresh and competing tabs. The new lost-
  response case actually commits one begin to the fixture then withholds its
  response, verifies ended microphone tracks and recovers without a second POST.
  Its screenshot was inspected; no page errors were observed in that case.
- The first attempt failed BEFORE recording, at encounter navigation. Its trace
  records successful encounter POST and workspace requests during development
  hot reloads; it is not proof of a failed capture or of the ultimate navigation
  cause. Evidence was preserved outside the repository. No assertion or test
  timeout was relaxed. The subsequent complete run passed, but a final unchanged-
  source targeted browser recheck FAILED again at encounter navigation, before
  recording (two remaining cases did not run). The complete recording suite is
  therefore not a stable final-source acceptance claim. Both failed traces are
  retained in local evidence/local-scribe-20260917-1043 and -1052.
- Final-source typecheck and changed-file lint pass. The full local suite passed
  2,030 tests with11existing skips across183files (required America/Los_Angeles
  timezone, two workers). Exact commit CI is reported separately when observed.

## Encounter-opening follow-up

The final failed trace shows the encounter POST returned200 in2.4seconds and the
workspace RSC request returned200 in3.0seconds with the correct encounter ID.
The page nevertheless stayed on Opening. This establishes a response-to-navigation
failure, not its framework/runtime cause. StartEncounterButton previously never
cleared its working state after a successful POST and offered no recovery.

It now retains the validated returned encounter path and exposes Open encounter,
a deliberate document-navigation link that bypasses a stalled client router and
does not repeat creation. Patient/appointment/visit changes unmount the old
request owner. Unmount cancellation ignores late results. Creation is bounded
to12seconds, including response decoding; uncertain/malformed/server-error
responses offer timeline reconciliation rather than an automatic new POST.
Aborting does not promise rollback or guarantee that a late server commit is
already visible in the timeline. Request-id idempotency for non-appointment
encounters and coordinated duplicate protection across separate controls/tabs
remain outside this increment; practitioner review before another start matters.

Ten encounter helper tests pass. Two new synthetic-browser tests pass: held
client navigation with a real fixture creation followed by direct-link recovery,
and a503 after fixture commit followed by timeline review. Each asserts exactly
one POST. The first browser run had a test-selector collision with Next's route
announcer; narrowing the alert locator fixed that test, not runtime behavior.
The final run passed both. The recovery screenshot was inspected and no page
errors occurred in the stalled-navigation case. This is a tested recovery path,
not a claim that the underlying intermittent client-router stall is eliminated.

## Remaining scope

This is recovery hardening for an observed failure mode, not proof that the
original intermittent upstream/development-navigation stall is eliminated.
Hosted load, physical audio formats/devices and actual provider acceptance are
still required. Browser provider responses are synthetic; production scribe
provider activation is unchanged. Existing pause/resume heartbeat-failure and
physical device-reconnection behavior needed further engineering review at this
checkpoint; the subsequent source repairs and16case combined run are recorded in
recording-pause-and-device-recovery.md. That follow-up replaces automatic client-
router handoff with document navigation; this file retains the earlier failures
as historical evidence. Long-running
transcription/draft operations and other transport deadlines are unchanged.

All original account continuity, processing, privacy/cross-store fulfillment,
clinical/source-verification, commerce/provider and exact-release/human gates
remain in scope. No clinical holds, consent requirements or source approvals
were weakened. No paid mobile build was triggered.
