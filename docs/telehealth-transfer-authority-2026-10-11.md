# Telehealth transfer authority source repair

Source candidate only, PHI disabled and activation blocked. No historical SQL,
release receipt or runtime mapping changes. The exact 116 parent is preserved
in a distinct 117 assembly. No AWS deployment or preserving upgrade is supplied.

## Independent findings against exact 116

The earlier standalone diagnostic stopped at 114; those historical failures
cannot support a claim about 116. Two corrected native PostgreSQL 17.7 runs
bind the complete 116 ledger and assembly before any fixture or API call.

The restricted-owner run compiled as clinical_admin, NOSUPERUSER and NOBYPASSRLS.
A valid fictional transfer refused with telehealth_admission_unavailable:
the key table forced RLS but offered no policy allowing the definer to read it.
This is local role evidence, not proof of Aurora's managed-role behavior.

A separate explicitly labelled bootstrap-owner control verified that 115's key
fence serializes retirement correctly, refuses a later retry, and expiry rolls
back a transfer after a real destination lock wait. It also reproduced a
transfer committing a draft and receipt after either membership suspension or
patient deactivation had committed during that destination wait. Those are
actual native concurrency results, not controlled dependency delays.

Reports are preserved separately outside the repository at the workspace's
tools/native-postgres-17.7-20261010/race-runs directories telehealth-pg17-19AjzU
and telehealth-pg17-qQBcJD. Each names the exact 116 source; both owned local
clusters were confirmed stopped. No fixture was written to AWS.

## Source repair and acceptance conditions

Owner-only policies are constrained to the actual table owner while exercising
the migrator role. No API table grant, global RLS bypass or key is introduced.
The existing key fence and immutable-key/append-only-record triggers remain.
After the draft path finishes its potentially blocking work, a shared
transaction fence protects a fresh identity, person, clinic, membership, patient
and appointment check. Authority-bearing updates and deletes take the matching exclusive fence
through triggers, including privileged direct SQL. A revocation which committed
first must roll back draft, receipt and audit; later authority changes cannot
commit ahead of a writer holding that shared fence. Concurrent transfers may
share it. Unrelated names and appointment-time edits return without taking it.

An initial unregistered 117 iteration allowed a key read but not the locking
read's UPDATE policy, and its native positive refused. Candidate/2 added the
locking policy and passed ten native cases. Its expanded run then failed six
cases: identity status, person status and clinic status could change ahead of
an admitted writer, and each could commit during a destination lock wait while
the transfer still wrote. The original identity test attempted to change the
immutable production binding; that fixture error is recorded separately from
the corrected status-change failures.

Candidate/3 uses a distinct migration timestamp and allows only the table-owning migrator's key
read, locking/retirement and reviewed registration; the API remains denied.
No clinical table UPDATE policy is broadened to obtain authorization locks.
The transfer resolves the exact active workforce subject, active person and
active clinic again instead of treating retained context claims as live
authority. The corresponding identity status, person and clinic mutations
share the fence, and replay receipt reads recheck current authority as well.
PostgreSQL applies UPDATE policies to locking reads as documented in its
[policy reference](https://www.postgresql.org/docs/17/sql-createpolicy.html).

## Selected candidate and local evidence

- Contract: `telehealth-transfer-authority-candidate/3`.
- Migration: `20261011030000_production_telehealth_transfer_authority.sql`.
- SQL SHA-256: `a1e74c6fda49391a1ee07104297d1df2292a185a29f2fbb7b2cfb5b0b2bccac6`.
- Ledger SHA-256: `1c7c7d7e9dcd387ecb3166b757e3d4fdbab338a578e60d9ef006c0015c077215`.
- Assembly SHA-256: `0ed9943a4056ece0391b78b030002882ffab0361e9908aa00a5c6435bf770795`.

The expanded before run at `de381a9c19b24eee1789ac331eb422fb8f58159b`
has 18 cases, 12 passed and six failed. Its report is
`dist/native-authority-runs/authority-pg17-jvNw22/race-qualification.json`.
The repaired run at `d47b0c5bf627f44a05430354d0b096b199050360` passed
all 18 on PostgreSQL 17.7. Its report is
`dist/native-authority-runs/authority-pg17-CYCL0w/race-qualification.json`.
Both record actual transaction outcomes and confirmed cluster shutdown, never
masking a bad accepted write by rolling it back. The after run uses a real
NOSUPERUSER/NOBYPASSRLS session and the restricted API role; bootstrap fixture
administration is separate. Managed and hosted verification remain false.

The after run covers a valid transfer, private key and receipt read denials,
expiry, key-retirement serialization and retry refusal, and both clinical
authority orderings for membership, patient, identity, person and clinic.
The subsequent runner adds concurrent and exact replay checks; those require
their own native report and are not certified by the 18-case run.
Twelve candidate/hold tests and six credential-free runner tests pass; the
combined candidate suite passed 91. Typecheck and targeted lint passed. The new
refusal mapper test failed before its additive allowlist repair, then the
mapper and embedded chart/clinic suites passed 230 tests. These embedded tests
exercise historical chart/clinic candidates, not native or hosted 117.

Run the portable qualification only on Windows with reviewed local PostgreSQL
17.7 binaries and a local `pg` 8.16.3 driver directory:

```text
npm run qualify:telehealth-authority-native -- --binary-directory <absolute-pg-bin> --driver-directory <absolute-driver-directory>
```

The runner refuses external database URLs, target manifests, activation and
source substitution. It binds a clean exact checkout before and after a fresh
local source compilation through 112, 113, 114, 115, 116 and 117; it cannot
admit an existing AWS target. Reports are source evidence only. Build output
uses a distinct `telehealth-transfer-authority-candidate-v3` directory, leaving
earlier candidate artifacts alone. No historical installer or mapping changed.

Managed owner admission, preserving upgrade/custody, independent source
definition review, mapping, hosted races and policy approvals remain separate.
The global authority fence also needs managed contention/deadlock qualification
with other clinic writers; local single-feature success does not prove that.
The 107-to-112 executable approval does not authorize this 117 candidate.
