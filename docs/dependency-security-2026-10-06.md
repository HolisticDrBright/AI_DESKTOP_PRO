# Desktop lint dependency security repair

This source candidate removes the dependency that failed Desktop's full security
gate. It does not deploy either app, qualify a release, enable PHI, or approve
clinical content. All six original commercial-readiness phases remain partial.

## Vulnerable dependency and replacement

Next's lint plugin 15.5.25 depended on fast-glob 3.3.1, micromatch 4.0.8 and
braces 3.0.3. The full audit reported five High findings from that chain.
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
lists no patched braces release at this inspection. A suggested downgrade of the
Next lint configuration was not applied.

The reviewed plugin has exactly one fast-glob consumer: its synchronous,
directory-only project-root resolver. A private CommonJS adapter at
`vendor/next-root-glob` supplies only that call. Dynamic matching uses the
already-installed tinyglobby 0.2.17; literal roots use a directory stat without
walking descendants. Empty, NUL-containing, over-4,096-character and more than
32-level nested requests are refused before matching. Absolute paths, Windows
roots, literal spelling, explicit dot prefixes and directory-only matching are
preserved. This is not a general replacement for the fast-glob API.

The adapter is a root development dependency under the fast-glob alias. Only
the exact Next plugin version overrides its dependency to that local package.
The lock file no longer contains braces or micromatch. Next runtime and lint
configuration remain 15.5.25; React and TypeScript versions and the application's
lint configuration are unchanged. Three local CommonJS interop annotations
apply only to the adapter's required synchronous imports.

Both `Dockerfile` and `Dockerfile.production` copy the private package before
their dependency install. CI retains the full `npm audit --audit-level=high`
gate and adds the matcher regressions plus a real Linux Node 22 dependency-stage
build and resolution check. No audit omission, advisory waiver, suppressed
Next rule, or clinical-policy exception was added.

## Local verification and retained failures

A fresh `npm ci` and `npm ls` verified valid resolution from the actual Next
plugin. The full audit reports zero known findings. The 22 matcher regressions
pass, including the original upstream resolver's normalized-byte hash and package
integrity, unsupported-request refusals, root-path compatibility, the actual
internal-link rule and all recommended Next rules with React/TypeScript checks.

The first default two-worker full run failed: 329 files passed and two failed;
4,140 tests passed, one timed out, and two tests were skipped by a timed-out
recording setup in addition to the 11 existing skips. The inventory outage test
hit its unchanged five-second deadline and the recording fixture hit its
unchanged 60-second setup deadline. This result is retained, not relabeled a pass.

Both unchanged suites subsequently passed all 35 tests in a focused one-worker
run. The complete one-worker run then passed **331 files and 4,143 tests**, with
the **11 existing skips**, in 827.49 seconds. No assertion, test inclusion or
deadline was removed or increased, and the repository's normal two-worker
configuration is unchanged. This does not establish that the earlier timing
failures cannot recur. Typecheck and full lint passed. The canonical gate remains
105 migrations with zero seeded rows; covered-entity mapping remains 207 tables.

## Release requirements

The new CI run must be observed at its exact pushed head, including the Linux
container check and the normal full suite. Local Docker is unavailable, so a
static copy-order test is not represented as a built-image pass. The local
clinical production build completed successfully, including page generation and
build tracing. Its client-bundle scan passed across 291 chunks, finding none of
the forbidden synthetic-identity, demo-copy or server-only markers. This was a
local source build, not a built container, matched release or deployment.
No running Desktop, installed V2 binary, AWS resource, consent or provider release
changed. AWS reauthentication is required before further hosted work.

The remaining source and qualification requirements are in
`care-connections-source-candidate.md` and V2's
`expo/docs/six-phase-current-evidence-2026-10-05.md`. In particular, request-id
recovery still needs preserving schema promotion, privacy dispositions, actual
route and candidate/fleet wiring, safe legacy recovery and second-device
discovery. Matched synthetic releases, hosted acceptance, physical devices,
provider/store/security/retention review and independent PHI activation remain
required. A clean dependency audit closes none of those requirements.
