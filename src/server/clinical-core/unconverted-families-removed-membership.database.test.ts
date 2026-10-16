import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * The unconverted claims families served by the synthetic-staging boundary, under the deployed default (`legacy_claims`),
 * path by path: a removed membership (`organization_memberships.status='suspended'`; there is no other removal state)
 * is refused on the next request, though the token it presents still names the clinic. Each call runs as its service
 * runs it: set_request_context with the token's person and clinic (which checks only the identity row), then the
 * operation the Desktop route reaches, as clinical_core_api. Every one first succeeds for the same person while the
 * membership is active, so the refusal is the membership's, not the request's.
 *
 * These are the synthetic, fictional-only schema's functions; none is in the production overlay (each file is
 * `production_transform:false`), and the identity API serves them only on the synthetic boundary. The recording
 * subfamilies (production schema) are in recording-transcription.database.test.ts. Fictional rows only.
 */
let db: PGlite;
let org: string, practitioner: string;
type Call = { family: string; route: string; fn: string; payload: Record<string, unknown>; refusal: string };
const CALLS: Call[] = [
  { family: 'calendar connection', route: 'live/calendar-connection', fn: 'external_calendar_request', payload: { action: 'read' }, refusal: 'external_calendar_forbidden' },
  { family: 'workforce Ask ALP', route: 'live/ask-alp/configuration', fn: 'patient_chat_request', payload: { action: 'configuration_status' }, refusal: 'chat_workforce_refused' },
  { family: 'consult links', route: 'live/consult-requests (links)', fn: 'consult_link_admin', payload: { action: 'list' }, refusal: 'consult_request_forbidden' },
  { family: 'consult requests', route: 'live/consult-requests (queue, contact)', fn: 'consult_request_review', payload: { action: 'list' }, refusal: 'consult_request_forbidden' },
  { family: 'consult retention', route: 'live/consult-retention', fn: 'consult_contact_retention', payload: { action: 'settings_read' }, refusal: 'consult_retention_forbidden' },
  { family: 'disputes', route: 'live/care-governance (disputes)', fn: 'clinical_dispute_workforce', payload: { action: 'list' }, refusal: 'clinical_dispute_forbidden' },
  { family: 'content revisions', route: 'live/care-governance (revisions)', fn: 'content_revision_workforce', payload: { action: 'list' }, refusal: 'clinical_dispute_forbidden' },
  { family: 'practice outcomes', route: 'live/practice-outcomes (ledger)', fn: 'outcome_ledger_workforce', payload: { action: 'vocabulary' }, refusal: 'outcome_ledger_forbidden' },
  { family: 'outcome report', route: 'live/practice-outcomes (report)', fn: 'outcome_report', payload: { action: 'report', groupBy: [] }, refusal: 'outcome_ledger_forbidden' },
  { family: 'protocol carts', route: 'live/protocol-carts', fn: 'protocol_cart_workforce', payload: { action: 'list', programId: randomUUID() }, refusal: 'protocol_cart_forbidden' },
  { family: 'note templates', route: 'live/note-templates (templates)', fn: 'note_template_admin', payload: { action: 'list' }, refusal: 'note_template_forbidden' },
  { family: 'note drafting context', route: 'live/note-templates (drafting context)', fn: 'note_drafting_context', payload: { action: 'resolve', noteType: 'soap' }, refusal: 'note_template_forbidden' },
  { family: 'intake forms (no Desktop route)', route: 'none', fn: 'intake_form_admin', payload: { action: 'list' }, refusal: 'consult_request_forbidden' },
];

async function as(fn: string, payload: unknown) {
  return db.transaction(async tx => {
    await tx.exec('set local role clinical_core_api');
    await tx.query("select clinical_private.set_request_context($1,$2,'workforce',$3,'clinical_data','synthetic-staging','synthetic_only')",
      [practitioner, org, 'subject-' + practitioner]);
    return (await tx.query<{ result: unknown }>(`select clinical_core.${fn}($1::jsonb) as result`, [JSON.stringify(payload)])).rows[0]!.result;
  });
}

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  const manifest = JSON.parse(readFileSync('infra/aws-clinical-core/migrations/manifest.json', 'utf8')) as { migrations: Array<{ file: string }> };
  for (const { file } of manifest.migrations) await db.exec(readFileSync('infra/aws-clinical-core/migrations/' + file, 'utf8'));
}, 180_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  [org, practitioner] = [randomUUID(), randomUUID()];
  await db.query("insert into clinical_core.organizations(id,synthetic_label) values($1,'FICTIONAL clinic')", [org]);
  await db.query('insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)', [practitioner, 'syn_' + practitioner.replaceAll('-', '')]);
  await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values($1,'workforce',$2,true)",
    [practitioner, 'subject-' + practitioner]);
  await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')", [org, practitioner]);
});

describe('unconverted synthetic families: a removed membership is refused on the next request', () => {
  it.each(CALLS.map(c => [c.family, c] as const))('%s', async (_family, c) => {
    await expect(as(c.fn, c.payload), `${c.fn} as an active member`).resolves.toBeDefined();
    await db.query("update clinical_core.organization_memberships set status='suspended' where organization_id=$1 and person_id=$2", [org, practitioner]);
    await expect(as(c.fn, c.payload)).rejects.toThrow(c.refusal);
  });

  it('calendar busy sync: the membership is checked before the request is read (an active member reaches validation)', async () => {
    const payload = { action: 'busy_sync', busy: 'not-an-array' };
    await expect(as('external_calendar_busy_sync', payload)).rejects.toThrow('external_calendar_invalid');
    await db.query("update clinical_core.organization_memberships set status='suspended' where organization_id=$1 and person_id=$2", [org, practitioner]);
    await expect(as('external_calendar_busy_sync', payload)).rejects.toThrow('external_calendar_forbidden');
  });

  it('every call above is the one its Desktop route reaches (the route names match the inventory family)', async () => {
    const { routeFamily } = await import('@/server/route-authority-inventory');
    for (const c of CALLS.filter(c => c.route !== 'none')) expect(routeFamily(c.route.split(' ')[0]!), c.route).toBe('unconverted_claims_families');
  });
});
