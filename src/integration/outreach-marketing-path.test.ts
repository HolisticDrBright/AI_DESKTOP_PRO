import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createElement } from 'react';

/**
 * The marketing side, end to end, with every external service faked at its boundary: the campaign engine's own HTTP
 * handler (in-memory store, fake SES) behind its API origin, the clinical API's public consult intake behind its
 * origin, and the SES SDK the consult route sends through. Everything between is the real code: the middleware, the
 * program page's links, the /join page, the Desktop's campaign routes, the engine, the consult route and the queue's
 * counts. The program page is a fictional published copy built in this test; no definition in the repository is
 * published. Fictional people, addresses and clinics only.
 */
const { sesSend } = vi.hoisted(() => ({ sesSend: vi.fn() }));
vi.mock('@aws-sdk/client-sesv2', async original => ({ ...await original<typeof import('@aws-sdk/client-sesv2')>(), SESv2Client: class SESv2Client { send = sesSend; } }));
vi.mock('@aws-sdk/client-secrets-manager', async original => ({ ...await original<typeof import('@aws-sdk/client-secrets-manager')>(), SecretsManagerClient: class SecretsManagerClient {} }));
vi.mock('@/server/consult/consultContactKey', () => ({ ConsultKeyError: class ConsultKeyError extends Error {}, createConsultContactKeyResolver: () => async () => Buffer.alloc(32, 7) }));
vi.mock('@/app/api/live/route-helpers', async original => ({ ...await original<typeof import('@/app/api/live/route-helpers')>(), liveGuard: () => null }));

import { middleware } from '@/middleware';
import { fictionalEngine, tokenFrom } from '@/campaigns/testing';
import { FORM_MIN_MS } from '@/campaigns/public';
import type { WorkforceResponse } from '@/campaigns/contract';
import { allFunnels, funnelChannelFrom, funnelDefinition, funnelSourceOf, type FunnelDefinition } from '@/funnels';
import { longevityProgram } from '@/funnels/definitions/longevity-program';
import { marketingSignupDirectory } from '@/funnels/marketingSignup';
import { funnelPageLinks } from '@/lib/funnelPageLinks';
import { funnelRequestCounts } from '@/components/funnels/funnelRequestCounts';
import { FunnelPage } from '@/components/funnels/FunnelPage';
import { unavailable } from '@/contracts/programOffers';
import { renderToMarkup } from '@/test-support/renderToText';
import JoinPage from '@/app/join/[practice]/[program]/page';
import { POST as joinRoute } from '@/app/api/public/campaigns/join/route';
import { POST as confirmRoute } from '@/app/api/public/campaigns/confirm/route';
import { POST as consultRoute } from '@/app/api/public/consult/route';

const SITE = 'https://clinic.fictional.example';
const HOST = 'clinic.fictional.example';
const CAMPAIGN_API = 'https://abcdefghij.execute-api.us-east-2.amazonaws.com';
const CLINICAL_PUBLIC_API = 'https://klmnopqrst.execute-api.us-east-2.amazonaws.com';
const PRACTICE = '11111111-1111-4111-8111-111111111111';
const ADMIN = { practiceId: PRACTICE, personId: '21111111-1111-4111-8111-111111111111', email: 'admin@fictional-clinic.example', name: 'Fictional Admin' };
const VISITOR = 'avery.fictional@example.test';
const ENV = {
  CAMPAIGN_ENGINE_ENABLED: 'true', CAMPAIGN_API_ORIGIN: CAMPAIGN_API, FUNNEL_PRACTICE_SLUG: 'fictional-clinic', NEXT_PUBLIC_SITE_ORIGIN: SITE,
  CLINICAL_AWS_PUBLIC_API_ORIGIN: CLINICAL_PUBLIC_API, CONSULT_ENQUIRER_EMAILS_ENABLED: 'true', CONSULT_ENQUIRER_SENDER: 'Fictional Clinic <hello@clinic.fictional.example>',
  CONSULT_ENQUIRER_CONFIGURATION_SET: 'alp-transactional', CONSULT_ENQUIRER_CONTACT_LINE: 'call (555) 010-0000 during office hours',
};

/** The program page as it would be once Brandon publishes it: a fictional copy, validated by the real schema. */
const publishedLongevity: FunnelDefinition = funnelDefinition.parse({
  ...longevityProgram, status: 'published', draftNote: null,
  approval: { by: 'Fictional Approver', on: '2026-10-15', attorneyReview: false },
  sections: longevityProgram.sections.map(section => section.kind === 'what-is-included'
    ? { kind: 'what-is-included', heading: section.heading, source: 'published_program', items: ['Fictional phase one lessons', 'Fictional practitioner check-ins'] }
    : section),
});

