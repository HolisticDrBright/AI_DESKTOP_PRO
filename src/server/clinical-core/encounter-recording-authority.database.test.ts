import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

let db: PGlite;
const org = randomUUID(), otherOrg = randomUUID(), actor = randomUUID(), colleague = randomUUID();
const consumer = randomUUID(), staff = randomUUID(), outsider = randomUUID(), patient = randomUUID();
const tables = ["recording_controls", "recording_consent_releases", "recording_participants",
  "recording_representative_authorities", "recording_consent_grants", "recording_consent_withdrawals",
  "recording_capture_releases", "encounter_captures", "recording_authority_events"];
type Capture = { recordingId: string; sessionId: string; captureToken: string; authorityEpoch: number; status: string; replayed: boolean };
async function call<T = unknown>(sql: string, args: unknown[] = [], who = actor, pool = "workforce", organization = org) {
  return db.transaction(async tx => {
    await tx.exec("set local role clinical_core_api");
    await tx.query("select clinical_private.set_request_context($1,$2,$3,$4,'clinical_data','production-clinical','clinical_phi')",
      [who, organization, pool, "subject-" + who]);
    return (await tx.query<{ result: T }>(sql, args)).rows[0]?.result;
  });
}
async function encounter() {
  return (await call<string>("select clinical_core.start_encounter($1,$2) as result", [org, patient]))!;
}
const participant = (e: string, kind = "patient", self = true) => call<string>(
  "select clinical_private.add_encounter_recording_participant($1,$2,'FICTIONAL PARTICIPANT',$3) as result", [e, kind, self]);
async function release(scope = "recording", options: { organization?: string; corrupt?: boolean; future?: boolean } = {}) {
  const id = randomUUID();
  await db.query(`insert into clinical_private.recording_consent_releases
    (id,organization_id,scope,version,locale,jurisdiction,content,content_sha256,approved_by,approved_at)
    values($1::uuid,$2,$3,($1::uuid)::text,'en','FICTIONAL','FICTIONAL CONSENT ONLY',
      case when $4 then repeat('a',64) else encode(public.digest('FICTIONAL CONSENT ONLY','sha256'),'hex') end,
      'FICTIONAL TEST REVIEW, NOT APPROVAL',clock_timestamp()+case when $5 then interval '1 day' else interval '-1 day' end)`,
    [id, options.organization ?? org, scope, Boolean(options.corrupt), Boolean(options.future)]);
  return id;
}
async function policy(configuration: Record<string, unknown> = { provider: "aws_healthscribe", region: "us-east-2", maxRecordingBytes: 1000000, audioRetentionHours: 24 }) {
  const id = randomUUID();
  await db.query(`insert into clinical_private.recording_capture_releases
    (id,organization_id,configuration,configuration_sha256,qualification_sha256,approved_by,approved_at,expires_at)
    values($1,$2,$3::jsonb,encode(public.digest(($3::jsonb)::text,'sha256'),'hex'),repeat('a',64),
      'FICTIONAL IN-MEMORY QUALIFICATION',clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day')`,
    [id, org, JSON.stringify(configuration)]);
  return id;
}
const grant = (p: string, d: string | null, command = randomUUID(), authority: string | null = null) => call<string>(
  "select clinical_private.grant_encounter_recording_consent($1,$2,$3,'written','FICTIONAL ACK',$4) as result", [p, d, command, authority]);
const begin = (e: string, config: string, command = randomUUID(), contentType = "audio/webm") => call<Capture>(
  "select clinical_private.begin_encounter_capture($1,$2,$3,$4) as result", [e, config, command, contentType]);
const authorize = (c: Capture, scope = "recording", who = actor) => call(
  "select clinical_private.authorize_encounter_capture($1,$2,$3,$4) as result",
  [c.recordingId, c.sessionId, c.captureToken, scope], who);
const withdraw = (id: string) => call("select clinical_private.withdraw_encounter_recording_consent($1,'FICTIONAL WITHDRAWAL') as result", [id]);
async function ready() {
  const e = await encounter(), p = (await participant(e))!, clinician = (await participant(e, "practitioner"))!;
  const d = await release(), pGrant = (await grant(p, d))!, clinicianGrant = (await grant(clinician, d))!;
  return { e, p, clinician, d, pGrant, clinicianGrant, config: await policy() };
}

