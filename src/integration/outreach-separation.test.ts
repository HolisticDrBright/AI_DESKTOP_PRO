import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * The separation tests, across workstreams, on the integrated line:
 *
 * - the campaign code path holds no clinical credential and reads no clinical store: every module the marketing entry
 *   points reach, transitively, is named here, and none is a clinical adapter, a notification ledger, consult intake or
 *   a database client; the campaign stack's functions see only CAMPAIGN_* settings and can touch only its own table,
 *   key and secret; no clinical template names any campaign resource;
 * - one practice's lists, emails and results are invisible to another, through the Desktop's own staff route;
 * - the reverse direction: no clinical sender (patient notices, consult emails, the telehealth and identity handlers and
 *   their routes) reaches a campaign module or names a campaign resource, so marketing consent cannot stand in for
 *   clinical consent.
 *
 * Fictional practices, people and addresses only.
 */
const session = vi.hoisted(() => vi.fn());
vi.mock('@/server/session', () => ({ getRequestSession: session }));
vi.mock('@/adapters/mode', () => ({ USE_LIVE_API: true }));

import { fictionalEngine, tokenFrom } from '@/campaigns/testing';
import { FORM_MIN_MS } from '@/campaigns/public';
import { POST as staffRoute } from '@/app/api/live/campaigns/route';

/* ------------------------------------------------------------------------------------------------ the import graph */
const ROOT = process.cwd();
const MARKETING_ENTRIES = [
  'src/app/join/[practice]/[program]/page.tsx', 'src/app/join/sent/page.tsx', 'src/app/join/confirm/page.tsx', 'src/app/join/unsubscribe/page.tsx',
  'src/app/campaigns/page.tsx', 'src/app/api/public/campaigns/join/route.ts', 'src/app/api/public/campaigns/confirm/route.ts',
  'src/app/api/public/campaigns/unsubscribe/route.ts', 'src/app/api/live/campaigns/route.ts', 'src/funnels/marketingSignup.ts',
  ...readdirSync('src/campaigns/lambda').filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts')).map(f => `src/campaigns/lambda/${f}`),
];
/** Every module reached through value imports (type-only imports carry no code), and every package named. */
function reach(entries: readonly string[]) {
  const modules = new Set<string>(), packages = new Set<string>();
  const resolveSpec = (from: string, spec: string): string | null => {
    const base = spec.startsWith('@/') ? join(ROOT, 'src', spec.slice(2)) : spec.startsWith('.') ? resolve(dirname(from), spec) : null;
    if (base === null) return null;
    for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) if (existsSync(base + ext) && statSync(base + ext).isFile()) return base + ext;
    throw new Error(`unresolved ${spec} from ${from}`);
  };
  const walk = (file: string) => {
    const name = relative(ROOT, file);
    if (modules.has(name)) return;
    modules.add(name);
    for (const m of readFileSync(file, 'utf8').matchAll(/(?:^|\n)\s*(import|export)(\s+type)?\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if (m[2]) continue;
      const spec = (m[3] ?? m[4])!;
      const target = resolveSpec(file, spec);
      if (target === null) packages.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!);
      else walk(target);
    }
  };
  for (const entry of entries) walk(resolve(entry));
  return { modules: [...modules].sort(), packages: [...packages].sort() };
}