/** The engine's HTTP API as API Gateway would invoke it: route templates, decoded path parameters, no authorizer on public routes. */
function campaignApiGateway(engine: ReturnType<typeof fictionalEngine>) {
  const routes: Array<[string, RegExp, string, string[]]> = [
    ['GET', /^\/campaigns\/public\/join\/([^/]+)\/([^/]+)$/, 'GET /campaigns/public/join/{practice}/{program}', ['practice', 'program']],
    ['GET', /^\/campaigns\/public\/signup-open\/([^/]+)\/([^/]+)$/, 'GET /campaigns/public/signup-open/{practice}/{program}', ['practice', 'program']],
    ['POST', /^\/campaigns\/public\/join$/, 'POST /campaigns/public/join', []],
    ['POST', /^\/campaigns\/public\/confirm$/, 'POST /campaigns/public/confirm', []],
    ['POST', /^\/campaigns\/public\/unsubscribe$/, 'POST /campaigns/public/unsubscribe', []],
  ];
  return async (url: URL, init: RequestInit) => {
    for (const [method, pattern, routeKey, names] of routes) {
      const match = pattern.exec(url.pathname);
      if (!match || (init.method ?? 'GET') !== method) continue;
      const reply = await engine.http({ routeKey, pathParameters: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(match[i + 1]!)])), body: typeof init.body === 'string' ? init.body : null });
      return new Response(reply.body, { status: reply.statusCode, headers: reply.headers });
    }
    return new Response('{"message":"Not Found"}', { status: 404, headers: { 'content-type': 'application/json' } });
  };
}

