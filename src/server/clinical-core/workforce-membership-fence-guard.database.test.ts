import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { FictionalAppointmentStore } from './appointment-operation-store.test-support';
import { createAwsProductionDesktopAdapter } from './aws-production-desktop';
import type { ClinicalCoreDatabase } from './database';
import { createMembershipFenceWriter, MEMBERSHIP_FENCE_PROTOCOL, membershipFenceKey, type MembershipFenceWriter } from './membership-fence';
import { classifyDatabaseRejection } from './rds-data-database';

// The membership-changing half of the workforce membership fence: the real production Desktop adapter over the
// assembled production schema plus the UNREGISTERED current-membership setter and the UNREGISTERED fence guard, in
// PGlite with fictional rows; the fence table is the fictional conditional store. Nothing here registers, applies or
// deploys SQL, and no fence table exists anywhere.
const SETTER = 'infra/aws-clinical-core/source-candidates/workforce-current-membership-context.sql';
const GUARD = 'infra/aws-clinical-core/source-candidates/workforce-membership-fence-guard.sql';
const ROLLBACK = 'infra/aws-clinical-core/source-candidates/workforce-membership-fence-guard-rollback.sql';
/** The exact candidate reviewed here. Any edit to it must change this digest and the return document together. */
const GUARD_SHA256 = 'd3bb86387a75da63a7742530acb571e0e1a8625c52343fd32db2a726596ff5ec';
const FENCE_TABLE = 'fictional-membership-fences';
const CLINIC = randomUUID(), OTHER = randomUUID();
const person = () => ({ person: randomUUID(), sub: randomUUID(), membership: randomUUID() });
const owner = person(), practitioner = person(), colleague = person(), elsewhere = person(), applicant = person();
const PRACTITIONER_EMAIL = 'fictional.practitioner@example.test';

let db: PGlite;
const timeline: string[] = [];
const unwrap = (value: unknown) => value && typeof value === 'object' && 'kind' in value && value.kind === 'uuid'
  && 'value' in value && typeof value.value === 'string' ? value.value : value;
const database: ClinicalCoreDatabase = {
  transaction: async (work) => {
    try {
      const result = await db.transaction(async (tx) => {
        await tx.exec('set local role clinical_core_api');
        return work({ query: async (sql, parameters = []) => {
          timeline.push(`sql ${/clinical_[a-z]+\.[a-z_]+|set_config/.exec(sql)?.[0] ?? sql.slice(0, 40)}`);
          return await tx.query(sql, parameters.map(unwrap)) as never;
        } });
      });
      timeline.push('commit');
      return result;
    } catch (cause) {
      timeline.push('rollback');
      const message = cause instanceof Error ? cause.message : String(cause);
      throw classifyDatabaseRejection({ name: 'DatabaseErrorException', message }) ?? cause;
    }
  },
};
let fences: FictionalAppointmentStore;
let failBegin: boolean;
const writer = (): MembershipFenceWriter => createMembershipFenceWriter(async (command) => {
  const phase = String((command.input as { UpdateExpression?: string }).UpdateExpression ?? '').includes('DELETE pendingChanges') ? 'settle' : 'begin';
  timeline.push(`fence ${phase}`);
  if (phase === 'begin' && failBegin) throw new Error('fictional_fence_unavailable');
  return fences.send(command as never);
}, FENCE_TABLE);
const fence = (subject: string) => fences.get(membershipFenceKey({ kind: 'subject', subject })) as Record<string, unknown> | undefined;
const status = async (who: { membership: string }) => (await db.query<{ status: string; role: string }>(
  'select status, role from clinical_core.organization_memberships where id=$1', [who.membership])).rows[0];
