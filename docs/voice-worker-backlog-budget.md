# Voice worker backlog and deadline handling

September 17, 2026. Original phases 2/3 source increment. No deployment, PHI
activation, retention-policy change, hold release or paid mobile build.

## Runtime behavior

- Both synthetic and production/drain workers now follow the PendingWork index's
  complete continuation key (`id`, `pending`, `nextWork`), oldest due time first.
  Each invocation fixes its cutoff once, reads at most 20 pages of 25 records and
  processes an ID at most once. Leased jobs on page one do not hide later pages.
- Pages and cursors are validated before processing; repeated cursors, unexpected
  keys, invalid job IDs and out-of-bounds due times refuse the sweep. A GSI is
  eventually consistent and not a snapshot. Exhaustion does not certify deletion
  or an empty account, and a moved item can be observed again on a later page.
- A fresh budget is created for every Lambda invocation, including warm calls.
  It uses the Lambda remaining-time callback plus an elapsed-time deadline capped
  at 30 seconds. New pages/jobs require more than 12 seconds remaining. Ordinary
  SDK calls reserve 5 seconds; lease release reserves 1 second. Individual SDK
  calls also retain their 15-second maximum. These limits never extend the Lambda
  timeout. Both object-version reads and guarded deletions use the same budget.
- Hold/identity guards check the budget again after obtaining database authority,
  immediately before the remote mutation. Expiry stops additional deletion.
  Partial cleanup leaves pending state and does not advance lastCleanupAt. Lease
  release is attempted in the reserved interval; if it cannot finish, the existing
  90-second lease expiry permits a later retry. No TTL or fabricated erasure receipt
  replaces reconciliation.
- Sweep reports contain counts and `stopReason` (`exhausted`, `budget`, `limit`),
  always `backlogCleared: false`, never identities or transcript contents. Ordinary
  job failures remain failed scheduled invocations while later jobs can proceed.
  Synthetic scheduled failures now throw too, instead of returning an HTTP 503
  which EventBridge/Lambda would treat as successful execution. HTTP requests keep
  their sanitized error responses. Budget deferral alone is not a cleanup success
  claim and leaves jobs for the next scheduled invocation.

## Verification and limits

Tests exercise pagination beyond 25 jobs, a leased first page, held-job isolation,
cursor loops/malformed pages, duplicate GSI observations, the 500-job bound,
deadline checks, warm Lambda reuse, and the actual AWS adapter with mocked SDK
transports. A deadline between input/output deletion preserves the remaining
object and retry metadata; waiting for the hold database cannot authorize a new
remote deletion after the work budget is exhausted.

This is not hosted timing/load qualification. A provider timeout can be uncertain;
the database guard and its transaction transport are not made cancellable by an
SDK abort signal. A slow database call may still consume the invocation or leave
a lease to expire. Retained cleanup watches remain necessary for late writes.
Twenty pages bounds one invocation, not total backlog latency. Production must
qualify arrival rate, old-lease recovery, holds, index propagation, multiple
workers, oldest-due age and alarm delivery under realistic load. Counts/logs are
diagnostics, not a tested backlog-age alarm or an exactly-once claim.

Verification at this increment: full Desktop suite **1,986 passed / 11 existing
skips**, 179 files, two workers. Typecheck and changed-file lint pass. The owned
voice Lambda builds and its generated CloudFormation validates. No UI changed.
AWS synthetic STS still reports an expired session; no hosted run is claimed.

The old `owned-privacy-fulfillment.ts` helper remains unwired and must not be
enabled: it mutates per page before full inventory validation and does not bind
work to reviewed request/policy authority. Request-bound retained lab/voice
inventory, durable operator commands and recorded cross-store outcomes remain
required. The worker repair is a prerequisite, not completion of account deletion.
