import { timingSafeEqual } from 'node:crypto';
import { LEAD_CONSENT_VERSION, LEAD_PROGRAMS, leadSignupForm, type LeadProgram } from '@/contracts/leadCampaigns';
import { leadUserId, openSignup, sealSignup } from './signup-token';
import { PAGE_HEADERS, checkEmailPage, closedPage, confirmPage, confirmationEmail, confirmedPage, linkProblemPage, sendFailedPage, signupPage, unavailablePage } from './pages';
import type { CampaignDirectory } from './dittofeed';
import type { CampaignSendReadiness } from './send-settings';

/**
 * The campaign service's own public surface, beside Dittofeed and outside the Desktop web tier:
 *
 *   GET  /signup/<program>   the form (address, optional first name, unticked consent box)
 *   POST /signup             validates, emails a confirmation link; same page for every valid address
 *   GET  /confirm?t=…        a page with a button (opening the link changes nothing)
 *   POST /confirm            the button: subscribes the person to that program's opt-in list
 *   GET  /internal/counts    counts only, for the Desktop's Campaigns screen, behind a bearer token
 *   GET  /healthz            the load balancer's check; says nothing but that the process answers
 *
 * While the sending settings are incomplete (send-settings.ts), the sign-up page says sign-ups are not open
 * and a submitted form sends nothing: the confirmation email is the only thing this service ever sends,
 * and it is refused exactly like a campaign would be. The counts endpoint names the missing settings.
 *
 * Bounces and complaints arrive separately (bounces.ts): an SNS-subscribed function, not an HTTP route.
 *
 * It holds no list of its own and has no credentials for, or network path to, the clinical API.
 */
export type ServiceRequest = { method: string; path: string; query: URLSearchParams; form: URLSearchParams | null; authorization: string | null };
export type ServiceResponse = { status: number; headers: Record<string, string>; body: string };
export interface ConfirmationMailer { send(message: { to: string; subject: string; text: string }): Promise<boolean> }
export type LeadSignupConfig = { publicOrigin: string; linkKey: Buffer; idKey: Buffer; statsToken: string };

const html = (status: number, body: string): ServiceResponse => ({ status, headers: { ...PAGE_HEADERS }, body });
const json = (status: number, value: unknown): ServiceResponse => ({ status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(value) });
const notFound = (): ServiceResponse => ({ status: 404, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' }, body: 'Not found' });
function bearerMatches(header: string | null, token: string) {
  const given = Buffer.from(/^Bearer (.+)$/.exec(header ?? '')?.[1] ?? ''), expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function createLeadSignupService(deps: { config: LeadSignupConfig; sending: CampaignSendReadiness; directory: CampaignDirectory; mailer: ConfirmationMailer; now?: () => number }) {
  const now = deps.now ?? Date.now;
  const { config, sending } = deps;
  return async function handle(request: ServiceRequest): Promise<ServiceResponse> {
    const signupMatch = /^\/signup\/([a-z-]{1,60})$/.exec(request.path);
    if (request.method === 'GET' && signupMatch) {
      const program = signupMatch[1] as LeadProgram;
      if (!LEAD_PROGRAMS.includes(program)) return notFound();
      return sending.ready ? html(200, signupPage(program)) : html(503, closedPage(program));
    }
    if (request.method === 'POST' && request.path === '/signup') {
      const form = request.form ?? new URLSearchParams();
      if (!sending.ready) {
        const asked = form.get('program') ?? '';
        return LEAD_PROGRAMS.includes(asked as LeadProgram) ? html(503, closedPage(asked as LeadProgram)) : notFound();
      }
      const raw = { email: form.get('email') ?? '', firstName: form.get('firstName') ?? '', program: form.get('program') ?? '', ...(form.has('consent') ? { consent: form.get('consent') } : {}) };
      const parsed = leadSignupForm.safeParse(raw);
      if (!parsed.success) {
        const program = LEAD_PROGRAMS.includes(raw.program as LeadProgram) ? raw.program as LeadProgram : null;
        return program ? html(400, signupPage(program, 'invalid')) : notFound();
      }
      const token = sealSignup(config.linkKey, { email: parsed.data.email, firstName: parsed.data.firstName, program: parsed.data.program, consentVersion: LEAD_CONSENT_VERSION, issuedAt: now() });
      const message = confirmationEmail({ program: parsed.data.program, firstName: parsed.data.firstName, confirmUrl: `${config.publicOrigin}/confirm?t=${token}`,
        senderName: sending.values.fromName, mailingAddress: sending.values.mailingAddress });
      const sent = await deps.mailer.send({ to: parsed.data.email, ...message }).catch(() => false);
      return sent ? html(200, checkEmailPage()) : html(503, sendFailedPage());
    }
    if (request.method === 'GET' && request.path === '/confirm') {
      const token = request.query.get('t') ?? '';
      const opened = openSignup(config.linkKey, token, now());
      return opened.ok ? html(200, confirmPage(token, opened.pending.program)) : html(400, linkProblemPage(opened.reason));
    }
    if (request.method === 'POST' && request.path === '/confirm') {
      const opened = openSignup(config.linkKey, request.form?.get('t') ?? '', now());
      if (!opened.ok) return html(400, linkProblemPage(opened.reason));
      const { pending } = opened;
      try {
        await deps.directory.confirm({ userId: leadUserId(config.idKey, pending.email), email: pending.email, firstName: pending.firstName, program: pending.program,
          consentVersion: pending.consentVersion, confirmedAt: new Date(now()).toISOString() });
      } catch { return html(503, unavailablePage()); }
      return html(200, confirmedPage(pending.program));
    }
    if (request.method === 'GET' && request.path === '/healthz') return { status: 200, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' }, body: 'ok' };
    if (request.method === 'GET' && request.path === '/internal/counts') {
      if (!bearerMatches(request.authorization, config.statsToken)) return json(401, { error: 'unauthorized' });
      const readiness = { ready: sending.ready, missing: sending.missing };
      try { return json(200, { ...await deps.directory.counts(), sending: readiness }); } catch { return json(503, { error: 'campaign_directory_unavailable', sending: readiness }); }
    }
    return notFound();
  };
}