const asOwner = { subject: owner.sub, selectedOrganizationId: CLINIC };
/** A transaction as the API role with the owner's current context, and optionally an acknowledgement. */
async function asApi(sql: string, parameters: unknown[] = [], acknowledgement?: string) {
  return db.transaction(async (tx) => {
    await tx.exec('set local role clinical_core_api');
    await tx.query("select clinical_private.set_current_workforce_context($1,$2,'clinical_data')", [owner.sub, CLINIC]);
    if (acknowledgement) await tx.query("select set_config('clinical.membership_fence_ack',$1,true)", [acknowledgement]);
    return tx.query(sql, parameters);
  });
}
/** An operator's ad-hoc statement, as the database owner, with no request context at all. */
async function asOperator(sql: string, parameters: unknown[] = [], acknowledgement?: string) {
  return db.transaction(async (tx) => {
    if (acknowledgement) await tx.query("select set_config('clinical.membership_fence_ack',$1,true)", [acknowledgement]);
    return tx.query(sql, parameters);
  });
}
const ack = (...targets: string[]) => [MEMBERSHIP_FENCE_PROTOCOL, randomUUID(), ...targets].join(' ');
async function restore() {
  await asOperator(`update clinical_core.organization_memberships set status='active', role='practitioner' where id=$1`,
    [practitioner.membership], ack(`subject:${practitioner.sub}`));
}

beforeAll(async () => {
  const { manifest, files } = JSON.parse(execFileSync(process.execPath, [
    'scripts/build-aws-production-clinical-core.mjs', '--json',
  ], { encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }));
  expect(manifest.migrations.some((m: { file: string }) => /membership-fence|current-membership-context/.test(m.file))).toBe(false);
  db = new PGlite({ extensions: { pgcrypto } });
  for (const migration of manifest.migrations) await db.exec(files[migration.file]);
  await db.exec(readFileSync(SETTER, 'utf8'));
  await db.query(`insert into clinical_core.organizations(id,organization_label) values ($1,'FICTIONAL CLINIC'),($2,'FICTIONAL OTHER')`, [CLINIC, OTHER]);
  for (const who of [owner, practitioner, colleague, elsewhere, applicant]) {
    await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [who.person, `subject_${who.person.replaceAll('-', '')}`]);
    await db.query(`insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)`,
      [who.person, who.sub]);
  }
  await db.query(`insert into clinical_core.organization_memberships(id,organization_id,person_id,role,status) values
    ($1,$2,$3,'owner','active'),($4,$2,$5,'practitioner','active'),($6,$2,$7,'practitioner','active'),($8,$9,$10,'practitioner','active'),
    ($11,$2,$12,'practitioner','suspended')`,
  [owner.membership, CLINIC, owner.person, practitioner.membership, practitioner.person, colleague.membership, colleague.person,
    elsewhere.membership, OTHER, elsewhere.person, applicant.membership, applicant.person]);
  await db.query(`insert into clinical_core.workforce_identity_directory(person_id,identity_subject,email_sha256) values($1,$2,$3)`,
    [practitioner.person, practitioner.sub, createHash('sha256').update(PRACTITIONER_EMAIL).digest('hex')]);
  await db.exec(readFileSync(GUARD, 'utf8'));
}, 120_000);
afterAll(async () => { await db?.close(); });
beforeEach(() => { timeline.length = 0; fences = new FictionalAppointmentStore(); failBegin = false; });