beforeAll(async () => {
  execFileSync(process.execPath, ["scripts/build-aws-production-clinical-core.mjs"], { stdio: "pipe" });
  const directory = resolve("dist/aws-clinical-core/production-migrations");
  const manifest = JSON.parse(readFileSync(resolve(directory, "manifest.json"), "utf8")) as { migrations: { file: string }[] };
  db = new PGlite({ extensions: { pgcrypto } });
  for (const entry of manifest.migrations) {
    try { await db.exec(readFileSync(resolve(directory, entry.file), "utf8")); }
    catch (cause) { throw new Error(entry.file + ": " + (cause instanceof Error ? cause.message : "failed")); }
  }
  // No deployment rows or clinical approvals. Everything below is isolated fictional SQL data.
  for (const table of tables) expect((await db.query<{ n: number }>(`select count(*)::int n from clinical_private.${table}`)).rows[0].n).toBe(0);
  for (const id of [org, otherOrg]) await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL')", [id]);
  for (const id of [actor, colleague, consumer, staff, outsider]) {
    await db.query("insert into clinical_core.persons(id,subject_key) values($1,$2)", [id, "subject_" + id.replaceAll("-", "")]);
    await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)",
      [id, id === consumer ? "consumer" : "workforce", "subject-" + id]);
    if (id !== consumer) await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,$3)",
      [id === outsider ? otherOrg : org, id, id === staff ? "staff" : "practitioner"]);
  }
  await db.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'Fictional','Patient')",
    [patient, org, "patient_" + patient.replaceAll("-", "")]);
}, 30000);
afterAll(async () => { await db?.close(); });

