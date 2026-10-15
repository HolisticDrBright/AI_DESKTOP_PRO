import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDynamoCampaignStore } from './dynamo-store';
import { FORM_MIN_MS } from './public';
import { fictionalEngine, tokenFrom } from './testing';
import { addressHash } from './tokens';
import { unsubscribeToken } from './workforce';

/**
 * Practice separation, tested directly: one practice's lists, emails and results are invisible to another, tokens
 * and sends cannot cross practices, every stored key names its practice, and the campaign code path holds no
 * clinical credential and imports nothing clinical. Fictional practices only.
 */
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const adminA = { practiceId: A, personId: '21111111-1111-4111-8111-111111111111', email: 'admin@clinic-a.example', name: 'Admin Alpha' };
const adminB = { practiceId: B, personId: '32222222-2222-4222-8222-222222222222', email: 'admin@clinic-b.example', name: 'Admin Bravo' };

async function twoPractices() {
  const e = fictionalEngine();
  const askA = await e.readyPractice({ practiceId: A, slug: 'clinic-alpha', name: 'Clinic Alpha', domain: 'mail.clinic-a.example', admin: adminA });
  const askB = await e.readyPractice({ practiceId: B, slug: 'clinic-bravo', name: 'Clinic Bravo', domain: 'mail.clinic-b.example', admin: adminB, tier: 'complete' });
  for (const [slug] of [['clinic-alpha'], ['clinic-bravo']]) {
    const page = await e.publicSide.joinPage(slug!, 'longevity-program');
    e.advance(FORM_MIN_MS + 10);
    await e.publicSide.join({ practice: slug, program: 'longevity-program', email: 'shared@fictional.example', consent: 'yes', formToken: page!.formToken });
  }
  return { e, askA, askB };
}

