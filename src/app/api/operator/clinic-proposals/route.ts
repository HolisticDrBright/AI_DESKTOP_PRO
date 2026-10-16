import { z } from 'zod';
import { operatorRoute } from '@/server/platform-operator-upstream';
import { operatorProposal, operatorProposalDecision, operatorProposalDecisionRequest } from '@/contracts/platformOperatorConsole';

/**
 * The platform operator's review of new-clinic proposals, through the BLOCKED operator API. Only the operator session
 * (never a practitioner's) is sent. An approval is held: it creates a clinic and gives nobody patient access, and an
 * answer that says otherwise is not passed on. The browser names a request id and, to reject, a reason from the list.
 */
const PATH = '/clinical-core/platform-operator/clinic-proposals';

export function GET(request: Request) {
  return operatorRoute(request, { method: 'GET', path: PATH,
    answer: data => ({ proposals: z.object({ proposals: z.array(operatorProposal).max(50) }).strict().parse(data).proposals }) });
}

export function POST(request: Request) {
  return operatorRoute(request, { method: 'POST', path: `${PATH}/decision`, requestSchema: operatorProposalDecisionRequest,
    answer: data => {
      const decision = operatorProposalDecision.parse(data);
      if (decision.action === 'approve' && (decision.status !== 'approved' || decision.activation !== 'held')) throw new Error('not held');
      return decision;
    } });
}
