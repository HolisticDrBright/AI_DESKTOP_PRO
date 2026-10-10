# Fullscript synthetic deployment operator

The native operator builds a single reviewed Fullscript qualification stack in
the synthetic account. It does not authorize provider use, qualify effective
IAM or alarm delivery, or enable PHI. Cart delivery remains `not_implemented`.

## Source and artifact binding

Run `npm run build:fullscript-deployment-operator` from clean committed source.
The result is `dist/aws-clinical-core/fullscript-deployment-operator/index.cjs`.
The command requires six absolute paths, in order: API build manifest, ZIP,
template, target release, explicit parameter array and separate owner deployment
review. It rereads those exact bytes and the current clean source before
admitting a write. A local build does not create an owner review.

The command shape is:

```text
node <absolute operator path> --fictional-fullscript-deployment-only <mode> <manifest> <zip> <template> <target> <parameters> <review>
```

`inspect` checks live prerequisites without acquiring deployment custody or
writing AWS resources. `deploy` admits a new stack only. `resume-unadmitted`
requires a stopped prior writer with no admitted operation. `execute-prepared`
uses the same reviewed change set only if execution was never admitted.
`observe` is read-only recovery after an admitted execution; it cannot dispatch
another operation. Custody uses the existing fixed shared operator directory,
not a caller-selected recovery directory.

## Native observations and dispatch

SDKs and bounded CLI calls explicitly use `ai-synthetic-member` in `us-east-2`.
Both must report the same current assumed-role session in `588966314750`.
Metadata checks never read secret values. Only the exact code and target object
versions are read, with declared and actual byte bounds and stream cleanup.
The fixed read-only RDS observer verifies the dedicated login, worker privileges
and exact migration ledger, then requires a confirmed rollback.

Every create or execute is durably admitted first. The native transport repeats
the prerequisite check, local byte/source guard and identity check before
dispatch. Creation additionally requires observed absence of the stack,
function and draft routes. Execution rereads and validates the exact prepared
proposal immediately before dispatch. A lost response stays fenced; the
transport never retries a write. Pagination must be complete within its bounds
or the command refuses. An empty successful ExecuteChangeSet response is not
mistaken for a failed dispatch, but an empty metadata response is always refused.

The resulting control-plane report verifies the exact published code, version,
environment, stack resources, JWT authorizers and routes. It keeps
`iamQualified`, `alarmsQualified`, `sqlQualified` and `hostedQualified` false.
Effective runtime access, provider behavior, notification delivery and hosted
acceptance still require separate tests.

## Required before the actual run

The exact 107-to-111 database upgrade and the deployment target, SQL privilege,
credential and resource reviews remain separate approvals. The prepared
qualification foundation and general synthetic testing approval do not replace
them. Do not invent review hashes or substitute the staging database.

The existing schema-upgrade operator is not rebuilt by this command. Preserve
its reviewed bytes and shared recovery custody. Paid mobile builds remain held,
production activation remains blocked and PHI remains disabled.

## Verification scope

Native transport tests use fictional SDK and CLI responses, including bounded
object reads, identity drift, pagination, unknown responses and changed
proposals. Clean-built command tests reject invalid arguments and reviews before
credentials or cloud calls. Neither suite deploys resources or counts as hosted
qualification.

AWS documents the distinct execute response and rollback controls in
[ExecuteChangeSet](https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_ExecuteChangeSet.html).
Version-specific artifact reads follow
[GetObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html).
