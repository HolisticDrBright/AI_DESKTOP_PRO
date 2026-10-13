if (typeof window !== "undefined") {
  throw new Error("commerce/sql-acceptance-host is server-only.");
}
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase } from "../clinical-core/database";
import { classifyDatabaseRejection } from "../clinical-core/rds-data-database";
import type { ClinicalRequestContext } from "../clinical-core/aws-identity-consent";
import { PROGRAM_OFFER_SCHEMA_CANDIDATE_SHA256 } from "./program-commerce-activation";
import { PROGRAM_COMMERCE_AUTHORITY_SCHEMA_CANDIDATE_SHA256 } from "./program-commerce-authority";
import { createSqlProgramOfferLedger } from "./program-offer-ledger-sql";
import { PROGRAM_CHECKOUT_RECOVERY_SCHEMA_CANDIDATE_SHA256, PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256, createSqlCheckoutLedger } from "./program-checkout-ledger-sql";
import { PROGRAM_EDUCATION_DELIVERY_SCHEMA_CANDIDATE_SHA256, PROGRAM_EDUCATION_PROGRESS_SCHEMA_CANDIDATE_SHA256, PROGRAM_EDUCATION_SCHEMA_CANDIDATE_SHA256, createSqlEducationLedger } from "./program-education-ledger-sql";
import { createClaimDelivery, createFictionalClaimSealer, type createFictionalContactAuthority, type createFictionalDeliveryProvider } from "./program-claim-delivery";
import type { createFictionalCheckoutProcessor } from "./program-checkout-processor";
import { createProgramCheckout } from "./program-checkout";
import { createProgramSettlement } from "./program-settlement";
import { createCommerceWorker } from "./program-commerce-worker";
import { createEducationAccessService } from "./education-access-service";
import { createEducationProgressService } from "./education-progress-service";
import { JOURNEY_COURSE_TITLE, journeyCoursePhases } from "./journey-fixture";
import { sqlAcceptanceAllowed } from "./sql-acceptance-gate";
import type { LearnerHost } from "../learner/learner-host";

/**
 * The SQL acceptance host: a SEPARATELY configured fictional test target for the purchase-to-learning
 * path over the actual BLOCKED candidate chain, its SQL ledger adapters and reduced database sessions,
 * on an embedded database kept on disk so it outlives the host that opened it.
 *
 *   - Gate: constructed only where `sqlAcceptanceAllowed()` (local contract fixture AND
 *     COMMERCE_SQL_ACCEPTANCE=1). Nothing in a route or page constructs it; a test target does.
 *   - Schema: the migration manifest, then offer, checkout, checkout recovery, education access,
 *     delivery, the authority successor and the progress successor, each checked against its pinned
 *     SHA-256 before it is applied, once, on a fresh directory. A reopened directory is used as found.
 *   - Fixture rows (visibly fictional; bootstrap only): one clinic, one clinician, one published
 *     program version holding the journey test course, two consumer learners, the fixture's reviewed
 *     access terms and activation evidence reading FICTIONAL REVIEW FIXTURE, and one published offer
 *     created through the SQL offer ledger as that clinician. None of it can register a migration,
 *     approve a review outside this database, publish a real funnel or enable PHI.
 *   - Sessions: each authority (API, worker, delivery, operator) is a handle whose transactions run
 *     with the SESSION user switched to that role (`set session authorization`), checked to be that
 *     role for both session_user and current_user, so a role cannot `set role` into another. The
 *     embedded database authenticates one bootstrap user, so this is not a separate login per role;
 *     separate logins and real lock contention are hosted acceptance. Handles are serialized: the
 *     embedded engine has one connection and serializes everything anyway.
 *   - Boundaries outside this host, passed in and kept by the test across restarts: the processor
 *     (its sessions are its own state), purchaser contacts, the delivery provider and its mailbox, the
 *     consumer identity issuer, and the sealing key.
 * Every service above the ledgers is the real one: checkout, settlement, claim delivery, the worker,
 * and the education access and progress services. Close it and open another on the same directory to
 * recover from what the database saved, with nothing carried in memory.
 */
