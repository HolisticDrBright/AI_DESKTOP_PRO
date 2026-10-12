import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase } from '../clinical-core/database';
import { classifyDatabaseRejection } from '../clinical-core/rds-data-database';
import { PROGRAM_OFFER_SCHEMA_CANDIDATE_SHA256 } from './program-commerce-activation';
import { createSqlProgramOfferLedger } from './program-offer-ledger-sql';
import { ProgramOfferError, type OfferActor, type ProgramOfferLedger } from './program-offer-ledger';
import { formatAmount, type ProgramOffer } from '../../contracts/programOffers';

/**
 * The BLOCKED program-offer candidate against the full synthetic manifest and nowhere else, driven
 * through the SQL ledger under the API role with fictional identities. The first block is the point:
 * with the activation row disabled (its shipped state) and the adapter's evidence absent, nothing
 * works and the API role can read nothing. The rest enables activation in this embedded database only
 * and proves every invariant the design names. It registers nothing and enables nothing elsewhere.
 */
const CANDIDATE = 'infra/aws-clinical-core/source-candidates/program-offer-revisions.sql';
const PARENTS: Record<string, string> = {
  'infra/aws-clinical-core/migrations/20260812010000_synthetic_identity_consent.sql': 'c4ca967352bce6c678249336ef410fe7de4216d123a0d3da06a467379780c445',
  'infra/aws-clinical-core/migrations/20260903200000_synthetic_desktop_programs_inbox.sql': '6ba42349af12e2deb2aa163fbca59ea168bababe4017a098ec88314f31a8b26f',
  'infra/aws-clinical-core/migrations/20260929120000_synthetic_program_assignments.sql': '8d6bcac8dfbe5582e7ee63d5f7ed6a5b4466760195f251d10780f08e3fb4a1d8',
};
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const id = (n: number) => '60000000-0000-4000-8000-' + String(n).padStart(12, '0');
const org = id(1), otherOrg = id(2), staff = id(3), otherStaff = id(4), clerk = id(5), program = id(6), otherProgram = id(7), unpublished = id(8), version1 = id(9), version2 = id(10), otherVersion = id(11);
let db: PGlite;
const fails = async (sql: string, args: unknown[] = []) => { try { await db.query(sql, args); } catch (error) { return (error as Error).message; } return 'none'; };
const database: ClinicalCoreDatabase = { transaction: work => db.transaction(async tx => {
  await tx.exec('set local role clinical_core_api');
  return work({ query: async <Row extends Record<string, unknown>>(sql: string, parameters: readonly unknown[] = []) => {
    try { return await tx.query<Row>(sql, parameters.map(p => p && typeof p === 'object' && 'kind' in p && p.kind === 'uuid' && 'value' in p ? p.value : p)); }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw classifyDatabaseRejection({ name: 'DatabaseErrorException', message }) ?? new ClinicalCoreDatabaseRejection('operation_refused');
    }
  } });
}) };
const enabled = () => ({ contract: 'program-commerce-activation/1', enabled: true, target: 'synthetic-staging', schemaCandidateSha256: PROGRAM_OFFER_SCHEMA_CANDIDATE_SHA256, evidenceSha256: 'e'.repeat(64), reviewedBy: 'FICTIONAL REVIEW FIXTURE', reviewedAt: '2026-10-11T00:00:00Z' });
const identity = (actor: OfferActor) => ({ identityPool: 'workforce' as const, identitySubject: 'wf:' + actor.personId });
const ledger = (activation: unknown = enabled()): ProgramOfferLedger => createSqlProgramOfferLedger({ database, activation, identity });
const me: OfferActor = { personId: staff, organizationId: org };
const paid = (over: Record<string, unknown> = {}) => ({ mode: 'paid', name: 'Fictional program, one payment', pricing: { currency: 'USD', amountMinor: 1999, billing: { kind: 'one_time' } }, providerPriceRef: 'price_FictionalAbc123', accessTermsVersion: 'education-access-terms/1', accessDurationDays: null, ...over });
async function refusal(work: () => Promise<unknown>): Promise<ProgramOfferError> {
  try { await work(); } catch (error) { if (error instanceof ProgramOfferError) return error; throw error; }
  throw new Error('expected a refusal');
}
const phases = (suffix: string) => [{ id: 'phase-1', title: 'Phase one', days: 1, transition: 'scheduled', items: [{ id: 'lesson-' + suffix, title: 'Fictional lesson ' + suffix, kind: 'lesson', instructions: 'Read the fictional lesson.', released: true }] }];
async function setActivation(on: boolean) {
  await db.query(`update commercial_education.program_commerce_activation set enabled=$1,evidence_sha256=case when $1 then repeat('e',64) end,reviewed_by=case when $1 then 'FICTIONAL REVIEW FIXTURE' end,reviewed_at=case when $1 then now() end`, [on]);
}
async function publishVersion(versionId: string, programId: string, organization: string, version: number, suffix: string) {
  await db.query(`insert into clinical_core.synthetic_desktop_program_versions(id,organization_id,program_id,version,status,content,created_by_person_id,published_at) values($1,$2,$3,$4,'published',$5::jsonb,$6,clock_timestamp())`,
    [versionId, organization, programId, version, JSON.stringify({ consumerProgram: { title: 'Fictional guide', phases: phases(suffix) } }), organization === org ? staff : otherStaff]);
  await db.query('update clinical_core.synthetic_desktop_programs set published_version_id=$2,status=$3 where id=$1', [programId, versionId, 'published']);
}

