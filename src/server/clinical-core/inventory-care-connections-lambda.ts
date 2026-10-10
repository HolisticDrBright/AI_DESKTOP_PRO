import type { ApiGatewayV2Event } from './aws-identity-api';
import { createInventoryCareConnectionsHandler, type InventoryCareConnectionsBuild } from './care-connections-deployment';
declare const __INVENTORY_CARE_CONNECTIONS_BUILD__: InventoryCareConnectionsBuild;
let cached: ReturnType<typeof createInventoryCareConnectionsHandler> | undefined;
export async function handler(event: ApiGatewayV2Event) {
  cached ??= createInventoryCareConnectionsHandler(process.env, __INVENTORY_CARE_CONNECTIONS_BUILD__);
  return cached(event);
}
