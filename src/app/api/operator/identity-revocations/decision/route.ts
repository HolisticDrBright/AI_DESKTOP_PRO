import { operatorRoute } from '@/server/platform-operator-upstream';
import { identityRevocationDecisionRequest, identityRevocationOutcome } from '@/contracts/platformOperatorConsole';

/**
 * A different operator's approval, decline, confirmation or dispute of an emergency login revocation, through the
 * BLOCKED operator API. A dispute is recorded and never restores the login.
 */
export function POST(request: Request) {
  return operatorRoute(request, { method: 'POST', path: '/clinical-core/platform-operator/identity-revocations/decision',
    requestSchema: identityRevocationDecisionRequest, answer: data => identityRevocationOutcome.parse(data) });
}