/** The clinical API's one public route, faked: it records what the queue would hold (the slug, never the plaintext contact). */
function consultIntake(queue: Array<{ slug: string; receivedAt: string; contact: unknown }>) {
  return async (_url: URL, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as { action: string; slug: string; contact?: unknown };
    const data = request.action === 'describe'
      ? { action: 'describe', slug: request.slug, label: 'Fictional link', clinic: 'Fictional Clinic', visitTypes: ['initial'], reasonCodes: ['program_question'], acceptingRequests: true }
      : (queue.push({ slug: request.slug, receivedAt: new Date().toISOString(), contact: request.contact }),
        { action: 'submit', outcome: 'received', reference: 'ABCDEFGHJK', receivedAt: new Date().toISOString(), status: 'received' });
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

const browser = (url: string, body: string, contentType = 'application/x-www-form-urlencoded') => new Request(url, { method: 'POST', body,
  headers: { host: HOST, origin: SITE, 'sec-fetch-site': 'same-origin', 'content-type': contentType } });
const consultMails = () => sesSend.mock.calls.map(([command]) => (command as { input: { Destination: { ToAddresses: string[] }; ConfigurationSetName: string; Content: { Simple: { Subject: { Data: string }; Body: { Text: { Data: string } } } } } }).input);
const done = (r: WorkforceResponse) => { if (r.action !== 'done') throw new Error(r.action); return r.refreshed; };

let engine: ReturnType<typeof fictionalEngine>;
let queue: Array<{ slug: string; receivedAt: string; contact: unknown }>;
beforeEach(async () => {
  for (const [key, value] of Object.entries(ENV)) vi.stubEnv(key, value);
  sesSend.mockReset(); sesSend.mockResolvedValue({ MessageId: 'fictional-consult-mail' });
  engine = fictionalEngine({ config: { siteOrigin: SITE } });
  queue = [];
  const gateway = campaignApiGateway(engine), intake = consultIntake(queue);
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.origin === CAMPAIGN_API) return gateway(url, init);
    if (url.origin === CLINICAL_PUBLIC_API && url.pathname === '/clinical-core/public/consult-intake') return intake(url, init);
    throw new Error(`no fake for ${url.origin}`);
  });
  // The practice: marketing package, settings, a verified domain, and the Longevity welcome sequence approved and on.
  const ask = await engine.readyPractice({ practiceId: PRACTICE, slug: 'fictional-clinic', name: 'Fictional Clinic', domain: 'mail.fictional-clinic.example', admin: ADMIN });
  const o = done(await ask({ action: 'install_starter', programKey: 'longevity-program' }));
  const seq = o.sequences.find(s => s.programKey === 'longevity-program')!;
  for (const step of seq.steps) {
    const t = o.templates.find(x => x.templateId === step.templateId)!;
    done(await ask({ action: 'approve_template', templateId: t.templateId, version: t.version }));
  }
  done(await ask({ action: 'set_sequence_status', programKey: 'longevity-program', expectedVersion: seq.version, status: 'active' }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('the marketing path: program page to "we received your request"', () => {
  it('runs from a signed-out visitor to a request in the queue on the email channel and the received email', async () => {
    // 1. A signed-out visitor opens the program page and its sign-up page: no redirect to sign-in.
    for (const path of ['/learn/longevity-program', '/join/fictional-clinic/longevity-program', '/consult/longevity-program-email']) {
      const response = await middleware(new NextRequest(SITE + path));
      expect(response.headers.get('location'), path).toBeNull();
    }
    const web = await funnelPageLinks(publishedLongevity, undefined, marketingSignupDirectory(process.env), process.env);
    expect(web).toEqual({ consultHref: `${SITE}/consult/longevity-program`, updatesUrl: `${SITE}/join/fictional-clinic/longevity-program` });
    const page = renderToMarkup(createElement(FunnelPage, { funnel: publishedLongevity, consultHref: web.consultHref, purchase: unavailable('program_unbound'), buyHref: '#', updatesUrl: web.updatesUrl }));
    expect(page).toContain(`href="${SITE}/join/fictional-clinic/longevity-program"`);
    expect(page).not.toMatch(/<form|<script/);

    // 2. They follow "Get updates": the /join page, a plain form, then the post; the confirmation email arrives.
    const join = renderToMarkup(await JoinPage({ params: Promise.resolve({ practice: 'fictional-clinic', program: 'longevity-program' }), searchParams: Promise.resolve({}) }));
    const formToken = /name="formToken" value="([^"]+)"/.exec(join)?.[1];
    expect(formToken).toBeTruthy();
    engine.advance(FORM_MIN_MS + 10);
    const posted = await joinRoute(browser(`${SITE}/api/public/campaigns/join`,
      new URLSearchParams({ practice: 'fictional-clinic', program: 'longevity-program', email: VISITOR, firstName: 'Avery', consent: 'yes', formToken: formToken!, website: '' }).toString()));
    expect(posted.headers.get('location')).toBe(`${SITE}/join/sent`);
    const confirmation = engine.ses.outbox.at(-1)!;
    expect(confirmation).toMatchObject({ to: VISITOR, configurationSet: expect.stringMatching(/^alp-marketing/) });

    // 3. After the click (the confirm page's button), the first sequence email.
    const confirmed = await confirmRoute(browser(`${SITE}/api/public/campaigns/confirm`, `t=${tokenFrom(confirmation.text, '/join/confirm')}`));
    expect(confirmed.headers.get('location')).toBe(`${SITE}/join/confirm?o=confirmed`);
    await engine.pass();
    const welcome = engine.ses.outbox.at(-1)!;
    expect(welcome.subject).toBe('Welcome: about the Longevity Program');
    expect(welcome.headers.map(h => h.name)).toEqual(['List-Unsubscribe', 'List-Unsubscribe-Post']);

    // 4. That email leads to the program page with ?via=email, whose button is the email consult link.
    const programLink = [...welcome.html.matchAll(/href="([^"]+)"/g)].map(m => m[1]!).find(href => href.includes('/learn/'));
    expect(programLink).toBe(`${SITE}/learn/longevity-program?via=email`);
    const via = new URL(programLink!).searchParams.get('via');
    expect(funnelChannelFrom(via)).toBe('email');
    const fromEmail = await funnelPageLinks(publishedLongevity, via, marketingSignupDirectory(process.env), process.env);
    expect(fromEmail.consultHref).toBe(`${SITE}/consult/longevity-program-email`);

    // 5. They submit a request through that link; it reaches the queue carrying the email link's slug.
    const slug = new URL(fromEmail.consultHref).pathname.split('/').pop()!;
    const submitted = await consultRoute(browser(`${SITE}/api/public/consult`, JSON.stringify({ action: 'submit', slug, name: 'Avery Fictional', email: VISITOR, phone: null,
      visitType: 'initial', reasonCode: 'program_question', preferredWindows: [], timeZone: 'America/Los_Angeles' }), 'application/json'));
    expect((await submitted.json()).data).toMatchObject({ outcome: 'received' });
    expect(queue.map(r => r.slug)).toEqual(['longevity-program-email']);
    expect(JSON.stringify(queue)).not.toContain(VISITOR);
    expect(funnelSourceOf(allFunnels(), queue[0]!.slug)).toMatchObject({ channel: 'email', funnel: { slug: 'longevity-program' } });
    const counts = funnelRequestCounts(publishedLongevity, queue, new Date());
    expect(counts.map(c => [c.channel, c.windows[7].count])).toEqual([['web', 0], ['email', 1]]);

    // 6. They receive "we received your request", through the transactional set, naming nothing they chose.
    expect(consultMails()).toHaveLength(1);
    const received = consultMails()[0]!;
    expect(received).toMatchObject({ Destination: { ToAddresses: [VISITOR] }, ConfigurationSetName: 'alp-transactional' });
    expect(received.Content.Simple.Subject.Data).toBe('We received your consultation request');
    expect(JSON.stringify(received.Content)).not.toMatch(/longevity|program_question|initial|Avery|ABCDEFGHJK/i);

    // The two sides never crossed: two campaign emails, both through a marketing set; one consult email, through the transactional set.
    expect(engine.ses.outbox.map(m => m.configurationSet)).toEqual(['alp-marketing', 'alp-marketing']);
    expect(consultMails().map(m => m.ConfigurationSetName)).toEqual(['alp-transactional']);
  });
});
