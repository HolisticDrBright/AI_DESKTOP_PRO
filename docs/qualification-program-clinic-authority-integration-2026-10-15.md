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
here. The original merged head `cf18432d` subsequently passed all 11 jobs in
[exact-head CI 38806424988](https://github.com/HolisticDrBright/AI_DESKTOP_PRO/actions/runs/38806424988).
That CI result does not change any hosted or activation hold.

## Follow-up clinic-message source integration

Head `3074ac5c` fixes a fail-open input in the still-unregistered current-
membership setter: SQL three-valued logic had admitted a null request purpose.
The corrected candidate LF SHA-256 is
`ff89c1a2d5b934a3a49437099d14b34e5dffed400ae332f26eea2c311a891342`;
the matching rollback SHA-256 is
`d0fae1b0c8565400f1f320db3ef765e5dea6d66b6bbe65c2be32d1ccd751dd08`.
The old candidate was never registered or applied. The new test failed before
the correction; 45 related database cases, typecheck, targeted lint and the
production migration gate passed locally. CI 38809531439 was still running
when this section was written.

The first Claude care-messaging increment `fd10fb51` was then rehearsed on a
**separate local integration branch**. A naive merge returned 503 for ten of
its 16 database cases because its pinned `pg_proc.prosrc` hash described the
old setter. The corrected body hash,
`7054db763a6ff38b00a504a09398dcbd60f69b6476b6c85bab36da496d6e0cd6`,
was independently read from the 106-migration fictional database. Updating
only that pin made the care-message, route and setter suites pass **40/40**;
typecheck, focused lint and the production migration gate also pass. This is
not Claude's complete return or hosted acceptance. The new care-message mode
remains opt-in and off, the setter remains unregistered, and the program,
telehealth, clinic and PHI holds are unchanged. Do not promote this preliminary
integration until Claude's final head is reconciled and exact-head CI passes.
