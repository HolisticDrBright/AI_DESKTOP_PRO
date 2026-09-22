/**
 * Operator tools say why a run stopped; they never repeat what it was carrying. A thrown error's message is written by
 * whoever threw it — a driver can put a failing statement, and with it parameter values, into that string. The cloud
 * agreement asks for the highest level of audit logging and the maximum retention of logs; the model vendor's terms
 * forbid holding protected information as a designated record set. Both hold at once only if logs carry codes and
 * identifiers rather than bodies, so narrowing an unknown error to a code shape happens in one place and is tested.
 */
export const LOG_SAFE_CODE = /^[a-z0-9_:.-]{1,200}$/;

/** The error's own message when it is a code, otherwise the caller's fallback code. Never free text. */
export function errorCode(error: unknown, fallback: string): string {
  return error instanceof Error && LOG_SAFE_CODE.test(error.message) ? error.message : fallback;
}
