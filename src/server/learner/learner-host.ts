if (typeof window !== "undefined") {
  throw new Error("learner/learner-host is server-only.");
}
import { randomBytes } from "node:crypto";
import type { ClinicalRequestContext } from "../clinical-core/aws-identity-consent";
import { createEducationAccessService, type EducationAccessResponse } from "../commerce/education-access-service";
import { createEducationProgressService, type EducationProgressResponse } from "../commerce/education-progress-service";
import { FICTIONAL_REVIEW_FIXTURE } from "../commerce/program-commerce-authority";
import { PROGRAM_OFFER_SCHEMA_CANDIDATE_SHA256 } from "../commerce/program-commerce-activation";
import { PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256 } from "../commerce/program-checkout-ledger-sql";
import { PROGRAM_EDUCATION_PROGRESS_SCHEMA_CANDIDATE_SHA256, PROGRAM_EDUCATION_SCHEMA_CANDIDATE_SHA256 } from "../commerce/program-education-ledger-sql";
import { selectProgramCheckout } from "../commerce/program-commerce-runtime";
import { JOURNEY_FIXTURE, ensureJourneySeed, journeyFixtureAllowed, learnerMediaFixtureAllowed } from "../commerce/journey-fixture";
import { createJourneyFixtureMediaService } from "../programs/learner-media-journey-fixture";
import { sqlAcceptanceAllowed } from "../commerce/sql-acceptance-gate";
import type { LearnerMediaReply } from "../../contracts/programLearnerMedia";

/**
 * The learner host: the narrow, server-only interface the Desktop "My courses" route reads and
 * writes through. It is the integration point a REVIEWED host fills in; this source does not.
 *
 *   identify(request)  the verified consumer behind this request, as the host's own authentication
 *                      establishes it (its session, its token verification, its revocation list), or
 *                      null. Never a workforce session, a course slug, or a subject the browser sent.
 *   education(...)     the existing education access service (access view, exact curriculum);
 *   progress(...)      the existing education progress service (read, complete, position).
 *
 * The services are the returned ones with their own checks (consumer pool, synthetic boundary,
 * activation evidence naming the candidate); the host supplies identity and storage, nothing else.
 *
 * Selection, in order:
 *   1. a host installed by the deployment's reviewed bootstrap (`installLearnerHost`); nothing in
 *      this source calls it, so a normal runtime has none;
 *   2. the SQL acceptance host (sql-acceptance-host.ts), only where its own gate admits it (local
 *      contract fixture AND COMMERCE_SQL_ACCEPTANCE=1) and only once that test target installed it;
 *   3. the fictional fixture host, only where the journey fixture is admitted (local contract
 *      fixture AND COMMERCE_JOURNEY_FIXTURE=1, never a deployment). Its identities are the fixture's
 *      two fictional learners, chosen by a fixture session the fixture route issues;
 *   4. otherwise none: the route answers `learner_host_unavailable`, and the page says so.
 * No fictional ledger is constructed, and no identity is fabricated, outside cases 2 and 3.
 */
export type LearnerServices = {
  education: (context: ClinicalRequestContext, body: unknown) => Promise<EducationAccessResponse>;
  progress: (context: ClinicalRequestContext, body: unknown) => Promise<EducationProgressResponse>;
  /** One lesson media slot (program-learner-media/1). Absent on a host without learner media; the route then answers held. */
  media?: (context: ClinicalRequestContext, body: unknown) => Promise<LearnerMediaReply>;
};
export type LearnerHost = {
  readonly kind: "reviewed" | "fictional_fixture" | "fictional_sql_fixture";
  identify(request: Request): Promise<ClinicalRequestContext | null>;
  services(): LearnerServices;
};

const KEY = Symbol.for("alp.learner.host");
type State = { installed: LearnerHost | null; acceptance?: LearnerHost | null; fixtureSessions: Map<string, { learner: "a" | "b"; revoked: boolean }> };
const state = (): State => {
  const holder = globalThis as unknown as Record<symbol, State | undefined>;
  return (holder[KEY] ??= { installed: null, fixtureSessions: new Map() });
};

/** For the deployment's reviewed bootstrap only: installs the one host this process reads through. */
export function installLearnerHost(host: LearnerHost): void {
  if (host.kind !== "reviewed") throw new Error("learner_host_must_be_reviewed");
  if (state().installed) throw new Error("learner_host_already_installed");
  state().installed = host;
}