const CANDIDATES = [
  ["program-offer-revisions.sql", PROGRAM_OFFER_SCHEMA_CANDIDATE_SHA256],
  ["program-checkout-orders.sql", PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256],
  ["program-checkout-recovery.sql", PROGRAM_CHECKOUT_RECOVERY_SCHEMA_CANDIDATE_SHA256],
  ["program-education-access.sql", PROGRAM_EDUCATION_SCHEMA_CANDIDATE_SHA256],
  ["program-education-delivery.sql", PROGRAM_EDUCATION_DELIVERY_SCHEMA_CANDIDATE_SHA256],
  ["program-commerce-authority.sql", PROGRAM_COMMERCE_AUTHORITY_SCHEMA_CANDIDATE_SHA256],
  ["program-education-progress.sql", PROGRAM_EDUCATION_PROGRESS_SCHEMA_CANDIDATE_SHA256],
] as const;
export const ACCEPTANCE_ROLES = ["clinical_core_api", "commercial_education_worker", "commercial_education_delivery", "commercial_education_operator"] as const;
export type AcceptanceRole = (typeof ACCEPTANCE_ROLES)[number];

const fixtureId = (n: number) => "7e1b0000-0000-4000-8000-" + String(n).padStart(12, "0");
export const ACCEPTANCE_FIXTURE = {
  organizationId: fixtureId(1), otherOrganizationId: fixtureId(2), staffPersonId: fixtureId(3), otherStaffPersonId: fixtureId(4),
  programId: fixtureId(6), versionId: fixtureId(9),
  learners: {
    a: { personId: fixtureId(20), identitySubject: "sub:fictional-acceptance-learner-a" },
    b: { personId: fixtureId(21), identitySubject: "sub:fictional-acceptance-learner-b" },
  },
  reviewer: "FICTIONAL REVIEW FIXTURE",
  expected: { accountRef: "acct_FictionalAccount1", apiVersion: "2025-08-27.basil" },
  publicOrigin: "https://clinic.fictional.example",
} as const;
export const ACCEPTANCE_LEARNER_COOKIE = "alp_acceptance_learner";
const evidence = { contract: "program-commerce-activation/1", enabled: true, target: "synthetic-staging", schemaCandidateSha256: PROGRAM_OFFER_SCHEMA_CANDIDATE_SHA256, evidenceSha256: "e".repeat(64), reviewedBy: ACCEPTANCE_FIXTURE.reviewer, reviewedAt: "2026-10-12T00:00:00Z" };

/** The consumer identity service, as a fictional boundary: it signs a fixture learner in and can revoke. It lives outside the host. */
export function createFictionalIdentityIssuer() {
  const sessions = new Map<string, { learner: "a" | "b"; revoked: boolean }>();
  return {
    signIn(learner: "a" | "b"): string { const token = randomBytes(32).toString("base64url"); sessions.set(token, { learner, revoked: false }); return token; },
    revoke(learner: "a" | "b"): void { for (const [token, session] of sessions) if (session.learner === learner) sessions.set(token, { ...session, revoked: true }); },
    resolve(token: string | null): "a" | "b" | null { const session = token ? sessions.get(token) : undefined; return session && !session.revoked ? session.learner : null; },
  };
}
export type FictionalIdentityIssuer = ReturnType<typeof createFictionalIdentityIssuer>;

export type AcceptanceBoundaries = {
  processor: ReturnType<typeof createFictionalCheckoutProcessor>;
  contacts: ReturnType<typeof createFictionalContactAuthority>;
  provider: ReturnType<typeof createFictionalDeliveryProvider>;
  identity: FictionalIdentityIssuer;
  /** The sealing key, kept by the test across restarts as a KMS key would be kept by its service. */
  sealerKey: { key: Buffer; keyRef: string };
  now?: () => Date;
};
/** Injectable faults: a role whose store is down, and a hook before each statement batch (for barriers). */
export type AcceptanceFaults = { down: Set<AcceptanceRole>; before?: (role: AcceptanceRole) => Promise<void> | void };

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

