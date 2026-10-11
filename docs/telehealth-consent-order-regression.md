# Telehealth consent ordering regression

The exact-copy consent suite now establishes release chronology explicitly and
tests equal timestamps in both insertion orders. This repairs a nondeterministic
test fixture, not the SQL selection or the consent policy.

## CI finding

At Desktop source `5b666437c62b85ff3f1494a0db599cb8bf7385b6`, pull-request run
`38100099339`, job `114354077304`, failed its telehealth consent runtime step.
The test “never falls back to old wording when the newest release has no copy”
received the earlier copy instead of a missing artifact. The suite's two rapid
inserts could share a millisecond timestamp in PGlite. The database orders approved
artifacts by `approved_at DESC, created_at DESC, id DESC`; random UUIDs do not
establish chronology.

The chronological test now dates the earlier approval one minute before the later
approval and asserts which row the full SQL ordering selects. Two additional
tests fix both timestamps and UUID ordering, insert in opposite orders, and verify
that the selected artifact without copy text refuses both review availability
and granting the earlier artifact. Neither case writes a consent grant.

## Verification and limits

The runtime suite passes all 84 tests (34 exact-copy, 30 deployment, 20 API).
The separate blocked-deployment node suite passes 10 tests. Typecheck, targeted
lint, and the blocked consent Lambda/template build pass. Production SQL,
candidate identity, migration mapping, grants, and provider configuration are
unchanged. No AWS call, deployment, consent registration, PHI activation, paid
mobile build, or physical-device acceptance belongs to this repair.

The full SQL ordering is tested as defined; insertion order is not a policy for
resolving tied approvals. Any change to that policy needs a separately reviewed
source candidate. CI for the new repair must be observed at its exact commit;
the failed predecessor run remains a failure, not a pass by rerunning it.
