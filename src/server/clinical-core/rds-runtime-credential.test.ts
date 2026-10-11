import { describe, expect, test, vi } from "vitest";
import {
  createRdsDataAdministrativeDatabase,
  createRdsDataClinicalCoreDatabase,
  createRdsDataFullscriptDraftDatabase,
} from "./rds-data-database";

const configuration = {
  clusterArn: "arn:aws:rds:us-east-2:123456789012:cluster:fictional-runtime",
  secretArn: "arn:aws:secretsmanager:us-east-2:123456789012:secret:fictional/runtime-AbCd12",
  databaseName: "fictional_runtime",
};
type Call = { name: string; input: Record<string, unknown> };
const guardResponse = {
  columnMetadata: [{ name: "runtime_credential_admitted" }],
  records: [[{ booleanValue: true }]],
};

function transport(response: Record<string, unknown> | Error = guardResponse) {
  const calls: Call[] = [];
  return {
    calls,
    async send(command: unknown): Promise<Record<string, unknown>> {
      const call = {
        name: (command as { constructor: { name: string } }).constructor.name,
        input: (command as { input: Record<string, unknown> }).input,
      };
      calls.push(call);
      if (call.name === "BeginTransactionCommand") return { transactionId: "fictional-tx" };
      if (String(call.input.sql).includes("clinical-runtime-credential/1")) {
        if (response instanceof Error) throw response;
        return response;
      }
      return {};
    },
  };
}

describe("runtime database credential admission", () => {
  for (const [name, factory, role] of [
    ["API", createRdsDataClinicalCoreDatabase, "clinical_core_api"],
    ["Fullscript", createRdsDataFullscriptDraftDatabase, "fullscript_draft_worker"],
  ] as const) {
    test(`${name} checks its actual login before assuming the role or invoking work`, async () => {
      const client = transport();
      const work = vi.fn(async () => "fictional-result");
      await expect(factory(configuration, client).transaction(work)).resolves.toBe("fictional-result");
      const statements = client.calls.filter(call => call.name === "ExecuteStatementCommand");
      expect(statements).toHaveLength(2);
      expect(String(statements[0].input.sql)).toContain("clinical-runtime-credential/1");
      expect(statements[0].input.parameters).toEqual([{ name: "p1", value: { stringValue: role } }]);
      expect(statements[1].input.sql).toBe(`set local role ${role}`);
      expect(work).toHaveBeenCalledOnce();
      expect(client.calls.at(-1)?.name).toBe("CommitTransactionCommand");
    });

    test.each([
      ["administrative or otherwise excessive credential", { ...guardResponse, records: [[{ booleanValue: false }]] }],
      ["missing metadata", { records: [[{ booleanValue: true }]] }],
      ["missing result", {}],
      ["null result", { ...guardResponse, records: [[{ isNull: true }]] }],
      ["textual true", { ...guardResponse, records: [[{ stringValue: "true" }]] }],
      ["multiple results", { ...guardResponse, records: [[{ booleanValue: true }], [{ booleanValue: true }]] }],
      ["duplicate column names", { columnMetadata: [{ name: "runtime_credential_admitted" }, { name: "runtime_credential_admitted" }], records: [[{ booleanValue: false }, { booleanValue: true }]] }],
      ["extra row cell", { ...guardResponse, records: [[{ booleanValue: true }, { booleanValue: true }]] }],
      ["ambiguous field encoding", { ...guardResponse, records: [[{ booleanValue: true, isNull: true }]] }],
      ["unexpected field", { columnMetadata: [{ name: "runtime_credential_admitted" }, { name: "other" }], records: [[{ booleanValue: true }, { booleanValue: true }]] }],
      ["transport failure", new Error("fictional provider detail must not escape")],
    ])(`${name} refuses %s before work and rolls back`, async (_label, response) => {
      const client = transport(response);
      const work = vi.fn(async () => "must-not-run");
      await expect(factory(configuration, client).transaction(work)).rejects.toThrow(/^(configuration_invalid|query_failed)$/);
      expect(work).not.toHaveBeenCalled();
      expect(client.calls.some(call => String(call.input.sql).startsWith("set local role"))).toBe(false);
      expect(client.calls.some(call => call.name === "CommitTransactionCommand")).toBe(false);
      expect(client.calls.at(-1)?.name).toBe("RollbackTransactionCommand");
    });
  }

  test("the separate reviewed administrative operator is not a runtime-role fallback", async () => {
    const client = transport(new Error("runtime admission must not be invoked"));
    await createRdsDataAdministrativeDatabase(configuration, { purpose: "reviewed_synthetic_migration" }, client)
      .transaction(tx => tx.query("select 1"));
    expect(client.calls.filter(call => call.name === "ExecuteStatementCommand").map(call => call.input.sql))
      .toEqual(["select 1"]);
  });
});
