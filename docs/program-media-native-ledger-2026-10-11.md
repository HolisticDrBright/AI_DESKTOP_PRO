# Native lesson media ledger and request source

Prepared for Codex integration and Brandon Bright's readiness record on October 11, 2026. The complete educational-media ledger now has a PostgreSQL implementation, a restricted RDS worker source and a per-request factory. The database journey runs under the restricted worker role, not an administrator. All of these sources remain uninstalled and disabled by default. They do not activate uploads, delivery, a schema upgrade, production or PHI.

## Source identity and preserved parents

Desktop branch `agent/program-media-native-ledger-20261011` starts from `8f06c841bd6160fa6561c2265527715d136f25b0`. It carries the selected `66fa018` settlement and `8f06c84` native storage work. Claude's independent `23d65e9` and alternative settlement SQL are not integrated.

The distinct, BLOCKED successor is `infra/aws-clinical-core/source-candidates/program-media-native-ledger.sql`, SHA-256 `69eb187cd22500014c1b79bf5dfdc7577e1c18376f30197eded0804f9114a6d7`. It is unregistered and unapplied. Its exact parent bytes are preserved:

| Parent | SHA-256 |
| --- | --- |
| `program-media-ledger.sql` | `6dae2f237c13540b13cc3b7ecde877be104c35e59c7fddd9206130a62356a34d` |
| `program-media-settlement.sql` | `74f54bbb72539218dc6d12098a1773da572f4eb9230faae10010f69d5c95ff04` |

The embedded database applies the full 47-migration synthetic manifest, then these exact parent candidates and the new successor. That is not the hosted qualification database's installed history, a preserving-upgrade qualification against its exact assembly, or authority to register the candidate. Historical migration files and installed release mappings are untouched.

## Permission and transaction boundaries

`program_media_worker` is NOLOGIN and NOINHERIT. It may set the already verified request context and call only `clinical_core.program_media_request(jsonb)` for media operations. It receives no media table SELECT/DML, private settlement-helper execution, definer-role membership or migration authority. The API role receives no media authority. `createRdsDataProgramMediaDatabase` pins account `588966314750`, region `us-east-2` and database `clinical_core_qualification`, assumes this worker before application SQL, and rolls back if the role is missing. There is no API/admin fallback and no managed credential is created.

The function owner, `program_media_authority`, is a separate NOLOGIN/NOINHERIT role without SUPERUSER or BYPASSRLS. It uses organization-scoped FORCE RLS and limited grants. Column-id UPDATE grants permit row locks; they do not expose a worker mutation endpoint. It has no schema CREATE privilege after function ownership is transferred.

Every method rechecks active synthetic organization, person, attested workforce identity or reviewed alias, active owner/admin/practitioner membership, enabled complete media release and current same-clinic non-archived program. Authority rows are locked before artifacts. Membership or release revocation after upload admission prevents a later commit; unresolved writer work is retained rather than certified absent. Each transaction is short. STS, S3, upload verification and cleanup I/O stay outside database transactions.

`program-media-native-ledger/1` is a closed reply envelope, not a direct table query or exception-text protocol. The host supplies the exact reviewed storage release with each operation. The database compares its evidence digest, dedicated bucket, origin, owner account, region, KMS key and size limits against the current activation row before mutations. The row is locked for the transaction; an old release cannot commit after the release changes during external I/O. SQL uses database time for admissions and transitions, not caller timestamps.

The SQL implements configuration, authorization, reservation and replay, artifact reads, commit, settlement, durable writer admission/finish, cleanup sealing/certification, supplied-text attachment, retirement, exact publication receipts and bounded orphan discovery. Direct worker access to private helpers stays denied. Publication/text provenance and settlement are inherited from the exact preserved parent contracts.

The TypeScript adapter checks reply shape, clinic, requested artifact/program, object-key derivation, kind/content type, byte ceilings, replay command and payload, and cleanup-list uniqueness and expiry before committing the transaction. Closed SQL errors remain closed; malformed replies and unknown transport/provider errors become `service_unavailable`, not raw validation or provider text. Invalid context is refused before SQL.

## Request factory and upload snapshots

`createProgramMediaNativeRequestSource` admits a closed operation/request pair. Browser input cannot name context, actor, role, storage, release evidence or provider endpoints. The host supplies a verified MFA workforce-session resolver and a separately reviewed scoped STS credential authority. These are trusted host interfaces, not a claim that SQL authenticates JWTs or that the runtime session/credential wiring is deployed.

The factory is off by default and refuses before authentication, database or provider observation. When separately configured, it verifies the current database release, derives scope from the admitted program/artifact, checks present authority and exact credential/store bindings, creates the actual S3/STS source and closes it after the operation. Cancellation and declared/actual upload limits are checked before copying bytes or requesting credentials. Captions/transcripts remain supplied material; no patient identity or generated clinical content is admitted.

Node `Buffer.slice()` aliases memory. Authoring, request-factory and AWS-store admission now use `new Uint8Array(bytes)` to snapshot bytes independently before asynchronous work. Three targeted fault tests mutate the original Buffer after admission and prove the captured upload is unchanged. This is a real source repair, not an AWS upload result.

