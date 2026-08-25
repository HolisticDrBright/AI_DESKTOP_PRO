import { afterEach, describe, expect, test } from "vitest";
import { apiHandler, createAwsSyncRpc, workerHandler } from "./aws-production-bridge-handler.mjs";

const original = { ...process.env };
afterEach(() => { process.env = { ...original }; });

describe("production AWS sync bridge activation boundary", () => {
  test("API and worker refuse before reading any secret or database", async () => {
    process.env.PHI_ALLOWED = "false";
    process.env.ACTIVATION_STATE = "blocked";
    delete process.env.SYNC_BRIDGE_SECRET_ARN;
    await expect(apiHandler({})).resolves.toMatchObject({ statusCode: 503 });
    await expect(workerHandler()).resolves.toEqual({ posture: "disabled", phiAllowed: false });
  });

  test("every AWS RPC transaction assumes only the worker database role", async () => {
    const calls = [];
    const client = { async send(command) {
      calls.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === "BeginTransactionCommand") return { transactionId: "tx-1" };
      if (command.constructor.name === "ExecuteStatementCommand" && command.input.sql.startsWith("select")) {
        return { records: [[{ stringValue: '{"events":[],"leaseReclaims":0,"maxQueueAgeSeconds":0}' }]] };
      }
      return {};
    } };
    const rpc = createAwsSyncRpc({ client, clusterArn: "arn:aws:rds:us-east-2:173535830222:cluster:clinical",
      secretArn: "arn:aws:secretsmanager:us-east-2:173535830222:secret:clinical-db", database: "clinical" });
    await rpc("claim_sync_outbound", { _organization_id: "71000000-0000-4000-8000-000000000001",
      _limit: 10, _lease_seconds: 120, _worker_id: "72000000-0000-4000-8000-000000000001" });
    expect(calls.map((call) => call.name)).toEqual([
      "BeginTransactionCommand", "ExecuteStatementCommand", "ExecuteStatementCommand", "CommitTransactionCommand",
    ]);
    expect(calls[1].input.sql).toBe("set local role clinical_sync_worker");
    expect(calls[2].input.sql).toContain("clinical_core.claim_sync_outbound");
  });

  test("unknown RPC names are refused before a transaction starts", async () => {
    const client = { send: async () => { throw new Error("must not run"); } };
    const rpc = createAwsSyncRpc({ client, clusterArn: "arn:aws:rds:us-east-2:173535830222:cluster:clinical",
      secretArn: "arn:aws:secretsmanager:us-east-2:173535830222:secret:clinical-db", database: "clinical" });
    await expect(rpc("arbitrary_sql", {})).rejects.toThrow("production_sync_rpc_refused");
  });
});

