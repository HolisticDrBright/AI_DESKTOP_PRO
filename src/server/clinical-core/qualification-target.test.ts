import { describe, expect, test } from "vitest";
import { assertQualificationDatabaseName, createQualificationDatabase, inspectQualificationTarget, QualificationTargetError } from "./qualification-target";

// The isolated qualification database: created empty on the synthetic cluster, never the populated staging database.
const CONFIG = {
  clusterArn: "arn:aws:rds:us-east-2:123456789012:cluster:ai-clinical-core-synthetic",
  secretArn: "arn:aws:secretsmanager:us-east-2:123456789012:secret:rds!cluster-abc123-XyZ789",
  qualificationDatabaseName: "clinical_core_qualification",
  stagingDatabaseName: "clinical_core",
  expectedAccountId: "123456789012",
};
type Seen = { database: string; sql: string; parameters: Array<{ name: string; value: { stringValue: string } }> };
function client(state: { databases: Record<string, { ledger?: Array<string> }> }) {
  const calls: Seen[] = [];
  return {
    calls,
    value: {
      async send(command: unknown) {
        const input = (command as { input: Seen }).input;
        calls.push({ database: input.database, sql: input.sql, parameters: input.parameters ?? [] });
        if (/from pg_database/.test(input.sql)) return { records: [[{ longValue: state.databases[input.parameters[0].value.stringValue] ? 1 : 0 }]] };
        if (/^create database/.test(input.sql)) { state.databases[input.sql.match(/"([^"]+)"/)![1]] = {}; return {}; }
        const db = state.databases[input.database];
        if (!db) throw new Error("database_missing");
        if (/to_regclass/.test(input.sql)) return { records: [[{ booleanValue: db.ledger !== undefined }]] };
        if (/from clinical_core.schema_migrations/.test(input.sql)) return { records: [[{ longValue: db.ledger!.length }, db.ledger!.length ? { stringValue: [...db.ledger!].sort().at(-1)! } : { isNull: true }]] };
        throw new Error("unexpected:" + input.sql);
      },
    },
  };
}

describe("qualification target", () => {
  test("names: must be a qualification name, never the staging, canonical or maintenance database", () => {
    expect(() => assertQualificationDatabaseName("clinical_core_qualification", "clinical_core")).not.toThrow();
    for (const name of ["clinical_core", "postgres", "rdsadmin", "template1", "clinical_core_staging", "Clinical_Qualification", "qualification-db"]) {
      expect(() => assertQualificationDatabaseName(name, "clinical_core")).toThrow(QualificationTargetError);
    }
    expect(() => assertQualificationDatabaseName("clinical_core_qualification", "clinical_core_qualification")).toThrow("qualification_name_refused");
  });
  test("inspect reads both ledgers without creating anything and never calls the artifact compatible with staging", async () => {
    const state = { databases: { clinical_core: { ledger: Array.from({ length: 30 }, (_, i) => `202608${String(i).padStart(2, "0")}090000`) } } };
    const c = client(state);
    const inspection = await inspectQualificationTarget(c.value, CONFIG);
    expect(inspection).toEqual({
      mode: "qualification_target_inspection_read_only",
      qualificationDatabase: { name: "clinical_core_qualification", exists: false, ledgerPresent: false, ledgerVersions: 0 },
      stagingDatabase: { name: "clinical_core", ledgerPresent: true, ledgerVersions: 30, latestVersion: "20260829090000" },
      productionArtifactCompatibleWithStaging: false,
    });
    expect(c.calls.some((call) => /create|insert|drop|alter/i.test(call.sql))).toBe(false);
    expect(c.calls.filter((call) => call.database === "clinical_core").every((call) => /^select/.test(call.sql))).toBe(true);
    expect(Object.keys(state.databases)).toEqual(["clinical_core"]);
  });
  test("create issues exactly one create-database statement on the maintenance database, then refuses to create it again", async () => {
    const state = { databases: { clinical_core: { ledger: ["20260904090000"] } } };
    const c = client(state);
    const created = await createQualificationDatabase(c.value, CONFIG);
    expect(created.mode).toBe("qualification_database_created");
    expect(created.nextStep).toContain("production-migration-operator apply");
    const creates = c.calls.filter((call) => /^create database/.test(call.sql));
    expect(creates).toEqual([{ database: "postgres", sql: 'create database "clinical_core_qualification" encoding \'UTF8\'', parameters: [] }]);
    expect(c.calls.every((call) => !("transactionId" in call))).toBe(true);
    expect(state.databases.clinical_core.ledger).toEqual(["20260904090000"]);
    await expect(createQualificationDatabase(c.value, CONFIG)).rejects.toThrow("qualification_database_exists");
    const after = await inspectQualificationTarget(c.value, CONFIG);
    expect(after.qualificationDatabase).toEqual({ name: "clinical_core_qualification", exists: true, ledgerPresent: false, ledgerVersions: 0 });
  });
  test("refuses the production account, a cluster in another account and malformed configuration before any statement", async () => {
    const c = client({ databases: {} });
    await expect(inspectQualificationTarget(c.value, { ...CONFIG, clusterArn: "arn:aws:rds:us-east-2:173535830222:cluster:x", expectedAccountId: "173535830222" })).rejects.toThrow("account_boundary_refused");
    await expect(createQualificationDatabase(c.value, { ...CONFIG, expectedAccountId: "210987654321" })).rejects.toThrow("account_boundary_refused");
    await expect(createQualificationDatabase(c.value, { ...CONFIG, secretArn: "not-an-arn" })).rejects.toThrow("configuration_refused");
    await expect(createQualificationDatabase(c.value, { ...CONFIG, qualificationDatabaseName: "clinical_core" })).rejects.toThrow("qualification_name_refused");
    expect(c.calls).toEqual([]);
  });
  test("a failing statement is reported as one category, never with the statement or secret", async () => {
    const failing = { async send() { throw new Error("secret:arn:aws:secretsmanager:..."); } };
    await expect(inspectQualificationTarget(failing, CONFIG)).rejects.toThrow("statement_failed");
  });
});
