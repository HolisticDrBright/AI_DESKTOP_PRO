# Care connections on the approved fictional 112 ledger

The connection service now has an explicit build and read-only inspection path
for the isolated `clinical_core_qualification` database in account
`588966314750`, region `us-east-2`. This is source engineering for fictional
qualification. It does not apply a migration, register consent, seed reviews,
enable serving, deploy a stack or authorize production/PHI use.

## Exact database identity

The build consumes `build-telehealth-consent-copy-candidate.mjs --json` and
requires its `telehealth-consent-copy-candidate/1` contract, blocked activation,
`phiAllowed=false`, 112 migrations and release
`45aec4369ec94bf6339a17e47eadba7b81e7b5195fd5be46c2903e587b709fb4`.
Those are the exact bytes used by the approved preserving 107→111→112
qualification upgrades. No historical SQL or operator is modified here.

The default build continues to use the 106-migration production artifact and
release `514959bf0d32de55ded312509ae2ebe39a0fdde9f59246b096b0c41ba63f4f9b`.
The successor option is explicit; neither runtime accepts an arbitrary ledger.
The connection and claim-recovery function bodies in 112 match the unchanged
106 bodies, and artifact tests verify all seven connection and two recovery
function bindings remain identical.

```powershell
node scripts/build-aws-care-connections.mjs --release=112
cfn-lint dist/aws-clinical-core/care-connections-qualification-112/template.json
node scripts/inspect-care-connections-qualification.mjs --release=112
```

An existing stack additionally requires `--binding=<reviewed-file>`. The
inspector rebuilds the exact artifact from clean source and inspects all 112
migration rows under a repeatable-read, read-only transaction with rollback.
It also verifies actual template, stack, code version, IAM, authorizers,
routes, alarms and identity bindings. It never signs or certifies the human
reviews represented by a supplied hash. A missing stack reports
`not_deployed`; a blocked stack without a reviewed serving binding is refused.
Neither is a positive functional test.

## Restrictions and tests

The successor template allows only `PhiAllowed=false` and
`Activation=blocked`. Runtime construction independently rejects the 112
build with production-like configuration before creating a database client,
even when production reviews have well-shaped test values. Default blocked
mode also constructs no data client. Qualification still requires current
database, MFA, connection, consent, retention, notification and qualification
reviews and the designated fictional subjects. New consent scopes and claim
recovery remain separately disabled by default.

The initial tests reproduced two failures on the parent: the build rejected
`--release=112`, and the connection runtime refused the exact 112 release.
Tests after the repair cover those positive fictional paths, unknown release
and duplicate options, changed ledger, widened production template, missing
qualification marker, blocked runtime, and fully configured production-mode
refusal. The existing 106 artifact/runtime and messaging tests remain in the
same focused verification. Observer tests use fictional AWS transports and
do not supply hosted acceptance.

The focused connection artifact/runtime/database-binding run passed 58 tests
in three files. The two Node observer suites passed 73 tests with no skips.
The full new-source suite passed 530 files, 8,416 tests and 11 existing skips,
exit 0, in 905.47 seconds. Typecheck, targeted lint, compatibility and
operation-inventory checks passed; the unchanged canonical production gate
still reports 106 migrations and zero seeded rows. Both 112 templates passed
local CloudFormation lint, and the workflow parsed successfully with PyYAML.
An initial workflow-parser check used an unavailable Node `yaml` module and
failed before parsing; no dependency or workflow rule was changed to avoid it.
CI now builds and lints the separate 112 messaging and connection templates
alongside the unchanged default and 107 profiles. Exact-head CI must be
observed separately; the parent's green run is not evidence for these edits.

## Next deployment work

Rebuild from the final clean commit after its required checks and CI pass.
Bind the immutable uploaded ZIP version and digest, exact 112 ledger,
foundation, reduced request role and reviewed identities. Deploy blocked
first; supply actual independent review evidence before enabling the
fictional qualification profile. Run invitation/claim/recovery, withdrawal,
scope admission, link replacement, cross-owner/clinic isolation, messaging
settlement and device convergence against the same deployed target. Keep
PHI and production activation disabled. Paid mobile builds remain held.

This advances phases 1, 3 and 6 of the original six-phase objective. The
remaining fleet packages, hosted journeys, commercial/provider acceptance,
matched releases, physical devices and human reviews still require evidence.
