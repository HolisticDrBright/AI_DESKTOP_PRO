# Telehealth canonical integration

## Source and release boundaries

The branch `agent/telehealth-canonical-integration-20261009` starts from canonical
Desktop source `a6935563a64acba6493c7450dd4f8e25bf964f83`. Five telehealth feature
and safety commits were ported selectively; the older application branch was
not merged wholesale. Framework security, catalog, privacy, SES notification
controls and the existing migration releases remain in place.

The identity extension now has 57 routes, including two workforce consent
reads. Those reads use the clinical API role's existing row policies. They do
not let consumer credentials read another patient's consent or make a retired
artifact authoritative.

## Separate consent candidate

`npm run build:telehealth-consent-candidate` builds a distinct 108-migration
artifact with activation blocked and PHI disabled. It binds to this exact
107-migration parent ledger:

`542b101ca1729576d2b203c9c2b3d98d2d9dd897e7480ab08ff150c8eacf773c`

Its successor ledger is:

`4e8e78f6d9aea14d9e622f07f5523380c17e704730c543230846c0ba5dc8e38b`

The extension adds `telehealth_recording` while preserving all previous
consent scopes, including `lab_specimen_context`. It seeds no consent,
approval, provider or activation rows. The existing 106/107 artifacts and
synthetic migration manifest are not redefined. A forward-apply operator,
rollback acceptance and deployed runtime binding for this candidate are
still required; this build is not an instruction to apply it to staging.

The production migration builder normalizes CRLF and CR input to canonical
LF bytes before hashing and shipping. An older Windows worktree retained
CRLF SQL even after the source attributes changed. The repair restores the
existing release identity rather than accepting a second hash.

## Local verification

The focused integration suite passed 172 tests in 11 files. Three newline
regression tests passed. Type checking and targeted lint passed. Both the
identity and telehealth CloudFormation templates passed lint after removing
the invalid `dynamodb:TransactWriteItems` IAM action; the retained PutItem and
UpdateItem permissions authorize the transaction operations actually used.
The telehealth Lambda and the distinct consent artifact built successfully.

All six local browser cases passed in one process, with no retries or skips:
the day view, direct consent/appointment refusals, consent through fixture
shutdown, denied-signature text clearing, persisted note signature, and a
delayed start delivered after navigation without loading an SDK. Two earlier
runs failed because the tests used the wrong recovery button label and tried
to import a note the preceding case had already imported. Their failure
snapshots are retained in the calling workspace; they are not retrospective
passes. The original four-case integrated journey also passed separately.

The database tests apply all 108 migrations in PGlite and exercise real row
policies under `clinical_core_api`. Browser API calls use the committed local
contract fixture. Dependencies were reused, not clean-installed for these
local runs. These checks are not AWS-hosted or physical-device acceptance.

The complete unit audit at `a14894b` passed 5,224 tests in 397 files, with 11
existing skips. Both exact-source CI runs failed on five historical release
checks: the new consent routes were incorrectly included in a fixture for the
actually deployed 51-route stack. Every browser job passed, including the real
pinned Zoom SDK bootstrap; deployed-backend steps remained skipped. The repair
explicitly excludes both new routes from that historical code-only deployment,
preserves its exact count and verifies that an added route still refuses as
drift. All 89 release tests then passed locally. The failed CI runs remain
failures; the successor needs its own CI result.

The subsequent `fab4c34020bb5a57eaa2e0333d11f3b0f6e0fe02` checkpoint passed
the full unchanged-source audit:399files,5,273passed,11skipped,1,101.90seconds.
Both CI38012601709 and38012604402 succeeded, including the real pinned Zoom SDK
bootstrap. Deployed-backend acceptance still skipped for missing secrets. The
AST report was refreshed fromfab4c340:15,636nodes,36,033edges,1,003communities.
These are predecessor results for the later observed Fullscript installation
increment, not its exact-source full-suite or CI evidence. The observer's local
305-test extended result and remaining runtime gates are recorded in
`docs/fullscript-observed-installation-2026-10-09.md`.

## Remaining commercial and PHI work

### October 10 Zoom response and recovery repair

The actual meeting-create, legacy meeting-read, marker-recovery listing and summary-import paths now reject coerced identifiers and credentials, unsafe join destinations and redirected responses before storing a meeting or importing text. Marker listings are bounded to300 entries per page and262144 received bytes; create/read responses to65536 bytes; summaries retain their256KiB bound. Pagination tokens must be bounded strings when present. A malformed token is not a completed empty listing and cannot permit another create. The listing and subsequent exact meeting read share one20-second deadline.

Create/read results require an exact numeric meeting number, bounded instance UUID, real string password and HTTPS Zoom join URL whose path names that same meeting. Regional `.zoom.us` hosts are accepted; credentials in URLs, foreign domains, nonstandard ports and mismatched meeting paths are refused. This is the declared standard-Zoom boundary, not automatic support for arbitrary ISV/custom/government destinations. Summary IDs are compared exactly instead of stripping non-digits or coercing an array. The encrypted join-URL token never becomes the meeting password.

The bounded reader now accepts the caller's abort signal and cancels its locked stream on deadline, including a body that never supplies another chunk. OAuth, ZAK, fresh host observations and appointment recovery use that signal. Local cancellation does not prove remote settlement or deletion. A malformed or timed-out create leaves its dispatched lease in place for reconciliation rather than claiming that no meeting exists.

The initial new regression run reproduced 18 failures in recovery/create/read checks; three further summary tests reproduced acceptance of non-exact IDs, and two reader tests reproduced missing abort refusal/cancellation. After repair, 459 tests across seven focused provider, booking, reminder and recovery suites pass without skips. Typecheck, targeted ESLint and the telehealth Lambda build pass. The complete Desktop unit suite passed 6,713 tests in 433 files, with 11 existing skips and no failures, in 679.99 seconds. It ran with the documented Pacific timezone and the unrelated clinical Supabase key unset. No live Zoom, hosted backend, current browser, device or production acceptance is supplied by these tests.

Read-only AWS inspection separately verified the short-lived member-role session in synthetic account 588966314750 and the existing qualification foundation as CREATE_COMPLETE, with its outputs still declaring synthetic-only data, PHI false and activation blocked. The database ledger was not reread. Both CI runs for predecessor `1eabf679223575672ba08f926c59fa3841c4be10` succeeded; these do not substitute for CI on this response-repair successor.

The pagination completion rule is documented by [Zoom pagination](https://developers.zoom.us/docs/api/pagination/), and [Zoom meeting creation](https://developers.zoom.us/docs/isv/workflows/create-meeting/) distinguishes the returned join URL and password. The ALP bounds and target restrictions above are explicit local controls, not new vendor guarantees.

The signed telehealth record is still not a chart note. Chart/timeline and
amendment integration; record export, retention, holds, erasure and Zoom-copy
reconciliation; per-clinic authorized host binding; the released V2 consent
journey; and reviewed agreement/runtime coverage remain open. A real
authorized fictional host-and-patient meeting must prove media, reconnect,
end-for-all and exact-instance summary import against the deployed boundary.
Provider races, current-access refusals and rollback also need hosted checks.

No AWS deployment, provider activation, real patient data or paid mobile build
is part of this integration. PHI remains OFF. None of the six original
commercial-readiness phases is closed by these local telehealth checks.
