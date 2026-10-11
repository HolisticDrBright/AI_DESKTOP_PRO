# Integration milestone — combined application pair, 2026-10-11

The first deliverable of the integration and program-delivery assignment: the required application bases with the
completed recovery, programs and commerce return integrated on top, verified and pushed. No merge into main, PR,
deploy, provider activation, build or AWS write. Fictional identities only; PHI disabled.

## Heads and ancestry

| Repository | Required base | Integration branch | Head after integration | Remote | Tree |
| --- | --- | --- | --- | --- | --- |
| AI_LONGEVITY_PRO_V2 | `f38b94992701c4eb9449be165595112255096625` (`agent/v2-return-context-repair-20261010`) | `claude/v2-integration-program-release-20261011` | `ee5f8ec78ba492e659909f4f38b1ee947a86238a` | matched | clean |
| AI_DESKTOP_PRO | `e97aec619c4c70ef8da963276cb763fa892bb33e` (`agent/clinic-fence-exit-custody-20261010`) | `claude/v2-integration-program-release-20261011` | `d8c2c60636f8224df2d7472d74aa9dd233a5fabb` | matched | clean |

Both required bases are the first parents of the integration commits (`git merge-base --is-ancestor` true for each).
The old return branches `claude/v2-recovery-program-commerce-20261011` (V2 `7757a71`, Desktop `4417387`) are
preserved and untouched. The required V2 base is one Codex commit (`f38b949`, assistant lab omission transport,
passive delivery claim, mounted Ask ALP and labs private-view tests) on top of the return's base `7b1cf4c`; the
required Desktop base is three Codex commits (clinic native custody, preserving workflow, fence-exit custody) on top of
the return's base `069340f`.

## Integration method and conflicts

Cherry-picks with `-x`, in the order the handoff lists, onto a fresh worktree at each base. No directory copies.

| Return commit | Integrated as | Conflicts |
| --- | --- | --- |
| V2 `a89ef1c4` adoption and regeneration recovery | `d71e2b5` | none |
| V2 `0b2a7087` personal-storage foreground recovery | `e533e04` | none |
| V2 `f61fa717` program states and shared refusal reasons | `1fa4ccc` | none |
| V2 `1fe081ea` prepared product actions and lesson presentation | `afdf779` | none |
| V2 `698b0d6a` Core launch mirror and paywall navigation | `9206756` | none |
| V2 `7757a717` acceptance kit and return record | `ee5f8ec` | none |
| Desktop `4417387b` program conflict reasons and education contract | `d8c2c60` | none |

The Codex base commits and the return commits touch disjoint files on both sides, so every pick applied cleanly. Both
sets of tests are present on the integrated heads: Codex's `assistant-omission-transport`, `lab-delivery-claim`,
`labs-private-view`, `ask-alp-private-view` and Desktop `clinic-native-custody`, `clinic-preserving-workflow`
suites, and the return's adoption, foreground-recovery, program, lesson and paywall suites. Shared `package.json`
and `.github/workflows/ci.yml` carry both sets of scripts and steps (Desktop `test:clinic-preserving-workflow`,
`test:clinic-native-custody` from the base; V2 `check:core-launch-scope` and `test:core-launch-scope` from the
return, with the CI step "Core launch scope mirror gate").

The additive RDS refusal markers `telehealth_current_authority_refused` and `telehealth_transaction_isolation_refused`
are not present in the required Desktop base `e97aec6` (they live in Codex's separate telehealth sources); the
refusal-mapper change in `d8c2c60` is additive, so a later integration that carries them keeps them.

## Verification on the integrated heads

V2 (`expo/`, source frozen during the run): typecheck exit 0; lint exit 0; `npm test` 262 files passed, 1 skipped;
3102 tests passed, 1 skipped; `build:production-patient-api`, `smoke:production-patient-api`,
`qualify:patient-api-security` (7 cases), `check:testflight` (389 files), `check:v2-capabilities`,
`check:surface-disclosure`, `check:hipaa-baseline`, `check:production-container`, `check:billing-configuration`,
`test:core-launch-scope`, `check:core-launch-scope` (pin `e2248e1be632…` unchanged), `test:store-readiness`,
`test:launch-acceptance` all exit 0; `check:launch-acceptance` 7 accepted / 9 unobserved, release acceptance
withheld, exit 1 (the kit is still bound to the old pair Desktop `4417387` / V2 `7b1cf4c` and is rebound in work
package 5); `check:store-readiness --require-submittable` refused, exit 2. Exact-head CI: run
[38160734307](https://github.com/HolisticDrBright/AI_LONGEVITY_PRO_V2/actions/runs/38160734307) success.

Desktop (source frozen during the run): typecheck exit 0; lint exit 0; `npm run test:unit` 450 files passed; 7141
tests passed, 11 skipped. Exact-head CI: run
[38161376698](https://github.com/HolisticDrBright/AI_DESKTOP_PRO/actions/runs/38161376698), in progress when this
record was written; its conclusion is reported in the return message, not claimed here.

Mounted React, intercepted HTTP and embedded PGlite are source evidence only; no hosted, device or human case is
observed by this milestone.
