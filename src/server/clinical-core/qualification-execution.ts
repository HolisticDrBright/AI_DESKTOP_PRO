if (typeof window !== "undefined") throw new Error("clinical-core/qualification-execution is server-only.");
import { assertQualificationDatabaseName, PRODUCTION_ACCOUNT_ID } from "./qualification-target";

/**
 * Qualification execution: the one reviewed way a candidate serves requests with PHI disabled. It exists so the hosted
 * harnesses can exercise real services against the isolated qualification database with fictional fixture identities,
 * and it can never widen production activation:
 * - disabled unless the deployment names it, and refused outright when PHI is allowed or the production activation is
 *   approved (the two modes never coexist in one deployment);
 * - pinned to the synthetic account (never the production account), to the cluster in that account and to a database
 *   whose name says `qualification` and is never the staging or canonical `clinical_core` database;
 * - admits only the designated fixture identity subjects; every other verified identity is refused exactly as when
 *   nothing is activated (`production_not_activated`), so ordinary consumer or practitioner traffic never reaches it;
 * - marks every response it produces, so evidence gathered under it cannot be read as production evidence.
 * Owner and clinic isolation, consent, holds and every other authorization check run unchanged under it.
 */
export type QualificationExecution = {
  reviewSha256: string;
  accountId: string;
  databaseName: string;
  /** Designated fictional identity subjects (Cognito `sub` values from the reviewed synthetic acceptance manifest). */
  identitySubjects: readonly string[];
};

export class QualificationExecutionError extends Error {
  constructor(readonly category: "qualification_execution_invalid") { super(category); this.name = "QualificationExecutionError"; }
}

export const QUALIFICATION_EXECUTION_HEADER = "x-clinical-execution";
export const QUALIFICATION_EXECUTION_MODE = "qualification" as const;
const HASH = /^[a-f0-9]{64}$/;
const SUBJECT = /^[A-Za-z0-9:_-]{8,128}$/;
const ACCOUNT = /^\d{12}$/;
const CLUSTER_ARN = /^arn:(aws|aws-us-gov|aws-cn):rds:[a-z0-9-]+:(\d{12}):cluster:[A-Za-z0-9-]{1,63}$/;

/** The candidate's process environment (or a subset): QUALIFICATION_EXECUTION, QUALIFICATION_REVIEW_SHA256,
 * QUALIFICATION_ACCOUNT_ID, QUALIFICATION_IDENTITY_SUBJECTS, PHI_ALLOWED, CLINICAL_DATABASE_NAME, CLINICAL_DATABASE_CLUSTER_ARN. */
export type QualificationExecutionEnvironment = { [name: string]: string | undefined };

/** Resolves the policy from a candidate's environment: `undefined` when not named (the default), the policy when every
 * boundary holds, and a thrown `qualification_execution_invalid` when it is named but any boundary fails. `activation`
 * is the candidate's own activation state; it must be `blocked`. */