export async function openSqlAcceptanceHost(dataDir: string, boundaries: AcceptanceBoundaries, options: { root?: string; env?: Record<string, string | undefined> } = {}) {
  if (!sqlAcceptanceAllowed(options.env)) throw new Error("sql_acceptance_not_admitted");
  const root = options.root ?? process.cwd();
  const db = await PGlite.create(dataDir, { extensions: { pgcrypto } });
  const bootstrapUser = (await db.query<{ s: string }>("select session_user::text as s")).rows[0]!.s;
  const fresh = (await db.query<{ ready: boolean }>("select to_regclass('commercial_education.program_education_completions') is not null as ready")).rows[0]!.ready === false;
  if (fresh) await buildChainAndFixture(db, root);

  const faults: AcceptanceFaults = { down: new Set() };
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(task: () => Promise<T>): Promise<T> => { const run = queue.then(task, task); queue = run.catch(() => undefined); return run; };
  const session = (role: AcceptanceRole): ClinicalCoreDatabase => ({
    transaction: async work => {
      await faults.before?.(role);
      if (faults.down.has(role)) throw new Error("fixture_store_outage");
      return serialize(async () => {
        await db.exec(`set session authorization ${role}`);
        try {
          const who = (await db.query<{ s: string; c: string }>("select session_user::text as s, current_user::text as c")).rows[0];
          if (who?.s !== role || who.c !== role) throw new ClinicalCoreDatabaseRejection("operation_refused");
          return await db.transaction(async tx => work({
            query: async <Row extends Record<string, unknown>>(sql: string, parameters: readonly unknown[] = []) => {
              try { return await tx.query<Row>(sql, parameters.map(p => (p && typeof p === "object" && "kind" in p && p.kind === "uuid" && "value" in p ? p.value : p))); }
              catch (cause) { throw classifyDatabaseRejection({ name: "DatabaseErrorException", message: cause instanceof Error ? cause.message : String(cause) }) ?? new ClinicalCoreDatabaseRejection("operation_refused"); }
            },
          }));
        } finally { await db.exec(`set session authorization ${bootstrapUser}`); }
      });
    },
  });
  const api = session("clinical_core_api"), worker = session("commercial_education_worker"), deliveryRole = session("commercial_education_delivery"), operatorRole = session("commercial_education_operator");
  const now = boundaries.now ?? (() => new Date());
  const chain = { activation: evidence, checkoutCandidateSha256: PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256, checkoutRecoveryCandidateSha256: PROGRAM_CHECKOUT_RECOVERY_SCHEMA_CANDIDATE_SHA256, commerceAuthorityCandidateSha256: PROGRAM_COMMERCE_AUTHORITY_SCHEMA_CANDIDATE_SHA256 };
  const offers = createSqlProgramOfferLedger({ database: api, activation: evidence, identity: actor => ({ identityPool: "workforce", identitySubject: "wf:" + actor.personId }) });
  const orders = createSqlCheckoutLedger({ database: api, ...chain });
  const workerOrders = createSqlCheckoutLedger({ database: worker, authority: "worker", ...chain });
  const education = createSqlEducationLedger({
    database: api, worker, delivery: deliveryRole, operator: operatorRole, ...chain,
    educationCandidateSha256: PROGRAM_EDUCATION_SCHEMA_CANDIDATE_SHA256, educationDeliveryCandidateSha256: PROGRAM_EDUCATION_DELIVERY_SCHEMA_CANDIDATE_SHA256, educationProgressCandidateSha256: PROGRAM_EDUCATION_PROGRESS_SCHEMA_CANDIDATE_SHA256,
  });
  const sealer = createFictionalClaimSealer(boundaries.sealerKey);
  const checkout = createProgramCheckout({ offers, ledger: orders, processor: boundaries.processor, publicOrigin: ACCEPTANCE_FIXTURE.publicOrigin, now });
  const workerCheckout = createProgramCheckout({ offers, ledger: workerOrders, processor: boundaries.processor, publicOrigin: ACCEPTANCE_FIXTURE.publicOrigin, now });
  // The SQL chain reads the curriculum itself (education_curriculum_for_caller); this callback is never the authority here.
  const settlement = createProgramSettlement({ ledger: education, curriculumContent: async () => null, expectedAccountRef: ACCEPTANCE_FIXTURE.expected.accountRef, now, sealer });
  const delivery = createClaimDelivery({ ledger: education, sealer, contacts: boundaries.contacts, provider: boundaries.provider, now });
  const commerceWorker = createCommerceWorker({ ledger: workerOrders, checkout: workerCheckout, settlement, delivery, now });
  const accessService = createEducationAccessService({ settlement, activation: evidence, checkoutCandidateSha256: PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256, educationCandidateSha256: PROGRAM_EDUCATION_SCHEMA_CANDIDATE_SHA256, expectedCheckoutSha256: PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256, expectedEducationSha256: PROGRAM_EDUCATION_SCHEMA_CANDIDATE_SHA256 });
  const progressService = createEducationProgressService({ ledger: education, activation: evidence, progressCandidateSha256: PROGRAM_EDUCATION_PROGRESS_SCHEMA_CANDIDATE_SHA256, expectedProgressSha256: PROGRAM_EDUCATION_PROGRESS_SCHEMA_CANDIDATE_SHA256 });
  const contextFor = (learner: "a" | "b"): ClinicalRequestContext => ({
    actorPersonId: ACCEPTANCE_FIXTURE.learners[learner].personId, organizationId: ACCEPTANCE_FIXTURE.organizationId, identityPool: "consumer", identitySubject: ACCEPTANCE_FIXTURE.learners[learner].identitySubject,
    purpose: "clinical_data", environment: "synthetic-staging", dataClassification: "synthetic_only", containsPhi: false, realPatientData: false,
  });
  const learnerHost: LearnerHost = {
    kind: "fictional_sql_fixture",
    async identify(request) {
      const cookie = (request.headers.get("cookie") ?? "").split(";").map(part => part.trim().split("=")).find(([key]) => key === ACCEPTANCE_LEARNER_COOKIE);
      const learner = boundaries.identity.resolve(cookie?.[1] ?? null);
      return learner ? contextFor(learner) : null;
    },
    services: () => ({ education: accessService, progress: progressService }),
  };
  let closed = false;
  return {
    dataDir, fresh, faults, sessions: { api, worker, delivery: deliveryRole, operator: operatorRole },
    offers, orders, workerOrders, education, checkout, settlement, delivery, worker: commerceWorker, learnerHost, contextFor,
    accessService, progressService,
    /** The selection the commerce routes read, for installAcceptanceCheckout. */
    selection: { kind: "acceptance" as const, checkout, expected: ACCEPTANCE_FIXTURE.expected, ledger: orders, education, settlement, worker: commerceWorker },
    /** One statement as the bootstrap user, for the fixture's named stand-ins only (time passing for a claim). */
    async bootstrap<Row extends Record<string, unknown>>(sql: string, parameters: unknown[] = []) { return serialize(() => db.query<Row>(sql, parameters)); },
    /**
     * Time passing, the fixture's one stand-in for the clock (the same technique as the candidate tests'
     * `elapse`): one statement as the bootstrap user with triggers suspended, used only to move a
     * timestamp into the past. It is never a path a role can take.
     */
    async elapse(sql: string, parameters: unknown[] = []) {
      return serialize(async () => { await db.exec("set session_replication_role = replica"); try { await db.query(sql, parameters); } finally { await db.exec("set session_replication_role = origin"); } });
    },
    async close() { if (closed) return; closed = true; await queue.catch(() => undefined); await db.close(); },
  };
}
export type SqlAcceptanceHost = Awaited<ReturnType<typeof openSqlAcceptanceHost>>;

