# Encounter transcription authority — September 20, 2026

Transcription is the first processing step after a finished recording, and the recording
authority previously declared it unavailable. Migration 83
(`20260920010000_production_recording_transcription.sql`) adds a separately released,
consent-bound transcription layer that reuses the recording grants, holds and cleanup
intents rather than trusting the caller or the provider.

## Database

- `recording_transcription_releases`: a reviewed release per organization with a hashed
  `aws_transcribe` configuration (region, language), approval and expiry. Every operation
  re-verifies the release the deployment was built with; the caller cannot pick one.
- `recording_transcription_jobs`: one open job per recording. `request_recording_transcription`
  is idempotent on the command ID and refuses a recording that is not closed with a `finish`
  disposition, has reserved segments, has a discard or consent-revoked cleanup intent, has an
  expired deletion deadline or belongs to a patient under a legal hold. It requires
  `recording_grants_for_scope(..., 'transcription', ...)` and pins the segment inventory hash
  and the grant identifiers it relied on.
- `recording_transcripts`: immutable versions (`provider` or `correction`) holding the object
  key, SHA-256, byte and word counts and a supersedes link. Text never enters the database.
- `recording_transcription_events`: append-only timeline for requested, processing, completed,
  failed and corrected.
- `complete_recording_transcription` re-checks the grants that authorized the job. If consent
  was withdrawn while the provider worked, it records a failed job and returns the failure
  instead of raising, so the outcome is durable and no transcript row is created.
- `correct_recording_transcript` appends a version with a reason; identical content is a
  conflict and a held patient is refused. `get_recording_transcript_object` and
  `get_recording_transcription_media` are the only functions that return storage
  coordinates, and only inside the owning organization.

## Runtime (`recording-transcription.ts`, `recording-transcription-api.ts`)

One workforce route, `POST /clinical-core/workforce/encounter-recording/transcription`, with
five operations: `request`, `advance`, `list`, `correct` and `read`. Every call runs under
gateway-verified workforce identity and is authorized again inside the database. The
processor performs one bounded step per `advance`: it reassembles the recording from stored
segments, verifying each segment's length and digest against the inventory (a 256 MiB cap
and strict sequence order), re-reads job authority after the reads, writes the media object
create-only under the organization's recording prefix, then starts the provider job. A later
`advance` polls the provider, parses only the documented result shape, stores `transcript-v1.txt`
and completes the job with its digest. Provider failure becomes a failed job with a bounded
code, never a transcript. `read` verifies the stored bytes against the recorded digest before
returning text, which is never listed, logged or cached. Corrections write a new immutable
object and version.

Activation follows the recording pattern: PHI activation plus transcription, provider and
storage review hashes, a release UUID and the workforce/database reviews. Without them the
built handler returns 503 and never loads the SDK runtime. The reviewed IAM policy allows
scoped RDS Data, secret, S3 get/put (create-only, KMS-conditioned) on the organization prefix
and only `transcribe:StartTranscriptionJob` and `GetTranscriptionJob` on `alp-*` job names:
no list, delete, wildcard or drafting-provider permission.

## Encounter page (`AwsRecordingTranscriptionPanel`)

Migration 84 (`20260920020000_production_recording_workspace_finished.sql`) extends the
consent workspace with `finishedCaptures`: closed recordings with a finish disposition, no
discard or consent-revoked cleanup intent and an unexpired deletion deadline, newest first
and bounded to twenty, each with its content type, segment count and the latest open or
completed transcription job. No token, object key, bucket or text is included. An authority
built before this migration omits the key and the page reads it as none.

The panel mounts below audio capture once the workspace is loaded. Each finished recording
gets a page-owned review (`aws-recording-transcription.ts`): load status, request (a fresh
command ID; an uncertain outcome keeps that exact request and blocks other steps until it is
retried), advance one step, open a version, and correct the latest version with a reason.
Text lives only in page memory while open and is dropped on correction, conflict, dispose or
when the panel is unavailable. The browser calls the same-origin proxy
`/api/live/scribe/transcription`, which uses only the request-scoped workforce cookie,
refuses cross-origin writes, queries, encodings, unknown operations and bodies over the
correction bound, and forwards to the separately configured
`RECORDING_TRANSCRIPTION_AWS_API_ORIGIN`. Responses are validated against the strict contract,
correlated to the requested recording, command or transcript, and must declare AI drafting
unavailable. Upstream detail is never forwarded or logged. A recording finished on this page
triggers a notice to reload the workspace; the page never assumes the server state.

## Evidence and what remains

Local only: PGlite tests exercise request gating, idempotency, consent, release refusal,
completion, immutability, consent withdrawal during processing, holds and corrections; unit
tests cover assembly verification, oversized media, provider failure, malformed results,
correction rules, database category mapping and API status mapping; the infrastructure test
builds `npm run build:aws-recording-transcription` and executes the blocked handler without
AWS credentials. No hosted migration, provider call, activation or PHI has occurred. AI
drafting, review-only proposed notes and hold-aware retention of transcripts and provider
artifacts are still engineering. The encounter panel has unit evidence for its controller and proxy only; no browser,
provider or hosted run has exercised it.
