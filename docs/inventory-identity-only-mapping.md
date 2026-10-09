# Inventory identity only mapping

The isolated fictional qualification accounts need database identity, practitioner membership and patient-link rows before candidate acceptance can begin. This operator maps only those rows. It writes no consent artifacts/grants, provider releases, clinical payloads, contact values, approval hashes or production activation.

## Authority and target

The operator uses only member profile `ai-synthetic-member`, account `588966314750`, Ohio, foundation `ai-clinical-core-qualification-foundation` and `clinical_core_qualification`. STS and the completed foundation are observed directly before and after mapping. The exact 107-migration ledger is embedded from the current candidate and verified under a schema lock. Staging and unknown history are refused.

Existing private Cognito pool bindings and the create-only Secrets Manager intent determine the three fictional subjects and person IDs. The operator reads only that intent and those users, never creates accounts, changes passwords/MFA or emits credentials. Independent Cognito observation verifies the configuration, exact person digest, confirmed users and workforce MFA. The secret is reread and never replaced.

The production-shaped schema constrains `production_bound=true`, `clinical_phi` and `contains_phi=true` on these metadata rows. These are schema posture, not real-PHI permission. The pools remain private and synthetic; the candidate profile and deployment still block production/PHI. This does not qualify the public registration plane.

## Build and execute

Build from clean committed source:

```powershell
npm run build:inventory-qualification-identity-mapping
node dist/aws-clinical-core/inventory-qualification-identity-mapping/index.cjs map --confirm-fictional-identity-only-mapping
node dist/aws-clinical-core/inventory-qualification-identity-mapping/index.cjs inspect
```

The literal confirmation is required for mapping. No target, identity, review hash, resource or approval can be passed through the command line or environment. The current checkout must equal the compiled source commit and remain clean.

Ten rows are inserted atomically: one organization, three persons, three identities, one practitioner membership, one placeholder patient and one verified fictional connection. The foreign consumer gets no membership or connection. Deterministic link IDs and exact rereads permit an already-complete replay with zero inserts; partial, foreign, changed or extra mappings are refused, not overwritten. Transaction-scoped advisory/table locks serialize authority changes. SQL and request timeouts are bounded and the native adapter dispatches only once.

A lost COMMIT receipt is reported as unobserved, with no automatic retry. Inspect the same target before any subsequent explicit run. A mapping result is not database-authority acceptance: the command separately runs the existing read-only observer against the full ledger and metadata and rolls that observation back.

## Verification and remaining scope

The initial focused suite passed 36 tests across the mapper's real 107-schema SQL, native observer and existing database observer. It covers exact ten-row creation, zero-insert replay, no approval writes, staging/history refusal, partial authority, alias pollution, wrong patient link, changed labels/contact/role, interrupted transaction, unknown commit receipt, fixed native origins and secret tags/current version, and SQL-level foreign-owner/impersonation refusal. Typecheck and focused lint passed. These use embedded PostgreSQL and fictional AWS transports, not deployed runtime evidence. Dependencies reuse the existing junction rather than a clean install.

Hosted evidence is separate. The operator is not yet a candidate deployment, complete runtime isolation test, retention-service release, provider qualification, physical login acceptance or a PHI approval. All six original launch phases remain incomplete. Preserve clinical holds, source verification, exclusions, adult-only launch scope and the paid-mobile-build hold.

## First hosted attempt

At exact source `39f41400bed436d0cf42cbf5f84620cbbc31ffc2`, the built command exited with `fictional_mapping_not_completed` after write admission. The separate inspect command also refused database authority. A read-only reconciliation observed 107 migrations and zero rows for the designated organization and identities; the transaction rolled back. Neither refusal is acceptance.

A rollback-only probe ran all 21 mapper SQL statements through the same native bound transport, observed the ten provisional rows and all five exact label/contact predicates, and acknowledged rollback. Its transport unconditionally prohibits COMMIT. This narrows the failure but does not establish its cause or a successful mapping. The command now reports a fixed failure stage and bounded exception class without SQL, provider text, stack, credentials or payload values. Two negative tests check that redaction. No write is automatically retried.

## Hosted mapping and independent inspection

The explicit command at clean `a431f93da0e2b4a91dd4b798d84e60eaa0774c8a` completed with an acknowledged ten-row commit. Its independent read-only metadata observer verified the exact 107-migration ledger, three active identities, one practitioner membership, one verified connection, no foreign-consumer connection and the independently observed Cognito person digest. A subsequent separate `inspect` command also completed, rolled back and returned the same mapping SHA `16fb84807e54470a97b218ceff9d935939265fcf2cf3649e8ab227bb49fb9698`. The first refusal remains failed; its original cause is not established by this later success.

Final focused verification at that commit passed 38 tests across five files; typecheck and focused lint passed separately. The complete regression at source `39f4140` is still running at this checkpoint and is not a pass for the later command diagnostics. Hosted zero-insert replay, native clinical-role isolation and complete runtime acceptance remain unverified. The mapping's database-authority component is verified, but retention-service identity, deployed candidate fleet, provider/network qualification, physical login, human reviews and PHI readiness remain open. No consent/provider release or production setting changed.