export function resolveQualificationExecution(env: QualificationExecutionEnvironment, activation: string): QualificationExecution | undefined {
  const named = (env.QUALIFICATION_EXECUTION ?? "").trim();
  if (named === "" || named === "disabled") return undefined;
  const invalid = () => { throw new QualificationExecutionError("qualification_execution_invalid"); };
  if (named !== "enabled" || env.PHI_ALLOWED !== "false" || activation !== "blocked") invalid();
  const reviewSha256 = (env.QUALIFICATION_REVIEW_SHA256 ?? "").trim(), accountId = (env.QUALIFICATION_ACCOUNT_ID ?? "").trim();
  const databaseName = (env.CLINICAL_DATABASE_NAME ?? "").trim(), clusterArn = (env.CLINICAL_DATABASE_CLUSTER_ARN ?? "").trim();
  if (!HASH.test(reviewSha256) || !ACCOUNT.test(accountId) || accountId === PRODUCTION_ACCOUNT_ID) invalid();
  const cluster = clusterArn.match(CLUSTER_ARN);
  if (!cluster || cluster[2] !== accountId) invalid();
  try { assertQualificationDatabaseName(databaseName, "clinical_core"); } catch { invalid(); }
  const identitySubjects = (env.QUALIFICATION_IDENTITY_SUBJECTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (identitySubjects.length === 0 || identitySubjects.length > 16 || identitySubjects.some((s) => !SUBJECT.test(s)) || new Set(identitySubjects).size !== identitySubjects.length) invalid();
  return { reviewSha256, accountId, databaseName, identitySubjects };
}

/** A candidate's configuration may carry the policy only while PHI is disabled and its own activation is blocked. */
export function assertQualificationConfiguration(c: { phiAllowed: boolean; activation: string; qualification?: QualificationExecution }): QualificationExecution | undefined {
  const q = c.qualification;
  if (q === undefined) return undefined;
  if (c.phiAllowed || c.activation !== "blocked" || !HASH.test(q.reviewSha256) || !ACCOUNT.test(q.accountId) || q.accountId === PRODUCTION_ACCOUNT_ID
    || q.identitySubjects.length === 0 || q.identitySubjects.some((s) => !SUBJECT.test(s))) throw new QualificationExecutionError("qualification_execution_invalid");
  try { assertQualificationDatabaseName(q.databaseName, "clinical_core"); } catch { throw new QualificationExecutionError("qualification_execution_invalid"); }
  return q;
}

/** Whether a verified identity subject is one of the designated fixture identities. */
export function qualificationAdmits(q: QualificationExecution | undefined, identitySubject: string): boolean {
  return q !== undefined && q.identitySubjects.includes(identitySubject);
}

/** Every response produced under qualification execution carries the marker header. */
export function markQualificationResponse<R extends { statusCode: number; headers?: Record<string, string>; body?: string }>(q: QualificationExecution | undefined, response: R): R {
  if (q === undefined) return response;
  return { ...response, headers: { ...(response.headers ?? {}), [QUALIFICATION_EXECUTION_HEADER]: QUALIFICATION_EXECUTION_MODE } };
}

/** Lambda wiring helpers: the activation state from its environment value, and the configuration fragment carrying the policy
 * (empty when the deployment does not name qualification execution). */
export function qualificationActivation(value: string | undefined): "approved" | "blocked" {
  return value === "approved" ? "approved" : "blocked";
}
export function qualificationFrom(env: QualificationExecutionEnvironment, activation: string | undefined): { qualification?: QualificationExecution } {
  const q = resolveQualificationExecution(env, qualificationActivation(activation));
  return q ? { qualification: q } : {};
}

/** What a hosted harness observed across its responses: qualification candidates mark every response they produce,
 * production candidates never do. A 401 or 403 without the marker is not evidence of either: API Gateway's authorizer
 * answers those before any function runs, so such denials are counted separately and never classify the execution.
 * The observation describes the run; it is never activation evidence, which is a separate reviewed record. */
export type ObservedExecution = "production" | "qualification" | "mixed" | "unobserved";
export function observeExecution(seen: Set<string>, headers: { get(name: string): string | null } | undefined, status: number): void {
  if (headers?.get(QUALIFICATION_EXECUTION_HEADER) === QUALIFICATION_EXECUTION_MODE) { seen.add(QUALIFICATION_EXECUTION_MODE); return; }
  if (status === 401 || status === 403) { seen.add("unmarked_denial"); return; }
  if (status > 0) seen.add("production");
}
export function summariseExecution(seen: Set<string>): { execution: ObservedExecution; unmarkedDenials: boolean } {
  const modes = new Set([...seen].filter((s) => s !== "unmarked_denial"));
  const execution: ObservedExecution = modes.size === 0 ? "unobserved" : modes.size > 1 ? "mixed" : modes.has(QUALIFICATION_EXECUTION_MODE) ? "qualification" : "production";
  return { execution, unmarkedDenials: seen.has("unmarked_denial") };
}
