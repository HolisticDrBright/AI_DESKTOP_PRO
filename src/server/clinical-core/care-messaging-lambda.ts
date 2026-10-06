import type { ApiGatewayV2Event } from './aws-identity-api';
import { createCareMessagingHandler, type CareMessagingBuild } from './care-messaging-deployment';
declare const __CARE_MESSAGING_BUILD__: CareMessagingBuild;
let cached: ReturnType<typeof createCareMessagingHandler> | undefined;
export async function handler(event: ApiGatewayV2Event) {
  cached ??= createCareMessagingHandler(process.env, __CARE_MESSAGING_BUILD__);
  return cached(event);
}
