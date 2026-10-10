import type { ApiGatewayV2Event } from './aws-identity-api';
import { createClinicRecordsHandler, type ClinicRecordsBuild } from './clinic-records-deployment';
declare const __CLINIC_RECORDS_BUILD__: ClinicRecordsBuild;
let cached: ReturnType<typeof createClinicRecordsHandler> | undefined;
export async function handler(event: ApiGatewayV2Event) {
  cached ??= createClinicRecordsHandler(process.env, __CLINIC_RECORDS_BUILD__);
  return cached(event);
}
