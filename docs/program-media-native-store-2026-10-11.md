# AWS program media storage source

The chosen media repair is Desktop `66fa01823b0451e2a9975c2741baab075063e5c3`.
This successor adds an actual AWS SDK storage adapter, while keeping authoring
activation disabled. It does not install an endpoint, create a bucket, apply SQL,
or approve any release. The complete native ledger and request factory remain
engineering work.

## Source integration decision

Claude's independent `23d65e9004e7c6bebe219f400b74f102b61b5fb2` repair remains
on `claude/program-media-repair-20261011` as evidence. Its six overlapping paths
and its `program-media-ledger-fence.sql` are not merged or cherry-picked.
The chosen BLOCKED successor remains `program-media-settlement.sql`, SHA-256
`74f54bbb72539218dc6d12098a1773da572f4eb9230faae10010f69d5c95ff04`, on the
preserved `program-media-ledger.sql` SHA-256
`6dae2f237c13540b13cc3b7ecde877be104c35e59c7fddd9206130a62356a34d`.
Both are unchanged, unregistered and unapplied.

Claude's seven audit cases use a different, time-expiring lease contract.
They are not counted as unchanged passing tests on this implementation.
The chosen implementation uses durable writer admissions: uncertain work
does not automatically expire into deletion permission. Two additional
tests adapt the reconciliation-first interleaving and recovery-after-uncertainty
scenarios to this contract. The prior repair already covers cleanup-first,
late admission, substituted publication and acknowledged no-op deletion.

The separate funnels branch at `97779ab` is not integrated here. Its reported
in-flight checks are neither stopped nor counted as evidence for this source.

## Storage adapter

`src/server/programs/aws-program-media-store.ts` constructs private S3 and STS
clients with explicit temporary credentials, fixed regional endpoints,
one attempt per call and a 30-second request lifetime. There is no ambient
credential chain, caller-selected endpoint, administrative role fallback,
retry, unversioned deletion or multipart fallback. Closing the handle aborts
in-flight work and destroys both clients. Late or ignored aborts are rejected
after the reply as well as before a call.

Configuration is restricted to synthetic account `588966314750`, `us-east-2`,
one clinic and one program. A mandatory separation inventory excludes clinical
and recording buckets and KMS keys. The actual caller must match the configured
temporary role. Before exposing the store, readbacks require versioning,
exact SSE-KMS encryption, all public-access blocks, enforced bucket ownership,
dedicated synthetic education tags and independent TLS/encryption/key denials.
Those readbacks do not prove the role's IAM policy, current workforce authority,
a review hash, schema identity or production activation.

Conditional writes copy and validate the exact input bytes, send their SHA-256,
bind the owner, key, type, length, KMS key and educational metadata, and require
a real version ID. Only a structured precondition rejection is classified as a
definitely rejected write. Lost replies, aborts, late replies and malformed
success leave the durable admission uncertain. S3 conditional-write behavior
is described in the [PutObject API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html).

Version inventory follows both continuation markers, filters prefix matches
to the exact key, includes data versions and delete markers, rejects duplicate
IDs and bounds pages and versions. Every data version receives a checksum-enabled,
version-specific HEAD. A page boundary between neighboring keys does not invent
a version marker. Denied, malformed, looping, disappearing or aborted inventory
is incomplete, never proof of absence. See the [ListObjectVersions API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectVersions.html).

Cleanup admits a delete marker only with its exact listed key and a non-null
version ID. A successful delete call is not certification: the authoring service
must observe a second complete empty inventory and record its absence proof.
Foreign-key, missing-key and null-version markers are held without deletion.
Ready artifacts and uncertain writers remain protected by the chosen settlement
contract.

HEAD denial is not absence. Only a structured missing-object response is null;
missing metadata, checksums and content lengths are not synthesized. The
[HeadObject API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html)
also documents the KMS permission requirements for checksum reads, which need
hosted qualification with the reviewed role.

Author preview verifies the exact stored version before signing a private GET
for at most five minutes. The actual SDK signer is exercised locally. The URL
is pinned to the reviewed regional bucket, key and version, not the publication
origin. An issued bearer link is not immediately revoked by closing the handle;
cache behavior, publication delivery and withdrawal semantics remain separate
release decisions.

## Verification status

The five-file focused run passed 113 tests: 35 SDK storage tests over fictional
network replies, 51 authoring tests, 14 settlement database tests, 8 preserved
parent database tests and 5 wire-contract tests. Typecheck and lint passed.
The actual SDK command construction and URL signing run locally; SDK network
sends are fictional. No AWS read or write is counted as observed here.

Earlier checks found two test/runtime issues before the final focused pass:
HEAD validation threw synchronously and a preview fixture included reservation
fields rejected by the artifact schema. The source now returns a rejected
promise for HEAD validation; the fixture uses the exact artifact shape.
An additional actual-SDK signing failure came from freezing the identity
object the SDK annotates. Captured credentials remain frozen, while the SDK
receives a fresh private copy. No fallback credential source was added.

The normal full suite and exact-head CI must be recorded separately after
completion. Green CI on the predecessor `66fa018` is not evidence for this
successor. Hosted verification, device verification and PHI approval are absent.

## Remaining engineering and qualification

1. Finish the complete restricted native ledger, independently resolving the
   current workforce actor, clinic, program rights and exact release. Compose
   mutations and settlement in the same database transaction. Never expose
   private functions through administrative credentials.
2. Build the immutable request factory and bounded workforce upload routes,
   including an explicit large-video/multipart admission design. This single-put
   adapter is not an HTTP upload solution.
3. Implement the mirrored consumer media-reference successor and its safe
   published delivery path. The existing consumer URL slot is unchanged.
4. Review the distinct schema upgrade, dedicated educational bucket, KMS key,
   restricted role, delivery origin and retention/accessibility/caching policies
   before resource or schema changes. Prior schema approval does not apply.
5. Run the real-store matrix with fictional data: caller/resource readback,
   conditional and lost writes, explicit version reads, KMS and IAM denials,
   all inventory pages and markers, both settlement race orders, late writes,
   acknowledged no-op deletes, unknown writers, repeated cleanup and cross-clinic
   refusals. Record complete reports; a refusal or skipped positive case is not
   a pass.
6. Build exact matched V2, Desktop and backend releases, then run device and
   provider acceptance. Keep production and PHI activation off pending separate
   approval. Paid mobile builds remain held.

No AWS provisioning, secret retrieval, migration application, provider call,
activation, mobile build, deployment, main merge, PR or force-push is part of
this source increment.
