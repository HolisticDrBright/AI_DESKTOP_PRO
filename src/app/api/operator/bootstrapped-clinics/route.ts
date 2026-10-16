import { z } from 'zod';
import { operatorRoute } from '@/server/platform-operator-upstream';
import { bootstrappedClinic, bootstrappedClinicSuspension, bootstrappedClinicSuspensionRequest } from '@/contracts/platformOperatorConsole';

/**
 * The platform operator's list of bootstrapped clinics with their recorded decisions, and suspension with a reason from
 * the closed list, through the BLOCKED operator API. Only the operator session is sent. There is no reinstatement: no
 * policy defines one, so no route offers it.
 */
const PATH = '/clinical-core/platform-operator/bootstrapped-clinics';

export function GET(request: Request) {
  return operatorRoute(request, { method: 'GET', path: PATH,
    answer: data => ({ clinics: z.object({ clinics: z.array(bootstrappedClinic).max(50) }).strict().parse(data).clinics }) });
}

export function POST(request: Request) {
  return operatorRoute(request, { method: 'POST', path: `${PATH}/suspension`, requestSchema: bootstrappedClinicSuspensionRequest,
    answer: data => bootstrappedClinicSuspension.parse(data) });
}
