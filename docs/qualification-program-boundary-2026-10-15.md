# Qualification program boundary: one program family for the production-shaped qualification database

**Status:** BLOCKED source candidate.

- Applied nowhere and registered in no manifest.
- A source Lambda entry point now imports it, with a clean-checkout build that embeds the exact commit. A distinct
  BLOCKED template successor names its route and bundle parameters; no deployed template or route imports that bundle.
  Building and linting are not deployment.
- The Core entitlement port is a bounded, Sandbox-only verifier in
  `src/server/clinical-core/core-subscription-guard.ts`, wired into that source entry point. There is no hosted billing
  endpoint for it to call yet.
- Nothing in this work deployed, applied SQL, enabled a row, designated a subject or changed an AWS resource.
- PHI stays disabled, and production program activation stays off everywhere, including in the qualification database.

## The mismatch it resolves

Codex's read-only observation (`docs/qualification-program-api-candidate.md`) found the isolated
`clinical_core_qualification` database production-shaped:

- 112 migration receipts: the 106-migration production artifact plus the approved 107→111→112 upgrades, release
  `45aec4369ec94bf6339a17e47eadba7b81e7b5195fd5be46c2903e587b709fb4`;
- `program_versions` and `program_enrollments`, but neither program family's request function.

The prepared qualification API candidate projects the identity Lambda, whose program route calls
`createProgramAssignments`. That adapter requires a `synthetic-staging` context and
`clinical_core.program_assignment_request(jsonb)` over `synthetic_desktop_program_versions`, neither of which exists on that
database or may be grafted onto it.

The separate production adapter needs reviewed production activation evidence and enabled production activation rows. A
qualification deployment must carry neither.

The 112-ledger test reproduces the mismatch on the same ledger with the parents alone (the rollback case):

- the synthetic adapter refuses the production-shaped context;
- the production database refuses a synthetic one;
- `program_assignment_request(jsonb)` and `synthetic_desktop_program_versions` are absent.

## What this adds

| Piece | File | Role |
| --- | --- | --- |
| BLOCKED SQL successor | `infra/aws-clinical-core/source-candidates/qualification-program-boundary.sql` (SHA-256 `0f07717d…4261a6`) | Adds a disabled qualification row, an empty designated-subject list and `clinical_private.program_qualification_open()`. Redefines three family functions, each identical to its parent except one activation check, which also accepts qualification-open |
| Rollback | `…/qualification-program-boundary-rollback.sql` (SHA-256 `bfdf50b7…74da9e`) | Restores the three parent definitions exactly and drops only what the successor created |
| Metadata | `…/qualification-program-boundary.json` | Parents, digests, function body digests, the runtime binding, the required environment. Pinned to the code by the test |
| Qualification adapter | `src/server/clinical-core/qualification-program-assignments.ts` | Built only under qualification execution. Admits only designated subjects. Runs the production request path (`boundedProgramExecutor`, now shared with the production adapter) behind a per-transaction function-digest binding |
| Route handler | `src/server/clinical-core/qualification-program-api.ts` | The two routes, `POST /clinical-core/{consumer,workforce}/programs`, with every configuration pin checked before any data client exists |
| Lambda entry and source build | `src/server/clinical-core/aws-qualification-program-lambda.ts` and `scripts/build-aws-qualification-program.mjs` | Bundles the exact reviewed function digests and compiled commit from a clean checkout; requires the real Sandbox billing verifier, never a synthetic Core bypass |
| BLOCKED template successor | `infra/aws-clinical-core/qualification-program-api-successor.json` and `scripts/build-qualification-program-api-successor.mjs` | Two JWT-protected routes, correct qualification program context and immutable PHI/activation holds; requires exact fictional subjects, reviewed billing origin, schema review, clean-source bundle and S3 object version before any deployment |

### Qualification-open

`clinical_private.program_qualification_open()` is true only when all of these hold:

- the qualification row is enabled and names `current_database()`, so a copy of the row in any other database opens
  nothing;
- **both** production activation rows are disabled, so the two modes never coexist;
- the request context is the production-shaped one the qualification database runs;
- the caller's identity subject is designated.

The program-step purchase candidates keep their production-only checks, so qualification never opens a purchase.

### One context and one contract

- The route builds the production-shaped context with the existing identity builders.
- The adapter runs the production adapter's own request path: the bound completion contract, the per-request Core
  entitlement check, `clinical_core.production_program_bounded_request` and the destination lock.
- The database opens that same entry point under qualification.

There is no third request function and no second contract.

## Evidence (source only, fictional)

`src/server/clinical-core/qualification-program-boundary.database.test.ts`: 20 cases on the actual 112 ledger in
PGlite, with the four parents and the successor, through the API role.

**Preservation**
- The ledger's 112 rows are byte-identical before and after.
- Each redefined function equals its parent once the one qualification line is removed.
- The review and lab-hold functions are untouched.

**Closed by default**
- The file inserts the row disabled, no subject, and no production row update.
- With the row off, a designated subject gets `program_boundary_disabled`.

**Designated subjects only**
- A designated clinician assigns and the designated owner reads, accepts once, replays as a duplicate and completes a
  lesson against the review shown. Both production rows stay off.
