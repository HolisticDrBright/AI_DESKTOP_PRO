import { readBoundedRequestBody } from '@/server/bounded-request-body';
import {
  consultIntakeRequest, parseConsultIntakeResponse,
  type ConsultIntakeRequest, type ConsultIntakeResponse,
} from '@/contracts/consultRequests';

/**
 * The unauthenticated call into the clinical API's one public route.
 *
 * There is no bearer token, because there is no account. What stands in for it is the
 * narrowness of the route and the fact that only a sealed contact envelope is ever sent:
 * this function is given a request the web tier has already sealed, and it cannot send
 * anything else, because the contract it validates against has no plaintext field.
 */
export class ConsultPublicApiError extends Error {
  constructor(readonly status: number) { super(`consult_public_${status}`); this.name = 'ConsultPublicApiError'; }
}

export function consultPublicCall(signal?: AbortSignal) {
  const requestSignal = signal ?? AbortSignal.timeout(20000);
  return async (request: ConsultIntakeRequest): Promise<ConsultIntakeResponse> => {
    const parsed = consultIntakeRequest.parse(request);
    const origin = new URL(process.env.CLINICAL_AWS_PUBLIC_API_ORIGIN ?? '');
    if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash
      || origin.username || origin.password || origin.port
      || !/^[a-z0-9]{10}\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/.test(origin.hostname)) {
      throw new ConsultPublicApiError(503);
    }
    const response = await fetch(`${origin.origin}/clinical-core/public/consult-intake`, {
      method: 'POST', redirect: 'error', cache: 'no-store', signal: requestSignal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(parsed),
    });
    if (!response.ok) throw new ConsultPublicApiError([400, 403, 409, 429].includes(response.status) ? response.status : 503);
    if (!response.headers.get('content-type')?.includes('application/json')) throw new ConsultPublicApiError(503);
    const bytes = await readBoundedRequestBody({ body: response.body, headers: response.headers, signal: requestSignal }, 100000, 20000);
    return parseConsultIntakeResponse(parsed, JSON.parse(new TextDecoder().decode(bytes)).data);
  };
}
