if (typeof window !== "undefined") {
  throw new Error("clinical-core/qualification-target is server-only.");
}

import { ExecuteStatementCommand } from "@aws-sdk/client-rds-data";
import type { RdsDataCommandClient } from "./rds-data-database";

/**
 * The isolated qualification target: a separate, initially empty database on the synthetic cluster that receives the
 * production-shaped schema through the production migration operator, then fictional production-shaped fixtures. The
 * existing synthetic-staging database (30 synthetic migrations, populated) is never a compatible target for the
 * production artifact and is never touched here: its name is refused as a qualification name, and `inspect` only ever
 * reads its migration ledger to prove it unchanged. `create database` cannot run inside a transaction, so this module is
 * the one reviewed place that issues a statement without one, and it issues exactly that statement.
 */
export type QualificationTargetConfiguration = {
  clusterArn: string;
  secretArn: string;
  /** The isolated database that receives the production artifact. Must contain `qualification`. */
  qualificationDatabaseName: string;
  /** The populated synthetic-staging database that must stay untouched. */
  stagingDatabaseName: string;
  expectedAccountId: string;
};

export type QualificationTargetInspection = {
  mode: "qualification_target_inspection_read_only";
  qualificationDatabase: { name: string; exists: boolean; ledgerPresent: boolean; ledgerVersions: number };
  stagingDatabase: { name: string; ledgerPresent: boolean; ledgerVersions: number; latestVersion: string | null };
  productionArtifactCompatibleWithStaging: false;
};

export class QualificationTargetError extends Error {
  constructor(readonly category: "configuration_refused" | "account_boundary_refused" | "qualification_name_refused" | "qualification_database_exists" | "qualification_database_missing" | "statement_failed") {
    super(category);
    this.name = "QualificationTargetError";
  }
}

const CLUSTER_ARN = /^arn:(aws|aws-us-gov|aws-cn):rds:[a-z0-9-]+:(\d{12}):cluster:[A-Za-z0-9-]{1,63}$/;
const SECRET_ARN = /^arn:(aws|aws-us-gov|aws-cn):secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@!-]+$/;
const DB_NAME = /^[a-z][a-z0-9_]{0,62}$/;
/** The production account is refused by name; no manifest or flag can make it a qualification target. */
export const PRODUCTION_ACCOUNT_ID = "173535830222";
const RESERVED = new Set(["postgres", "rdsadmin", "template0", "template1", "clinical_core"]);

/** A qualification database name must be a valid identifier, name itself as a qualification target, and never be the
 * staging database, a maintenance database or the canonical `clinical_core` name any staging stack could resolve to. */
export function assertQualificationDatabaseName(name: string, stagingDatabaseName: string): void {
  if (!DB_NAME.test(name) || !DB_NAME.test(stagingDatabaseName)) throw new QualificationTargetError("configuration_refused");
  if (!name.includes("qualification") || RESERVED.has(name) || name === stagingDatabaseName) throw new QualificationTargetError("qualification_name_refused");
}

function assertConfiguration(configuration: QualificationTargetConfiguration): void {
  const cluster = configuration.clusterArn.match(CLUSTER_ARN);
  if (!cluster || !SECRET_ARN.test(configuration.secretArn) || !/^\d{12}$/.test(configuration.expectedAccountId)) throw new QualificationTargetError("configuration_refused");
  if (cluster[2] !== configuration.expectedAccountId || configuration.expectedAccountId === PRODUCTION_ACCOUNT_ID) throw new QualificationTargetError("account_boundary_refused");
  assertQualificationDatabaseName(configuration.qualificationDatabaseName, configuration.stagingDatabaseName);
}

type Row = Array<{ stringValue?: string; longValue?: number; booleanValue?: boolean; isNull?: boolean }>;

