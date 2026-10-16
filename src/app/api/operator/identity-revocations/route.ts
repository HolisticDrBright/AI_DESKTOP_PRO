import { z } from 'zod';
import { operatorRoute } from '@/server/platform-operator-upstream';
import { identityRevocationOutcome, identityRevocationRequest, identityRevocationSummary } from '@/contracts/platformOperatorConsole';

/**
 * The platform operator's emergency revocation of one practitioner's LOGIN, through the BLOCKED operator API: the
 * revocations that still need an independent operator or a confirmed provider sign-out, and a new reasoned decision.
 * Only the operator session is sent, never a practitioner's. It disables the login in every clinic and changes no
 * clinic, membership or patient record. There is no restore here.
 */
const PATH = '/clinical-core/platform-operator/identity-revocations';

export function GET(request: Request) {
  return operatorRoute(request, { method: 'GET', path: PATH,
    answer: data => ({ revocations: z.object({ revocations: z.array(identityRevocationSummary).max(200) }).strict().parse(data).revocations }) });
}

export function POST(request: Request) {
  return operatorRoute(request, { method: 'POST', path: PATH, requestSchema: identityRevocationRequest, answer: data => identityRevocationOutcome.parse(data) });
}
