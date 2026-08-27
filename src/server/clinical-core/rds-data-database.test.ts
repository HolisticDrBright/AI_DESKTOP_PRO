import { describe, expect, test } from "vitest";
import { clinicalUuid, ClinicalCoreDatabaseRejection } from "./database";
import {
  bindParameters,
  createRdsDataAdministrativeDatabase,
  createRdsDataClinicalCoreDatabase,
  RdsDataDatabaseError,
} from "./rds-data-database";

const CONFIG = {
  clusterArn: "arn:aws:rds:us-east-2:123456789012:cluster:clinical-core",
  secretArn: "arn:aws:secretsmanager:us-east-2:123456789012:secret:clinical/db-AbCd12",
  databaseName: "clinical_core",
};

type Seen = { name: string; input: Record<string, unknown> };

function client(respond?: (seen: Seen) => Record<string, unknown> | Promise<Record<string, unknown>>) {
  const calls: Seen[] = [];
  return {
    calls,
    value: {
      async send(command: unknown) {
        const item = {
          name: (command as { constructor: { name: string } }).constructor.name,
          input: (command as { input: Record<string, unknown> }).input,
        };
        calls.push(item);
        if (respond) return respond(item);
        if (item.name === "BeginTransactionCommand") return { transactionId: "tx-1" };
        return {};
      },
    },
  };
}