/** For the SQL acceptance host only, and only where its gate admits it. */
export function installAcceptanceLearnerHost(host: LearnerHost | null, env: Record<string, string | undefined> = process.env): void {
  if (host && (host.kind !== "fictional_sql_fixture" || !sqlAcceptanceAllowed(env))) throw new Error("sql_acceptance_not_admitted");
  state().acceptance = host;
}

export function selectLearnerHost(env: Record<string, string | undefined> = process.env): LearnerHost | null {
  const installed = state().installed;
  if (installed) return installed;
  const acceptance = state().acceptance;
  if (acceptance && sqlAcceptanceAllowed(env)) return acceptance;
  if (journeyFixtureAllowed(env)) return fixtureHost;
  return null;
}

/* ------------------------------------------------------- the fixture host */

export const FIXTURE_LEARNER_COOKIE = "alp_fixture_learner";
const fixtureEvidence = { contract: "program-commerce-activation/1", enabled: true, target: "synthetic-staging", schemaCandidateSha256: PROGRAM_OFFER_SCHEMA_CANDIDATE_SHA256, evidenceSha256: "f".repeat(64), reviewedBy: FICTIONAL_REVIEW_FIXTURE, reviewedAt: "2026-10-12T00:00:00Z" };
const cookieValue = (request: Request, name: string): string | null => {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
};

const fixtureHost: LearnerHost = {
  kind: "fictional_fixture",
  async identify(request) {
    if (!journeyFixtureAllowed()) return null;
    const token = cookieValue(request, FIXTURE_LEARNER_COOKIE);
    const session = token && /^[A-Za-z0-9_-]{43}$/.test(token) ? state().fixtureSessions.get(token) : undefined;
    if (!session || session.revoked) return null;
    const learner = JOURNEY_FIXTURE.learners[session.learner];
    return {
      actorPersonId: learner.personId, organizationId: JOURNEY_FIXTURE.organizationId, identityPool: "consumer", identitySubject: learner.identitySubject,
      purpose: "clinical_data", environment: "synthetic-staging", dataClassification: "synthetic_only", containsPhi: false, realPatientData: false,
    };
  },
  services() {
    const selection = selectProgramCheckout();
    if (selection.kind !== "fictional") throw new Error("learner_fixture_unconfigured");
    return {
      education: async (context, body) => {
        await ensureJourneySeed();
        return createEducationAccessService({ settlement: selection.settlement, activation: fixtureEvidence, checkoutCandidateSha256: PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256, educationCandidateSha256: PROGRAM_EDUCATION_SCHEMA_CANDIDATE_SHA256, expectedCheckoutSha256: PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256, expectedEducationSha256: PROGRAM_EDUCATION_SCHEMA_CANDIDATE_SHA256 })(context, body);
      },
      progress: async (context, body) => {
        await ensureJourneySeed();
        return createEducationProgressService({ ledger: selection.education, activation: fixtureEvidence, progressCandidateSha256: PROGRAM_EDUCATION_PROGRESS_SCHEMA_CANDIDATE_SHA256, expectedProgressSha256: PROGRAM_EDUCATION_PROGRESS_SCHEMA_CANDIDATE_SHA256 })(context, body);
      },
      // Only under its own flag; without it the fixture host has no media service and the route answers held.
      ...(learnerMediaFixtureAllowed() ? { media: async (context: ClinicalRequestContext, body: unknown) => { await ensureJourneySeed(); return createJourneyFixtureMediaService(selection.settlement)(context, body); } } : {}),
    };
  },
};

/** The fixture route's stand-in for a consumer sign-in: an opaque session for one fictional learner. */
export function openFixtureLearnerSession(learner: "a" | "b"): string {
  if (!journeyFixtureAllowed()) throw new Error("learner_fixture_not_admitted");
  const token = randomBytes(32).toString("base64url");
  state().fixtureSessions.set(token, { learner, revoked: false });
  return token;
}
/** The stand-in for the identity service revoking a learner's sessions (sign-out elsewhere, access withdrawn). */
export function revokeFixtureLearnerSessions(learner: "a" | "b"): number {
  let revoked = 0;
  for (const [token, session] of state().fixtureSessions) if (session.learner === learner && !session.revoked) { state().fixtureSessions.set(token, { ...session, revoked: true }); revoked += 1; }
  return revoked;
}
export function __resetLearnerHost(): void {
  state().installed = null;
  state().acceptance = null;
  state().fixtureSessions.clear();
}
