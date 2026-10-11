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
transaction fence protects a fresh identity, membership, patient and appointment
check. Authority-bearing updates and deletes take the matching exclusive fence
through triggers, including privileged direct SQL. A revocation which committed
first must roll back draft, receipt and audit; later authority changes cannot
commit ahead of a writer holding that shared fence. Concurrent transfers may
share it. Unrelated names and appointment-time edits return without taking it.

An initial unregistered 117 iteration allowed a key read but not the locking
read's UPDATE policy, and its native positive refused. Candidate/2 uses a
distinct migration timestamp and allows only the table-owning migrator's key
read, locking/retirement and reviewed registration; the API remains denied.
No clinical table UPDATE policy is broadened to obtain authorization locks.
PostgreSQL applies UPDATE policies to locking reads as documented in its
[policy reference](https://www.postgresql.org/docs/17/sql-createpolicy.html).

Required after evidence includes a valid transfer under a real non-superuser
session, API denial of private key and receipt-table reads, both retirement
orderings, authority revocation and patient deactivation during destination
waits, expiry, rollback counts and replay. Until the native run completes,
these after results are unverified. Pure candidate tests prove only byte,
contract, hold and parent-preservation checks.

Managed owner admission, preserving upgrade/custody, independent source
definition review, mapping, hosted races and policy approvals remain separate.
The 107-to-112 executable approval does not authorize this 117 candidate.
