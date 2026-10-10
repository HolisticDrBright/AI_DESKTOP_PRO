import { readBoundedRequestBody } from '@/server/bounded-request-body';
import { clinicRecordWorkforceRequest, parseClinicRecordWorkforceResponse, type ClinicRecordWorkforceResponse } from '@/contracts/clinicRecordRequests';
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
  consultRetentionRequest, parseConsultRetentionResponse,
  type ConsultRetentionRequest, type ConsultRetentionResponse,
} from '@/contracts/consultRetention';
import {
  outcomeLedgerRequest, outcomeReportRequest,
  parseOutcomeLedgerResponse, parseOutcomeReportResponse,
  type OutcomeLedgerRequest, type OutcomeLedgerResponse,
  type OutcomeReportRequest, type OutcomeReportResponse,
} from '@/contracts/practiceOutcomes';
import {
  protocolCartRequest, parseProtocolCartResponse,
  type ProtocolCartRequest, type ProtocolCartResponse,
} from '@/contracts/protocolCarts';
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
  /** `code` is the Lambda's decided error word when a call chose to keep it (clinic records); absent for the other calls. */
  constructor(readonly status: number, readonly code?: string) { super(`consult_workforce_${status}`); this.name = 'ConsultWorkforceError'; }
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

/**
 * Patient clinic-record requests (copy / correction): the decided error word is
 * kept so the screen can tell a missing disclosure release or a stale revision
 * from an outage. Nothing else from the body is relayed.
 */
export const clinicRecordsWorkforceCall = (token: string, signal?: AbortSignal) => {
  const requestSignal = signal ?? AbortSignal.timeout(20000);
  return async (body: unknown): Promise<ClinicRecordWorkforceResponse> => {
    const parsed = clinicRecordWorkforceRequest.parse(body);
    const response = await fetch(`${apiOrigin().origin}/clinical-core/workforce/clinic-records`, {
      method: 'POST', redirect: 'error', cache: 'no-store', signal: requestSignal,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(parsed),
    });
    const json = response.headers.get('content-type')?.includes('application/json');
    if (!response.ok) {
      const status = [400, 401, 403, 404, 409, 429].includes(response.status) ? response.status : 503;
      let code: string | undefined;
      if (json) { try { const text = new TextDecoder().decode(await readBoundedRequestBody({ body: response.body, headers: response.headers, signal: requestSignal }, 4096, 5000)); const word = (JSON.parse(text) as { error?: unknown }).error; if (typeof word === 'string' && /^[a-z_]{3,48}$/.test(word)) code = word; } catch { /* a refusal without a readable word is still a refusal */ } }
      throw new ConsultWorkforceError(status, code);
    }
    if (!json) throw new ConsultWorkforceError(503);
    const bytes = await readBoundedRequestBody({ body: response.body, headers: response.headers, signal: requestSignal }, 400000, 20000);
    return parseClinicRecordWorkforceResponse(parsed, JSON.parse(new TextDecoder().decode(bytes)).data);
  };
};

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
/** Compiling and reading a cart from a published protocol. Nothing here delivers anything. */
export const protocolCartCall = (token: string, signal?: AbortSignal) =>
  call<ProtocolCartRequest, ProtocolCartResponse>({
    token, signal, path: '/clinical-core/workforce/protocol-carts',
    parse: body => protocolCartRequest.parse(body), bind: parseProtocolCartResponse,
  });
export const outcomeLedgerCall = (token: string, signal?: AbortSignal) =>
  call<OutcomeLedgerRequest, OutcomeLedgerResponse>({
    token, signal, path: '/clinical-core/workforce/outcome-ledger',
    parse: body => outcomeLedgerRequest.parse(body), bind: parseOutcomeLedgerResponse,
  });
/** Counts only. The suppression that makes them safe to read is in the clinic, not here. */
export const outcomeReportCall = (token: string, signal?: AbortSignal) =>
  call<OutcomeReportRequest, OutcomeReportResponse>({
    token, signal, path: '/clinical-core/workforce/outcome-report',
    parse: body => outcomeReportRequest.parse(body), bind: parseOutcomeReportResponse,
  });
/** The retention policy, and erasing an enquirer's contact details. No consumer counterpart. */
export const consultRetentionCall = (token: string, signal?: AbortSignal) =>
  call<ConsultRetentionRequest, ConsultRetentionResponse>({
    token, signal, path: '/clinical-core/workforce/consult-retention',
    parse: body => consultRetentionRequest.parse(body), bind: parseConsultRetentionResponse,
  });
