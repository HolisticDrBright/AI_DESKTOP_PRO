if (typeof window !== "undefined") {
  throw new Error("clinical-core/rds-data-database is server-only.");
}

import {
  BeginTransactionCommand,
  CommitTransactionCommand,
  ExecuteStatementCommand,
  RDSDataClient,
  RollbackTransactionCommand,
  type Field,
  type SqlParameter,
} from "@aws-sdk/client-rds-data";
import { ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase, type ClinicalCoreQueryResult, type ClinicalCoreTransaction } from "./database";

export type RdsDataConfiguration = {
  clusterArn: string;
  secretArn: string;
  databaseName: string;
  region?: string;
};

export interface RdsDataCommandClient {
  send(command: unknown): Promise<Record<string, unknown>>;
}

export class RdsDataDatabaseError extends Error {
  constructor(readonly category: "configuration_invalid" | "transaction_failed" | "query_failed") {
    super(category);
    this.name = "RdsDataDatabaseError";
  }
}

const ARN = /^arn:(aws|aws-us-gov|aws-cn):rds:[a-z0-9-]+:\d{12}:cluster:[A-Za-z0-9-]{1,63}$/;
const SECRET_ARN = /^arn:(aws|aws-us-gov|aws-cn):secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/;
const DB_NAME = /^[a-z][a-z0-9_]{0,62}$/;

export function createRdsDataClinicalCoreDatabase(
  configuration: RdsDataConfiguration,
  client: RdsDataCommandClient = new RDSDataClient({ region: configuration.region }),
): ClinicalCoreDatabase {
  return createRdsDataDatabase(configuration, client, "clinical_core_api");
}

/** Administrative access is reserved for the reviewed synthetic migration/fixture operator path. */
export function createRdsDataAdministrativeDatabase(
  configuration: RdsDataConfiguration,
  authorization: { purpose: "reviewed_synthetic_migration" },
  client: RdsDataCommandClient = new RDSDataClient({ region: configuration.region }),
): ClinicalCoreDatabase {
  if (authorization.purpose !== "reviewed_synthetic_migration") {
    throw new RdsDataDatabaseError("configuration_invalid");
  }
  return createRdsDataDatabase(configuration, client);
}

function createRdsDataDatabase(
  configuration: RdsDataConfiguration,
  client: RdsDataCommandClient,
  assumeRole?: "clinical_core_api",
): ClinicalCoreDatabase {
  assertConfiguration(configuration);
  const common = {
    resourceArn: configuration.clusterArn,
    secretArn: configuration.secretArn,
    database: configuration.databaseName,
  };

  return {
    async transaction<T>(work: (tx: ClinicalCoreTransaction) => Promise<T>): Promise<T> {
      let transactionId: string | undefined;
      try {
        const begun = await client.send(new BeginTransactionCommand(common));
        transactionId = stringProperty(begun, "transactionId");
        if (!transactionId) throw new RdsDataDatabaseError("transaction_failed");

        if (assumeRole) {
          await client.send(new ExecuteStatementCommand({
            ...common,
            transactionId,
            sql: `set local role ${assumeRole}`,
          }));
        }

        const tx: ClinicalCoreTransaction = {
          query: <Row extends Record<string, unknown>>(sql: string, parameters: readonly unknown[] = []) =>
            execute<Row>(client, common, transactionId as string, sql, parameters),
        };
        const result = await work(tx);
        await client.send(new CommitTransactionCommand({ ...common, transactionId }));
        return result;
      } catch (error) {
        if (transactionId) {
          try {
            await client.send(new RollbackTransactionCommand({ ...common, transactionId }));
          } catch {
            // The original bounded category is authoritative; rollback errors contain no useful caller detail.
          }
        }
        if (error instanceof RdsDataDatabaseError || error instanceof ClinicalCoreDatabaseRejection) throw error;
        throw new RdsDataDatabaseError(transactionId ? "query_failed" : "transaction_failed");
      }
    },
  };
}

