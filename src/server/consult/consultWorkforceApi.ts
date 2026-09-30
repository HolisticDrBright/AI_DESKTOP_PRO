import { readBoundedRequestBody } from '@/server/bounded-request-body';
import {
  consultLinkAdminRequest, consultReviewRequest,
  parseConsultLinkAdminResponse, parseConsultReviewResponse,
  type ConsultLinkAdminRequest, type ConsultLinkAdminResponse,
  type ConsultReviewRequest, type ConsultReviewResponse,
} from '@/contracts/consultRequests';
import {
  disputeWorkforceRequest, revisionWorkforceRequest,
  parseDisputeWorkforceResponse, parseRevisionWorkforceResponse,
  type DisputeWorkforceRequest, type DisputeWorkforceResponse,
  type RevisionWorkforceRequest, type RevisionWorkforceResponse,
} from '@/contracts/clinicalDisputes';
import {
  noteTemplateAdminRequest, noteDraftingContextRequest,
  parseNoteTemplateAdminResponse, parseNoteDraftingContextResponse,
  type NoteTemplateAdminRequest, type NoteTemplateAdminResponse,
  type NoteDraftingContextRequest, type NoteDraftingContextResponse,
} from '@/contracts/noteTemplates';
import {
  intakeFormAdminRequest, intakePacketWorkforceRequest, intakePacketConsumerRequest,
  parseIntakeFormAdminResponse, parseIntakePacketWorkforceResponse, parseIntakePacketConsumerResponse,
  type IntakeFormAdminRequest, type IntakeFormAdminResponse,
  type IntakePacketWorkforceRequest, type IntakePacketWorkforceResponse,
  type IntakePacketConsumerRequest, type IntakePacketConsumerResponse,
} from '@/contracts/intakeForms';

/**
 * The authenticated calls into the clinical API for consult links, the request queue and
 * pre-visit forms.
 *
 * One origin shape is pinned for all of them, as it is for the calendar: an API Gateway host
 * on HTTPS with nothing else in the URL. A misconfigured origin is a service failure rather
 * than something to fall back from, because falling back would mean sending a patient's
 * paperwork somewhere unintended.
 */
export class ConsultWorkforceError extends Error {
  constructor(readonly status: number) { super(`consult_workforce_${status}`); this.name = 'ConsultWorkforceError'; }
}

function apiOrigin(): URL {
  const origin = new URL(process.env.CLINICAL_AWS_WORKFORCE_API_ORIGIN ?? '');
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash
    || origin.username || origin.password || origin.port
    || !/^[a-z0-9]{10}\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/.test(origin.hostname)) {
    throw new ConsultWorkforceError(503);
  }
  return origin;
}

function call<Request, Response>(input: {
  token: string; signal?: AbortSignal; path: string;
  parse: (body: unknown) => Request; bind: (request: Request, raw: unknown) => Response;
}) {
  const requestSignal = input.signal ?? AbortSignal.timeout(20000);
  return async (body: unknown): Promise<Response> => {
    const parsed = input.parse(body);
    const response = await fetch(`${apiOrigin().origin}${input.path}`, {
      method: 'POST', redirect: 'error', cache: 'no-store', signal: requestSignal,
      headers: { authorization: `Bearer ${input.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(parsed),
    });
    if (!response.ok) throw new ConsultWorkforceError([400, 401, 403, 409, 429].includes(response.status) ? response.status : 503);
    if (!response.headers.get('content-type')?.includes('application/json')) throw new ConsultWorkforceError(503);
    const bytes = await readBoundedRequestBody({ body: response.body, headers: response.headers, signal: requestSignal }, 400000, 20000);
    return input.bind(parsed, JSON.parse(new TextDecoder().decode(bytes)).data);
  };
}

export const consultLinkCall = (token: string, signal?: AbortSignal) =>
  call<ConsultLinkAdminRequest, ConsultLinkAdminResponse>({
    token, signal, path: '/clinical-core/workforce/consult-links',
    parse: body => consultLinkAdminRequest.parse(body), bind: parseConsultLinkAdminResponse,
  });
export const consultReviewCall = (token: string, signal?: AbortSignal) =>
  call<ConsultReviewRequest, ConsultReviewResponse>({
    token, signal, path: '/clinical-core/workforce/consult-requests',
    parse: body => consultReviewRequest.parse(body), bind: parseConsultReviewResponse,
  });
export const intakeFormCall = (token: string, signal?: AbortSignal) =>
  call<IntakeFormAdminRequest, IntakeFormAdminResponse>({
    token, signal, path: '/clinical-core/workforce/intake-forms',
    parse: body => intakeFormAdminRequest.parse(body), bind: parseIntakeFormAdminResponse,
  });
export const intakePacketCall = (token: string, signal?: AbortSignal) =>
  call<IntakePacketWorkforceRequest, IntakePacketWorkforceResponse>({
    token, signal, path: '/clinical-core/workforce/intake-packets',
    parse: body => intakePacketWorkforceRequest.parse(body), bind: parseIntakePacketWorkforceResponse,
  });
/** The patient's own packet calls, for a consumer session rather than a practitioner's. */
export const intakePacketConsumerCall = (token: string, signal?: AbortSignal) =>
  call<IntakePacketConsumerRequest, IntakePacketConsumerResponse>({
    token, signal, path: '/clinical-core/consumer/intake-packets',
    parse: body => intakePacketConsumerRequest.parse(body), bind: parseIntakePacketConsumerResponse,
  });

export const disputeQueueCall = (token: string, signal?: AbortSignal) =>
  call<DisputeWorkforceRequest, DisputeWorkforceResponse>({
    token, signal, path: '/clinical-core/workforce/disputes',
    parse: body => disputeWorkforceRequest.parse(body), bind: parseDisputeWorkforceResponse,
  });
export const revisionNoticeCall = (token: string, signal?: AbortSignal) =>
  call<RevisionWorkforceRequest, RevisionWorkforceResponse>({
    token, signal, path: '/clinical-core/workforce/content-revisions',
    parse: body => revisionWorkforceRequest.parse(body), bind: parseRevisionWorkforceResponse,
  });
export const noteTemplateCall = (token: string, signal?: AbortSignal) =>
  call<NoteTemplateAdminRequest, NoteTemplateAdminResponse>({
    token, signal, path: '/clinical-core/workforce/note-templates',
    parse: body => noteTemplateAdminRequest.parse(body), bind: parseNoteTemplateAdminResponse,
  });
/** What drafting is handed: the published template, the house style, and what context it may see. */
export const noteDraftingContextCall = (token: string, signal?: AbortSignal) =>
  call<NoteDraftingContextRequest, NoteDraftingContextResponse>({
    token, signal, path: '/clinical-core/workforce/note-drafting-context',
    parse: body => noteDraftingContextRequest.parse(body), bind: parseNoteDraftingContextResponse,
  });
