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

Before any fictional audio is written, obtain the separate capture, storage,
and retention reviews and register the correct release rows. The cleanup
worker's real S3 Object Lock/retention responses, IAM scope, late writes,
deletion holds, and alarm path still need hosted acceptance. Never use a
synthetic bucket or test review hash as production PHI evidence.
