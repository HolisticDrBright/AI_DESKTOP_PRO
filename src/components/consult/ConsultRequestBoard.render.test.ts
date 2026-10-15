import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToMarkup, renderToText } from '@/test-support/renderToText';
import { BOARD_COLUMNS, BoardView, type BoardState } from './ConsultRequestBoard';

/**
 * The leads board: the queue's own rows, one column per state the queue records, the program page and channel on each
 * card, and the queue's existing actions. A failed read is not an empty board. Fictional requests only.
 */
const id = (n: number) => `9b000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const request = (n: number, status: 'received' | 'accepted' | 'declined' | 'withdrawn' | 'converted', slug = 'longevity-program') => ({
  requestId: id(n), reference: `REF${String(n).padStart(5, '0')}`, slug, visitType: 'initial' as const, reasonCode: 'program_question' as const, status,
  preferredWindows: [], timeZone: 'America/Los_Angeles', receivedAt: '2026-10-10T17:00:00.000Z', decidedAt: null, declineReason: null, patientRecordId: null, connectionId: null, revision: '1',
}) as unknown as Extract<BoardState, { status: 'read' }>['requests'][number];
const board = (state: BoardState) => createElement(BoardView, { state, busy: false, problem: null, contact: null, onAct: () => {}, onOpen: () => {}, onRetry: () => {} });

describe('the leads board', () => {
  it('has exactly one column per state the queue records, in pipeline order, and none it does not record', () => {
    expect(BOARD_COLUMNS.map(c => c.status)).toEqual(['received', 'accepted', 'converted', 'declined', 'withdrawn']);
    const markup = renderToMarkup(board({ status: 'read', requests: [] }));
    for (const c of BOARD_COLUMNS) expect(markup).toContain(`data-testid="consult-board-column-${c.status}"`);
    expect(markup).not.toMatch(/consult-board-column-(contacted|scheduled)/);
    expect(renderToText(board({ status: 'read', requests: [] }))).toContain('"Contacted" and "scheduled" are not recorded by the queue');
  });
  it('puts each request in its state\'s column with the program page and channel it came from', () => {
    const requests = [request(1, 'received', 'longevity-program-email'), request(2, 'received'), request(3, 'accepted', 'diabetes-program'), request(4, 'converted'), request(5, 'declined'), request(6, 'withdrawn'), request(7, 'received', 'fictional-clinic-link')];
    const text = renderToText(board({ status: 'read', requests }));
    expect(text).toMatch(/New \(3\)/); expect(text).toMatch(/Accepted \(1\)/); expect(text).toMatch(/Chart created \(1\)/); expect(text).toMatch(/Declined \(1\)/); expect(text).toMatch(/Withdrawn \(1\)/);
    expect(text).toContain('From Longevity Program page · email');
    expect(text).toContain('From Longevity Program page · web');
    expect(text).toContain('From link fictional-clinic-link');
  });
  it('offers the queue\'s existing actions only where the queue allows them', () => {
    const markup = renderToMarkup(board({ status: 'read', requests: [request(1, 'received'), request(2, 'accepted'), request(3, 'converted'), request(4, 'declined')] }));
    const column = (status: string) => markup.split(`data-testid="consult-board-column-${status}"`)[1]!.split('data-testid="consult-board-column-')[0]!;
    expect(column('received')).toMatch(/Accept<\/button>[\s\S]*Decline as outside scope<\/button>/);
    expect(column('accepted')).toContain('Create chart and invitation');
    for (const status of ['converted', 'declined']) expect(column(status)).not.toMatch(/<button/);
  });
  it('a failed read is its own state, not an empty board; loading is a third', () => {
    const failed = renderToMarkup(board({ status: 'failed' }));
    expect(failed).toContain('data-testid="consult-board-failed"');
    expect(failed).not.toContain('consult-board-columns');
    expect(renderToText(board({ status: 'failed' }))).toContain('This is not the same as having no requests.');
    expect(renderToMarkup(board({ status: 'loading' }))).toContain('data-testid="consult-board-loading"');
  });
  it('says when the newest 200 are all that is shown', () => {
    const many = Array.from({ length: 200 }, (_, i) => request(i + 1, 'received'));
    expect(renderToMarkup(board({ status: 'read', requests: many }))).toContain('data-testid="consult-board-limit"');
  });
  it('is the same rows as the list, on the same page, and never links a request to a marketing list', () => {
    const page = readFileSync('src/app/telehealth-requests/page.tsx', 'utf8');
    expect(page).toContain('<ConsultRequestsView />');
    const source = readFileSync('src/components/consult/ConsultRequestBoard.tsx', 'utf8');
    expect(source).toContain('surface: "queue", request: { action: "list", limit: BOARD_READ_LIMIT }');
    expect(source).not.toMatch(/campaign|\/join\/|subscribe/i);
  });
});
