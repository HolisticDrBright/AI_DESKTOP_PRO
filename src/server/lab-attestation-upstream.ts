if (typeof window !== 'undefined') throw new Error('Lab attestation transport is server-only.');
import { readBoundedRequestBody } from '@/server/bounded-request-body';
import { getContractFixtureTransport } from '@/server/runtime/contractFixture';
import { labAttestationReviewActivationFromEnvironment } from '@/server/clinical-core/lab-attestation-review';
import {
  LAB_ATTESTATION_REFUSALS, labAttestationBoundReceipt, labAttestationReview,
  type LabAttestationBoundReceipt, type LabAttestationBoundRequest, type LabAttestationRefusal, type LabAttestationReview,
  type LabAttestationReviewRequest,
} from '@/contracts/labAttestationReview';

/**
 * The Desktop's one way to reach the reviewer attestation service. Disabled by default, twice over:
 *  - on a deployment, nothing leaves this process unless CLINICAL_LAB_ATTESTATION_ACTIVATION holds activation evidence
 *    naming the three reviewed lab candidates exactly (lab-attestation-review-activation/1). Without it the answer is
 *    `lab_attestation_disabled`, decided here, with no network call;
 *  - the service refuses again on its own activation rows, so evidence here is necessary and never sufficient.
 * Under the local contract fixture (loopback only, refused in any deployment) the request goes to the fixture
 * backend, which keeps its own activation switch, off at every reset.
 *
 * The service's answer is parsed with the contract before anything is returned, and must be about the reading that
 * was asked for: a view or receipt for another patient or reading is the service failing, never data to show.
 */
export type LabAttestationOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; status: 400 | 401 | 403 | 404 | 409 | 503; code: LabAttestationRefusal | 'reauth_required' | 'service_unavailable' };

const PATHS = { review: '/clinical-core/workforce/lab-attestations/review', attest: '/clinical-core/workforce/lab-attestations' } as const;
const unavailable = { ok: false, status: 503, code: 'service_unavailable' } as const;

function target(path: string): { url: string; headers: Record<string, string> } | 'disabled' | null {
  const fixture = getContractFixtureTransport();
  if (fixture) return { url: `${fixture.origin}${path}`, headers: { apikey: fixture.credential } };
  if (!labAttestationReviewActivationFromEnvironment(process.env.CLINICAL_LAB_ATTESTATION_ACTIVATION).enabled) return 'disabled';
  let origin: URL;
  try { origin = new URL(process.env.CLINICAL_AWS_WORKFORCE_API_ORIGIN ?? ''); } catch { return null; }
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password || origin.port
    || !/^[a-z0-9]{10}\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/.test(origin.hostname)) return null;
  return { url: `${origin.origin}${path}`, headers: {} };
}

async function call(path: string, body: unknown, token: string, signal?: AbortSignal): Promise<{ status: number; payload: unknown } | 'disabled' | null> {
  const to = target(path);
  if (to === 'disabled' || to === null) return to;
  let response: Response;
  try {
    response = await fetch(to.url, {
      method: 'POST', redirect: 'error', cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
      headers: { ...to.headers, authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch { return null; }
  try {
    if (!response.headers.get('content-type')?.includes('application/json')) return null;
    const bytes = await readBoundedRequestBody({ body: response.body, headers: response.headers, signal: signal ?? new AbortController().signal }, 262_144, 20_000);
    return { status: response.status, payload: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch { return null; }
}

function refusedOutcome(status: number, payload: unknown): LabAttestationOutcome<never> {
  if (status === 401) return { ok: false, status: 401, code: 'reauth_required' };
  const code = payload && typeof payload === 'object' && 'error' in payload && payload.error && typeof payload.error === 'object'
    && 'code' in payload.error ? (payload.error as { code: unknown }).code : undefined;
  // Only decided refusals in the closed vocabulary are relayed; anything else is the service being unavailable.
  if (![400, 403, 404, 409].includes(status) || !(LAB_ATTESTATION_REFUSALS as readonly unknown[]).includes(code)) return unavailable;
  return { ok: false, status: status as 400 | 403 | 404 | 409, code: code as LabAttestationRefusal };
}

export async function labAttestationReviewUpstream(request: LabAttestationReviewRequest, token: string, signal?: AbortSignal): Promise<LabAttestationOutcome<LabAttestationReview>> {
  const answer = await call(PATHS.review, request, token, signal);
  if (answer === 'disabled') return { ok: false, status: 409, code: 'lab_attestation_disabled' };
  if (answer === null) return unavailable;
  if (answer.status !== 200) return refusedOutcome(answer.status, answer.payload);
  const parsed = labAttestationReview.safeParse((answer.payload as { data?: unknown } | null)?.data);
  if (!parsed.success || parsed.data.patientRecordId !== request.patientRecordId || parsed.data.observationId !== request.observationId) return unavailable;
  return { ok: true, data: parsed.data };
}

export async function labAttestationUpstream(request: LabAttestationBoundRequest, token: string, signal?: AbortSignal): Promise<LabAttestationOutcome<LabAttestationBoundReceipt>> {
  const answer = await call(PATHS.attest, request, token, signal);
  if (answer === 'disabled') return { ok: false, status: 409, code: 'lab_attestation_disabled' };
  if (answer === null) return unavailable;
  if (answer.status !== 200) return refusedOutcome(answer.status, answer.payload);
  const parsed = labAttestationBoundReceipt.safeParse((answer.payload as { data?: unknown } | null)?.data);
  if (!parsed.success || parsed.data.patientRecordId !== request.patientRecordId || parsed.data.observationId !== request.attestation.observationId
    || parsed.data.outcome !== request.attestation.outcome) return unavailable;
  return { ok: true, data: parsed.data };
}