describe('the campaign code path holds no clinical credential and reads no clinical store', () => {
  const { modules, packages } = reach(MARKETING_ENTRIES);
  it('reaches no clinical adapter, notification ledger, consult intake, patient contract or database client', () => {
    const clinical = modules.filter(m => /^src\/server\/(?:clinical-core|notifications|consult|commerce|programs)\//.test(m)
      || /^src\/contracts\//.test(m) || (/^src\/adapters\//.test(m) && !/^src\/adapters\/(?:auth\.server|errors|mode|types)\.ts$/.test(m)));
    expect(clinical).toEqual([]);
    for (const p of packages) expect(p, `package ${p}`).toMatch(/^(?:react|next|zod|node:\w+|@aws-sdk\/(?:client-sesv2|lib-dynamodb|client-dynamodb|client-secrets-manager)|esbuild)$/);
    // The only session code reached is the staff route's read of the signed-in person's own workforce token, which it forwards to the campaign API's authorizer.
    expect(modules.filter(m => /^src\/adapters\//.test(m))).toEqual(['src/adapters/auth.server.ts', 'src/adapters/errors.ts', 'src/adapters/mode.ts']);
  });
  it('the campaign stack\'s functions see only CAMPAIGN_* settings, and reach only their own table, key and secret', () => {
    const template = JSON.parse(readFileSync('infra/campaigns/campaign-engine.json', 'utf8')) as { Resources: Record<string, { Type: string; Properties: Record<string, unknown> }> };
    const resources = Object.entries(template.Resources);
    for (const [name, r] of resources.filter(([, r]) => r.Type === 'AWS::Lambda::Function')) {
      const variables = Object.keys((r.Properties.Environment as { Variables?: Record<string, unknown> } | undefined)?.Variables ?? {});
      expect(variables.length, name).toBeGreaterThan(0);
      for (const v of variables) expect(v, `${name} ${v}`).toMatch(/^CAMPAIGN_/);
    }
    for (const [name, r] of resources.filter(([, r]) => r.Type === 'AWS::IAM::Role')) {
      const statements = ((r.Properties.Policies ?? []) as Array<{ PolicyDocument: { Statement: Array<{ Effect: string; Action: string | string[]; Resource?: unknown }> } }>).flatMap(p => p.PolicyDocument.Statement);
      for (const s of statements.filter(x => x.Effect === 'Allow')) {
        for (const action of [s.Action].flat()) expect(action, `${name} ${action}`).toMatch(/^(?:logs|dynamodb|kms|secretsmanager|ses|sqs|lambda):/);
        if ([s.Action].flat().some(a => a.startsWith('secretsmanager:'))) expect(JSON.stringify(s.Resource), name).toMatch(/CampaignKeySecret/);
        if ([s.Action].flat().some(a => a.startsWith('dynamodb:'))) expect(JSON.stringify(s.Resource), name).toMatch(/CampaignTable/);
      }
    }
    expect(JSON.stringify(template)).not.toMatch(/rds-data|clinical_core|ClinicalApi|CLINICAL_|cognito-idp:Admin/);
  });
  it('no clinical template names a campaign resource', () => {
    for (const file of readdirSync('infra/aws-clinical-core').filter(f => f.endsWith('.json'))) {
      expect(readFileSync(join('infra/aws-clinical-core', file), 'utf8'), file).not.toMatch(/alp-campaigns|alp-marketing|Campaign(?:Table|Api|Sender|Events|Key)/);
    }
  });
});

/* ------------------------------------------------------------------------------------- two practices, one Desktop */
const API = 'https://abcdefghij.execute-api.us-east-2.amazonaws.com';
const HOST = 'clinic.fictional.example';
const A = { practiceId: '11111111-1111-4111-8111-111111111111', personId: '21111111-1111-4111-8111-111111111111', email: 'admin@clinic-a.fictional.example', name: 'Fictional Admin A' };
const B = { practiceId: '22222222-2222-4222-8222-222222222222', personId: '32222222-2222-4222-8222-222222222222', email: 'admin@clinic-b.fictional.example', name: 'Fictional Admin B' };
const TOKENS: Record<string, typeof A> = { 'fictional-token-a': A, 'fictional-token-b': B };

describe('one practice\'s lists, emails and results are invisible to another, through the Desktop', () => {
  let engine: ReturnType<typeof fictionalEngine>;
  beforeEach(async () => {
    vi.stubEnv('CAMPAIGN_ENGINE_ENABLED', 'true'); vi.stubEnv('CAMPAIGN_API_ORIGIN', API);
    engine = fictionalEngine();
    // API Gateway's JWT authorizer, faked: a known token becomes its claims; anything else never reaches the function.
    vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
      const url = new URL(input);
      if (url.origin !== API || url.pathname !== '/campaigns/workforce') throw new Error(`no fake for ${url.href}`);
      const who = TOKENS[String((init.headers as Record<string, string>).authorization).replace(/^Bearer /, '')];
      if (!who) return new Response('{"message":"Unauthorized"}', { status: 401, headers: { 'content-type': 'application/json' } });
      const reply = await engine.http({ routeKey: 'POST /campaigns/workforce', body: String(init.body),
        requestContext: { authorizer: { jwt: { claims: { 'custom:organization_id': who.practiceId, 'custom:person_id': who.personId, email: who.email, exp: Date.now() / 1000 + 300 } } } } });
      return new Response(reply.body, { status: reply.statusCode, headers: reply.headers });
    });
    // Practice A: ready, with one confirmed subscriber and a test send recorded.
    const askA = await engine.readyPractice({ practiceId: A.practiceId, slug: 'clinic-a', name: 'Fictional Clinic A', domain: 'mail.clinic-a.fictional.example', admin: A });
    const page = await engine.publicSide.joinPage('clinic-a', 'longevity-program');
    engine.advance(FORM_MIN_MS + 10);
    await engine.publicSide.join({ practice: 'clinic-a', program: 'longevity-program', email: 'avery@fictional.example', consent: 'yes', formToken: page!.formToken });
    await engine.publicSide.confirm(tokenFrom(engine.ses.outbox.at(-1)!.text, '/join/confirm'));
    const installed = await askA({ action: 'install_starter', programKey: 'longevity-program' });
    if (installed.action !== 'done') throw new Error(installed.action);
    // Practice B: holds the package too, with nothing of its own yet.
    await engine.operator.grantMarketing(B.practiceId, 'growth', 'fictional-operator', { personId: B.personId, name: B.name });
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
  const ask = async (token: string, body: unknown) => {
    session.mockResolvedValueOnce({ token });
    const response = await staffRoute(new Request('https://x/api/live/campaigns', { method: 'POST', body: JSON.stringify(body),
      headers: { host: HOST, origin: `https://${HOST}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' } }));
    return { status: response.status, ...await response.json() as { data?: Record<string, unknown> } };
  };

  it('practice B sees its own empty practice: no subscriber, address, email or result of A\'s', async () => {
    const a = await ask('fictional-token-a', { action: 'overview' });
    const b = await ask('fictional-token-b', { action: 'overview' });
    expect(a.status).toBe(200); expect(b.status).toBe(200);
    const confirmed = (o: { data?: Record<string, unknown> }) => (o.data!.lists as Array<{ counts: { confirmed: number } }>).reduce((n, l) => n + l.counts.confirmed, 0);
    expect(confirmed(a)).toBe(1);
    expect(confirmed(b)).toBe(0);
    expect((a.data!.templates as unknown[]).length).toBeGreaterThan(0);
    expect(b.data!.templates).toEqual([]);
    expect(b.data!.results).toEqual([]);
    expect(JSON.stringify(b)).not.toMatch(/avery@fictional\.example|clinic-a|Fictional Clinic A|mail\.clinic-a/);
    const contactsB = await ask('fictional-token-b', { action: 'contacts', programKey: 'longevity-program' });
    expect(contactsB.status).toBe(200);
    expect(contactsB.data!.contacts).toEqual([]);
  });
  it('a request naming the other practice is refused before it leaves the Desktop, and an unknown token never reaches the engine', async () => {
    expect((await ask('fictional-token-b', { action: 'overview', practiceId: A.practiceId })).status).toBe(400);
    expect((await ask('fictional-token-x', { action: 'overview' })).status).toBe(401);
    const status = await ask('fictional-token-b', { action: 'status' });
    expect(status.data).toMatchObject({ action: 'status', marketing: true, domain: null, activeSequences: [], approvedTemplates: 0 });
  });
});

/* ---------------------------------------------- the reverse direction: clinical senders and the marketing store */
// Everything that decides or sends a clinical message: the patient-notice switches, policy, ledger and dispatcher, the
// telehealth and identity handlers that call them, the consult intake and its enquirer emails, and the routes over them.
const CLINICAL_SENDERS = [
  ...readdirSync('src/server/notifications').filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts')).map(f => `src/server/notifications/${f}`),
  ...readdirSync('src/server/consult').filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts')).map(f => `src/server/consult/${f}`),
  'src/server/clinical-core/aws-telehealth-requests.ts', 'src/server/clinical-core/aws-telehealth-requests-lambda.ts',
  'src/server/clinical-core/aws-identity-api.ts', 'src/server/clinical-core/aws-identity-lambda.ts',
  'src/app/api/public/consult/route.ts', 'src/app/api/live/consult-requests/route.ts', 'src/app/api/live/patient-notification-settings/route.ts',
];
describe('marketing consent is never clinical consent: no clinical sender reaches the marketing store', () => {
  const { modules } = reach(CLINICAL_SENDERS);
  it('reaches no campaign module, marketing sign-up or campaign API, so a list subscription cannot permit, widen or suppress a clinical message', () => {
    // The notice ledger asks the patient's own notification choices in the clinical database; a confirmed list
    // subscription lives in the campaign table and is not in any module these senders load.
    expect(modules.length).toBeGreaterThan(CLINICAL_SENDERS.length);
    expect(modules.filter(m => /^src\/campaigns\//.test(m) || /^src\/app\/(?:join|campaigns)\//.test(m)
      || /^src\/app\/api\/(?:public|live)\/campaigns\//.test(m) || /(?:^|\/)(?:marketingSignup|marketingSignupLink|campaign-api)\.tsx?$/.test(m))).toEqual([]);
  });
  it('names no campaign table, setting or SES configuration set in any clinical sender', () => {
    for (const file of modules.filter(m => /^src\/server\/(?:notifications|consult|clinical-core)\//.test(m))) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/CAMPAIGN_[A-Z_]+|alp-marketing|campaign_subscri|CampaignStore|campaignStore/);
    }
  });
});
