import { describe, expect, it } from 'vitest';
import { operatorRead } from './operator-console';

// What the operator console may say from one route's answer: a failed read is never an empty list.
const pick = (data: unknown) => Array.isArray((data as { clinics?: unknown })?.clinics) ? (data as { clinics: unknown[] }).clinics : null;

describe('operator console reads', () => {
  it('names the held, signed-out, refused and unconfigured states apart from a failure', () => {
    expect(operatorRead(503, { error: 'platform_operator_not_released' }, pick).kind).toBe('not_released');
    expect(operatorRead(503, { error: 'platform_operator_sign_in_not_released' }, pick).kind).toBe('not_released');
    expect(operatorRead(401, { error: 'operator_sign_in_required' }, pick).kind).toBe('signed_out');
    expect(operatorRead(403, { error: 'platform_operator_refused' }, pick).kind).toBe('refused');
    expect(operatorRead(503, { error: 'operator_service_not_configured' }, pick).kind).toBe('not_configured');
  });

  it('an empty list only from an answer that says so; anything else is a failure', () => {
    expect(operatorRead(200, { data: { clinics: [] } }, pick)).toEqual({ kind: 'answered', value: [] });
    for (const [status, body] of [[503, { error: 'platform_operator_unavailable' }], [200, { data: {} }], [200, null], [500, { error: 'x' }], [403, { error: 'operator_self_approval_refused' }]] as const) {
      expect(operatorRead(status, body, pick).kind).toBe('failed');
    }
  });
});