describe("AWS encounter recording authority: production SQL, fictional in-memory fixtures", () => {
  it("enforces default-deny tables and denies every helper to the API role", async () => {
    for (const table of tables) {
      const r = (await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        "select relrowsecurity,relforcerowsecurity from pg_class where oid=$1::regclass", ["clinical_private." + table])).rows[0];
      expect(r).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      await expect(call(`select * from clinical_private.${table}`)).rejects.toThrow("permission denied");
    }
    await expect(call("select clinical_private.lock_recording_encounter($1)", [randomUUID()])).rejects.toThrow("permission denied");
    await expect(call("select clinical_private.recording_grants_for_scope($1,'recording',$2::uuid[])", [randomUUID(), []])).rejects.toThrow("permission denied");
  });
  it("rejects consumer, staff, cross-organization and missing encounter access", async () => {
    const e = await encounter(), sql = "select clinical_private.add_encounter_recording_participant($1,'patient','FICTIONAL',true) as result";
    await expect(call(sql, [e], consumer, "consumer")).rejects.toThrow();
    await expect(call(sql, [e], staff)).rejects.toThrow("clinical_role_required");
    await expect(call(sql, [e], outsider, "workforce", otherOrg)).rejects.toThrow();
    await expect(call(sql, [randomUUID()])).rejects.toThrow("recording_access_refused");
  });
  it("requires an intact, current, same-organization consent release", async () => {
    const p = (await participant(await encounter()))!;
    for (const d of [randomUUID(), await release("recording", { corrupt: true }), await release("recording", { future: true }),
      await release("recording", { organization: otherOrg })]) await expect(grant(p, d)).rejects.toThrow("recording_consent_release_required");
    const retired = await release();
    await db.query("update clinical_private.recording_consent_releases set retired_at=clock_timestamp() where id=$1", [retired]);
    await expect(grant(p, retired)).rejects.toThrow("recording_consent_release_required");
  });
  it("binds idempotent consent receipts to exact command content, without resurrecting withdrawal", async () => {
    const p = (await participant(await encounter()))!, d = await release(), command = randomUUID();
    const id = (await grant(p, d, command))!;
    expect(await grant(p, d, command)).toBe(id);
    await expect(grant(p, null, command)).rejects.toThrow("recording_consent_conflict");
    await expect(grant(p, await release(), command)).rejects.toThrow("recording_consent_conflict");
    await withdraw(id); expect(await grant(p, d, command)).toBe(id);
    expect((await db.query("select * from clinical_private.recording_consent_withdrawals where grant_id=$1", [id])).rows).toHaveLength(1);
  });
  it("requires reviewed participant-specific representative authority", async () => {
    const p = (await participant(await encounter(), "patient", false))!, d = await release();
    await expect(grant(p, d)).rejects.toThrow("recording_representative_authority_required");
    const a = randomUUID();
    await db.query(`insert into clinical_private.recording_representative_authorities
      (id,participant_id,basis,representative_name,evidence_sha256,reviewed_by,reviewed_at,expires_at)
      values($1,$2,'minor_guardian','FICTIONAL GUARDIAN',repeat('a',64),$3,clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day')`, [a, p, colleague]);
    expect(await grant(p, d, randomUUID(), a)).toMatch(/^[a-f0-9-]{36}$/);
    const other = (await participant(await encounter(), "patient", false))!;
    await expect(grant(other, d, randomUUID(), a)).rejects.toThrow("recording_representative_authority_required");
  });
  it("requires the roster, every participant's recording consent and a qualified capture release", async () => {
    const e = await encounter(), config = await policy();
    await expect(begin(e, config)).rejects.toThrow("recording_roster_required");
    const p = (await participant(e))!, clinician = (await participant(e, "practitioner"))!, d = await release();
    await grant(p, d);
    await expect(begin(e, config)).rejects.toThrow("recording_consent_required");
    await grant(clinician, d);
    await expect(begin(e, randomUUID())).rejects.toThrow("recording_capture_release_required");
    await expect(begin(e, await policy({ provider: "unapproved", region: "us-east-2", maxRecordingBytes: 100, audioRetentionHours: 24 }))).rejects.toThrow("recording_capture_release_required");
    await expect(begin(e, await policy({ provider: "aws_healthscribe", region: "us-east-2", maxRecordingBytes: 100, audioRetentionHours: 25 }))).rejects.toThrow("recording_capture_release_required");
    expect(await begin(e, config)).toMatchObject({ status: "capturing", replayed: false });
  });
  it("stores hashes only, does not replay capture secrets, and refuses competing starts", async () => {
    const f = await ready(), command = randomUUID(), c = (await begin(f.e, f.config, command))!;
    expect(c.captureToken).toMatch(/^[a-f0-9]{64}$/);
    const replay = (await begin(f.e, f.config, command))!;
    expect(replay).toMatchObject({ recordingId: c.recordingId, sessionId: c.sessionId, replayed: true });
    expect(replay).not.toHaveProperty("captureToken");
    await expect(begin(f.e, f.config, command, "audio/mp4")).rejects.toThrow("recording_capture_conflict");
    await expect(begin(f.e, f.config)).rejects.toThrow("recording_disposition_required");
    const persisted = await db.query("select row_to_json(r) as row from clinical_private.encounter_captures r where id=$1", [c.recordingId]);
    expect(JSON.stringify(persisted.rows)).not.toContain(c.captureToken);
    expect(JSON.stringify((await db.query("select * from clinical_private.recording_authority_events where encounter_id=$1", [f.e])).rows))
      .not.toMatch(/FICTIONAL ACK|FICTIONAL PARTICIPANT|captureToken|token_sha256/);
  });
  it("binds capture to actor/session/token/epoch and independently checks each scope", async () => {
    const f = await ready(), c = (await begin(f.e, f.config))!;
    expect(await authorize(c)).toMatchObject({ recordingId: c.recordingId, scope: "recording" });
    await expect(authorize({ ...c, sessionId: randomUUID() })).rejects.toThrow("recording_capture_refused");
    await expect(authorize({ ...c, captureToken: "0".repeat(64) })).rejects.toThrow("recording_capture_refused");
    await expect(authorize(c, "recording", colleague)).rejects.toThrow("recording_capture_refused");
    await expect(authorize(c, "transcription")).rejects.toThrow("recording_consent_required");
    const d = await release("transcription"); await grant(f.p, d); await grant(f.clinician, d);
    expect(await authorize(c, "transcription")).toMatchObject({ scope: "transcription" });
    await expect(authorize(c, "ai_drafting")).rejects.toThrow("recording_consent_required");
    await expect(authorize(c, "invented")).rejects.toThrow("recording_consent_required");
  });
  it("late join pauses and invalidates the old epoch even after the new participant consents", async () => {
    const f = await ready(), c = (await begin(f.e, f.config))!, late = (await participant(f.e, "caregiver"))!;
    await grant(late, f.d);
    await expect(authorize(c)).rejects.toThrow("recording_capture_refused");
    const row = (await db.query<{ status: string; epoch: number }>(`select r.status,c.authority_epoch::int epoch
      from clinical_private.encounter_captures r join clinical_private.recording_controls c on c.encounter_id=r.encounter_id where r.id=$1`, [c.recordingId])).rows[0];
    expect(row.status).toBe("paused"); expect(row.epoch).toBeGreaterThan(c.authorityEpoch);
  });
  it("withdrawal of transcription revokes capture and re-consent cannot revive an old token", async () => {
    const f = await ready(), d = await release("transcription");
    const grantId = (await grant(f.p, d))!; await grant(f.clinician, d);
    const c = (await begin(f.e, f.config))!;
    await withdraw(grantId); await grant(f.p, d);
    await expect(authorize(c)).rejects.toThrow("recording_capture_refused");
    await expect(begin(f.e, f.config)).rejects.toThrow("recording_disposition_required");
    expect((await db.query<{ status: string }>("select status from clinical_private.encounter_captures where id=$1", [c.recordingId])).rows[0].status).toBe("revoked");
  });
  it("expires authorization and rechecks release retirement and encounter closure", async () => {
    const f = await ready(), c = (await begin(f.e, f.config))!;
    await db.query("update clinical_private.encounter_captures set token_expires_at=clock_timestamp()-interval '1 second' where id=$1", [c.recordingId]);
    await expect(authorize(c)).rejects.toThrow("recording_capture_refused");
    const next = await ready(), fresh = (await begin(next.e, next.config))!;
    await db.query("update clinical_private.recording_capture_releases set retired_at=clock_timestamp() where id=$1", [next.config]);
    await expect(authorize(fresh)).rejects.toThrow("recording_capture_release_required");
    const closed = await ready(), active = (await begin(closed.e, closed.config))!;
    await db.query("update clinical_core.encounters set status='completed' where id=$1", [closed.e]);
    await expect(authorize(active)).rejects.toThrow("recording_capture_refused");
  });
  it("keeps grant/withdrawal/events and release content immutable", async () => {
    const f = await ready(); await withdraw(f.pGrant);
    await expect(db.query("update clinical_private.recording_consent_grants set acknowledgment='changed' where id=$1", [f.pGrant])).rejects.toThrow();
    await expect(db.query("delete from clinical_private.recording_consent_withdrawals where grant_id=$1", [f.pGrant])).rejects.toThrow();
    await expect(db.query("delete from clinical_private.recording_authority_events where encounter_id=$1", [f.e])).rejects.toThrow();
    await expect(db.query("update clinical_private.recording_consent_releases set content='changed' where id=$1", [f.d])).rejects.toThrow("recording_release_immutable");
    await db.query("update clinical_private.recording_consent_releases set retired_at=clock_timestamp() where id=$1", [f.d]);
    await expect(db.query("update clinical_private.recording_consent_releases set retired_at=null where id=$1", [f.d])).rejects.toThrow("recording_release_immutable");
  });
  it.each(["provider", "region", "maxRecordingBytes", "audioRetentionHours"])("refuses null or missing %s in a capture release without writing a capture or audit event", async key => {
    const f = await ready();
    const before = (await db.query("select * from clinical_private.recording_authority_events where encounter_id=$1", [f.e])).rows;
    for (const missing of [false, true]) {
      const configuration: Record<string, unknown> = { provider: "aws_healthscribe", region: "us-east-2", maxRecordingBytes: 100, audioRetentionHours: 1 };
      if (missing) delete configuration[key]; else configuration[key] = null;
      await expect(begin(f.e, await policy(configuration))).rejects.toThrow("recording_capture_release_required");
    }
    expect((await db.query("select * from clinical_private.encounter_captures where encounter_id=$1", [f.e])).rows).toEqual([]);
    expect((await db.query("select * from clinical_private.recording_authority_events where encounter_id=$1", [f.e])).rows).toEqual(before);
  });
  it("rechecks representative revocation on every authorization and preserves the reviewed evidence", async () => {
    const e = await encounter(), p = (await participant(e, "patient", false))!, clinician = (await participant(e, "practitioner"))!;
    const a = randomUUID(), d = await release();
    await db.query(`insert into clinical_private.recording_representative_authorities
      (id,participant_id,basis,representative_name,evidence_sha256,reviewed_by,reviewed_at,expires_at)
      values($1,$2,'minor_guardian','FICTIONAL GUARDIAN',repeat('b',64),$3,clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day')`, [a, p, colleague]);
    await grant(p, d, randomUUID(), a); await grant(clinician, d);
    const c = (await begin(e, await policy()))!;
    expect(await authorize(c)).toMatchObject({ scope: "recording" });
    await expect(db.query("update clinical_private.recording_representative_authorities set evidence_sha256=repeat('c',64) where id=$1", [a])).rejects.toThrow("recording_authority_immutable");
    await db.query("update clinical_private.recording_representative_authorities set revoked_at=clock_timestamp() where id=$1", [a]);
    await expect(authorize(c)).rejects.toThrow("recording_consent_required");
    await expect(db.query("update clinical_private.recording_representative_authorities set revoked_at=null where id=$1", [a])).rejects.toThrow("recording_authority_immutable");
    await expect(db.query("delete from clinical_private.recording_representative_authorities where id=$1", [a])).rejects.toThrow("recording_authority_immutable");
  });
  it("rechecks workforce membership instead of trusting an issued capture token", async () => {
    const f = await ready(), c = (await begin(f.e, f.config))!;
    await db.query("update clinical_core.organization_memberships set role='staff' where organization_id=$1 and person_id=$2", [org, actor]);
    try { await expect(authorize(c)).rejects.toThrow("clinical_role_required"); }
    finally { await db.query("update clinical_core.organization_memberships set role='practitioner' where organization_id=$1 and person_id=$2", [org, actor]); }
  });
});
