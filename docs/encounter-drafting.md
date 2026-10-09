# Review-only encounter AI drafting — September 20, 2026

The recording authority listed AI drafting as unavailable. Migration 86
(`20260920040000_production_recording_drafting.sql`) adds a separately released,
consent-bound drafting layer that turns a stored transcript version into a *proposed*
note for the clinician to review. It is review-only by construction: no function in this
layer reads or writes clinical notes, signatures or addenda, and the only way text reaches
a note is the composer's existing explicit insert, chosen by the clinician for one section
at a time and labelled with its provenance.

## Database

- `recording_drafting_releases`: a reviewed release per organization with a hashed
  configuration (`openai_responses`, model, prompt release hash, `zeroDataRetention: true`),
  approval and expiry. Every operation re-verifies the release the deployment was built
  with; the caller cannot pick a release, model or prompt.
- `recording_drafting_jobs`: one open job per recording, bound to one transcript version and
  a note structure (`soap`, `narrative`, `follow_up`, `adime`, `patient_instructions`).
  `request_recording_drafting` is idempotent on the command ID, requires every participant's
  current `ai_drafting` grant (pinned on the job), the recording to be finished, no hold, no
  actionable cleanup intent, and the transcript to be the recording's newest version, so a
  proposal never silently describes superseded text.
- `recording_proposed_notes`: immutable versions with object key, SHA-256, size, section count
  and model. Text never enters the database.
- `complete_recording_drafting` re-checks the grants the job relied on and that the transcript
  is still the newest version; a withdrawal or correction in between records a failed job and
  stores nothing. `get_recording_drafting_input` and `get_recording_proposed_note_object` are
  the only functions returning storage coordinates, only inside the owning organization.
- Proposed-note objects are registered in `recording_transcription_artifacts` (kind
  `proposed_note`, `drafting_job_id`) and appear in cleanup admission under the recording's
  `drafting/<job>/` prefix; an actionable cleanup intent cancels open drafting jobs and cleanup
  admission waits while one is open.

## Runtime (`recording-drafting.ts`, `aws-recording-drafting-openai.ts`, `recording-drafting-api.ts`)

One workforce route, `POST /clinical-core/workforce/encounter-recording/drafting`, with four
operations: `request`, `advance`, `list`, `read`. `advance` performs the single drafting step:
read the transcript object and verify its digest, call the provider once with only the
transcript text, the note structure and a documentation-only boundary, validate that the
output has exactly the requested sections in order with some content, write
`proposed-vN.json` create-only with a full-object checksum and provenance metadata, complete
the job with its digest and register the artifact. Provider failure, invalid output or an
oversized transcript become a failed job with a bounded code. `read` verifies stored bytes
against the recorded digest and returns the document, including the model's own cautions,
which the page shows rather than hides.

The provider is the OpenAI Responses API with `store: false`, a strict JSON schema and a
key read from one exact, separately reviewed secret; consumer ChatGPT is never a provider.
Activation follows the recording pattern plus drafting, provider and storage review hashes,
a release UUID and the provider secret ARN. The reviewed IAM policy allows scoped RDS Data,
the database secret, S3 get/put on the organization prefix, and exactly one additional
secret read on the provider key. There is no Transcribe, Bedrock or wildcard permission.

## Encounter page (`AwsRecordingDraftingPanel`)

Below transcription, each finished recording gets a page-owned review
(`aws-recording-drafting.ts`): load status, choose a note structure, request from the newest
transcript version (a fresh command ID; an uncertain outcome keeps that exact request for
retry), run the single step, open a proposed note. Each section shows its text and, only
while an unsigned note is open, an "Insert into the open unsigned note" button that appends
that one section through the composer's explicit insert with provenance
`proposed_note` and the label "AI-proposed … (review required)". Signed content is never
touched. The browser reaches the service through a same-origin proxy
(`/api/live/scribe/drafting`) that uses only the workforce cookie, refuses foreign origins,
queries, encodings, unknown operations and caller-supplied release or model fields,
forwards to `RECORDING_DRAFTING_AWS_API_ORIGIN`, and validates that every response declares
`writesClinicalNotes: false`.

## Reviewed prompt binding and recovery (migration 91)

The drafting release row pins `promptSha256`, but until September 20 nothing compared it with
the prompt the code actually sends, so a release approved against one prompt would have run
whatever prompt the deployed code contained. The prompt text now lives in
`recording-drafting-prompt.ts`; `DRAFTING_PROMPT_SHA256` is the digest of the exact artifact
(boundary text plus the response contract) and is exported for release preparation. The
processor refuses a job whose release digest differs (`prompt_unreviewed`, HTTP 409, job left
untouched, provider never called), and `buildDraftingRequest` makes the same check before the
API key is read, so an unreviewed prompt never reaches the provider or the secret.

Recovery follows the transcription rules: the proposed-note key is declared before the
provider is called, the write is create-only, and a retry after the write succeeded but the
database completion failed heads the existing `proposed-vN.json`, verifies that it belongs to
this job, transcript and prompt release, and completes with its stored digest instead of
regenerating. A different document under that key is `conflict`. Declared proposed notes with
no row are listed as drafting orphans and registered for cleanup; `reconcile` is an explicit
operation on the drafting route. The page controller drops an opened proposal on
authorization loss, superseded transcript or absence, keeping it only through transient
failures.

## Evidence and what remains

Local only: PGlite tests (consent, latest-version rule, release refusal, idempotency, input,
completion, immutability, withdrawal during processing, cancellation on cleanup, artifact
registry and inventory), processor and API unit tests with a fake provider, provider
request/response boundary tests with a fake secret and fetch, infrastructure tests on the
built `npm run build:aws-recording-drafting` candidate, proxy and controller tests, and a
Chromium run in `e2e/aws-recording-transcription.spec.ts` (request from the stored transcript,
the single drafting step, opening the proposal with its cautions, insertion disabled until an
unsigned note is explicitly opened, insertion with `proposed_note` provenance saved through the
composer, refusal without a transcript, and an opened proposal dropped on authorization loss).
No hosted migration, provider call, OpenAI project configuration, activation or PHI has
occurred. The executed OpenAI HIPAA amendment supplied by the practice owner must be checked for the
covered entity, the project it names and its retention terms; the HIPAA-eligible project, the
documented zero-data retention setting and the prompt release review are recorded outside the
code and gate the release row. `store: false` alone does not establish coverage, and nothing
here asserts the review has happened. Quality review of proposed documentation
against real transcripts is clinical acceptance, not covered by these tests.
