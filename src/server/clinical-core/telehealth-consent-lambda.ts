import type { ApiGatewayV2Event } from './aws-identity-api';
import { createTelehealthConsentHandler, type TelehealthConsentBuild } from './telehealth-consent-deployment';
declare const __TELEHEALTH_CONSENT_BUILD__: TelehealthConsentBuild;
let cached: ReturnType<typeof createTelehealthConsentHandler> | undefined;
export async function handler(event: ApiGatewayV2Event) {
  cached ??= createTelehealthConsentHandler(process.env, __TELEHEALTH_CONSENT_BUILD__);
  return cached(event);
}
