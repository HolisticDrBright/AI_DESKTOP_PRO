import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import { renderToText } from '@/test-support/renderToText';

import { ClinicRecordRequestsView, type ClinicRecordQueueState, type ClinicRecordReview } from './ClinicRecordRequestsView';

/**
 * The practitioner's view of patient record requests. What it must never do:
 * show a submitted request as fulfilled, hide what a copy excluded, present a
 * missing disclosure release as an outage, or offer a decision on a settled request.
 */
const uuid = (n: number) => 'c0000000-0000-4000-8000-' + String(n).padStart(12, '0');
const request = (over: Record<string, unknown> = {}) => ({
  requestId: uuid(1), kind: 'copy' as const, status: 'submitted' as const, revision: 1, sections: ['signed_notes', 'correspondence'] as never,
  subject: null, reasonCode: null, statement: null, submittedAt: '2026-10-10T10:00:00.000Z', updatedAt: '2026-10-10T10:00:00.000Z',
  decidedAt: null, decisionReasonCode: null, decisionReason: null, fulfillmentId: null, supersededBy: null, outcome: null, patientRecordId: uuid(2), ...over,
});
const review = (over: Partial<ClinicRecordReview> = {}): ClinicRecordReview => ({
  action: 'review', request: request() as never, events: [{ seq: 1, action: 'submitted', actorPool: 'consumer', fromStatus: null, toStatus: 'submitted', reasonCode: null, reason: null, decisionId: null, detail: {}, at: '2026-10-10T10:00:00.000Z' }],
  preview: [{ section: 'signed_notes', readable: true, exclusionReason: null, includable: 2, excluded: { unsigned_not_disclosable: 1 } },
    { section: 'correspondence', readable: false, exclusionReason: 'available_through_care_message_export', includable: 0, excluded: {} }],
  subjectNote: null, release: null, copy: null, ...over,
});
const view = (over: Partial<ClinicRecordQueueState> = {}) => createElement(ClinicRecordRequestsView, {
  state: { requests: [], review: null, busy: false, error: null, onRefresh: () => {}, onOpen: () => {}, onBeginReview: () => {}, onFulfill: () => {}, onRefuse: () => {}, onAmend: () => {}, onDecline: () => {}, ...over } as ClinicRecordQueueState,
});

describe('patient record requests, as the practice sees them', () => {
  it('distinguishes loading, empty and a waiting request; a submitted request is not called fulfilled', () => {
    expect(renderToText(view({ requests: null }))).toContain('Loading patient record requests');
    expect(renderToText(view({ requests: [] }))).toContain('No patient is waiting');
    const text = renderToText(view({ requests: [request() as never] }));
    expect(text).toContain('Copy of clinic records'); expect(text).toContain('Submitted — not yet reviewed');
    expect(text).toContain('Signed visit notes and their addenda'); expect(text).not.toContain('Fulfilled');
  });
  it('shows what a copy would include and exclude, and refuses to offer preparation without a disclosure release', () => {
    const text = renderToText(view({ requests: [request() as never], review: review() }));
    expect(text).toContain('2 to include'); expect(text).toContain('1 unsigned not disclosable');
    expect(text).toContain('Messages with the clinic: not readable here (available through care message export)');
    expect(text).toContain('No reviewed disclosure release is registered');
    const released = renderToText(view({ requests: [request() as never], review: review({ release: { releaseVersion: 'fictional-review-1', sections: ['signed_notes'], approvedAt: '2026-10-10T00:00:00.000Z' } }) }));
    expect(released).toContain('Disclosure release fictional-review-1 covers: Signed visit notes and their addenda');
    expect(released).toContain('Prepare the copy under the release');
  });
  it('names a missing release as a decided refusal, not an outage, and reports a prepared copy with its exclusions', () => {
    expect(renderToText(view({ error: 'disclosure_release_required' }))).toContain('No reviewed disclosure release covers these sections');
    expect(renderToText(view({ error: 'service_unavailable' }))).toContain('Nothing was decided');
    const fulfilled = request({ status: 'fulfilled', outcome: 'copy_delivered', revision: 3, decidedAt: '2026-10-10T11:00:00.000Z' });
    const text = renderToText(view({ requests: [fulfilled as never], review: review({ request: fulfilled as never, copy: { copyId: uuid(9), asOf: '2026-10-10T11:00:00.000Z', itemCount: 2, byteTotal: 4096,
      manifest: { contract: 'clinic-record-copy/1', copyId: uuid(9), requestId: uuid(1), asOf: '2026-10-10T11:00:00.000Z', consistency: 'snapshot_at_fulfillment', releaseVersion: 'fictional-review-1',
        sections: [{ section: 'signed_notes', included: true, itemCount: 2, byteTotal: 4096, omittedCount: 0, exclusionReason: null, excluded: { unsigned_not_disclosable: 1 } },
          { section: 'correspondence', included: false, itemCount: 0, byteTotal: 0, omittedCount: 0, exclusionReason: 'available_through_care_message_export', excluded: {} }],
        coverage: { completeClinicRecord: false, notIncluded: ['chart drafts and unsigned notes'] } } } }) }));
    expect(text).toContain('Decided and closed (1)'); expect(text).toContain('Fulfilled · copy delivered');
    expect(text).toContain('Copy prepared 2026-10-10T11:00:00.000Z: 2 records, 4096 bytes, release fictional-review-1. Excluded: Messages with the clinic (available_through_care_message_export).');
    expect(text).not.toContain('Prepare the copy under the release');
  });
  it('shows a correction with the patient’s words and the note it targets, offering only append-only acceptance or decline', () => {
    const correction = request({ kind: 'correction', sections: [], subject: { kind: 'clinical_note', id: uuid(5), revision: 1 }, reasonCode: 'not_true_of_me', statement: 'I never had this.' });
    const text = renderToText(view({ requests: [correction as never], review: review({ request: correction as never, preview: null, subjectNote: { noteId: uuid(5), status: 'signed', currentVersion: 1, signedAt: '2026-10-09T00:00:00.000Z', addenda: 0 } }) }));
    expect(text).toContain('Correction of a signed note'); expect(text).toContain('Not true of them: “I never had this.”');
    expect(text).toContain('Accepting adds an addendum; the signed text is never rewritten');
    expect(text).toContain('Accept: add an addendum'); expect(text).toContain('Decline: record stands');
    expect(text).not.toContain('Prepare the copy'); expect(text).not.toMatch(/delete (the|this) (record|note)|erase/i);
  });
});
