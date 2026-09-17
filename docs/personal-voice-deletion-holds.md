# Personal voice deletion and preservation

September 17, 2026. Source candidate for original phases 2/3; no deployment,
PHI activation, hold release, new approval or paid mobile build.

## Authority and lifecycle

The production service now requires the shared external-deletion guard. Cleanup
derives person, organization and identity subject from the persisted server-issued
voice authorization and checks that the stored owner matches it exactly. Missing,
malformed or conflicting bindings cannot authorize removal. Current processing
consent is not a prerequisite for deletion, but active identity and no legal hold
are: migration 62 enforces these under the shared database owner lock.

Every Transcribe-job deletion, S3 object-version batch and final cleanup-watch
receipt holds that guard while its bounded remote mutation executes. Each remote
mutation has a 15-second abort deadline. A hold arriving between steps stops the
next step. Partial results and uncertain failures leave pending state and do not
advance the cleanup verification time. An empty object listing is not a bypass.
The final DynamoDB write also compares the exact persisted owner and authorization
map, as well as the lease token. AWS supports equality on maps ([condition
reference](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_Condition.html));
expression names are aliased rather than relying on non-reserved field names.

Cancellation remains logical and immediate: it stops exposure/new processing
without claiming physical erasure. Existing nonterminal provider work is still
waited out. Cleanup-triggering reads return the safe `voice_deletion_held` 409
when the guard refuses for a hold. Scheduled failures remain sanitized retries.

The same guard is wired into active service and reviewed cleanup-only drain.
Drain therefore needs scoped database/secret access; the old no-SQL description
was incorrect for hold-safe deletion and is superseded. Both lab and voice
candidates now take an explicit SecretKmsKeyArn and restrict secret decryption to
that secret's encryption context through Secrets Manager. Voice drain still has
no audio/transcript read/write, new provider-start or billing permission.

Production DynamoDB TTL and S3 lifecycle expiry have been removed because neither
can consult an owner hold. Processing/readability deadlines remain. Retention
cleanup and storage growth require operational review; no retention policy was
invented. Synthetic cleanup/expiry and default blocked activation are preserved.

## What verification can and cannot show

Targeted tests exercise the actual VoiceJobs lifecycle and production AWS command
adapter with mocked transports. They cover success, holds, identity/database
refusal, malformed persisted bindings, missing guard, a hold between input/output
deletion, a hold before the final receipt, immediate cancellation, and API-safe
errors. Separate existing executable SQL tests verify the guard's database rules.
Neither layer substitutes for hosted Aurora/provider/event-delivery acceptance.

Verification: 84 initial focused checks passed, then 51 targeted checks covered
the added API hold response and final owner/authorization receipt binding. The
final full Desktop suite passed **1,966 tests / 11 existing skips** across 177
files. Typecheck, changed-file lint, and both generated lab/voice CloudFormation
schema checks passed. No new hosted or physical evidence was obtained.

This is not distributed atomic erasure: a remote timeout may already have deleted
something, database rollback cannot restore object versions, and a later hold
cannot undo prior authorized deletion. It does not create S3 Object Lock or change
AWS Transcribe's own service-retention policy. Those requirements need review.

Still open: reviewed cross-store/owner inventory orchestration, backlog fairness
and runtime-budget qualification, held/disabled-identity operator resolution,
identity-last deletion, full archive/device/clinic/backup/audit handling and
physical/hosted acceptance. No whole-account deletion or commercial completion
is claimed by a cleaned voice job or a green source test.
