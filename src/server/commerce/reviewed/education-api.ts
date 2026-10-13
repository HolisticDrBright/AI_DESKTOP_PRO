if (typeof window !== 'undefined') throw new Error('reviewed education API is server-only');
import type { ApiGatewayV2Event, ApiGatewayV2Response } from '../../clinical-core/aws-identity-api';
import type { SyntheticRequestContext } from '../../clinical-core/aws-identity-consent';
import { EducationAccessError, EDUCATION_ACCESS_ROUTE_SEAM } from '../education-access-service';
import { EducationProgressError, EDUCATION_PROGRESS_ROUTE_SEAM } from '../education-progress-service';
import { LearnerMediaError, LEARNER_MEDIA_ROUTE_SEAM } from '../../programs/learner-media';
import { commerceFlagsOn, type ProgramCommerceHostTarget } from './commerce-host-target';
import { commerceHostTargetFromEnvironment } from './commerce-host-target-source';
import { createReviewedCommerceRuntime, type ReviewedCommerceInputs } from './reviewed-commerce-runtime';

/**
 * The consumer education API: the two route seams the education services named, served by their
 * OWN function (not the identity API, whose route table stays as it was), closed by default.
 *
 *   POST /clinical-core/consumer/education            access view, claim, exact curriculum
 *   POST /clinical-core/consumer/education/progress   read, complete, position
 *   POST /clinical-core/consumer/education/media      one lesson media slot (program-learner-media/1)
 *
 * Every request, in order: the process flags (qualification on, PHI off, production activation
 * blocked); the pinned target from this function's configuration; the route; the consumer session
 * from the request's ID token (Authorization: Bearer) AND access token (x-alp-consumer-access-token),
 * verified by the consumer session verifier (signature, claims, Cognito revocation, owner); when the
 * gateway's JWT authorizer also supplied claims, their subject must be the verified one. Then the
 * service, then the session is verified AGAIN and a reply finished for a session that ended or
 * changed meanwhile is discarded. Nothing in the body names the learner.
 *
 * Least privilege: this function reaches the database only through the runtime's API session; it
 * settles, delivers and records policy never. Its IAM role is meant to read only the API session's
 * secret, which only the hosted deployment can establish.
 */
const ROUTES = {
  [EDUCATION_ACCESS_ROUTE_SEAM.route]: 'education',
  [EDUCATION_PROGRESS_ROUTE_SEAM.route]: 'progress',
  [LEARNER_MEDIA_ROUTE_SEAM.route]: 'media',
} as const satisfies Record<string, 'education' | 'progress' | 'media'>;
export const REVIEWED_EDUCATION_API_ROUTES = Object.keys(ROUTES);
export const CONSUMER_ACCESS_TOKEN_HEADER = 'x-alp-consumer-access-token';
const MAX_BODY_BYTES = 16_384;

const reply = (statusCode: number, payload: Record<string, unknown>): ApiGatewayV2Response => ({
  statusCode,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  body: JSON.stringify(payload),
});
const refuse = (statusCode: number, code: string) => reply(statusCode, { error: { code, message: code } });
const header = (event: ApiGatewayV2Event, name: string) => {
  for (const [key, value] of Object.entries(event.headers ?? {})) if (key.toLowerCase() === name) return value;
  return undefined;
};
const same = (a: SyntheticRequestContext, b: SyntheticRequestContext) => a.actorPersonId === b.actorPersonId && a.organizationId === b.organizationId && a.identitySubject === b.identitySubject;

export type EducationApiDeps = {
  env?: Record<string, string | undefined>;
  /** For the source tests; the function's configuration otherwise. */
  target?: () => ProgramCommerceHostTarget;
  runtimeInputs?: Omit<ReviewedCommerceInputs, 'target' | 'env'>;
};

export function createReviewedEducationApiHandler(deps: EducationApiDeps = {}) {
  const env = deps.env ?? process.env;
  let composed: { pin: string; runtime: ReturnType<typeof createReviewedCommerceRuntime> } | null = null;
  const runtimeFor = (target: ProgramCommerceHostTarget) => {
    const pin = JSON.stringify(target);
    if (!composed || composed.pin !== pin) composed = { pin, runtime: createReviewedCommerceRuntime({ ...deps.runtimeInputs, target, env }) };
    return composed.runtime;
  };
  return async (event: ApiGatewayV2Event): Promise<ApiGatewayV2Response> => {
    if (!commerceFlagsOn(env)) return refuse(503, 'education_api_disabled');
    let target: ProgramCommerceHostTarget;
    try { target = (deps.target ?? (() => commerceHostTargetFromEnvironment(env)))(); } catch { return refuse(503, 'education_api_disabled'); }
    const runtime = runtimeFor(target);
    if (!runtime.learner) return refuse(503, 'education_api_disabled');
    const service = event.routeKey ? (ROUTES as Record<string, 'education' | 'progress' | 'media'>)[event.routeKey] : undefined;
    if (!service) return refuse(404, 'not_found');

    const bearer = /^Bearer ([A-Za-z0-9_.-]{20,8192})$/.exec(header(event, 'authorization') ?? '')?.[1];
    const access = header(event, CONSUMER_ACCESS_TOKEN_HEADER);
    const tokens = bearer && access ? { idToken: bearer, accessToken: access } : null;
    const verifyNow = async () => {
      const result = await runtime.learner.verify(tokens);
      if (result.state !== 'verified') return result;
      const gateway = event.requestContext?.authorizer?.jwt?.claims;
      if (gateway && gateway.sub !== result.context.identitySubject) return { state: 'refused' as const, reason: 'owner_mismatch' as const };
      return result;
    };
    const before = await verifyNow();
    if (before.state === 'unavailable') return refuse(503, 'service_unavailable');
    if (before.state !== 'verified') return refuse(401, 'consumer_signin_required');

    let body: unknown;
    try {
      const raw = event.body ?? '';
      const text = event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw;
      if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return refuse(400, 'request_invalid');
      if (!/^application\/json(?:;|$)/i.test(header(event, 'content-type') ?? '')) return refuse(400, 'request_invalid');
      body = JSON.parse(text);
    } catch { return refuse(400, 'request_invalid'); }

    let data: unknown;
    try {
      const services = runtime.learner.services();
      data = service === 'education' ? await services.education(before.context, body)
        : service === 'progress' ? await services.progress(before.context, body)
        : await services.media(before.context, body);
    } catch (error) {
      const category = error instanceof EducationAccessError || error instanceof EducationProgressError || error instanceof LearnerMediaError ? error.category : 'service_unavailable';
      const after = await verifyNow().catch(() => ({ state: 'unavailable' as const }));
      if (after.state !== 'verified' || !same(before.context, after.context)) return refuse(401, 'consumer_signin_required');
      return refuse(category === 'request_invalid' ? 400 : category === 'identity_refused' ? 403 : 503, category);
    }
    const after = await verifyNow().catch(() => ({ state: 'unavailable' as const }));
    if (after.state === 'unavailable') return refuse(503, 'service_unavailable');
    if (after.state !== 'verified' || !same(before.context, after.context)) return refuse(401, 'consumer_signin_required');
    return reply(200, { data });
  };
}
