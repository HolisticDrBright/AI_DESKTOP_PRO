# Reviewed educational knowledge — September 14, 2026

## Status and exact scope

Implemented in source, disabled by default, not deployed. No real clinical entry
was approved or signed. No model was called, no PHI activation occurred, and no
paid EAS/TestFlight build was made. Core remains independent of individual
clinician approval; this is review of reusable evidence, not review of each plan.

This increment adds **educational references for recorded lab markers** to the
personal Ask ALP context and the lab-synthesis request. It does not create new
supplement eligibility, dosing, treatment rules, functional ranges, clinical
diagnoses, or semantic resolution of conflicting practitioner claims. It does
not alter the existing Desktop copilot database retrieval contract.

## Source → runtime contract

1. Canonical authoring remains in V2 `data/clinical-pearls/`. No duplicate editable
   clinical catalog is added to Desktop. All 782 source records remain draft.
2. V2 `scripts/prepare-reviewed-knowledge.mjs` exports the pure
   `prepareReviewedKnowledge(sourceText, decisions)` function. It checks the exact
   LF-normalized source-file SHA-256, original IDs/draft status, rejects original
   contested claims even if a decision tries to clear the flag, binds each selected
   row's JSON hash, and returns an **unsigned** `reviewed-knowledge/1` payload.
   `sourcePackageSha256` identifies the normalized `pearls.json` bytes;
   `sourcePearlSha256` identifies `JSON.stringify(originalRow)` in that package.
   Preparation is not final schema validation, signing or clinical approval.
3. Reviewed decisions supply concise educational summaries, explicit limitations,
   exact analyte aliases, attributable reviewer/date, and canonical HTTPS sources
   classified as guideline, systematic review or clinical trial. These labels need
   actual evidence review; cryptographic validation does not establish medical truth.
   Numeric-range/dosing/product fields are outside this contract. Narrative URLs,
   affiliate tracking and commercial codes are refused; links belong only in the
   source list. Conflicting source identities and duplicate source pearls are refused.
4. An authorized release process signs the **exact UTF-8 payload string** with
   Ed25519 and produces `{payload, signature}` (base64 signature). No production
   signing key is embedded or created by these tools. Pin its SHA-256 and trusted
   public key in deployment configuration. The runtime verifier checks signature,
   schema, issue/review/expiry dates, sources, and approval/education-only status.
   Unsigned, modified, expired, draft, contested or malformed releases are refused.
5. `aws-reviewed-knowledge.ts` reads one exact S3 object version with size/time
   limits, checks the payload hash/signature, and performs deterministic exact
   analyte-alias retrieval. No fuzzy diagnosis or deficiency inference. Up to six
   references / 10,000 reference-content characters, ordered by review recency/ID.
   Empty or unrelated recorded marker sets return no references, not invented data.
6. Personal context requires existing AI/lab consent and rechecks consent after
   retrieval. V2 validates `reviewedKnowledge`, expiry and provenance, preserves
   limitations, and budgets references **before discarding patient measurements**.
   References without a retained matching marker are removed. Its chip indicates
   supplied reference count, not proof every reference influenced an answer.
7. Ask ALP's generation endpoint reloads the server-pinned release and verifies
   every transmitted reference against it. A patient cannot submit altered
   "approved" reference text. The lab synthesizer loads references server-side;
   the existing `ai-synthesis` artifact retains their provenance with the request's
   input hash. Compiled policy treats references as data, never instructions,
   measurements, patient approval, range authority, or product eligibility.
   Unknown `[[knowledge:id]]` citations are refused. This checks identifiers, not
   semantic correctness of every generated sentence. Existing safety checks remain.

## Deployment contract (not executed)

Both synthetic lab-worker and Ask ALP templates expose:

- `KnowledgeReleaseMode`: `disabled` (default) or `reviewed_release`.
- `KnowledgeReleaseBucket`, `KnowledgeReleaseKey` (`reviewed-knowledge/*.json`).
- `KnowledgeReleaseObjectVersion`: explicit, non-null S3 version ID.
- `KnowledgeReleaseSha256`: hash of the exact signed payload string, not envelope.
- `KnowledgeSignerPublicKeyPem`: Ed25519 public key, never a private key.

Enabling requires all material and grants only `s3:GetObjectVersion` for the exact
object with `s3:VersionId` condition. No S3 writes, list access, broad bucket read,
or new secret permission. Use approved non-PHI reference storage with SSE-S3;
KMS-encrypted reference storage needs separately qualified key access. See
[AWS's specific-version access documentation](https://docs.aws.amazon.com/AmazonS3/latest/userguide/amazon-s3-policy-keys.html).

The disabled personal-storage deployment remains logs-only and inaccessible; it
does **not** acquire reference/data-plane IAM. Its future functional production
template must receive equivalent exact-version permission and matching release
configuration during the separately approved production conversion. Do not
unblock it merely to make this feature visible.

Release order: compatible V2 patient backend first; then context producer and
generation consumer using the same pinned release; then synthetic hosted/device
qualification. Older strict V2 validators reject new context fields. If a pin
changes between context assembly and generation, the request is refused and must
be reassembled rather than mixing releases.

No reference cache is retained. Revoke by disabling the feature/deployment or
removing permission/access to the **pinned object version**. Adding a delete marker
to the current object is not sufficient to revoke an explicitly readable historical
version. Verify rollout completion and in-flight requests operationally. Expiry
is checked on every retrieval. Changing a file in Git does not revoke an S3 release.

## Verification and remaining work

From Desktop, with both checkouts available:

```
node scripts/check-reviewed-knowledge-contract.mjs <V2-repository-path>
```

This executes fictional source preparation → ephemeral test signature → Desktop
verification/retrieval → V2 strict schema → generation-side revalidation and a
forged-content rejection. No emitted files, real clinical signing, AWS or model call.
Unit suites cover consent withdrawal, disabled/invalid modes, exact object/version,
expiry/tampering, duplicate identities, wrong sources, context truthfulness and
budget preservation. Synthetic AWS clients are mocked; local backend smoke keeps
normal production routes refused. Graphify records final counts/commits.

Still required: actual evidence decisions and a signed reference release; source
quality/clinical conflict resolution; independently qualified numeric ranges and
product rules; production personal-service IAM/configuration/activation; hosted
source-to-answer, citation, safety and physical-device verification. A reference
detail/link panel and automatic semantic citation entailment checking are not
implemented here. Full commercial readiness and BAA gates remain open.