async function statement(client: RdsDataCommandClient, configuration: QualificationTargetConfiguration, database: string, sql: string, parameters: Array<{ name: string; value: { stringValue: string } }> = []): Promise<Row[]> {
  try {
    const output = await client.send(new ExecuteStatementCommand({ resourceArn: configuration.clusterArn, secretArn: configuration.secretArn, database, sql, parameters }));
    return ((output as { records?: Row[] }).records ?? []);
  } catch {
    throw new QualificationTargetError("statement_failed");
  }
}

async function databaseExists(client: RdsDataCommandClient, configuration: QualificationTargetConfiguration, name: string): Promise<boolean> {
  const rows = await statement(client, configuration, "postgres", "select count(*)::int as n from pg_database where datname = :name", [{ name: "name", value: { stringValue: name } }]);
  return Number(rows[0]?.[0]?.longValue ?? 0) > 0;
}

async function ledger(client: RdsDataCommandClient, configuration: QualificationTargetConfiguration, database: string): Promise<{ ledgerPresent: boolean; ledgerVersions: number; latestVersion: string | null }> {
  const present = await statement(client, configuration, database, "select to_regclass('clinical_core.schema_migrations') is not null as present");
  if (present[0]?.[0]?.booleanValue !== true) return { ledgerPresent: false, ledgerVersions: 0, latestVersion: null };
  const rows = await statement(client, configuration, database, "select count(*)::int as n, max(version) as latest from clinical_core.schema_migrations");
  const latest = rows[0]?.[1];
  return { ledgerPresent: true, ledgerVersions: Number(rows[0]?.[0]?.longValue ?? 0), latestVersion: latest && !latest.isNull && typeof latest.stringValue === "string" ? latest.stringValue : null };
}

/** Read-only: whether the qualification database exists and what both ledgers hold. Nothing is created. */
export async function inspectQualificationTarget(client: RdsDataCommandClient, configuration: QualificationTargetConfiguration): Promise<QualificationTargetInspection> {
  assertConfiguration(configuration);
  const exists = await databaseExists(client, configuration, configuration.qualificationDatabaseName);
  const qualification = exists ? await ledger(client, configuration, configuration.qualificationDatabaseName) : { ledgerPresent: false, ledgerVersions: 0, latestVersion: null };
  const stagingExists = await databaseExists(client, configuration, configuration.stagingDatabaseName);
  const staging = stagingExists ? await ledger(client, configuration, configuration.stagingDatabaseName) : { ledgerPresent: false, ledgerVersions: 0, latestVersion: null };
  return {
    mode: "qualification_target_inspection_read_only",
    qualificationDatabase: { name: configuration.qualificationDatabaseName, exists, ledgerPresent: qualification.ledgerPresent, ledgerVersions: qualification.ledgerVersions },
    stagingDatabase: { name: configuration.stagingDatabaseName, ...staging },
    productionArtifactCompatibleWithStaging: false,
  };
}

/** Creates the empty qualification database and nothing else: no schema, no ledger, no rows. Refuses when it exists,
 * so a populated target is never re-created or reset from here; dropping one is a reviewed manual action. */
export async function createQualificationDatabase(client: RdsDataCommandClient, configuration: QualificationTargetConfiguration): Promise<{ mode: "qualification_database_created"; name: string; stagingDatabase: string; nextStep: string }> {
  assertConfiguration(configuration);
  if (await databaseExists(client, configuration, configuration.qualificationDatabaseName)) throw new QualificationTargetError("qualification_database_exists");
  // The name passed the identifier pattern above, so it is quoted as an identifier rather than bound as a parameter,
  // which `create database` does not accept.
  await statement(client, configuration, "postgres", `create database "${configuration.qualificationDatabaseName}" encoding 'UTF8'`);
  return {
    mode: "qualification_database_created",
    name: configuration.qualificationDatabaseName,
    stagingDatabase: configuration.stagingDatabaseName,
    nextStep: "production-migration-operator apply with CLINICAL_DATABASE_NAME set to the qualification database, then qualification fixtures",
  };
}
