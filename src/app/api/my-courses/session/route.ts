import { currentReviewedLearner } from '@/server/learner/reviewed-learner-host';
import { signInStart } from '@/server/learner/consumer-signin';

/** Start the consumer sign-in for My courses (src/server/learner/consumer-signin.ts). Without the reviewed runtime: 503 `learner_host_unavailable`. */
export const dynamic = 'force-dynamic';
export async function GET() {
  return signInStart(await currentReviewedLearner());
}
