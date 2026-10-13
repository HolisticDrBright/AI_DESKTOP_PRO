import { currentReviewedLearner } from '@/server/learner/reviewed-learner-host';
import { signInCallback } from '@/server/learner/consumer-signin';

/** The hosted sign-in's return: state checked, code exchanged, tokens verified before any cookie is set (src/server/learner/consumer-signin.ts). */
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  return signInCallback(request, await currentReviewedLearner());
}
