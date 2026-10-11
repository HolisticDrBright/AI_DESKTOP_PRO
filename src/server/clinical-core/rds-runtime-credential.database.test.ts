import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { RUNTIME_CREDENTIAL_ADMISSION_SQL } from "./rds-runtime-credential";

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    create role clinical_admin login createrole createdb nosuperuser nobypassrls;
    create role clinical_core_api nologin nosuperuser nocreaterole nocreatedb nobypassrls;
    create role fullscript_draft_worker nologin nosuperuser nocreaterole nocreatedb nobypassrls;
    create role fictional_runtime login noinherit nosuperuser nocreaterole nocreatedb nobypassrls;
    create role fictional_other nologin;
    grant clinical_core_api to fictional_runtime with inherit false, set true;
    grant clinical_core_api to clinical_admin;
    create schema fictional_records authorization clinical_admin;
    create table fictional_records.values_only(a integer, b integer);
    alter table fictional_records.values_only owner to clinical_admin;
    create sequence fictional_records.counter;
    alter sequence fictional_records.counter owner to clinical_admin;
    create function fictional_records.private_function() returns integer language sql as 'select 1';
    alter function fictional_records.private_function() owner to clinical_admin;
    revoke all on function fictional_records.private_function() from public;
    grant usage on schema fictional_records to clinical_core_api;
    grant select(a) on fictional_records.values_only to clinical_core_api;
  `);
});
afterAll(async () => { await pg?.close(); });

async function admitted(setup: string, login = "fictional_runtime", target = "clinical_core_api") {
  await pg.exec("begin");
  try {
    if (setup) await pg.exec(setup);
    // Embedded session authorization is explicitly not native login evidence.
    await pg.exec(`set local session authorization ${login}`);
    return (await pg.query<{ runtime_credential_admitted: boolean }>(RUNTIME_CREDENTIAL_ADMISSION_SQL, [target]))
      .rows[0]?.runtime_credential_admitted;
  } finally {
    await pg.exec("rollback");
    // PGlite retains session authorization across this rollback; explicitly
    // restore its initial bootstrap identity before the next fixture setup.
    await pg.exec("set session authorization postgres; reset role");
  }
}

describe("actual runtime credential metadata SQL in embedded PostgreSQL", () => {
  test("admits a minimal dedicated login, including NOINHERIT with SET permission", async () => {
    expect(await admitted("")).toBe(true);
  });
  test("refuses the existing administrative-login pattern even without superuser or RLS bypass", async () => {
    expect(await admitted("", "clinical_admin")).toBe(false);
  });
  test.each([
    ["create role", "alter role fictional_runtime createrole"],
    ["create database", "alter role fictional_runtime createdb"],
    ["RLS bypass", "alter role fictional_runtime bypassrls"],
    ["replication", "alter role fictional_runtime replication"],
    ["superuser", "alter role fictional_runtime superuser"],
    ["non-login", "alter role fictional_runtime nologin"],
    ["administrative membership even without inheritance or SET", "grant clinical_admin to fictional_runtime with inherit false, set false"],
    ["unrelated membership", "grant fictional_other to fictional_runtime with inherit false, set false"],
    ["target privileged", "alter role clinical_core_api createrole"],
    ["target administrative membership", "revoke clinical_core_api from clinical_admin; grant clinical_admin to clinical_core_api with inherit false, set false"],
    ["schema creation", "grant create on schema public to fictional_runtime"],
    ["target schema creation", "grant create on schema public to clinical_core_api"],
    ["schema ownership", "alter schema fictional_records owner to fictional_runtime"],
    ["table ownership", "alter table fictional_records.values_only owner to fictional_runtime"],
    ["function ownership", "alter function fictional_records.private_function() owner to fictional_runtime"],
    ["table read beyond target", "grant select on fictional_records.values_only to fictional_runtime"],
    ["different column despite both roles having some column access", "grant select(b) on fictional_records.values_only to fictional_runtime"],
    ["table write", "grant update on fictional_records.values_only to fictional_runtime"],
    ["sequence grant", "grant usage on sequence fictional_records.counter to fictional_runtime"],
    ["function grant", "grant execute on function fictional_records.private_function() to fictional_runtime"],
    ["missing SET permission", "grant clinical_core_api to fictional_runtime with inherit false, set false"],
  ])("refuses %s", async (_name, setup) => {
    expect(await admitted(setup)).toBe(false);
  });
  test("refuses a missing target rather than an empty successful lookup", async () => {
    expect(await admitted("", "fictional_runtime", "fictional_missing_role")).toBe(false);
  });
  test("admits a separately bound worker login but refuses an API-to-worker substitution", async () => {
    const setup = "revoke clinical_core_api from fictional_runtime; grant fullscript_draft_worker to fictional_runtime with inherit false, set true";
    expect(await admitted(setup, "fictional_runtime", "fullscript_draft_worker")).toBe(true);
    expect(await admitted("", "fictional_runtime", "fullscript_draft_worker")).toBe(false);
  });
});
