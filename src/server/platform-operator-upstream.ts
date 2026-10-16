import { NextResponse } from 'next/server';
import type { z } from 'zod';
import { readBoundedRequestBody } from '@/server/bounded-request-body';
import { sameBrowserOrigin } from '@/server/same-browser-origin';
import { DESKTOP_PLATFORM_OPERATOR_CONSOLE_RELEASE } from '@/server/platform-operator-release';
import { clearOperatorSession, readOperatorToken } from '@/server/platform-operator-session';
import { PLATFORM_OPERATOR_REFUSALS } from '@/contracts/platformOperatorConsole';

/**
 * The one way this Desktop reaches the BLOCKED platform operator API (platform-operator-console/1).
 *
 * Held by `DESKTOP_PLATFORM_OPERATOR_CONSOLE_RELEASE` before anything is read. The origin must be an API Gateway
 * execute-api host of its own (`PLATFORM_OPERATOR_API_ORIGIN`), never the applicant or workforce API. Only the operator
 * session's token (src/server/platform-operator-session.ts) is sent: never a practitioner cookie, a clinic selection or
 * a browser-named identity. Bodies are strict and bounded both ways, answers are validated and never cached, an error
 * name the contract does not list reaches the browser as `platform_operator_unavailable`, and nothing is logged.
 */
const json = (status: number, value: unknown) => NextResponse.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const PASSED = new Set([400, 401, 403, 404, 409]);
const REFUSALS = new Set<string>(PLATFORM_OPERATOR_REFUSALS);
const ORIGIN = /^[a-z0-9]{10}\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/;

export function operatorUpstreamOrigin(): string | null {
  try {
    const origin = new URL(process.env.PLATFORM_OPERATOR_API_ORIGIN ?? '');
    if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password || origin.port
      || !ORIGIN.test(origin.hostname)) return null;
    const others = [process.env.WORKFORCE_APPLICATIONS_API_ORIGIN, process.env.CLINICAL_AWS_WORKFORCE_API_ORIGIN]
      .map(value => { try { return new URL(String(value ?? '')).origin; } catch { return null; } });
    return others.includes(origin.origin) ? null : origin.origin;
  } catch { return null; }
}

export async function operatorRoute<Answer>(request: Request, input: {
  method: 'GET' | 'POST'; path: string; requestSchema?: z.ZodType; answer: (data: unknown) => Answer;
}): Promise<NextResponse> {
  if (DESKTOP_PLATFORM_OPERATOR_CONSOLE_RELEASE !== 'qualification') return json(503, { error: 'platform_operator_not_released' });
  if (input.method === 'POST' && !sameBrowserOrigin(request)) return json(403, { error: 'identity_refused' });
  const token = await readOperatorToken();
  if (!token) return json(401, { error: 'operator_sign_in_required' });
  let body: unknown = undefined;
  if (input.method === 'POST') {
    try {
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '') || request.headers.has('content-encoding')) throw new Error('invalid');
      body = input.requestSchema!.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedRequestBody(request, 1024, 5000))));
    } catch { return json(400, { error: 'request_invalid' }); }
  }
  const origin = operatorUpstreamOrigin();
  if (!origin) return json(503, { error: 'operator_service_not_configured' });
  try {
    const response = await fetch(origin + input.path, { method: input.method, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000),
      headers: { authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const bytes = await readBoundedRequestBody({ body: response.body, headers: response.headers, signal: request.signal }, 65536, 15000);
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('invalid');
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid');
    if (response.ok) return json(200, { data: input.answer(payload.data) });
    const error = typeof payload.error === 'string' && REFUSALS.has(payload.error) ? payload.error : 'platform_operator_unavailable';
    const reply = json(PASSED.has(response.status) && error !== 'platform_operator_unavailable' ? response.status : 503, { error });
    // A refused or expired operator sign-in ends the operator session on this browser; the operator signs in again.
    if (error === 'platform_operator_refused' || error === 'operator_sign_in_required') clearOperatorSession(reply);
    return reply;
  } catch { return json(503, { error: 'platform_operator_unavailable' }); }
}
