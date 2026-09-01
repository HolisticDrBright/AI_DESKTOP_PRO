import { readFileSync } from "node:fs";
import { RDSDataClient, BeginTransactionCommand, CommitTransactionCommand, ExecuteStatementCommand, RollbackTransactionCommand } from "@aws-sdk/client-rds-data";

const [clusterArn, secretArn, databaseName, migrationPath, testPath] = process.argv.slice(2);
if (!clusterArn?.includes(":cluster:ai-clinical-core-synthetic-")
  || !secretArn?.includes(":secret:rds!cluster-")
  || !/^alp_chat_rls_synthetic_[a-z0-9_]{1,30}$/.test(databaseName ?? "")
  || !migrationPath || !testPath) throw new Error("isolated_chat_test_configuration_refused");
const client = new RDSDataClient({ region: "us-east-2" });
const base = { resourceArn: clusterArn, secretArn };

function split(sql) {
  const out=[]; let start=0,index=0,state="normal",tag="",depth=0;
  while(index<sql.length){const c=sql[index],n=sql[index+1];
    if(state==="normal"){if(c==="'"){state="single";index++;continue;}if(c==='"'){state="double";index++;continue;}if(c==='-'&&n==='-'){state="line";index+=2;continue;}if(c==='/'&&n==='*'){state="block";depth=1;index+=2;continue;}if(c==='$'){const m=sql.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];if(m){state="dollar";tag=m;index+=m.length;continue;}}if(c===';'){const s=sql.slice(start,index).trim();if(s)out.push(s);start=index+1;}index++;continue;}
    if(state==="single"){if(c==='\\'&&n!==undefined)index+=2;else if(c==="'"&&n==="'")index+=2;else if(c==="'"){state="normal";index++;}else index++;continue;}
    if(state==="double"){if(c==='"'&&n==='"')index+=2;else if(c==='"'){state="normal";index++;}else index++;continue;}
    if(state==="line"){if(c==='\n'||c==='\r')state="normal";index++;continue;}
    if(state==="block"){if(c==='/'&&n==='*'){depth++;index+=2;}else if(c==='*'&&n==='/'){depth--;index+=2;if(!depth)state="normal";}else index++;continue;}
    if(state==="dollar"){if(sql.startsWith(tag,index)){index+=tag.length;state="normal";}else index++;}
  }
  const tail=sql.slice(start).trim();if(tail)out.push(tail);return out;
}

async function execute(database, sql, transactionId) {
  return client.send(new ExecuteStatementCommand({ ...base, database, sql, transactionId,
    includeResultMetadata: true, formatRecordsAs: "JSON" }));
}

const exists = await execute("clinical_core", `select exists(select 1 from pg_database where datname='${databaseName}') as present`);
if (!JSON.parse(exists.formattedRecords ?? "[]")[0]?.present) await execute("clinical_core", `create database ${databaseName}`);

const bootstrap = `
create extension if not exists pgcrypto;
create extension if not exists pgtap;
do $$ begin if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if; end $$;
create schema if not exists auth;
create table if not exists auth.users(id uuid primary key,email text);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;`;
const migration = readFileSync(migrationPath, "utf8").replace(/^\s*begin\s*;|\s*commit\s*;\s*$/gi, "");
const setupTx = (await client.send(new BeginTransactionCommand({ ...base, database: databaseName }))).transactionId;
try {
  for (const statement of [...split(bootstrap), ...split(migration)]) await execute(databaseName, statement, setupTx);
  await client.send(new CommitTransactionCommand({ ...base, resourceArn: clusterArn, secretArn, transactionId: setupTx }));
} catch (error) {
  await client.send(new RollbackTransactionCommand({ ...base, resourceArn: clusterArn, secretArn, transactionId: setupTx }));
  throw error;
}

const testSql = readFileSync(testPath, "utf8").replace(/^\s*begin\s*;/i, "").replace(/\s*rollback\s*;\s*$/i, "");
const testTx = (await client.send(new BeginTransactionCommand({ ...base, database: databaseName }))).transactionId;
const tap = [];
try {
  for (const statement of split(testSql)) {
    const result = await execute(databaseName, statement, testTx);
    if (result.formattedRecords) tap.push(...JSON.parse(result.formattedRecords));
  }
} finally {
  await client.send(new RollbackTransactionCommand({ ...base, resourceArn: clusterArn, secretArn, transactionId: testTx }));
}
const lines = tap.flatMap((row) => Object.values(row).filter((value) => typeof value === "string" && /^(?:ok|not ok|1\.\.)/.test(value)));
if (lines.some((line) => line.startsWith("not ok")) || !lines.includes("1..13") || lines.filter((line) => line.startsWith("ok")).length !== 13) {
  throw new Error("isolated_chat_pgtap_failed");
}
console.log(JSON.stringify({ ok: true, database: databaseName, tests: 13, tap: lines }));