beforeAll(async () => {
  for (const [path, digest] of Object.entries(PARENTS)) expect(sha(path), path).toBe(digest);
  const candidate = readFileSync(CANDIDATE, 'utf8');
  for (const digest of Object.values(PARENTS)) expect(candidate).toContain(digest);
  expect(candidate).toContain('BLOCKED source candidate');
  expect(sha(CANDIDATE)).toBe(PROGRAM_OFFER_SCHEMA_CANDIDATE_SHA256);
  const manifest = JSON.parse(readFileSync('infra/aws-clinical-core/migrations/manifest.json', 'utf8')) as { migrations: { file: string }[] };
  expect(manifest.migrations.some(m => /program[-_]offer|commercial_education/.test(m.file))).toBe(false);
  db = new PGlite({ extensions: { pgcrypto } });
  for (const { file } of manifest.migrations) await db.exec(readFileSync('infra/aws-clinical-core/migrations/' + file, 'utf8'));
  await db.exec(candidate);
  for (const [o, label] of [[org, 'Fictional A'], [otherOrg, 'Fictional B']]) await db.query('insert into clinical_core.organizations(id,synthetic_label) values($1,$2)', [o, label]);
  for (const [p, o, role] of [[staff, org, 'practitioner'], [otherStaff, otherOrg, 'practitioner'], [clerk, org, 'staff']]) {
    await db.query('insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)', [p, 'syn_' + p.replaceAll('-', '')]);
    await db.query(`insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values($1,'workforce',$2,true)`, [p, 'wf:' + p]);
    await db.query(`insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,$3)`, [o, p, role]);
  }
  for (const [p, o, by] of [[program, org, staff], [unpublished, org, staff], [otherProgram, otherOrg, otherStaff]]) {
    await db.query("insert into clinical_core.synthetic_desktop_programs(id,organization_id,name,status,created_by_person_id) values($1,$2,'Fictional program','draft',$3)", [p, o, by]);
  }
  await publishVersion(version1, program, org, 1, 'a');
  await publishVersion(otherVersion, otherProgram, otherOrg, 1, 'z');
}, 120_000);
afterAll(async () => { await db?.close(); });

