if (typeof window !== 'undefined') throw new Error('reviewed education API lambda is server-only');
import { createReviewedEducationApiHandler } from './education-api';

/** Lambda entry for the consumer education API (education-api.ts). Configuration is read per request; nothing is constructed open. */
export const handler = createReviewedEducationApiHandler();
