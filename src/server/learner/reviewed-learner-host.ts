if (typeof window !== 'undefined') throw new Error('learner/reviewed-learner-host is server-only.');
import type { LearnerMediaReply } from '../../contracts/programLearnerMedia';
import type { SyntheticRequestContext } from '../clinical-core/aws-identity-consent';
import type { EducationAccessResponse } from '../commerce/education-access-service';
import type { EducationProgressResponse } from '../commerce/education-progress-service';
import type { ConsumerSessionVerifier } from './consumer-session';
import type { LearnerHost } from './learner-host';

/**
 * The reviewed learner host: identity from a verified consumer session in two HttpOnly cookies the
 * Desktop's own consumer sign-in sets (api/my-courses/session), and the existing education services
 * of the reviewed commerce runtime. Everything is resolved per request: when the bootstrap's
 * resolver says the runtime is not open now (flags changed, target missing or altered), there is no
 * identity and no service, and the route answers as it does with no host.
 *
 *   identify   both cookies, verified by the consumer session verifier (signature, claims, Cognito
 *              revocation and owner checks on every call). A refused session is no identity; an
 *              unreachable identity service is an error the route reports as unavailable, never
 *              "signed out" and never a remembered earlier answer.
 *   services   the runtime's access and progress services, which repeat their own consumer-pool,
 *              synthetic-boundary and activation-evidence checks.
 */
export const CONSUMER_ID_COOKIE = '__Host-alp_learner_id';
export const CONSUMER_ACCESS_COOKIE = '__Host-alp_learner_access';
export const CONSUMER_SIGNIN_COOKIE = '__Host-alp_learner_signin';

export type ReviewedLearnerRuntime = {
  verify: ConsumerSessionVerifier;
  services: () => {
    education: (context: SyntheticRequestContext, body: unknown) => Promise<EducationAccessResponse>;
    progress: (context: SyntheticRequestContext, body: unknown) => Promise<EducationProgressResponse>;
    media?: (context: SyntheticRequestContext, body: unknown) => Promise<LearnerMediaReply>;
  };
  /** The pool's hosted sign-in, the app client and this Desktop's origin, from the verified target. */
  consumer: { poolId: string; clientId: string; signInOrigin: string; desktopOrigin: string };
};
export type ReviewedLearnerResolver = () => Promise<ReviewedLearnerRuntime | null>;

export class LearnerIdentityUnavailable extends Error { constructor() { super('learner_identity_unavailable'); this.name = 'LearnerIdentityUnavailable'; } }

export function cookieValue(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

export function sessionTokensFrom(request: Request): { idToken: string; accessToken: string } | null {
  const idToken = cookieValue(request, CONSUMER_ID_COOKIE), accessToken = cookieValue(request, CONSUMER_ACCESS_COOKIE);
  return idToken && accessToken ? { idToken, accessToken } : null;
}

export function createReviewedLearnerHost(resolve: ReviewedLearnerResolver): LearnerHost {
  const current = async () => {
    const runtime = await resolve().catch(() => null);
    if (!runtime) throw new LearnerIdentityUnavailable();
    return runtime;
  };
  return {
    kind: 'reviewed',
    async identify(request) {
      const runtime = await current();
      const result = await runtime.verify(sessionTokensFrom(request));
      if (result.state === 'unavailable') throw new LearnerIdentityUnavailable();
      return result.state === 'verified' ? result.context : null;
    },
    services() {
      return {
        education: async (context, body) => (await current()).services().education(context as SyntheticRequestContext, body),
        progress: async (context, body) => (await current()).services().progress(context as SyntheticRequestContext, body),
        media: async (context, body) => {
          const media = (await current()).services().media;
          // A runtime composed without learner media answers held, never a read.
          return media ? media(context as SyntheticRequestContext, body) : { outcome: 'held' };
        },
      };
    },
  };
}

const KEY = Symbol.for('alp.learner.reviewed-resolver');
const holder = globalThis as unknown as Record<symbol, ReviewedLearnerResolver | undefined>;
/** Set once by the reviewed bootstrap, alongside the learner host it installs; the sign-in routes read the same runtime. */
export function setReviewedLearnerResolver(resolve: ReviewedLearnerResolver): void {
  if (holder[KEY]) throw new Error('reviewed_learner_already_installed');
  holder[KEY] = resolve;
}
/** The reviewed learner runtime for this request, or null: no bootstrap, or not open now. */
export async function currentReviewedLearner(): Promise<ReviewedLearnerRuntime | null> {
  const resolve = holder[KEY];
  if (!resolve) return null;
  return resolve().catch(() => null);
}
export function __resetReviewedLearner(): void { holder[KEY] = undefined; }