async function execute<Row extends Record<string, unknown>>(
  client: RdsDataCommandClient,
  common: { resourceArn: string; secretArn: string; database: string },
  transactionId: string,
  sql: string,
  values: readonly unknown[],
): Promise<ClinicalCoreQueryResult<Row>> {
  const { sql: namedSql, parameters } = bindParameters(sql, values);
  let response: Record<string, unknown>;
  try {
    response = await client.send(new ExecuteStatementCommand({
      ...common,
      transactionId,
      sql: namedSql,
      parameters,
      includeResultMetadata: true,
    }));
  } catch (error) {
    const rejection = classifyDatabaseRejection(error);
    if (rejection) throw rejection;
    throw new RdsDataDatabaseError("query_failed");
  }

  const columns = Array.isArray(response.columnMetadata)
    ? response.columnMetadata.map((entry) => stringProperty(entry, "name") ?? "")
    : [];
  const records = Array.isArray(response.records) ? response.records as Field[][] : [];
  return {
    rows: records.map((record) => Object.fromEntries(
      columns.map((name, index) => [name, decodeField(record[index])]),
    ) as Row),
    rowCount: numberProperty(response, "numberOfRecordsUpdated") ?? records.length,
  };
}

export function bindParameters(sql: string, values: readonly unknown[]): { sql: string; parameters: SqlParameter[] } {
  if (values.length === 0) return { sql, parameters: [] };
  const referenced = [...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
  if (referenced.some((index) => index < 1 || index > values.length)) {
    throw new RdsDataDatabaseError("query_failed");
  }
  const names = [...new Set(referenced)].sort((a, b) => a - b);
  return {
    sql: sql.replace(/\$(\d+)/g, (_whole, index) => `:p${index}`),
    parameters: names.map((index) => ({ name: `p${index}`, value: encodeField(values[index - 1]) })),
  };
}

function encodeField(value: unknown): Field {
  if (value === null || value === undefined) return { isNull: true };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number" && Number.isSafeInteger(value)) return { longValue: value };
  if (typeof value === "number" && Number.isFinite(value)) return { doubleValue: value };
  if (typeof value === "bigint") return { stringValue: value.toString() };
  if (value instanceof Date && Number.isFinite(value.getTime())) return { stringValue: value.toISOString() };
  if (value instanceof Uint8Array) return { blobValue: value };
  throw new RdsDataDatabaseError("query_failed");
}

function decodeField(field: Field | undefined): unknown {
  if (!field || field.isNull) return null;
  if (field.stringValue !== undefined) return field.stringValue;
  if (field.longValue !== undefined) return field.longValue;
  if (field.doubleValue !== undefined) return field.doubleValue;
  if (field.booleanValue !== undefined) return field.booleanValue;
  if (field.blobValue !== undefined) return field.blobValue;
  if (field.arrayValue !== undefined) return field.arrayValue;
  return null;
}

function assertConfiguration(configuration: RdsDataConfiguration) {
  if (!ARN.test(configuration.clusterArn) || !SECRET_ARN.test(configuration.secretArn) || !DB_NAME.test(configuration.databaseName)) {
    throw new RdsDataDatabaseError("configuration_invalid");
  }
}

function classifyDatabaseRejection(error: unknown): ClinicalCoreDatabaseRejection | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  if (record.name !== "DatabaseErrorException" || typeof record.message !== "string") return undefined;
  const message = record.message;
  if (/(request_context_refused|synthetic_context_refused|clinical_role_required|consumer_identity_required|consent_actor_refused)/.test(message)) {
    return new ClinicalCoreDatabaseRejection("identity_refused");
  }
  if (/(invitation_|synthetic_patient_not_found|connection_|approved_artifact_required|consent_|idempotency_conflict)/.test(message)) {
    return new ClinicalCoreDatabaseRejection("operation_refused");
  }
  return undefined;
}

function stringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function numberProperty(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "number" ? candidate : undefined;
}
