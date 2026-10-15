# Qualification program credential and clinic authority source integration

This source-only integration combines two independently verified Desktop lines on
`agent/qualification-program-clinic-fences-20261015`:

- `agent/qualification-program-restricted-db-20261015` at `3280d771`: the
  inactive, restricted qualification-program database-role candidate and its
  transaction-aware operator; and
- `claude/clinic-authority-fences-20261015` at `42a57928`: first clinic
  selection, stale-tab refusal, disabled telehealth membership fencing, and
  fail-closed handling for unconverted caller families.

The merge was clean. Both additive `package.json` scripts and both independent
changes to `rds-data-database.ts` are retained. This integration does not
register SQL, deploy a Lambda, create a secret, activate a database login or
fence table, enable telehealth writes, or change PHI or billing posture.

The credential SQL is still the atomic candidate with LF SHA-256
`7b8541f9c647b13decfef5e7fa42b1d96cab488b7ea91fc5a772d8f5520b2d6f`.
The older conditional approval referred to a withdrawn candidate; a hosted
rollback-only rehearsal and an eventual apply each require fresh owner approval
of the revised exact file and target. The read-only inspect remains the only
hosted operator action.

The clinic-authority SQL candidates remain BLOCKED and unregistered. Its
membership fence table and writer are not deployed, so all 11 telehealth writes
stay disabled in the new authority mode. Its ten unconverted caller families
refuse rather than inheriting clinical access. Hosted revocation races, provider
compensation, device checks, and the policy decisions in
`docs/clinic-authority-fences-2026-10-15.md` remain open.

Integration verification: the credential operator tests (3), restricted
credential candidate tests (7), and four combined database/telehealth test
files (304 tests) pass; `npm run typecheck` passes. Lint exits 0 with one
pre-existing unused-import warning in `build-qualification-program-api.mjs`.
The clinical production build passed (262 pages) and its strict bundle scan
passed (344 client chunks, none of the 21 server-only markers). The native
two-session PostgreSQL harness requires local PostgreSQL binaries; they are
absent on this Windows host, so that particular merged-head run is unobserved
here. Exact-head CI is pending as this note is updated. Do not promote the
integration on this preliminary evidence.