describe('the membership writer begins the fence before a change can commit', () => {
  it('suspends a member only after the fence for their subject has begun, and settles it after the commit', async () => {
    onTestFinished(restore);
    const adapter = createAwsProductionDesktopAdapter(database, undefined, { membershipFence: writer() });
    await expect(adapter.executeWithCurrentMembership!(asOwner, { kind: 'rpc', functionName: 'remove_org_member',
      args: { _membership_id: practitioner.membership } })).resolves.toBeNull();
    expect(timeline).toEqual(['sql clinical_private.set_current_workforce_context', 'sql clinical_private.membership_fence_subjects',
      'fence begin', 'sql set_config', 'sql clinical_core.remove_org_member', 'commit', 'fence settle']);
    expect(await status(practitioner)).toEqual({ status: 'suspended', role: 'practitioner' });
    // Begun and settled: two versions on, nothing in flight. A write that read version 0 or 1 cannot commit now.
    expect(fence(practitioner.sub)).toMatchObject({ fenceProtocol: MEMBERSHIP_FENCE_PROTOCOL, fenceVersion: 2 });
    expect(fence(practitioner.sub)).not.toHaveProperty('pendingChanges');
    expect(fence(owner.sub)).toBeUndefined();
  });

  it('fences a role change the same way, and settles even when the change itself is refused', async () => {
    const adapter = createAwsProductionDesktopAdapter(database, undefined, { membershipFence: writer() });
    onTestFinished(restore);
    await adapter.executeWithCurrentMembership!(asOwner, { kind: 'rpc', functionName: 'set_org_member_role',
      args: { _membership_id: practitioner.membership, _role: 'staff' } });
    expect(await status(practitioner)).toEqual({ status: 'active', role: 'staff' });
    expect(timeline.indexOf('fence begin')).toBeLessThan(timeline.indexOf('commit'));
    expect(timeline.at(-1)).toBe('fence settle');
    timeline.length = 0;
    // The owner may not suspend themself: the database refuses, the transaction rolls back, and the fence still settles.
    await expect(adapter.executeWithCurrentMembership!(asOwner, { kind: 'rpc', functionName: 'remove_org_member',
      args: { _membership_id: owner.membership } })).rejects.toMatchObject({ name: 'ProductionDesktopError' });
    expect(timeline.slice(-2)).toEqual(['rollback', 'fence settle']);
    expect(fence(owner.sub)).not.toHaveProperty('pendingChanges');
  });

  it('under database_current, refuses both changes without a fence writer, before any change', async () => {
    const adapter = createAwsProductionDesktopAdapter(database);
    for (const request of [{ functionName: 'remove_org_member', args: { _membership_id: practitioner.membership } },
      { functionName: 'set_org_member_role', args: { _membership_id: practitioner.membership, _role: 'staff' } }]) {
      await expect(adapter.executeWithCurrentMembership!(asOwner, { kind: 'rpc', ...request }))
        .rejects.toMatchObject({ category: 'membership_fence_unavailable' });
    }
    expect(timeline.filter((entry) => entry.includes('clinical_core.'))).toEqual([]);
    expect(await status(practitioner)).toEqual({ status: 'active', role: 'practitioner' });
  });

  it('refuses the change when its begin cannot be confirmed, and settles whatever that begin may have reached', async () => {
    failBegin = true;
    const adapter = createAwsProductionDesktopAdapter(database, undefined, { membershipFence: writer() });
    await expect(adapter.executeWithCurrentMembership!(asOwner, { kind: 'rpc', functionName: 'remove_org_member',
      args: { _membership_id: practitioner.membership } })).rejects.toMatchObject({ category: 'membership_fence_unavailable' });
    expect(timeline).not.toContain('sql clinical_core.remove_org_member');
    expect(timeline).toContain('fence settle');
    expect(await status(practitioner)).toEqual({ status: 'active', role: 'practitioner' });
  });

  it('names only subjects of the caller\'s own clinic; a membership elsewhere names none and is still refused by the RPC', async () => {
    const { rows } = await asApi('select clinical_private.membership_fence_subjects($1) as subjects', [elsewhere.membership]);
    expect(rows).toEqual([{ subjects: [] }]);
    const own = await asApi('select clinical_private.membership_fence_subjects($1) as subjects', [practitioner.membership]);
    expect(own.rows).toEqual([{ subjects: [practitioner.sub.toLowerCase()] }]);
    const adapter = createAwsProductionDesktopAdapter(database, undefined, { membershipFence: writer() });
    await expect(adapter.executeWithCurrentMembership!(asOwner, { kind: 'rpc', functionName: 'remove_org_member',
      args: { _membership_id: elsewhere.membership } })).rejects.toMatchObject({ name: 'ProductionDesktopError' });
    expect(timeline).not.toContain('fence begin');
  });
});

