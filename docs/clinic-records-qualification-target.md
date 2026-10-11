# Clinic record qualification target

The clinic-record runner may test only the reviewed fictional target in account
588966314750, us-east-2, database `clinical_core_qualification`. It verifies
the live target independently before requests, at both sides of the separate
release step, and after the case list. A complete case list is not commercial,
PHI, provider or policy approval.

## Required target fields

The `--target` JSON must have `contract: clinic-records-hosted-target/1` and
these fields. Do not copy values from the credential-free test fixture.

| Field | Required value or source |
| --- | --- |
| account, region, database | 588966314750, us-east-2, clinical_core_qualification |
| apiId | Exact API named in the separate binding |
| clusterArn, secretArn | Reviewed synthetic cluster and inspection-secret identifiers; never secret contents |
| functionArn | Exact unqualified clinic-record Lambda ARN |
| foundationStackArn, candidateStackArn | Distinct full stack IDs, not ambiguous names |
| foundationTemplateSha256 | SHA-256 of the recursively key-sorted JSON of the reviewed foundation template; `clinicTargetCanonicalSha256` computes it |
| reviewSha256, databaseReviewSha256 | Actual separate review-artifact hashes; syntax is not evidence of approval |
| parameters | Every parameter from the exact generated clinic-record template, including defaults, as strings; no omissions or extras |

The parameter map must include the exact source commit, ledger and extension,
API, database resources, both identity pools, organization, all seven designated
subjects, qualification and review hashes, immutable code object version, encryption
keys and alarm topic. PHI is false, activation blocked, qualification enabled.
The observer refuses missing or inconsistent parameters and undeployed stacks.

## Execution

1. Settle the selected migration parent and coverage mapping. The source candidate
   remains on lifecycle /3; the existing qualification database is not automatically
   a compatible target. Obtain the exact preserving-upgrade approval and pass the
   required rollback and custody checks before applying any upgrade.
2. Reconcile and commit the source; CI must pass at the exact selected commit.
   Build and deploy that exact synthetic candidate separately, keeping PHI off.
   A blocked, undeployed or mismatched candidate is not a successful test.
3. Prepare the reviewed target, separate binding, fictional fixture descriptions
   and short-lived test tokens in local private files. Do not commit tokens.
4. Run from the clean exact source checkout:

   `node scripts/clinic-records-qualification-runner.mjs --binding=<private-binding.json> --tokens=<private-tokens.json> --fixtures=<fictional-fixtures.json> --target=<reviewed-target.json> --out=<report.json>`

   The CLI rebuilds locally before AWS observation. STS, CloudFormation, Lambda,
   API Gateway, RDS and Secrets Manager reads use `ai-synthetic-member`, fixed
   us-east-2 endpoints, bounded calls and no automatic retry. It does not sign in,
   deploy, retrieve secret contents, create fixtures or insert a release.
5. At the release prompt, use the separately reviewed operator to register only
   the bound fictional release on the independently verified qualification target.
   Do not substitute an unbound console statement or seed an approval to pass a case.
   Then continue. A target disagreement on either side refuses the run.
6. Keep the full report and exact build identities. Every required case must be
   observed with the qualification response marker. A refusal, skip, partial run
   or mixed execution cannot become a passing verdict.

The library runner also requires the guard. Injected test ports always generate
`embedded` evidence. Real hosted ports cannot be paired with arbitrary supplied
build metadata: hosted execution requires the CLI's verified fresh local build.

## Report and limitations

`clinic-records-qualification-report/2` records requested binding and observed
target separately. The old count-only report contract is refused. Before target
verification, the observed target is null. The terminal success wording is
`mandatory_cases_matched`, never acceptance or PHI approval.

Read-only SQL inspection uses a transaction that is always rolled back. The
database name and complete ordered ledger come from one statement snapshot.
AWS observations are not an atomic snapshot across services. Exact identity checks
do not establish IAM least privilege, preservation of managed protected rows,
real interleaved races, provider contracts, deletion, policy approval or devices.
Those remain separate hosted and human gates.

## Source verification

The target suite has 33 credential-free cases. The report suite has 42 cases.
The embedded runner has four cases, including a real database with a matching
114-row ledger but the wrong name, and the unchanged thirty-case handler journey.
No test fixture represents an AWS deployment, consent release or owner approval.
# Current selected source

The current integration requires the complete 116-row ledger from clinic
candidate `/4`, above the exact 115 key-fence parent. See
[Clinic privacy source integration](clinic-source-integration-2026-10-10.md).
Earlier 114-row observations are historical and cannot qualify the new candidate.
