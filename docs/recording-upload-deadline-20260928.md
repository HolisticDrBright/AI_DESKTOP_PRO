# Recording upload deadline and browser interruption test

This is source/local synthetic qualification work, not production recording
activation, hosted acceptance, or completion of a commercial-readiness phase.

## Evidence

Desktop CI run 36493806737 failed the network interruption case at the recovery
assertion (old `live-scribe.spec.ts:342`). Its trace shows an aborted chunk request,
then a chunk request with no completed response while a later heartbeat succeeded.
The retry and removal of Playwright interception occur at nearly the same time.
That trace does not establish why the transport remained pending. It does establish
that recovery did not finish within the unchanged 15-second assertion.

## Repair

- A chunk transport attempt now has an eight-second deadline, tied to the owning
  recording's cancellation signal. Even a transport that ignores cancellation
  cannot hold the upload pump forever. Timers/listeners are released on settlement.
- The helper does not acknowledge or discard buffered audio, repeat a request,
  alter consent/token validation, or turn a late success into a receipt. The
  existing owning pump retains the chunk and applies its existing retry policy.
- The browser test installs interception before recording and changes its network
  state without unregistering interception during an active retry. A second case
  withholds a request before it reaches the fixture, proving bounded recovery from
  a stalled transport. Neither test increases the existing assertion deadlines.
- HTTP refusals, including 409, are returned unchanged to the existing authorization
  handling. A cancelled owner cannot send a new request.

## Limits

This panel's transitional scribe adapter is explicitly local-contract-fixture-only;
deployed use is refused. This change does not repair or certify the separate AWS
capture/transcription/drafting candidates. Aborting a request is not rollback;
server-committed/lost-response retry deduplication is not proven by these tests.
The stalled browser test intentionally does not send that held request upstream.
No claim of durable audio preservation, exactly-once upload, or physical microphone
qualification is made. AWS hosted acceptance, matched releases, physical devices,
provider/policy reviews and production activation remain separate gates.

## Verification and separate artifact-test finding

- Twelve focused buffer/transport unit cases passed; typecheck and changed-file
  lint passed. The two focused Chromium recovery cases passed, followed by all
  eleven cases in the full local scribe browser suite (no retries).
- The first full unit run had 3,264 passes, eleven skips and one failure: the
  default-blocked recording-authority subprocess exceeded its ten-second limit.
  A separate diagnostic invocation of that exact artifact returned the expected
  503/PHI-disabled response in 155 ms. The cause of the earlier delay is not proven.
- The infrastructure test previously built and executed a shared release-directory
  artifact. It now uses its own temporary directory and cleans only that directory,
  removing interference from concurrent builds. Its three tests pass. Neither its
  execution timeout nor the production configuration changed. A full final-source
  run and exact-source CI must be reported separately, not inferred from this pass.