describe('the guard candidate', () => {
  it('refuses an authority-reducing membership change that carries no acknowledgement, from any path', async () => {
    await expect(asApi('select clinical_core.remove_org_member($1)', [practitioner.membership])).rejects.toThrow(/membership_fence_required/);
    await expect(asApi('select clinical_core.set_org_member_role($1,$2)', [practitioner.membership, 'staff'])).rejects.toThrow(/membership_fence_required/);
    // The deployed re-invite can demote an active member (its upsert keeps `active` and takes the new role): refused too.
    await expect(asApi(`select clinical_core.add_org_member($1,$2,'member')`, [CLINIC, PRACTITIONER_EMAIL])).rejects.toThrow(/membership_fence_required/);
    await expect(asOperator(`update clinical_core.organization_memberships set status='suspended' where id=$1`, [practitioner.membership]))
      .rejects.toThrow(/membership_fence_required/);
    await expect(asOperator('delete from clinical_core.organization_memberships where id=$1', [practitioner.membership]))
      .rejects.toThrow(/membership_fence_required/);
    expect(await status(practitioner)).toEqual({ status: 'active', role: 'practitioner' });
  });

  it('accepts only an exact acknowledgement for that member\'s own subject', async () => {
    const suspend = `update clinical_core.organization_memberships set status='suspended' where id=$1`;
    for (const wrong of [
      ack(`subject:${colleague.sub}`),
      `membership-fence/0 ${randomUUID()} subject:${practitioner.sub}`,
      `${MEMBERSHIP_FENCE_PROTOCOL} not-a-change subject:${practitioner.sub}`,
      `${MEMBERSHIP_FENCE_PROTOCOL} ${randomUUID()}`,
      ack(`clinic:${CLINIC}`),
      '',
    ]) await expect(asOperator(suspend, [practitioner.membership], wrong || undefined), wrong).rejects.toThrow(/membership_fence_required/);
    onTestFinished(restore);
    await asOperator(suspend, [practitioner.membership], ack(`subject:${colleague.sub}`, `subject:${practitioner.sub}`));
    expect(await status(practitioner)).toEqual({ status: 'suspended', role: 'practitioner' });
  });

  it('guards the identity, person and clinic rows the current-membership check reads', async () => {
    await expect(asOperator(`update clinical_core.identities set status='disabled' where identity_subject=$1`, [practitioner.sub]))
      .rejects.toThrow(/membership_fence_required/);
    await expect(asOperator(`update clinical_core.persons set status='disabled' where id=$1`, [practitioner.person]))
      .rejects.toThrow(/membership_fence_required/);
    await expect(asOperator(`update clinical_core.organizations set status='suspended' where id=$1`, [CLINIC]))
      .rejects.toThrow(/membership_fence_required/);
    await expect(asOperator(`update clinical_core.organizations set status='suspended' where id=$1`, [CLINIC], ack(`subject:${owner.sub}`)))
      .rejects.toThrow(/membership_fence_required/);
    await asOperator(`update clinical_core.organizations set status='suspended' where id=$1`, [CLINIC], ack(`clinic:${CLINIC}`));
    await asOperator(`update clinical_core.organizations set status='active' where id=$1`, [CLINIC]);
    await asOperator(`update clinical_core.identities set status='disabled' where identity_subject=$1`, [practitioner.sub], ack(`subject:${practitioner.sub}`));
    await asOperator(`update clinical_core.identities set status='active' where identity_subject=$1`, [practitioner.sub]);
  });

  it('leaves alone what grants or changes nothing: new invitations, approving a pending member, an already suspended row', async () => {
    const pending = randomUUID();
    await asOperator(`insert into clinical_core.organization_memberships(id,organization_id,person_id,role,status) values($1,$2,$3,'staff','pending')`,
      [pending, OTHER, practitioner.person]);
    await asOperator(`update clinical_core.organization_memberships set status='active' where id=$1`, [pending]);
    await asOperator(`update clinical_core.organization_memberships set role='staff' where id=$1`, [applicant.membership]);
    await asOperator(`update clinical_core.organization_memberships set role='practitioner' where id=$1`, [applicant.membership]);
    await asOperator(`delete from clinical_core.organization_memberships where id=$1`, [pending], ack(`subject:${practitioner.sub}`));
  });

  it('is the exact reviewed candidate, unregistered, and its rollback removes only the guard', async () => {
    const candidate = readFileSync(GUARD, 'utf8');
    expect(createHash('sha256').update(candidate, 'utf8').digest('hex')).toBe(GUARD_SHA256);
    expect(candidate.split('\n')[0]).toBe('-- UNREGISTERED, BLOCKED successor. No database has it, and no live API depends on it.');
    const suspend = `update clinical_core.organization_memberships set status='suspended' where id=$1`;
    await db.exec(readFileSync(ROLLBACK, 'utf8'));
    try {
      // Without the guard, the unfenced change commits again: exactly why the telehealth writes must be off first.
      await asOperator(suspend, [practitioner.membership]);
      expect(await status(practitioner)).toEqual({ status: 'suspended', role: 'practitioner' });
      await asOperator(`update clinical_core.organization_memberships set status='active' where id=$1`, [practitioner.membership]);
      await expect(db.exec(readFileSync(ROLLBACK, 'utf8'))).rejects.toThrow();
    } finally {
      await db.exec(candidate);
    }
    await expect(asOperator(suspend, [practitioner.membership])).rejects.toThrow(/membership_fence_required/);
  });
});