describe('disabled as shipped', () => {
  it('the activation row is off, the API role cannot read or flip it, and no clinical function names the commercial schema', async () => {
    const row = await db.query<{ enabled: boolean }>('select enabled from commercial_education.program_commerce_activation');
    expect(row.rows[0]).toEqual({ enabled: false });
    expect(await fails('update commercial_education.program_commerce_activation set enabled=true')).toMatch(/violates check constraint/);
    expect(await fails('delete from commercial_education.program_commerce_activation')).toContain('append_only_record');
    for (const table of ['program_commerce_activation', 'program_offers', 'program_offer_revisions']) {
      await expect(db.transaction(async tx => { await tx.exec('set local role clinical_core_api'); await tx.exec(`select * from commercial_education.${table}`); })).rejects.toThrow(/permission denied/);
    }
    const bodies = await db.query<{ n: string }>("select p.proname as n from pg_proc p join pg_namespace s on s.oid=p.pronamespace where s.nspname in('clinical_core','clinical_private','clinical_audit') and p.prokind='f' and pg_get_functiondef(p.oid) ilike '%commercial_education%'");
    expect(bodies.rows).toEqual([]);
    const columns = await db.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema='commercial_education'");
    expect(columns.rows.map(c => c.column_name).filter(c => /patient|consumer|connection|encounter|diagnos|symptom/.test(c))).toEqual([]);
  });
  it('the SQL ledger refuses without evidence, with evidence naming another candidate, and with evidence while the row is off', async () => {
    expect((await refusal(() => ledger(undefined).execute(me, { action: 'list', programId: program }))).category).toBe('activation_refused');
    expect((await refusal(() => ledger({ ...enabled(), schemaCandidateSha256: 'f'.repeat(64) }).execute(me, { action: 'list', programId: program }))).category).toBe('activation_refused');
    expect((await refusal(() => ledger().execute(me, { action: 'list', programId: program }))).category).toBe('activation_refused');
    expect(await ledger(undefined).availability(org, program)).toMatchObject({ available: false, reason: 'commerce_disabled' });
    expect(await ledger().availability(org, program)).toMatchObject({ available: false, reason: 'commerce_disabled' });
  });
});