- An undesignated identity is refused by the adapter before any transaction, and by the database itself when a
  misconfigured Lambda lets it through.

**Never coexisting**
- Enabling either production row closes qualification.
- A row naming another database opens nothing.
- The API role cannot read or write the row or the subject list, call the open check, or call the parent request
  function.

**Authorities unchanged**
- Cross-owner and cross-clinic access is refused.
- A suspended or absent membership refuses the clinician.
- A revoked connection refuses the owner, and a withdrawn consent is refused as consent.
- A changed published artifact refuses the next assignment, and a stale revision refuses the accept.
- Without a governed catalog answer for the owner's plan, the supplement step is held, cannot be completed, and holds
  its phase.
- A stored purchase destination never appears in the owner's read or the clinic's preview.
- A consumer without current Core is refused before the database.

**Binding**
- A Lambda naming another schema identity (the parent's entry point) is refused as `service_unavailable`.
- A function changed after review is refused until it is restored.
- PHI on, an approved activation, a missing policy, the production account, a non-qualification database, no subjects
  and a malformed binding are all refused at construction.

**Route**
- Designated assign and list work through the routes, marked `x-clinical-execution: qualification`.
- An undesignated subject gets `production_not_activated`.
- A synthetic-attested token gets 401.
- An unknown route gets 404 and a query string gets 400.
- Twelve misconfigurations answer 503 to everything and never create a data client: PHI, approved activation,
  qualification off, the production account, a non-qualification database, another ledger, the 106 ledger, another
  boundary candidate, a dirty build, another commit, no subjects and a malformed binding.

**Rollback**
- Exact parent definitions are restored and only the successor's objects are dropped.
- Qualification closes.
- The enrollment written under qualification remains: rollback removes access, never records.

What this does **not** prove:

- real Aurora privileges or locks;
- the RDS Data API driver against these functions;
- Cognito tokens for the designated subjects;
- the qualification billing answer;
- any hosted, device or human case.

## Prerequisites before any AWS change (Codex, in order)

1. **Review the candidate.** Review the successor, its rollback and the four parents in their order. The parents are
   BLOCKED too: `lab-result-transfer-v2.sql`, `lab-observation-attestation.sql`, `production-program-assignments.sql`
   and `production-program-consumer-boundary.sql`. Confirm the metadata digests from a clean checkout.
2. **Build a qualification-only preserving upgrade** from the 112 ledger: those four parents, then this successor. Use
   the approved migration operator, with read-only ledger inspection before and after and a rollback rehearsal. Do not
   apply it to staging, production or any database whose name is not `clinical_core_qualification`.
3. **Leave both production rows disabled.** In the qualification database only, set the qualification row:
   - `enabled=true` and `database_name='clinical_core_qualification'`;
   - the review digest, reviewer and time.
   Then insert the designated fictional subjects from the reviewed synthetic acceptance manifest, at most 16, the same
   list the Lambda's `QUALIFICATION_IDENTITY_SUBJECTS` names.
4. **Review and build the Lambda source entry point** for `createQualificationProgramHandler`. It exists in source,
   but no candidate template imports its artifact and it has not run in AWS. It needs:
   - a reviewed and pinned
     `QUALIFICATION_BILLING_API_ORIGIN`. It requires a bounded, fresh `Sandbox` answer from the billing service; it
     never accepts the client-side synthetic bypass. A read-only October 15 inventory found no billing stack and no
     billing route on either the isolated qualification API (`6zt8e9qz04`) or the shared synthetic API
     (`wxv734oi12`), so every consumer request must remain refused until a real sandbox billing boundary is installed
     and reviewed. The production-account billing readiness stack was also observed on October 15 with
     `BillingActivation=blocked`, `EnabledStores=none`, `StoreEnvironment=Sandbox` and production consumer pool
     `us-east-2_kl37QO1DJ`; it cannot verify tokens from the isolated fictional consumer pool. The source verifier
     alone is not an entitlement or hosted pass;
   - the function digests from `qualification-program-boundary.json`;
   - the environment listed there.
5. **Review the separate successor of `qualification-program-api-candidate.json`**. It now points the two routes at
   the source Lambda entry, keeps `PhiAllowed=false`, `Activation=blocked`, the pinned pools and API, and distinct log
   group and alarm names. Before any change set, pin the exact clean-source bundle/key, source commit, reviewed
   qualification subjects and clinic, a versioned S3 code object, and a Sandbox billing API origin that actually exists and verifies those same
   fictional consumer tokens. The origin is a required parameter, not an implicit fallback. Review resource ownership
   and replacement effects; the old candidate remains unchanged and must not be deployed.
6. **Run the hosted cases on fictional identities.** A skip, an unavailable catalog or a mismatched source is a refusal,
   not acceptance:
   - designated assign, accept, replay and bound completion;
   - an undesignated subject refused;
   - cross-owner and cross-clinic denial;
   - a revoked membership and a revoked connection;
   - a second device converging on the same enrollment;
   - a changed published artifact;
   - a catalog-held supplement;
   - a destination absent from every answer;
   - either production row enabled closing qualification;
   - the rollback rehearsal.

The acceptance kit stays withheld until those are observed.