describe('two practices on one deployment', () => {
  it('the same address on both is two separate subscriptions; confirming one does not confirm the other', async () => {
    const { e } = await twoPractices();
    const [mailA, mailB] = e.ses.outbox.filter(m => m.subject.startsWith('Please confirm'));
    expect(mailA).toMatchObject({ from: 'Clinic Alpha <updates@mail.clinic-a.example>', tenant: 'alp-practice-11111111111141118111111111111111' });
    expect(mailB).toMatchObject({ from: 'Clinic Bravo <updates@mail.clinic-b.example>', tenant: 'alp-practice-22222222222242228222222222222222' });
    expect(await e.publicSide.confirm(tokenFrom(mailA!.text, '/join/confirm'))).toBe('confirmed');
    const a = await e.staff.handle(adminA, { action: 'overview' }), b = await e.staff.handle(adminB, { action: 'overview' });
    if (a.action !== 'overview' || b.action !== 'overview') throw new Error();
    expect(a.lists.find(l => l.programKey === 'longevity-program')!.counts.confirmed).toBe(1);
    expect(b.lists.find(l => l.programKey === 'longevity-program')!.counts.confirmed).toBe(0);
  });
  it('one practice\'s staff see only their own lists, emails, broadcasts and results', async () => {
    const { e, askA } = await twoPractices();
    await e.publicSide.confirm(tokenFrom(e.ses.outbox[0]!.text, '/join/confirm'));
    await askA({ action: 'install_starter', programKey: 'longevity-program' });
    const b = await e.staff.handle(adminB, { action: 'overview' });
    if (b.action !== 'overview') throw new Error();
    expect(b.templates).toEqual([]);
    expect(b.sequences.every(s => s.steps.length === 0)).toBe(true);
    const contactsB = await e.staff.handle(adminB, { action: 'contacts', programKey: 'longevity-program' });
    expect(contactsB).toMatchObject({ action: 'contacts', contacts: [] });
    // Practice A's template id, named by practice B's staff, does not exist for B.
    const a = await e.staff.handle(adminA, { action: 'overview' });
    if (a.action !== 'overview') throw new Error();
    await expect(e.staff.handle(adminB, { action: 'approve_template', templateId: a.templates[0]!.templateId, version: 1 })).rejects.toMatchObject({ category: 'not_found' });
    await expect(e.staff.handle(adminB, { action: 'save_broadcast', broadcastId: null, programKey: 'longevity-program', templateId: a.templates[3]!.templateId })).rejects.toMatchObject({ category: 'not_found' });
  });
  it('a staff member of one practice cannot act as another: the practice comes from the token, never the request', async () => {
    const { e } = await twoPractices();
    const reply = await e.http({ routeKey: 'POST /campaigns/workforce', body: JSON.stringify({ action: 'overview', practiceId: B }),
      requestContext: { authorizer: { jwt: { claims: { 'custom:organization_id': A, 'custom:person_id': adminA.personId, exp: Date.now() / 1000 + 60 } } } } });
    expect(reply.statusCode).toBe(400);
    const own = await e.http({ routeKey: 'POST /campaigns/workforce', body: JSON.stringify({ action: 'overview' }),
      requestContext: { authorizer: { jwt: { claims: { 'custom:organization_id': A, 'custom:person_id': adminA.personId, exp: Date.now() / 1000 + 60 } } } } });
    expect(JSON.parse(own.body).data.settings.practiceId).toBe(A);
  });
  it('a token made for one practice changes nothing in the other', async () => {
    const { e } = await twoPractices();
    for (const mail of e.ses.outbox.filter(m => m.subject.startsWith('Please confirm'))) await e.publicSide.confirm(tokenFrom(mail.text, '/join/confirm'));
    const hash = addressHash(e.deps.keys, 'shared@fictional.example');
    expect(await e.publicSide.unsubscribe(unsubscribeToken(e.deps, A, 'longevity-program', hash, null))).toBe('unsubscribed');
    const b = await e.staff.handle(adminB, { action: 'overview' });
    if (b.action !== 'overview') throw new Error();
    expect(b.lists.find(l => l.programKey === 'longevity-program')!.counts).toMatchObject({ confirmed: 1, unsubscribed: 0 });
  });
  it('a bounce recorded for one practice suppresses the address there only', async () => {
    const { e } = await twoPractices();
    for (const mail of e.ses.outbox.filter(m => m.subject.startsWith('Please confirm'))) await e.publicSide.confirm(tokenFrom(mail.text, '/join/confirm'));
    const hash = addressHash(e.deps.keys, 'shared@fictional.example');
    await e.events({ Records: [{ EventSource: 'aws:sns', Sns: { TopicArn: 'arn:aws:sns:us-east-2:111122223333:fictional-campaign-events',
      Message: JSON.stringify({ eventType: 'Bounce', bounce: { bounceType: 'Permanent' }, mail: { tags: { practice: [A], contact: [hash] } } }) } }] });
    const a = await e.staff.handle(adminA, { action: 'overview' }), b = await e.staff.handle(adminB, { action: 'overview' });
    if (a.action !== 'overview' || b.action !== 'overview') throw new Error();
    expect(a.lists.find(l => l.programKey === 'longevity-program')!.counts).toMatchObject({ confirmed: 0, bounced: 1 });
    expect(b.lists.find(l => l.programKey === 'longevity-program')!.counts).toMatchObject({ confirmed: 1, bounced: 0 });
  });
  it('every stored item names its practice, or is one of the three global records', async () => {
    const { e } = await twoPractices();
    for (const [key, row] of e.store.dump()) {
      if (key.startsWith('G|')) { expect(['slug', 'allowances', 'marketing_practice']).toContain(row.kind); continue; }
      expect(key.startsWith(`P#${A}|`) || key.startsWith(`P#${B}|`), key).toBe(true);
    }
    const slugs = [...e.store.dump().values()].filter(r => r.kind === 'slug');
    expect(JSON.stringify(slugs)).not.toContain('@');
  });
  it('the DynamoDB store addresses only the handle\'s own partition, in every command', async () => {
    const sent: { input: Record<string, unknown> }[] = [];
    const client = { send: async (command: { input: Record<string, unknown> }) => { sent.push(command); return { Items: [] }; } };
    const store = createDynamoCampaignStore({ client: client as never, tableName: 'alp-campaigns-fictional' });
    const p = store.practice(A);
    await p.get('template', 'x'); await p.put('template', 'x', {}, { expected: null }); await p.query('contact', { prefix: 'longevity-program:' });
    await p.due('contact', '2026-10-15T00:00:00Z', 10); await p.increment('counter', 'contacts', 'confirmed', 1, 10);
    await p.transact([{ op: 'put', kind: 'contact', id: 'y', body: {}, expected: 3 }, { op: 'increment', kind: 'counter', id: 'list-longevity-program', field: 'confirmed', by: 1 }]);
    const pks = JSON.stringify(sent.map(c => c.input)).match(/"P#[^"#]+/g) ?? [];
    expect(new Set(pks)).toEqual(new Set([`"P#${A}`]));
    expect(() => store.practice('not-a-uuid')).toThrow('practice_id_invalid');
    await expect(p.get('template', 'a/../b')).rejects.toThrow('item_id_invalid');
  });
});

describe('the campaign code path holds nothing clinical', () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap(entry => { const path = join(dir, entry); return statSync(path).isDirectory() ? files(path) : [path]; });
  it('imports nothing from clinical adapters, contracts, sessions, consult or patient code', () => {
    for (const file of files('src/campaigns').filter(f => /\.tsx?$/.test(f))) {
      const imports = [...readFileSync(file, 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1]!);
      for (const target of imports) {
        expect(target, `${file} imports ${target}`).toMatch(/^(?:\.\/|\.\.\/(?!\.\.)[^/]+$|zod$|node:|vitest$|esbuild$|@aws-sdk\/(?:client-sesv2|lib-dynamodb|client-dynamodb|client-secrets-manager)$|@\/funnels\/schema$)/);
      }
    }
  });
  it('names no clinical table, schema, role or endpoint', () => {
    for (const file of files('src/campaigns').filter(f => /\.tsx?$/.test(f) && !f.endsWith('.test.ts'))) {
      // Comments may say what the code never does; the code itself names none of it.
      const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/clinical_core|clinical_private|clinical-core\/|patient_|consult_request|CLINICAL_DATABASE|CLINICAL_AWS|alp-transactional/);
    }
  });
});