/** The candidate chain and the visibly fictional fixture rows, on a fresh embedded database. Exported for the reviewed-runtime source tests, which run it under their own fake RDS Data client. */
export async function buildChainAndFixture(db: PGlite, root: string) {
  const manifest = JSON.parse(readFileSync(join(root, "infra/aws-clinical-core/migrations/manifest.json"), "utf8")) as { migrations: { file: string }[] };
  if (manifest.migrations.some(m => /program[-_](offer|checkout|order|education|entitlement)|commercial_education/.test(m.file))) throw new Error("a commerce candidate is in the installed manifest; this host applies them itself");
  for (const { file } of manifest.migrations) await db.exec(readFileSync(join(root, "infra/aws-clinical-core/migrations", file), "utf8"));
  for (const [file, pinned] of CANDIDATES) {
    const text = readFileSync(join(root, "infra/aws-clinical-core/source-candidates", file), "utf8");
    if (sha(text) !== pinned) throw new Error(`candidate ${file} does not match its pinned SHA-256`);
    await db.exec(text);
  }
  const F = ACCEPTANCE_FIXTURE;
  for (const [org, label] of [[F.organizationId, "Fictional acceptance clinic"], [F.otherOrganizationId, "Fictional other clinic"]] as const) await db.query("insert into clinical_core.organizations(id,synthetic_label) values($1,$2)", [org, label]);
  for (const [person, org] of [[F.staffPersonId, F.organizationId], [F.otherStaffPersonId, F.otherOrganizationId]] as const) {
    await db.query("insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)", [person, "syn_" + person.replaceAll("-", "")]);
    await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values($1,'workforce',$2,true)", [person, "wf:" + person]);
    await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')", [org, person]);
  }
  for (const learner of Object.values(F.learners)) {
    await db.query("insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)", [learner.personId, "syn_" + learner.personId.replaceAll("-", "")]);
    await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values($1,'consumer',$2,true)", [learner.personId, learner.identitySubject]);
  }
  await db.query("insert into clinical_core.synthetic_desktop_programs(id,organization_id,name,status,created_by_person_id) values($1,$2,'Fictional acceptance program (test fixture)','draft',$3)", [F.programId, F.organizationId, F.staffPersonId]);
  await db.query("insert into clinical_core.synthetic_desktop_program_versions(id,organization_id,program_id,version,status,content,created_by_person_id,published_at) values($1,$2,$3,1,'published',$4::jsonb,$5,clock_timestamp())",
    [F.versionId, F.organizationId, F.programId, JSON.stringify({ consumerProgram: { title: JOURNEY_COURSE_TITLE, phases: journeyCoursePhases("first") } }), F.staffPersonId]);
  await db.query("update clinical_core.synthetic_desktop_programs set published_version_id=$2,status='published' where id=$1", [F.programId, F.versionId]);
  await db.query("update commercial_education.program_commerce_activation set enabled=true,evidence_sha256=repeat('e',64),reviewed_by=$1,reviewed_at=now()", [F.reviewer]);
  await db.query("select commercial_education.record_reviewed_access_terms('education-access-terms/1','fixed_days','not_required','fictional-refund-policy/1',$1,repeat('f',64))", [F.reviewer]);
}

/** The fixture offer, published once through the SQL offer ledger as the fixture clinician (API role, workforce context). */
export async function publishAcceptanceOffer(host: SqlAcceptanceHost): Promise<string> {
  const me = { personId: ACCEPTANCE_FIXTURE.staffPersonId, organizationId: ACCEPTANCE_FIXTURE.organizationId };
  const created = await host.offers.execute(me, { action: "create", programId: ACCEPTANCE_FIXTURE.programId, terms: { mode: "paid", name: "Fictional acceptance program (test fixture)", pricing: { currency: "USD", amountMinor: 1234, billing: { kind: "one_time" } }, providerPriceRef: "price_FictionalAccept01", accessTermsVersion: "education-access-terms/1", accessDurationDays: 30 } });
  if (created.action !== "create") throw new Error("offer not created");
  const offerId = created.offer.offerId;
  await host.offers.execute(me, { action: "approve_provider_mapping", offerId, expectedRevision: 1 });
  await host.offers.execute(me, { action: "publish", offerId, expectedRevision: 2 });
  return offerId;
}
