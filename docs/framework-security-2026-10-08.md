# Desktop framework security and authentication boundary

This source candidate updates Next.js and repairs two authentication lifecycle
defects found through the actual built server. It does not deploy either app,
approve clinical content, qualify native devices or permit PHI. All six original
commercial-readiness scopes remain open.

## Dependency repair

Next.js runtime and lint configuration are pinned together to 15.5.27. The
lock contains the matching environment package, lint plugin and eight platform
compilers. The prior locked 15.5.25 runtime has two moderate cache advisories:
[maintainer advisory](https://github.com/vercel/next.js/security/advisories/GHSA-4jqv-mc3x-m676)
and [related advisory](https://github.com/vercel/next.js/security/advisories/GHSA-mcj8-r9mp-w47p).
The advisory prerequisites concern self-hosted Pages Router SSG/ISR applications;
this repair does not establish that every ALP route was exploitable.

A fresh independent installation reports zero known findings in the full npm
audit, including development dependencies. Only Next package entries changed
in the lock; unrelated dependency entries remain byte-equivalent as parsed JSON.
The existing bounded lint-root adapter is still required because this plugin
still depends on fast-glob 3.3.1. Its one directory-only consumer has the same
normalized source hash as the previous reviewed version. The adapter override
is restricted to the exact new plugin version. No advisory waiver, suppressed
lint rule, relaxed audit level or broader override was introduced.

This worktree has its own real node_modules directory. It does not share or
modify dependencies used by the frozen AWS application or running Desktop
instances. The source repair is stacked on the catalog integrity repair.

## Reproduced authentication defects

The clinical-only data adapters always require governed identity, but middleware
still skipped all authentication when a retired optional public mode flag was
absent. A real browser navigation to an encounter without a session returned
HTTP500. Four added unit cases also failed before the middleware repair: signed
out redirects and session refresh were skipped. An additional negative then
proved an expired access cookie with no refresh cookie was allowed onward.

Middleware now always runs the clinical authentication lifecycle. The separate
demo repository is unchanged. The production readiness-only refusal retains
precedence; no optional flag can reopen the application. Missing identity redirects
protected pages to sign-in with the original relative destination, and expired
sessions without refresh clear unusable cookies. Login redirects are no-store.
Public authentication pages and APIs retain their own handlers; protected APIs
still enforce identity themselves. Revoked refresh clears cookies, and successful
refresh retains the existing rotation behavior. Explicit isolated local contract
fixtures remain subject to the existing runtime boundary, never a production
fallback.

## Verification

The actual Next plugin passes all23 lint-root tests. Typecheck, full lint and the
full audit pass. After the middleware repair, the focused authentication and
fixture-boundary suites pass30 tests. The clinical production build succeeds,
and its291 client chunks pass the existing synthetic/server-marker scan.

Eight real Chromium checks against the built Next server pass without intercepting
clinical responses or using credentials: sign-in hydration without external
traffic/client exceptions; missing-identity and foreign-origin refusals for both
program APIs; recording privacy headers; signed-out chart redirect; expired
session redirect and cookie removal. The sign-in screenshot was visually checked.
The dedicated built-runtime CI step runs all eight. Development runs select a
different posture because their source-map CSP deliberately permits evaluation.

The initial six browser cases passed while server logs exposed the encounter
failure. The added navigation case then failed with actual HTTP500 before repair;
the failure remains recorded, not represented as a passed user journey. The
existing Playwright configuration uses next start, which warns about the standalone
output setting. These checks prove the built framework/server boundary, not a
built final container or hosted deployment.

The first full local run passed346 files and4,385 tests with11 existing skips in
542.32seconds. Middleware code/tests changed while that run was active, so it is
not a frozen-final-source receipt. The second full run against the fixed runtime
source passed346 files and4,385 tests with11 existing skips in514.05seconds.
The unit environment uses America/Los_Angeles and removes the
pre-existing edition fixture's conflicting CLINICAL_SUPABASE_ANON_KEY; no deadlines,
assertions or test inclusion were relaxed. Hosted CI must be observed at the
actual pushed head before a hosted-source claim.

## Remaining release requirements

Rebuild and qualify an exact matched API/Desktop/mobile release after the frozen
AWS routing run settles. Do not replace its source pair, bytes or dependency
installation during custody. Successful routing recovery is not positive erasure
acceptance, provider acceptance, physical devices or PHI activation. The catalog
RLS candidate and authoritative owner-plan integration remain separate work.

Original scope still includes plan continuity, owned lab/document/audio recovery,
full privacy/export/erasure/holds and scheduled retention, eligible knowledge and
catalog releases, Core19.99 commerce/providers, and matched rollback/load/security
and five-persona iOS/Android qualification. Clinical holds, exclusions and source
verification stay in place. PHI remains OFF and paid mobile builds remain HELD.
