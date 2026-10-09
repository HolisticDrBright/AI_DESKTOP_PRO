# Core plan context and lab-worker leases — September 14, 2026

Source engineering only. No deployment, PHI activation, paid EAS build, clinical
approval, or provider agreement is established by this increment.

## Product contract clarified by the owner

Core ($19.99/month) is an independent consumer app. Its eligible AI-generated
guidance and supplement suggestions do not require per-patient clinician approval
or a Desktop connection. The practitioner-connected service is a separate paid
offering; its price and billing contract have not been supplied. Purchasing it does
not approve a protocol. A clinician-reviewed version needs a separate attributable
review record tied to the exact version and reviewer. Peptide and longevity add-ons
remain outside the initial Core launch.

Review of evidence, product identity, interactions, contraindications and signed
application policy is distinct from approval of an individual patient's plan.
Core must still distinguish above/below/unknown values, units and demographic
applicability; unsafe or unsupported products must not be added to meet a quota.
Root-cause suggestions must be presented as uncertain hypotheses, not diagnoses.

## Personal plan context

The production owner-only context builder now reads the most recently saved active
plan among the latest 100 owned protocol records, only when both allowed scope and
current `protocols_supplements` consent permit it. It rechecks the exact consent
revision after assembly. Missing or withdrawn consent yields no plan context.

`personalPlan` is an additive, separately versioned `consumer-plan-context/1`
contract alongside—not inside—the existing clinician `protocol` field. It carries
the storage record/revision/time, plan version/name, and bounded recorded supplement
names/doses/frequencies and lifestyle tasks. Its fixed labels are
`not_clinician_reviewed` and `consumer_saved_unverified`. Client-editable generation
metadata is not proof of server generation or clinical approval. Affiliate URLs,
peptide records, arbitrary approval fields and free-form notes are not forwarded.
No eligible product recommendations are manufactured from the saved list.

V2 validates the new shape, budgets its contents, and labels its context chip
“your saved plan (not clinician-reviewed).” Old responses without the field remain
accepted. Production client-supplied context cannot override this owner-filtered
snapshot. The compiled OpenAI boundary allows explanation while expressly denying
that saved history, a payment, or practitioner access establishes approval/safety.

Deploy the compatible **V2 patient backend first**, then the Desktop-owned context
API. Older V2 strict response validators reject unknown fields. This is not proof
that a phone currently receives the new context. Saved plans must already exist in
the owned store; this change does not complete production generation/persistence,
cross-device conflict handling, or the clinician review workflow.

## Lab concurrency repair

Each lab pass acquires an exclusive DynamoDB lease, fenced to the current state
and pass. Completion requires the same unexpired lease token; release requires
ownership. A stale invocation cannot unlock another worker or overwrite an advanced
pass. Failure callbacks carry the originating pass and cannot fail an active lease
or downgrade a completed/advanced job.

Lease duration is 360 seconds, longer than the deployed worker's 300-second Lambda
timeout. The state machine retries `lab_worker_busy` first, at 60-second intervals
for up to seven retries, allowing expired-lease recovery. Keep this timeout/lease
invariant. This is not exactly-once billing or exactly-once remote model execution:
an ambiguous timed-out external request may still have executed remotely.

Deploy the worker and state-machine definition as one coordinated release. New
workers reject old failure callbacks without a pass. Quiesce/drain old executions
before upgrading; existing executions retain their original workflow definition.
No new worker release has been deployed in this increment.

## BAA and knowledge activation

The owner reports that OpenAI approved proceeding to signature but the Ironclad
link did not arrive; a replacement was requested. **The API BAA remains unsigned
and unverified.** Verify the executed agreement and the exact API organization's
Modified Retention configuration before PHI activation. `store:false` alone does
not establish either. OpenAI remains primary; Anthropic is not an approved PHI
fallback. Confirm that the described intended use covers the independent consumer
AI model, not only practitioner-reviewed output.

[OpenAI's eligibility documentation](https://help.openai.com/en/articles/20001069-hipaa-eligible-products-and-functionality)
was checked September 14, 2026.

The V2 source packages contain 135 draft functional-range records and 782 draft
clinical pearls. Structural/hash validation has passed; these new packages are
**not live model knowledge**. Source excerpts, social posts and conflicting claims
must not silently become treatment rules. Remaining engineering includes a
reviewed retrieval/release contract, source attribution/conflict handling, numeric
range qualification, and synthetic source-to-answer/product-selection acceptance.

## Verification boundary

Tests exercise consent withdrawal, missing permissions, malformed plan data,
forged approval/provenance, truthful context chips, token budgets, lease contention,
pass-bound completion/failure, and workflow timeout compatibility. AWS clients and
context responses are mocked; these are not physical DynamoDB concurrency, hosted
model, or phone acceptance tests. Exact final counts and published commits are
recorded in the shared Graphify handoff.

A full-suite migration test also exposed repeated loading/hashing of all migration
files inside every comparison. Its test-only comparison now loads once, preserving
the assertion and timeout rather than weakening either. Runtime SQL is unchanged.

Production lab ownership/routing, reviewed knowledge release, functional service
activation, privacy fulfillment, provider/store acceptance, security/load/restore
qualification and physical iOS/Android verification remain on the commercial
handoff. Engineering is not complete and the apps are not declared launch-ready.