## Local verification and failing before evidence

| Evidence | Result and scope |
| --- | --- |
| First native-ledger integration attempt | Missing module; no complete native ledger existed. This is an implementation gap, not nine failing assertion cases. |
| Restricted-role database diagnostics | Initial SQL syntax and RLS predicate/activation row-lock permissions failed. Repaired with explicit predicate execution and scoped lock policies, not a bypass role. |
| Transport negative suite before repair | 8 failed, 1 passed: foreign/substituted rows and cleanup lists were accepted; malformed output exposed validation detail outside the transaction. |
| Request-factory diagnostics | One new-test parse error corrected. The valid suite then had 2 failures and 12 passes: raw provider/context text and upload-bound checks admitted credential work too early. |
| Buffer diagnostics | Factory and native SDK tests failed before the copy fix; the strengthened authoring byte-observation test also failed. The original state-only authoring assertion passed because the fictional store trusted declared metadata, so that assertion alone was insufficient. |
| Native source checks before final full verification | 40 tests across four new suites passed before the three Buffer regressions were added. |
| Full focused source verification | 9 files, 358 tests passed after all three Buffer repairs. Includes the real embedded database role and actual authoring/ledger code with fictional store or SDK transports; does not certify AWS. |
| Typecheck and lint | Typecheck passed after the Buffer repairs. Full lint passed before them; focused lint over every changed/new TypeScript file passed afterward. |
| Source gates | Mock-import, AWS identity/consent, authenticated API, compatibility, operation-inventory, production clinical-core and stub-reset checks passed. The production gate remains 106 migrations and zero seeded rows; this candidate is not silently added to it. |
| Diagnostic local build and client scan | Build exited 0, 250 pages; Windows standalone dependency-junction copy produced EPERM, so this is not a qualified deployable package. Client scan passed over 309 chunks. The build preceded the later Buffer repairs; no exact final-release claim. |
| Full suite and exact-head CI | The first full suite is still running and is diagnostic because source changed afterward. Exact final-source full suite and exact-head CI are pending, not inherited from the base. |

Run from the repository root:

```powershell
npx vitest run src/contracts/programMedia.test.ts src/server/programs/program-media-authoring.test.ts src/server/programs/program-media-settlement.database.test.ts src/server/programs/aws-program-media-store.test.ts src/server/clinical-core/rds-data-database.test.ts src/server/programs/program-media-native-ledger.test.ts src/server/programs/program-media-native-ledger.database.test.ts src/server/programs/program-media-native-request.test.ts src/server/programs/program-media-rds-role.test.ts
npm run typecheck
npm run lint
npm run test:unit
npm run build:clinical
npm run check:clinical-bundle
```

The ordinary CI unit suite includes the new tests through its existing glob. No test retry, deadline increase, weakened assertion, skip or administrator fallback is added to obtain a pass. The first full-unit/build processes started before the later Buffer repairs; they are diagnostic runs, not exact final-source evidence. A final full run is required.

Graphify AST-only update completed: 18,091 nodes, 41,519 edges and 1,114 communities. The 88 source files with zero nodes are reported as omissions, not graph coverage. No semantic/API extraction ran. The shared vault map and canvas are separate artifacts; updating this local graph does not claim a shared-map append.

## Remaining source and hosted work

1. Add bounded same-origin workforce HTTP routes, native verified-session/STS request wiring and a deliberate bounded streaming/multipart admission protocol for large videos. The current factory accepts a bounded supplied byte array; it is not an HTTP-body or multipart parser.
2. Complete the mirrored V2 media-reference successor and read-only delivery. A published URL is not yet proof that a consumer can retrieve reviewed bytes. Integrate Studio authoring without reviving arbitrary unreviewed URL authority.
3. Reconcile native media, native telehealth, current funnels and Claude's upcoming commerce work onto a deliberate matched base. Preserve independent candidate identities and rebound release/acceptance kits. Never import a dirty demo checkout.
4. Register a reviewed preserving qualification upgrade against the actual installed assembly. Provision a dedicated education bucket/key, role and read-only delivery origin, and register real reviewed release bindings. Human review and fresh custody/rollback checks precede any AWS schema write or activation.
5. Qualify actual RDS, S3, KMS, STS and delivery behavior: row-security/role isolation, active and uncertain writer races, rights/release revocation, multipart/integrity, lost responses, complete version listings, denied/no-op deletion, exact historical references, and current-origin reads. Embedded PGlite orders are not PostgreSQL lock-wait or AWS cancellation evidence. Uncertain writers still need a reviewed recovery/settlement protocol; time alone cannot release them.
6. Build exact matched backend/Desktop/V2 candidates, then run physical iOS/Android journeys and the five-persona matrix after separate mobile-build authorization. Complete provider, security, retention, store and policy reviews before production/PHI activation.

All six original commercial-readiness scopes remain open. This source increment advances media custody and privacy/permission engineering, not commercial enrollment or live clinical readiness. Prices, held products, source verification, pediatric/guardian exclusions, Core launch scope and PHI restrictions are unchanged. No AWS write, secret retrieval, real provider call, schema application, mobile build/upload, main merge, PR, force-push, production launch or PHI activation occurred.
