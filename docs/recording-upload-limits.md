# Bounded recording upload proxy and production migration gap

September 17, 2026. Original phases 2/6 source work; no phase completion,
deployment, provider activation, clinical approval, PHI enablement or paid build.

## Production path audit

Desktop `scribe.live.ts` still calls the transitional `clinical.scribe.*` tRPC
procedures and `/api/clinical/scribe/recordings/:id/chunks` HTTP route. These are
not part of the AWS Desktop compatibility operation manifest. The inspected
source has a local contract-fixture implementation and legacy Supabase recording
migrations, not an AWS encounter-scribe implementation. V2's production-owned
consumer voice-message jobs are separate: their ownership and consent do not
authorize a multi-participant clinical encounter. Do not substitute that consumer
service or describe passing Desktop fixture tests as migrated AWS recording.

The Supabase/Postgres review preserved the migration requirements: participant-
specific recording/transcription/drafting consent, immutable reviewed releases,
revocation and late-participant handling, workforce/patient/org authorization,
bound expiring capture credentials, provider approval, immutable transcript
provenance, reviewed note creation and hold-aware verified deletion. The actual
AWS migration and its hosted acceptance remain engineering, not just a human gate.
No legacy database or SQL migration was modified in this increment.

## Implemented proxy protection

- Previously the chunk route called `arrayBuffer()` on the entire request before
  checking the five-MiB cap, and only then resolved the practitioner session.
- The route now resolves the existing session/token source before reading audio.
  Existing local-only fixture fallback is preserved; no new fallback is added.
  Recording IDs must have UUID shape and capture-token headers are bounded.
  Token presence/resolution is not cryptographic authorization: the backend
  still validates the workforce identity, organization, capture token and consent.
- A shared server helper accumulates at most five MiB with a fixed allocation,
  rejects malformed/oversized/lying Content-Length, and checks actual streamed
  bytes even when Content-Length is absent. It never returns a partial body.
- A ten-second body-read deadline and request-abort handling stop stalled reads;
  a synchronous empty-chunk stream cannot starve the elapsed-time check. Reader
  cancellation is not awaited indefinitely. Arbitrary stream error text is
  replaced with safe errors, not forwarded to the UI or log.
- One cancellation race covers the entire body, instead of retaining one pending
  promise handler per fragment. Locked bodies refuse without cancelling another
  reader's stream. Both cases have dedicated negative tests.
- Only complete valid bytes reach the existing scribe upload adapter. Backend
  consent/session revalidation is unchanged. This bounds inbound body reading,
  NOT outbound backend waiting, browser buffering or durable upload retries.

## Evidence and CI findings

Twenty-eight focused body/route cases cover exact bytes, boundaries, fragmentation,
empty bodies, false/missing lengths, oversize, stream failure, abort, stalled
read/cancellation and authentication refusal before body access. The first type
check caught test-only typed-array/header-fixture typing problems; these were
corrected without weakening the production contract.

Prior Desktop CI35258991975 at6d78143 failed: microphone-loss setup never reached
recording (the trace shows a pending begin request with no response), and an EMR
test hit Chromium Network.getResponseBody after document navigation evicted the
response. Full synthetic artifact evidence is retained outside the repository at
`evidence/ci-35258991975`. The microphone-start cause remains unproven/open.

The EMR test now relays the original POST exactly once with Playwright route.fetch,
captures its real JSON before releasing it to the browser, then verifies status,
returned encounter ID, URL and the original full note/sign/audit workflow. It does
not create a second encounter, invent a response, bypass the application button,
or relax timeouts. This fixes the evidence-collection race, not a product failure.

An initial full local unit run, concurrent with browser/graph work, had one existing
privacy-infrastructure timeout (2074 passed,11skipped). That run is not green and
no timeout was raised. Final verification results are recorded below.

The combined recording browser suite passed 15/15 against the local contract
fixture. This includes the original recording/transcription/review flow, device
reconnection, consent withdrawal and old-recorder isolation. It is not AWS or
physical-device evidence. The final single-race/locked-reader refinement then
passed all 28 focused proxy/body cases.

The first isolated EMR browser run reached encounter creation, signed note,
addendum, audit and cross-org denial, but exhausted its unchanged 90-second
overall timeout at the final sign-out check. Its full trace/error context is
preserved at `evidence/recording-upload-emr-20260917/test-results` outside the
repository. That run remains failed; no assertion or timeout was weakened.

The unchanged-timeout rerun exposed a sign-in hydration race: the trace recorded
a native GET `/login?` and **no POST `/api/auth/login`**. Server-rendered controls
were usable before React attached the handler. LoginForm now renders disabled
credential/submission/reset controls until its client effect runs, rejects a
duplicate pending submission and explains how to recover if JavaScript never
loads. It does not change workforce identity, MFA or authorization requirements.
New browser coverage deliberately holds JavaScript, checks disabled controls,
releases it and asserts exactly one real login POST, plus a JavaScript-disabled
case. The first fallback used noscript text that was absent from the rendered
page; that failing evidence is retained and the readiness message now includes
the explanation directly.

With the hydration fix, the unchanged full EMR case passed, including its final
sign-out assertion, and the existing practitioner sign-in/sign-out case passed.
The full unit suite passed **2077 tests, 11 existing skips, 188 files** with its
required timezone and two workers. Typecheck and changed-file lint passed.
The final login-readiness browser run passed **2/2**, including the visible
JavaScript-disabled explanation. The delayed-script screenshot was inspected:
credential fields and submit/reset controls are disabled with readable status.
No browser page errors were recorded in the delayed-script/login case.

The later prior-source CI35260825489 at a09e67b finished FAILURE at the same
Chromium response-body eviction in the old EMR test. Its recording tests passed,
but a pass does not establish the intermittent pending-start cause is resolved.
Current source needs its own CI. V2 f907bc7 CI35260829098 is SUCCESS, including
the real isolated final-image catalog test; that does not deploy either app.

## Remaining recording work

Actual AWS encounter-scribe service/route/consent migration; reviewed production
provider configuration and deployment; recording authorization-epoch disposition;
bounded client buffering; outbound request/completion deadlines; server chunk IDs,
durable deduplication and receipt reconciliation; revoked-session disposition/
restart; cross-page audio-container continuity; intermittent CI start diagnosis;
physical microphone/Safari/provider/load/restore acceptance. All six original
commercial-readiness phase scopes remain open. The latest AWS synthetic STS check
still reports an expired session; reauthentication is needed for hosted checks.
