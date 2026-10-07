import type { ApiGatewayV2Event } from './aws-identity-api';
import { createCareConnectionsHandler, type CareConnectionsBuild } from './care-connections-deployment';

declare const __CARE_CONNECTIONS_BUILD__: CareConnectionsBuild;
let cached: ReturnType<typeof createCareConnectionsHandler> | undefined;
export async function handler(event: ApiGatewayV2Event) {
  cached ??= createCareConnectionsHandler(process.env, __CARE_CONNECTIONS_BUILD__);
  return cached(event);
}