describe('enabled in this embedded database only', () => {
  let offer: ProgramOffer;
  beforeAll(async () => { await setActivation(true); });
  it('creates a draft bound to the current published curriculum the ledger read, never one the caller named', async () => {
    const created = await ledger().execute(me, { action: 'create', programId: program, terms: paid() });
    expect(created.action).toBe('create');
    offer = (created as { offer: ProgramOffer }).offer;
    expect(offer).toMatchObject({ contract: 'program-offer/1', organizationId: org, programId: program, revision: 1, state: 'draft', mode: 'paid', curriculum: { versionId: version1, version: 1 } });
    expect(offer.curriculum.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(offer.mode === 'paid' && offer.providerPrice).toMatchObject({ provider: 'stripe', mode: 'test', priceRef: 'price_FictionalAbc123', approval: null });
    const digest = await db.query<{ d: string }>(`select encode(public.digest(convert_to((clinical_private.program_consumer_content(content)->'phases')::text,'UTF8'),'sha256'),'hex') as d from clinical_core.synthetic_desktop_program_versions where id=$1`, [version1]);
    expect(offer.curriculum.sourceDigest).toBe(digest.rows[0]!.d);
    expect((await refusal(() => ledger().execute(me, { action: 'create', programId: program, terms: paid(), curriculum: { versionId: version1, version: 1, sourceDigest: 'a'.repeat(64) } }))).category).toBe('request_invalid');
    expect(await ledger().availability(org, program)).toMatchObject({ available: false, reason: 'offer_draft' });
  });
  it('refuses a program with nothing published, a program of another clinic, a clerk without a clinical role, and a stranger clinic reading the offer', async () => {
    expect((await refusal(() => ledger().execute(me, { action: 'create', programId: unpublished, terms: paid() }))).category).toBe('curriculum_unpublished');
    expect((await refusal(() => ledger().execute(me, { action: 'create', programId: otherProgram, terms: paid() }))).category).toBe('program_not_found');
    expect((await refusal(() => ledger().execute({ personId: clerk, organizationId: org }, { action: 'list', programId: program }))).category).toBe('identity_refused');
    expect(await ledger().read({ personId: otherStaff, organizationId: otherOrg }, offer.offerId)).toBeNull();
    expect((await refusal(() => ledger().execute({ personId: otherStaff, organizationId: otherOrg }, { action: 'retire', offerId: offer.offerId, expectedRevision: 1, reason: 'not mine' }))).category).toBe('offer_not_found');
  });
  it('malformed or incomplete paid terms are refused or stay a draft; they never become complimentary, free or zero', async () => {
    for (const terms of [
      paid({ pricing: { currency: 'USD', amountMinor: 0, billing: { kind: 'one_time' } } }),
      paid({ pricing: { currency: 'USD', amountMinor: -5, billing: { kind: 'one_time' } } }),
      paid({ pricing: { currency: 'USD', amountMinor: 19.99, billing: { kind: 'one_time' } } }),
      paid({ pricing: { currency: 'USD', amountMinor: 2 ** 31, billing: { kind: 'one_time' } } }),
      paid({ pricing: { currency: 'EUR', amountMinor: 1999, billing: { kind: 'one_time' } } }),
      paid({ pricing: { currency: 'USD', amountMinor: 1999, billing: { kind: 'recurring' } } }),
      paid({ pricing: { currency: 'USD', amountMinor: 1999, billing: { kind: 'lifetime' } } }),
      paid({ providerPriceRef: 'price_live_x' }),
      paid({ providerPriceRef: 'prod_FictionalAbc123' }),
      paid({ mode: 'free' }),
      paid({ refundPolicy: 'none' }),
    ]) {
      expect((await refusal(() => ledger().execute(me, { action: 'revise', offerId: offer.offerId, expectedRevision: offer.revision, terms }))).category, JSON.stringify(terms)).toBe('request_invalid');
    }
    const direct = await fails(`update commercial_education.program_offers set mode='complimentary',revision=revision+1 where id=$1`, [offer.offerId]);
    expect(direct).toMatch(/program_offers_complimentary_shape|check constraint/);
    expect(await fails(`update commercial_education.program_offers set amount_minor=0,revision=revision+1 where id=$1`, [offer.offerId])).toMatch(/check constraint/);
    const incomplete = await ledger().execute(me, { action: 'revise', offerId: offer.offerId, expectedRevision: offer.revision, terms: paid({ pricing: null }) });
    offer = (incomplete as { offer: ProgramOffer }).offer;
    expect(offer).toMatchObject({ revision: 2, state: 'draft', mode: 'paid', pricing: null });
    const publish = await refusal(() => ledger().execute(me, { action: 'publish', offerId: offer.offerId, expectedRevision: 2 }));
    expect(publish.category).toBe('publish_refused');
    expect(publish.holds).toEqual(['no_pricing', 'provider_mapping_unapproved']);
    expect(await ledger().availability(org, program)).toMatchObject({ available: false, reason: 'offer_draft' });
  });
  it('a stale revision cannot overwrite a newer one', async () => {
    expect((await refusal(() => ledger().execute(me, { action: 'revise', offerId: offer.offerId, expectedRevision: 1, terms: paid() }))).category).toBe('revision_stale');
    const current = await ledger().read(me, offer.offerId);
    expect(current).toMatchObject({ revision: 2, pricing: null });
  });
  it('the provider mapping is approved as a separate recorded act, bound to the typed reference', async () => {
    const priced = await ledger().execute(me, { action: 'revise', offerId: offer.offerId, expectedRevision: 2, terms: paid() });
    offer = (priced as { offer: ProgramOffer }).offer;
    expect(offer.mode === 'paid' && offer.providerPrice?.approval).toBeNull();
    const approved = await ledger().execute(me, { action: 'approve_provider_mapping', offerId: offer.offerId, expectedRevision: 3 });
    offer = (approved as { offer: ProgramOffer }).offer;
    expect(offer.mode === 'paid' && offer.providerPrice?.approval).toMatchObject({ by: staff });
    // The table refuses a reference change that keeps the approval; the ledger drops the approval when the reference is retyped.
    expect(await fails(`update commercial_education.program_offers set provider_price_ref='price_FictionalThird1',revision=revision+1 where id=$1`, [offer.offerId])).toContain('program_offer_approval_bound_to_reference');
    const changed = await ledger().execute(me, { action: 'revise', offerId: offer.offerId, expectedRevision: 4, terms: paid({ providerPriceRef: 'price_FictionalOther9' }) });
    expect((changed as { offer: ProgramOffer }).offer.mode === 'paid' && (changed as { offer: { providerPrice: { approval: unknown } } }).offer.providerPrice.approval).toBeNull();
    const back = await ledger().execute(me, { action: 'revise', offerId: offer.offerId, expectedRevision: 5, terms: paid() });
    const again = await ledger().execute(me, { action: 'approve_provider_mapping', offerId: offer.offerId, expectedRevision: (back as { offer: ProgramOffer }).offer.revision });
    offer = (again as { offer: ProgramOffer }).offer;
    expect(offer.revision).toBe(7);
  });
  it('publishes only with pricing, an approved mapping, access terms and the unchanged curriculum; then the visitor may buy on exactly those terms', async () => {
    const published = await ledger().execute(me, { action: 'publish', offerId: offer.offerId, expectedRevision: 7 });
    offer = (published as { offer: ProgramOffer }).offer;
    expect(offer).toMatchObject({ state: 'published', revision: 8 });
    const availability = await ledger().availability(org, program);
    expect(availability).toMatchObject({ available: true, offerId: offer.offerId, revision: 8, pricing: { currency: 'USD', amountMinor: 1999, billing: { kind: 'one_time' } }, curriculum: { versionId: version1, version: 1 }, accessTermsVersion: 'education-access-terms/1' });
    expect(availability.available && formatAmount(availability.pricing)).toBe('19.99 USD, one payment');
    // Published terms are immutable, in the ledger and in the table.
    expect((await refusal(() => ledger().execute(me, { action: 'revise', offerId: offer.offerId, expectedRevision: 8, terms: paid({ pricing: { currency: 'USD', amountMinor: 1, billing: { kind: 'one_time' } } }) }))).category).toBe('state_invalid');
    expect(await fails(`update commercial_education.program_offers set amount_minor=1,revision=revision+1 where id=$1`, [offer.offerId])).toMatch(/program_offer_(published_immutable|transition_refused)/);
    expect(await fails(`update commercial_education.program_offers set amount_minor=1,state='retired',revision=revision+1 where id=$1`, [offer.offerId])).toContain('program_offer_published_immutable');
    expect(await fails(`update commercial_education.program_offers set state='draft',revision=revision+1 where id=$1`, [offer.offerId])).toContain('program_offer_transition_refused');
    expect(await fails(`update commercial_education.program_offers set program_id=$2,revision=revision+1 where id=$1`, [offer.offerId, unpublished])).toMatch(/program_offer_identity_immutable|foreign key/);
    expect(await fails(`update commercial_education.program_offers set revision=revision+2 where id=$1`, [offer.offerId])).toContain('program_offer_revision_must_increase');
    expect(await fails(`delete from commercial_education.program_offers where id=$1`, [offer.offerId])).toContain('program_offer_append_only');
    // A second published offer for the same program is refused.
    const second = await ledger().execute(me, { action: 'create', programId: program, terms: paid({ name: 'Second' }) });
    const secondOffer = (second as { offer: ProgramOffer }).offer;
    await ledger().execute(me, { action: 'approve_provider_mapping', offerId: secondOffer.offerId, expectedRevision: 1 });
    expect((await refusal(() => ledger().execute(me, { action: 'publish', offerId: secondOffer.offerId, expectedRevision: 2 }))).category).toBe('state_invalid');
    await ledger().execute(me, { action: 'retire', offerId: secondOffer.offerId, expectedRevision: 2, reason: 'duplicate draft' });
  });
  it('a changed curriculum withholds purchase of the published offer and refuses a draft bound to the old version', async () => {
    const draft = await ledger().execute(me, { action: 'create', programId: program, terms: paid({ name: 'Bound to version one' }) });
    const bound = (draft as { offer: ProgramOffer }).offer;
    await ledger().execute(me, { action: 'approve_provider_mapping', offerId: bound.offerId, expectedRevision: 1 });
    await publishVersion(version2, program, org, 2, 'b');
    expect(await ledger().availability(org, program)).toMatchObject({ available: false, reason: 'curriculum_changed' });
    const refused = await refusal(() => ledger().execute(me, { action: 'publish', offerId: bound.offerId, expectedRevision: 2 }));
    expect(refused.category).toBe('publish_refused');
    expect(refused.holds).toEqual(['curriculum_changed']);
    const list = await ledger().execute(me, { action: 'list', programId: program });
    expect(list.action === 'list' && list.curriculum).toMatchObject({ versionId: version2, version: 2 });
    await ledger().execute(me, { action: 'retire', offerId: bound.offerId, expectedRevision: 2, reason: 'superseded curriculum' });
  });
  it('retiring is terminal; a retired program answers retired, and a program with no offer answers absent', async () => {
    const retired = await ledger().execute(me, { action: 'retire', offerId: offer.offerId, expectedRevision: 8, reason: 'Fictional retirement' });
    expect((retired as { offer: ProgramOffer }).offer).toMatchObject({ state: 'retired', revision: 9 });
    expect((await refusal(() => ledger().execute(me, { action: 'retire', offerId: offer.offerId, expectedRevision: 9, reason: 'again' }))).category).toBe('state_invalid');
    expect(await fails(`update commercial_education.program_offers set state='published',revision=revision+1 where id=$1`, [offer.offerId])).toContain('program_offer_transition_refused');
    expect(await ledger().availability(org, program)).toMatchObject({ available: false, reason: 'offer_retired' });
    expect(await ledger().availability(org, unpublished)).toMatchObject({ available: false, reason: 'offer_absent' });
    expect(await ledger().availability(otherOrg, program)).toMatchObject({ available: false, reason: 'offer_absent' });
  });
  it('complimentary is a named mode with an authorizer and a written reason; the revision log is append-only and complete', async () => {
    const comp = await ledger().execute(me, { action: 'create', programId: program, terms: { mode: 'complimentary', name: 'Clinic-arranged access', reason: 'Fictional authorized complimentary access for review', accessTermsVersion: 'education-access-terms/1', accessDurationDays: 90 } });
    const compOffer = (comp as { offer: ProgramOffer }).offer;
    expect(compOffer).toMatchObject({ mode: 'complimentary', authorization: { authorizedBy: staff, reason: 'Fictional authorized complimentary access for review' } });
    expect((await refusal(() => ledger().execute(me, { action: 'create', programId: program, terms: { mode: 'complimentary', name: 'No reason', reason: 'short', accessTermsVersion: null, accessDurationDays: null } }))).category).toBe('request_invalid');
    await ledger().execute(me, { action: 'publish', offerId: compOffer.offerId, expectedRevision: 1 });
    expect(await ledger().availability(org, program)).toMatchObject({ available: false, reason: 'complimentary_mode' });
    const log = await db.query<{ offer_id: string; revision: number; action: string; actor: string }>('select offer_id,revision,action,actor_person_id as actor from commercial_education.program_offer_revisions where offer_id=$1 order by revision', [offer.offerId]);
    expect(log.rows.map(r => [r.revision, r.action])).toEqual([[1, 'create'], [2, 'revise'], [3, 'revise'], [4, 'approve_provider_mapping'], [5, 'revise'], [6, 'revise'], [7, 'approve_provider_mapping'], [8, 'publish'], [9, 'retire']]);
    expect(log.rows.every(r => r.actor === staff)).toBe(true);
    expect(await fails('delete from commercial_education.program_offer_revisions where offer_id=$1', [offer.offerId])).toContain('append_only_record');
    expect(await fails("update commercial_education.program_offer_revisions set action='publish' where offer_id=$1 and revision=1", [offer.offerId])).toContain('append_only_record');
  });
});
