# Artifact-bound care messaging deployment candidate

The messaging handler and CloudFormation template now exist. This is an engineering/deployment **candidate**, not a deployed or activated service. The older `build:care-messaging-source` artifact remains an explicitly non-deployable library and points here. No reviewed evidence, consent grant, practitioner approval or PHI permission is created by either build.

## Build and immutable identities

```powershell
npm run build:aws-care-messaging
cfn-lint dist/aws-clinical-core/care-messaging/template.json
```

Outputs: `index.js`, `template.json`, `artifact-manifest.json`. The manifest hashes the exact code/template bytes, records clean-source status and commit, pins migration count 104 and ledger release `57fdf022f0fdd7d70be12384d6e6d54caab1a0ddb4965a884e4d59eec4c552b0`, and carries seven compiled messaging-function body digests. An isolated `--out-dir=<directory>` option lets artifact tests avoid shared-output races.

The template accepts only the compiled `SourceCommit` and migration release. It requires an immutable, non-null S3 `CodeVersion`. The deployed Lambda must match the recorded ZIP/code identity through AWS inspection before acceptance; a version pin alone cannot prove the uploaded bytes. A dirty build cannot serve even if someone supplies nonempty review parameters. Build a clean reviewed checkout before uploading. No AWS operation runs during the build.

## Runtime and identity boundaries

- Three POST routes: `/clinical-core/consumer/messages`, `/clinical-core/workforce/messages`, `/clinical-core/consumer/messages/export`. Lists, reads, sends, receipts and settlement use the existing typed request contract; export uses the owner-only export contract.
- Separate consumer/workforce Cognito JWT authorizers and issuer/audience checks. Caller-supplied bearer headers, identity fields or owner/organization selectors cannot replace Gateway-verified claims. Workforce access and consumer exports require fresh sign-in. Native mobile PIN/biometrics do not substitute for server identity or MFA policy.
- Lambda checks its compiled source/release, account/region/cluster/secret/database bindings before constructing a data client. Qualification is fixed to account `588966314750`, `us-east-2`, `clinical_core_qualification`, PHI off, activation blocked and designated fictional subjects. Production serving is pinned to account `173535830222` and requires its separate approvals. The two serving modes cannot coexist.
- Every admitted database transaction runs as `clinical_core_api`, never an administrative connection. Before any context or message SQL, a metadata-only check verifies seven actual function body hashes, security-definer/search-path settings, API/PUBLIC execution privileges, four force-RLS tables and table grants, plus six actual immutable/admission trigger bindings. Verification is not cached between requests, so contract drift is refused on the next transaction.
- This per-transaction check verifies the messaging contract, **not the entire migration ledger**. The target/deployment operator must independently inspect the actual complete ledger and match the release manifest. Existing 103-bound target reports cannot qualify the current 104 database.
- Consent, owner/clinic isolation, cancellation fencing, immutable receipts and retained owner correspondence exports are unchanged. Export after withdrawal is live owner-scoped pages, not an atomic whole-account snapshot or erasure receipt.

## Default posture, permissions and reviews

Defaults are `PhiAllowed=false`, `Activation=blocked`, `QualificationExecution=disabled`, with all review hashes empty. This posture has logs-only IAM, alarm actions disabled, and the handler refuses without constructing a database client. Only a separately reviewed serving posture attaches exact-cluster Data API, exact-secret read and secret-context-bound KMS decrypt permissions. No storage, external email/SMS, AI, transcription, identity administration or direct table grant is added.

Serving requires distinct database, workforce-MFA, messaging and retention reviews plus a monitored alarm topic. Qualification additionally requires its reviewed target/identities; production additionally requires activation evidence. Shape-valid values are not evidence of a real review. Do not reuse an unrelated hash or convert approval of fictional test resources/consent into those reviews. The schema upgrade at `1604f1d` is evidence only for schema preservation, rollback and replay.

The template includes Lambda exception and API-level count-only `5xx` alarms. A handled 503 does not necessarily increment Lambda `Errors`, so the API alarm is required too. The API alarm covers the whole named API, not an unverified per-route metric. AWS documents `ApiId` and `5xx` for HTTP APIs: [official metric/dimension reference](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-metrics.html). No request bodies, JWTs, recipient addresses or health content are put in alarm dimensions or application logs.

Timeouts are Lambda 29 seconds/integration 30 seconds, consistent with V2's bounded 35-second clinical transport. The candidate adds two reserved executions. The capacity planner now includes all eleven candidates and requires an observed synthetic-account assumed role. It credits only observed exact named reservations, never future reductions. A ready capacity report is not a deployment or fleet-acceptance pass.

## Versioned hosted target

`qualification-target-messaging.example.json` is the **unfilled** eleven-stack target (`aws-clinical-core-qualification-target/2`); it is deliberately refused as a run target. Version 1 remains a strictly ten-stack historical manifest for older journeys and cannot qualify messaging. Node and PowerShell target checks require all eleven names for version 2, exact source/resource/designated-subject pins, a finished messaging stack, and the migration release in **both** its parameters and outputs. Messaging cannot borrow the voice drain posture. Nothing upgrades a saved target, reviews a placeholder, or deploys a missing stack automatically.

The eleven-stack target is only part of deployment/acceptance integration. The candidate-specific operator still must physically inspect the full database ledger, uploaded ZIP/version and Lambda code digest, actual authorizers/issuer/audiences, organization binding, runtime environment and IAM before hosted journeys. Existing source checks of template parameters are not evidence that these resources were created correctly. The reviewed declaration and tests must not fabricate review hashes to satisfy missing prerequisites.

## Verification and next work

Local tests exercise the real handler → API role → canonical PostgreSQL message/export path with fictional fixtures, including cross-owner denial, workforce read, withdrawal and retained owner export. Actual search-path, force-RLS, PUBLIC grant and immutable-trigger mutations are rejected and restored. Artifact tests validate byte hashes, source/release/version pins, logs-only default permissions, account/region/mode separation, independent-review conditions, exact JWT routes/invoke grants, alarm posture and the CloudFormation ten-condition limit. Pure runtime tests cover mismatched/dirty bindings and authorization before client construction. These do not prove real Cognito, RDS/S3/KMS permissions, Aurora concurrency, mobile behavior or provider policy approval.

Still required engineering: candidate-specific target/deployment/acceptance operator integration, production program-assignment port, V2 production messaging/provider wiring, hold-aware clinic lifecycle and amendments. Then qualify positive and negative hosted messaging/settlement/export journeys against actual AWS, with matched release artifacts and designated fictional accounts. Provider/store acceptance, recovery/security/retention reviews and physical devices remain separate. Neither app is commercial or PHI ready; TestFlight/paid mobile builds stay held.
