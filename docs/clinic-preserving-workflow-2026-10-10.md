# Clinic preserving command protocol

The command protocol is implemented in `src/server/clinical-core/clinic-preserving-workflow.ts`. It validates the exact116 source artifact and independently pinned source receipt before any port, then qualifies the sequencing between target checks, rehearsal, write admission, forward invocation and readback. It is not the live AWS operator. Its only execution identity is `injected_protocol_qualification`; it exposes no CLI, AWS transport, managed-profile constructor, approval parser or patient API.

## Upgrade sequence

An outer fence surrounds all operations. The binding includes exact source, operator, artifact, receipt, target and profile identities and PHI-disabled posture. Every callback receives a cloned binding. Initial observation must be112 and strictly shaped, with a complete217-table row witness and all112 historical receipt columns.

The custody port archives the baseline before physical rehearsal. Rehearsal must return the same112 schema and historical rows/receipts. A separate fresh112 read after rehearsal must still match. The `write_admitted` record must return successfully, custody must verify, and the target and fence must be checked again before a single forward invocation. The eventual live forward kernel must re-admit that archived baseline inside its own locked transaction; this protocol does not supply that kernel.

A returned write must report116 and preserve all historical values. Its receipt precedes two fresh readbacks; each must match the whole written observation, including schema, rows and historical receipt digests. Only then is settlement called. Reconciliation and new upgrade are distinct commands: an already observed116 baseline never causes another forward call.

The outer fence must execute its callback exactly once and return its exact completed result. A skipped callback, swallowed refusal, repeated callback or substituted result is refused. The two skipped-callback audit tests failed against the initial implementation before this check; that initial failure remains evidence, not a first-pass success claim.

## Uncertain write outcomes

A timeout, thrown commit response, invalid reply, post-write drift or failed readback/settlement leaves the original custody with a finding. Forward is never retried. If the forward port was entered, its outcome remains `unknown`, even when a later inspection might show116. If admission recording was uncertain, forward was not entered, but the original journal still belongs to its recovery path.

Explicit reconciliation requires original recovery custody, verifies three separate identical readbacks and invokes neither rehearsal nor forward. A successor is refused when the original journal did not admit a writer. Mixed112/116 observations, changed historical values, unexpected prefixes and writer-stop refusal cannot settle. The native recovery adapter still needs to establish stopped-writer identity, immutable original executable/journal, settlement interval and guarded local retirement; injected callbacks do not prove those properties.

## Verification boundaries

`clinic-preserving-workflow.test.ts` covers source/report/binding refusals, sequencing, port mutation, failures at each journal/write/readback stage, changed schema/records/receipts, partial histories and read-only reconciliation. Its transport and custody ports are simulated.

`clinic-preserving-workflow.database.test.ts` connects the protocol to actual embedded PostgreSQL source, the existing physical rollback kernel, real committed successor SQL and fresh complete row/schema reads. It exercises the exact source and receipts, both SQL advisory fences and table locks, historical private legal-hold rows, an actual commit followed by a deliberately lost response, and recovery without repeating the write. The database-name response is modeled for PGlite; the test's forward adapter is a fictional SQL adapter, not the managed production kernel. Custody is in memory. Serial execution is not a real lock-interleaving result.

Every result keeps canonical managed admission, managed-role semantics, native custody proof, operator acceptance, provider/upgrade authorization and PHI false. The protocol cannot transform injected output into AWS evidence. The profile hash is a binding field, not an independent profile compilation or an approval. Source tests cannot certify disk power-loss durability or provider/backup disposition.

Run `npm run test:clinic-preserving-workflow`. CI runs it explicitly in the fictional database job. Test totals and CI outcomes are recorded only after terminal results; no full-suite or hosted pass is inferred from a focused run.

Final combined same-session79275 completed144 tests across the workflow, fence audit, actual workflow database, existing rollback kernel, historical-row witness and hosted-port suites, terminal exit0 in149.24 seconds. The workflow's own56 tests include three actual embedded SQL journeys. Typecheck, targeted ESLint, package/CI-hook validation and whitespace checks passed in same74995. Independently pinned source definition/native tests completed146/146 in same15469; that command's later YAML diagnostic failed because `yaml` was not installed, then was rerun successfully with the existing `js-yaml` package. No dependency was installed to mask the diagnostic.

The initial fence audit in same157b8a failed both skipped-callback cases; same92bc29 then failed repeated-callback outcome and fence-exit uncertainty cases. Both sets pass within the final144 run after their respective repairs. The preceding50 and138 passes belong to the earlier source and are not final-source full-suite evidence. Earlier exact069340f CI38109193250 and38109195776 are now both successful; the deployed-backend test step was skipped for absent secrets. The new workflow source still needs its own exact-head CI and full suite.

## Remaining operator engineering and activation gates

1. Independently compile and qualify the managed-role source profile. Do not learn expected definitions from the target or copy/normalize the local native pins into AWS.
2. Compose exact canonical admission at every112-to116 prefix, all217 historical rows and112 complete receipts, both fences/table locks and baseline matching into the real forward/rehearsal/readback kernel.
3. Bind this protocol to the native immutable custody adapter and fixed shared operator namespace, including original executable archives, torn journals, original writer-stop proof, recovery guard and uncertain-commit settlement. Validate settlement receipts before local retirement within that adapter.
4. Prepare a clean exact executable, reviewed target and coverage mapping. The pending10443ee predecessor review does not approve a112-to116 successor. No placeholder review hash or profile is acceptable.
5. Only after separate approvals, perform actual AWS rollback, preserving apply/recovery and mandatory concurrent hosted qualification, then matched releases, physical devices, provider/store acceptance and human policy/agreement reviews.

No historical SQL, native source receipt, approved predecessor operator or production activation control changes here. AWS remains last observed107. PHI is disabled and paid mobile builds remain held. All six original commercial-readiness scopes retain their original completion requirements.
