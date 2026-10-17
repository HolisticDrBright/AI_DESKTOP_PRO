# Withdrawal-only consent decision in a closed clinic — source review

**BLOCKED and unregistered.** Nothing here authorizes a migration, release switch, real-patient use, PHI activation, or a change to AWS. Brandon selected withdrawals-only for a suspended clinic: an authorized practitioner may record a patient's withdrawal, while new grants remain blocked. The patient can still withdraw directly.

## Revised candidate identity

The prior `workforce-consent-decision-clinic-status.sql` refused both grants and withdrawals. It was never registered or applied. This revision replaces that **source candidate**, not a deployed migration. Its rollback pins the new source before restoring the original parents. The old review hashes and native evidence are historical and must not be used for an apply.

| Artifact | SHA-256 of LF bytes |
| --- | --- |
| `infra/aws-clinical-core/source-candidates/workforce-consent-decision-clinic-status.sql` | `e3ac5c117165afffb37c9357ba3fa2240410dd3bd41a73bc206d99a3c69a31fd` |
| `infra/aws-clinical-core/source-candidates/workforce-consent-decision-clinic-status-rollback.sql` | `5a863a36011561c63c5013a9457ba9429a9707f6707ca350dbde5c243f5ee2c5` |

The grant function's successor prosrc remains `89ebfcfc7dbf9cb5443fec121ebac0b4eadde24c6fccc802ec2030ea9c3cf33c`. The revised withdrawal function is `002dc02bb8e55e9853a3fffa8ecbc1dd1f900893bce7ee2421530b53627da88f`. The private active-clinic helper remains `b0831b02f1f634d5d5d49e29a12c3ac2f0f7d634a834cdd14773a991c4a49888`. Forward and rollback refuse drift. The legacy clinic-status source candidate and its rollback are unchanged.

## Behaviour proven locally

- A workforce **new grant** waits for and checks the clinic's active status under a share lock. In a suspended or archived clinic it refuses with `consent_actor_refused`, without a new consent row.
- An active clinical member may record a **withdrawal** for the exact connection in a suspended or archived clinic. It creates a revocation version and audit event; it cannot create a grant.
- A suspended member remains refused. The patient's own withdrawal remains available. Cross-clinic authority and preserving rollback remain covered.
- The PGlite custody suite passed 52/52 cases. `node --check` passed for the revised two-session native script, but PostgreSQL 16 was not available on this Windows host. The prior native report applies only to the superseded refuse-withdrawal source.

## Still required before any activation

1. Resolve D1, D3, D4 and D5 in `docs/suspended-clinic-custody-2026-10-16.md`: lawful file continuity, recording cleanup and holds, and patient copies in a closed clinic. This narrow D2 fix does not approve the whole clinic-status release.
2. The unreleased `database_current` path now has a separate **blocked, unregistered** one-operation source candidate and adapter in `docs/current-membership-withdrawal-only-2026-10-16.md`. It has local negatives but still needs exact-source review, two-session lock races, fictional hosted qualification, rollback and separate activation approval. Do not relax the general consent-management gate.
3. Re-run the revised two-session script on disposable PostgreSQL 16, then on isolated fictional qualification Aurora after fresh parent hashes, ledger, rollback and row-custody checks. Do not substitute the old native report.
4. Review the exact candidate and rollback hashes above, operator authority and any legal/retention implications. Keep the candidate BLOCKED, PHI off and production activation off until separate approval.

