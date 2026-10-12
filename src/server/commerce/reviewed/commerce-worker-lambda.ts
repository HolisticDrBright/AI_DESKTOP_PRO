if (typeof window !== 'undefined') throw new Error('reviewed commerce worker lambda is server-only');
import { createReviewedCommerceWorkerHandler } from './commerce-worker-entry';

/** Lambda entry for the scheduled settlement and recovery pass (commerce-worker-entry.ts), invoked by the host's schedule. */
const run = createReviewedCommerceWorkerHandler();
export const handler = async () => {
  const summary = await run();
  console.info(JSON.stringify({ event: 'program_commerce_worker_pass', ...summary }));
  return summary;
};