describe("Aurora RDS Data API transaction adapter", () => {
  test("accepts AWS-managed RDS secret ARNs containing an exclamation mark", () => {
    const mock = client();
    expect(() => createRdsDataAdministrativeDatabase({
      ...CONFIG,
      secretArn: "arn:aws:secretsmanager:us-east-2:123456789012:secret:rds!cluster-abc123-XyZ789",
    }, { purpose: "reviewed_synthetic_migration" }, mock.value)).not.toThrow();
  });

  test("permits the distinct reviewed reference-catalog operator purpose", () => {
    expect(() => createRdsDataAdministrativeDatabase(
      CONFIG,
      { purpose: "reviewed_reference_catalog_import" },
      client().value,
    )).not.toThrow();
  });

  test("permits the distinct reviewed production schema operator purpose", () => {
    expect(() => createRdsDataAdministrativeDatabase(
      CONFIG,
      { purpose: "reviewed_production_schema_migration" },
      client().value,
    )).not.toThrow();
  });

  test("converts positional placeholders to bounded named parameters", () => {
    expect(bindParameters("select $2, $1, $2", ["alpha", 7])).toEqual({
      sql: "select :p2, :p1, :p2",
      parameters: [
        { name: "p1", value: { stringValue: "alpha" } },
        { name: "p2", value: { longValue: 7 } },
      ],
    });
  });

  test("marks UUID parameters with the Aurora Data API UUID type hint", () => {
    expect(bindParameters("select $1", [clinicalUuid("11111111-1111-4111-8111-111111111111")]).parameters)
      .toEqual([{ name: "p1", value: { stringValue: "11111111-1111-4111-8111-111111111111" }, typeHint: "UUID" }]);
  });

  test("does not infer UUID typing from opaque identity subjects", () => {
    expect(bindParameters("select $1", ["11111111-1111-4111-8111-111111111111"]).parameters)
      .toEqual([{ name: "p1", value: { stringValue: "11111111-1111-4111-8111-111111111111" } }]);
  });

  test("does not reinterpret PostgreSQL function arguments in unparameterized migration SQL", () => {
    expect(bindParameters("create function f(text) returns text as $$ select $1 $$ language sql", []))
      .toEqual({
        sql: "create function f(text) returns text as $$ select $1 $$ language sql",
        parameters: [],
      });
  });

  test("refuses unbound and unsupported parameter values", () => {
    expect(() => bindParameters("select $2", ["only-one"])).toThrowError(RdsDataDatabaseError);
    expect(() => bindParameters("select $1", [{ not: "scalar" }])).toThrow(/query_failed/);
  });

  test("starts a transaction, assumes the API role, decodes rows, and commits", async () => {
    const mock = client((call) => {
      if (call.name === "BeginTransactionCommand") return { transactionId: "tx-safe" };
      if (call.name === "ExecuteStatementCommand" && call.input.sql !== "set local role clinical_core_api") {
        return {
          columnMetadata: [{ name: "id" }, { name: "active" }],
          records: [[{ stringValue: "opaque-id" }, { booleanValue: true }]],
        };
      }
      return {};
    });
    const database = createRdsDataClinicalCoreDatabase(CONFIG, mock.value);
    const result = await database.transaction((tx) => tx.query<{ id: string; active: boolean }>("select $1 as id, $2 as active", ["opaque-id", true]));

    expect(result.rows).toEqual([{ id: "opaque-id", active: true }]);
    expect(mock.calls.map((call) => call.name)).toEqual([
      "BeginTransactionCommand", "ExecuteStatementCommand", "ExecuteStatementCommand", "CommitTransactionCommand",
    ]);
    expect(mock.calls[1]!.input.sql).toBe("set local role clinical_core_api");
    expect(mock.calls[2]!.input).toMatchObject({ transactionId: "tx-safe", sql: "select :p1 as id, :p2 as active" });
  });

  test("administrative migration transactions do not assume the request role", async () => {
    const mock = client();
    const database = createRdsDataAdministrativeDatabase(
      CONFIG,
      { purpose: "reviewed_synthetic_migration" },
      mock.value,
    );
    await database.transaction((tx) => tx.query("select 1"));
    expect(mock.calls.map((call) => [call.name, call.input.sql])).toEqual([
      ["BeginTransactionCommand", undefined],
      ["ExecuteStatementCommand", "select 1"],
      ["CommitTransactionCommand", undefined],
    ]);
  });

  test("rolls back failed work and never returns raw AWS errors", async () => {
    const mock = client((call) => {
      if (call.name === "BeginTransactionCommand") return { transactionId: "tx-rollback" };
      if (call.name === "ExecuteStatementCommand" && call.input.sql !== "set local role clinical_core_api") {
        throw new Error("AWS secret ARN and database detail must not escape");
      }
      return {};
    });
    const database = createRdsDataClinicalCoreDatabase(CONFIG, mock.value);
    await expect(database.transaction((tx) => tx.query("select $1", ["x"]))).rejects.toThrow(/^query_failed$/);
    expect(mock.calls.at(-1)?.name).toBe("RollbackTransactionCommand");
    expect(mock.calls.some((call) => call.name === "CommitTransactionCommand")).toBe(false);
  });

  test.each([
    ["request_context_refused", "identity_refused"],
    ["production_context_refused", "identity_refused"],
    ["patient_access_refused", "identity_refused"],
    ["invitation_invalid_or_expired", "operation_refused"],
    ["production_patient_not_found", "operation_refused"],
  ])("maps the authored %s marker without returning provider text", async (marker, category) => {
    const mock = client((call) => {
      if (call.name === "BeginTransactionCommand") return { transactionId: "tx-refused" };
      if (call.name === "ExecuteStatementCommand" && call.input.sql !== "set local role clinical_core_api") {
        const error = new Error(`ERROR: ${marker}; SQLState: 42501`);
        error.name = "DatabaseErrorException";
        throw error;
      }
      return {};
    });
    const database = createRdsDataClinicalCoreDatabase(CONFIG, mock.value);
    const failure = await database.transaction((tx) => tx.query("select $1", ["x"]))
      .then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(ClinicalCoreDatabaseRejection);
    expect(failure).toMatchObject({ category, message: category });
    expect(String(failure)).not.toContain(marker);
  });

  test("does not mistake a function name for an authored refusal marker", async () => {
    const mock = client((call) => {
      if (call.name === "BeginTransactionCommand") return { transactionId: "tx-function" };
      if (call.name === "ExecuteStatementCommand" && call.input.sql !== "set local role clinical_core_api") {
        const error = new Error("function clinical_core.issue_connection_invitation(uuid) does not exist");
        error.name = "DatabaseErrorException";
        throw error;
      }
      return {};
    });
    const database = createRdsDataClinicalCoreDatabase(CONFIG, mock.value);
    await expect(database.transaction((tx) => tx.query("select 1"))).rejects.toThrow(/^query_failed$/);
  });

  test("refuses malformed resource identifiers before constructing a transaction", () => {
    expect(() => createRdsDataClinicalCoreDatabase({ ...CONFIG, clusterArn: "not-an-arn" }, client().value))
      .toThrow(/configuration_invalid/);
  });
});
