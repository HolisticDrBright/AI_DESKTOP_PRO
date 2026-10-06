# Fictional recording-storage qualification candidate — October 6, 2026

This is a technical candidate for an **empty** bucket in account
`588966314750`, `us-east-2`. It does not authorize recording, transcription,
real identities, PHI, a retention schedule, or production activation.

## Observed prerequisite gap

The isolated qualification fleet has no dedicated recording bucket. The
placeholder `ai-clinical-core-qualification-recordings` returned 404, and the
existing owned-voice bucket has versioning, blocked public access, and SSE-KMS
but **no S3 Object Lock configuration**. The recording cleanup store refuses a
bucket unless versioning and Object Lock are both enabled. Reusing the voice
bucket for capture would therefore fail its cleanup qualification.

The candidate template at
`infra/aws-clinical-core/qualification-recording-storage.json` creates a
separate `alp-qualification-recordings-588966314750-us-east-2` bucket. That
name and stack name were absent at read-only inspection. It uses the existing
enabled, annually rotating synthetic clinical CMK
`c13ec29d-0e47-4c02-9136-f371bcbb7900`, versioning, Object Lock capability,
bucket-owner-enforced object ownership, bucket-level public-access blocking,
SSE-KMS, explicit TLS/encryption/key denial policies, and no
automatic expiry or default object-retention period. Bucket and policy are
retained by CloudFormation. Object Lock cannot later be disabled; because this
is an empty dedicated qualification bucket, removing it later would require a
separate reviewed cleanup rather than a stack rollback.

The template grants **no** recording, cleanup, or provider role access. Its
only data classification is fictional qualification; `PhiAllowed` accepts
`false` only. The exact source commit is a required stack parameter/output.
`cfn-lint`, AWS CloudFormation template validation, typecheck, targeted lint,
and three infrastructure tests pass. They do not prove S3 behavior until the
stack is created and checked against the service.

## Hosted result

The source-pinned change set `recording-storage-fictional-20261006` showed
exactly two `Add` actions (`RecordingBucket`, `RecordingBucketPolicy`), no role,
route, Lambda, replacement, or modification. Stack
`ai-clinical-core-qualification-recording-storage` reached `CREATE_COMPLETE`.
Its outputs report `PhiAllowed=false`, source
`5e63597ec1855a93fb2bdae0226b6f77230a5d92`, the named dedicated bucket,
and the existing synthetic CMK. Live S3 readback found versioning enabled,
Object Lock enabled with **no default retention rule**, no lifecycle policy,
all four public-access blocks true, SSE-KMS with that exact key, and the three
explicit deny policy statements. `ListObjectVersions` returned no versions or
delete markers. No audio or other object was written. This is storage-baseline evidence, not a
successful capture or deletion test. The existing owned-voice bucket was not
modified.

Before any fictional audio is written, obtain the separate capture, storage,
and retention reviews and register the correct release rows. The cleanup
worker's real S3 Object Lock/retention responses, IAM scope, late writes,
deletion holds, and alarm path still need hosted acceptance. Never use a
synthetic bucket or test review hash as production PHI evidence.
