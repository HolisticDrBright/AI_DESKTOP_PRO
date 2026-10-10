import type { ApiGatewayV2Event } from './aws-identity-api';
import { createInventoryCareMessagingHandler, type InventoryCareMessagingBuild } from './care-messaging-deployment';
declare const __INVENTORY_CARE_MESSAGING_BUILD__: InventoryCareMessagingBuild;
let cached: ReturnType<typeof createInventoryCareMessagingHandler> | undefined;
export async function handler(event: ApiGatewayV2Event) {
  cached ??= createInventoryCareMessagingHandler(process.env, __INVENTORY_CARE_MESSAGING_BUILD__);
  return cached(event);
}
