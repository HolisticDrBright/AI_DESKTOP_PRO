import type { ApiGatewayV2Event } from './aws-identity-api';
import { createRestrictedCareMessagingHandler, type CareMessagingBuild } from './care-messaging-deployment';
declare const __CARE_MESSAGING_BUILD__: CareMessagingBuild;
/** BLOCKED restricted-credential successor (qualification 112 only): see createRestrictedCareMessagingHandler. */
let cached: ReturnType<typeof createRestrictedCareMessagingHandler> | undefined;
export async function handler(event: ApiGatewayV2Event) {
  cached ??= createRestrictedCareMessagingHandler(process.env, __CARE_MESSAGING_BUILD__);
  return cached(event);
}
