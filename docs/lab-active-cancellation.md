# Owned unfinished-analysis cancellation

Original phases 2/3. Synthetic-only service implementation, not account-wide
erasure, a mobile release or commercial activation.

`POST /clinical-core/consumer/labs/jobs/{jobId}/cancel` (and the authenticated
synthetic-session equivalent) requires the exact body
`{"confirmRemoveUnfinishedAnalysis":true}`. It cancels **and removes unfinished
analysis inputs/artifacts**. Existing personal labs, saved plans and Desktop
records are separate and unchanged. Completed/needs-review/failed results return
409 rather than being silently deleted. Another owner or absent job returns 404.

The atomic job/outbox claim verifies subject/organization/person and an unfinished
state, switches to deleting and revokes the worker lease. A completion that wins
first prevents cancellation. Late worker completion/failure cannot replace the
fence or publish a plan. Normal reads/replay already exclude deleting jobs.

The outbox's optional `stopRequired:true` is durable and contains no health data.
Cleanup stops only the two deterministic execution names for this job on the
configured lab state machine, then purges versions and retains the late-write
watch. Only ExecutionDoesNotExist is tolerated. Timeouts/permission failures or
missing stop confirmation return 503 with no cancellation acknowledgement; the
five-minute sweep retries. Removal of stopRequired is conditional, so a concurrent
new requirement cannot be lost. An acknowledged retry is idempotent.

Stopping Step Functions does not terminate an already-running Lambda/provider
request. It may finish inside the existing Lambda timeout, but cannot publish a
result and late artifacts are cleaned up. This is not a claim of immediate
provider-side erasure, refunded model costs or erased execution/audit histories.

## Acceptance

The extended synthetic script accepts `-TestActiveCancellation` together with
the upload/late-upload switches. It changes **only its newly created synthetic
fixture**, conditional on its immutable request ID and awaiting-upload state,
to queued with a ten-minute held lease. The real workflow starts but its worker
cannot acquire the lease or access a document/model. It then tests wrong-owner
and missing-confirmation refusal, owned cancellation, exact execution ABORTED,
acknowledgement replay and automatic late-upload cleanup. It does not invoke
complete-upload or use any real health values. Record actual results separately;
unit tests and a prepared script are not proof that this has run.

## Remaining integration

Mobile confirmation/cancellation controls still need wiring. They must work
during an active local poll, preserve the account binding, persist cancellation
intent across a restart, prevent stale upload writes from restoring the pending
pointer, and clear only the acknowledged original request. An ambiguous timeout
must remain retryable, not be reported as cancelled. Physical device acceptance
and production processing/retention/alert-routing gates remain open.

The existing mobile `pendingJobs.exclusive` spans the polling loop and rejects
overlapping calls. Do not put cancellation behind that same lock: it would be
unavailable precisely while processing. Use a short storage-mutation lock and
account-scoped operation generations to invalidate stale running work, with
durable cancellation intent before the remote request. Account switching and
failed/ambiguous storage writes must not clear another pointer. If completion
wins and AWS refuses cancellation, preserve the completed job for explicit
review instead of automatically applying or discarding it.

AWS reference: [StopExecution](https://docs.aws.amazon.com/step-functions/latest/apireference/API_StopExecution.html).
