import { timingSafeEqual } from 'node:crypto';
import { LEAD_CONSENT_VERSION, LEAD_PROGRAMS, leadSignupForm, type LeadProgram } from '@/contracts/leadCampaigns';
import { leadUserId, openSignup, sealSignup } from './signup-token';
import { PAGE_HEADERS, checkEmailPage, confirmPage, confirmationEmail, confirmedPage, linkProblemPage, sendFailedPage, signupPage, unavailablePage } from './pages';
import type { CampaignDirectory } from './dittofeed';

/**
 * The campaign service's own public surface, beside Dittofeed and outside the Desktop web tier:
 *
 *   GET  /signup/<program>   the form (address, optional first name, unticked consent box)
 *   POST /signup             validates, emails a confirmation link; same page for every valid address
 *   GET  /confirm?t=…        a page with a button (opening the link changes nothing)
 *   POST /confirm            the button: subscribes the person to that program's opt-in list
 *   GET  /internal/counts    counts only, for the Desktop's Campaigns screen, behind a bearer token
 *
 * Bounces and complaints arrive separately (bounces.ts): an SNS-subscribed function, not an HTTP route.
 *
 * It holds no list of its own and has no credentials for, or network path to, the clinical API.
 */
export type ServiceRequest = { method: string; path: string; query: URLSearchParams; form: URLSearchParams | null; authorization: string | null };
export type ServiceResponse = { status: number; headers: Record<string, string>; body: string };
export interface ConfirmationMailer { send(message: { to: string; subject: string; text: string }): Promise<boolean> }
export type LeadSignupConfig = {
  publicOrigin: string; linkKey: Buffer; idKey: Buffer; statsToken: string; senderName: string; mailingAddress: string;
};

const html = (status: number, body: string): ServiceResponse => ({ status, headers: { ...PAGE_HEADERS }, body });
const json = (status: number, value: unknown): ServiceResponse => ({ status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(value) });
const notFound = (): ServiceResponse => ({ status: 404, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' }, body: 'Not found' });
function bearerMatches(header: string | null, token: string) {
  const given = Buffer.from(/^Bearer (.+)$/.exec(header ?? '')?.[1] ?? ''), expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function createLeadSignupService(deps: { config: LeadSignupConfig; directory: CampaignDirectory; mailer: ConfirmationMailer; now?: () => number }) {
  const now = deps.now ?? Date.now;
  const { config } = deps;
  return async function handle(request: ServiceRequest): Promise<ServiceResponse> {
    const signupMatch = /^\/signup\/([a-z-]{1,60})$/.exec(request.path);
    if (request.method === 'GET' && signupMatch) {
      const program = signupMatch[1] as LeadProgram;
      return LEAD_PROGRAMS.includes(program) ? html(200, signupPage(program)) : notFound();
    }
    if (request.method === 'POST' && request.path === '/signup') {
      const form = request.form ?? new URLSearchParams();
      const raw = { email: form.get('email') ?? '', firstName: form.get('firstName') ?? '', program: form.get('program') ?? '', ...(form.has('consent') ? { consent: form.get('consent') } : {}) };
      const parsed = leadSignupForm.safeParse(raw);
      if (!parsed.success) {
        const program = LEAD_PROGRAMS.includes(raw.program as LeadProgram) ? raw.program as LeadProgram : null;
        return program ? html(400, signupPage(program, 'invalid')) : notFound();
      }
      const token = sealSignup(config.linkKey, { email: parsed.data.email, firstName: parsed.data.firstName, program: parsed.data.program, consentVersion: LEAD_CONSENT_VERSION, issuedAt: now() });
      const message = confirmationEmail({ program: parsed.data.program, firstName: parsed.data.firstName, confirmUrl: `${config.publicOrigin}/confirm?t=${token}`,
        senderName: config.senderName, mailingAddress: config.mailingAddress });
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
    if (request.method === 'GET' && request.path === '/internal/counts') {
      if (!bearerMatches(request.authorization, config.statsToken)) return json(401, { error: 'unauthorized' });
      try { return json(200, await deps.directory.counts()); } catch { return json(503, { error: 'campaign_directory_unavailable' }); }
    }
    return notFound();
  };
}
