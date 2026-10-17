import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fictionalDynamoTables } from "./fictional-dynamo.fixture";
import { createAwsFullscriptRevocationOutbox, revocationBackoffMs } from "./membership-generation";
import { fullscriptOwnershipKey, reservationFor } from "./practitioner-reservation";
import { FULLSCRIPT_REVOCATION_RECONCILER_RELEASE, RECONCILER_STUCK_ATTEMPTS, runFullscriptRevocationReconciler } from "./revocation-reconciler";
import { build, handler } from "./lambda/revocation-reconciler";
import type { StoredFullscriptConnection } from "./token-store";

/**
 * The revocation outbox's reconciler. Before this change nothing drained the outbox: `reconcileFullscriptRevocations`
 * was called only by tests and no role could query it, so every superseded or refused token stayed valid at Fullscript.
 * Now a scheduled worker reads the queue index across every clinic, settles an item only once Fullscript confirms,
 * retries with backoff, and reports failures by fingerprint. It is BLOCKED, and its template deploys nothing.
 * Fictional tables, clinics and tokens only.
 */
const TOKENS = "fictional-token-table";
const env = { FULLSCRIPT_TOKEN_TABLE: TOKENS, AWS_REGION: "us-east-2", NODE_ENV: "test" as const };
let n = 0;
const connection = (organizationId = randomUUID(), label = String(++n)): StoredFullscriptConnection => ({
  actorKey: label.padStart(64, "a").slice(-64).replace(/[^a-f0-9]/g, "a"), organizationId, environment: "sandbox_us",
  connectedAt: new Date(Date.parse("2026-10-17T08:00:00.000Z") + n * 1000).toISOString(), installationId: randomUUID(),
  accessToken: `fictional-access-token-${label}-abcdefghijklmnopqrstuvwxyz`, refreshToken: `fictional-refresh-token-${label}-abcdefghijklmnopqrstuvwxyz`,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(), scope: ["catalog:read"], resourceOwner: { id: `fictional-practitioner-${label.padStart(4, "0")}`, type: "Practitioner" },
});
function world() {
  const db = fictionalDynamoTables(TOKENS);
  const outbox = createAwsFullscriptRevocationOutbox(env, db.send as never, { reconciler: true })!;
  const items = () => [...db.rows(TOKENS).values()].filter((row) => String(row.sk).startsWith("FULLSCRIPT_REVOCATION#"));
  const run = (revoke: (token: string) => Promise<void>, now = new Date(), limit?: number) =>
    runFullscriptRevocationReconciler({ outbox, environment: "sandbox_us", revoke, now: () => now, limit, release: "qualification" });
  return { db, outbox, items, run };
}
const later = (ms: number) => new Date(Date.now() + ms);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("the revocation reconciler is BLOCKED", () => {
  it("in source; a run without the release reads nothing", async () => {
    expect(FULLSCRIPT_REVOCATION_RECONCILER_RELEASE).toBe("blocked");
    const w = world();
    await w.outbox.queue(connection(), "install_refused");
    const commands = w.db.commands.length;
    expect(await runFullscriptRevocationReconciler({ outbox: w.outbox, environment: "sandbox_us", revoke: vi.fn() })).toEqual({ released: false });
    expect(w.db.commands).toHaveLength(commands);
  });

  it("the Lambda answers released: false and builds nothing, even with its environment lock open", async () => {
    vi.stubEnv("FULLSCRIPT_REVOCATION_RECONCILER_RELEASE", "qualification");
    const secrets = vi.spyOn(SecretsManagerClient.prototype, "send");
    expect(await handler()).toEqual({ released: false });
    expect(secrets).not.toHaveBeenCalled();
  });

  it("building the worker reads exactly this OAuth client's two secrets, and the built worker is still closed by the source release", async () => {
    const w = world();
    const send = vi.fn(async (command: GetSecretValueCommand) => ({ SecretString: command.input.SecretId!.endsWith("client-id") ? "fictional-client-id-abcdefghijklmnopqrstuvwxyz" : "fictional-client-secret-abcdefghijklmnopqrstuvwxyz" }));
    const run = await build({ ...env, FULLSCRIPT_ENVIRONMENT: "sandbox_us", FULLSCRIPT_CLIENT_ID_SECRET_ARN: "arn:aws:secretsmanager:us-east-2:111122223333:secret:fictional-client-id",
      FULLSCRIPT_CLIENT_SECRET_SECRET_ARN: "arn:aws:secretsmanager:us-east-2:111122223333:secret:fictional-client-secret" }, { send } as never, w.db.send as never);
    expect(send.mock.calls.map(([command]) => command.input.SecretId)).toEqual(["arn:aws:secretsmanager:us-east-2:111122223333:secret:fictional-client-id",
      "arn:aws:secretsmanager:us-east-2:111122223333:secret:fictional-client-secret"]);
    expect(await run()).toEqual({ released: false });
  });
});

describe("one reconciler pass", () => {
  it("reads due items across clinics from the queue index; Fullscript must confirm before an item is settled, and the receipt holds no token", async () => {
    const w = world();
    const first = connection(), second = connection();
    await w.outbox.queue(first, "install_refused");
    await w.outbox.queue(second, "practitioner_connected_elsewhere");
    const revoke = vi.fn(async (_token: string) => undefined);
    const summary = await w.run(revoke);
    expect(summary).toMatchObject({ released: true, examined: 2, revoked: 2, failed: 0, more: false });
    expect(revoke.mock.calls.map(([token]) => token).sort()).toEqual([first.accessToken, second.accessToken].sort());
    for (const item of w.items()) {
      expect(item).toMatchObject({ state: "revoked" });
      expect(item.payload).toBeUndefined();
      expect(item.revocationQueue).toBeUndefined(); // out of the queue
    }
    expect(await w.run(revoke)).toMatchObject({ examined: 0 });
  });

  it("a failure keeps the item and its token, counts the attempt, and backs off: not due again until its next attempt", async () => {
    const w = world();
    const queued = connection();
    await w.outbox.queue(queued, "install_refused");
    const down = vi.fn(async () => { throw new Error("fictional provider down"); });
    const failed = await w.run(down);
    expect(failed).toMatchObject({ examined: 1, failed: 1, failures: [{ keyFingerprint: expect.stringMatching(/^[a-f0-9]{16}$/), outcome: "provider_unavailable", attempts: 1 }] });
    expect(w.items()[0]).toMatchObject({ state: "pending", attempts: 1, payload: expect.stringContaining(queued.accessToken) });
    expect(await w.run(down)).toMatchObject({ examined: 0 });
    expect(await w.run(down, later(revocationBackoffMs(0) + 60_000))).toMatchObject({ examined: 1, failures: [{ attempts: 2 }] });
    expect(Date.parse(String(w.items()[0]!.nextAttemptAt)) - Date.now()).toBeGreaterThan(revocationBackoffMs(1) - 60_000);
    expect(await w.run(async () => undefined, later(revocationBackoffMs(1) + 60_000))).toMatchObject({ revoked: 1 });
  });

  it("a token a saved connection holds (a lost install reply that did commit) is never revoked: the item is discarded", async () => {
    const w = world();
    const installed = connection();
    w.db.set(TOKENS, { pk: `ORG#${installed.organizationId}`, sk: `FULLSCRIPT#${installed.actorKey}`, payload: JSON.stringify(installed) });
    await w.outbox.queue(installed, "install_unconfirmed");
    const revoke = vi.fn(async () => undefined);
    expect(await w.run(revoke)).toMatchObject({ examined: 1, inUse: 1, revoked: 0 });
    expect(revoke).not.toHaveBeenCalled();
    expect(w.items()).toEqual([]);
  });

  it("a confirmed revocation releases the practitioner's reservation only when it names exactly that connection", async () => {
    const w = world();
    const mine = connection(), renewed = { ...mine, connectedAt: "2026-10-17T09:30:00.000Z" };
    w.db.set(TOKENS, reservationFor(mine, new Date().toISOString()));
    await w.outbox.queue(mine, "install_refused");
    await w.run(async () => undefined);
    expect(w.db.get(TOKENS, fullscriptOwnershipKey("sandbox_us", mine.resourceOwner.id))).toBeUndefined();
    const other = connection();
    w.db.set(TOKENS, reservationFor({ ...renewed, resourceOwner: other.resourceOwner }, new Date().toISOString()));
    await w.outbox.queue({ ...mine, resourceOwner: other.resourceOwner, connectedAt: "2026-10-17T08:59:00.000Z" }, "membership_changed");
    await w.run(async () => undefined);
    expect(w.db.get(TOKENS, fullscriptOwnershipKey("sandbox_us", other.resourceOwner.id))).toMatchObject({ connectedAt: renewed.connectedAt });
  });

  it("reports a stuck item, bounds its report, never carries a token, and a settle that failed is unrecorded, not counted", async () => {
    const w = world();
    for (let i = 0; i < 3; i++) await w.outbox.queue(connection(), "install_refused");
    w.items().forEach((item, i) => w.db.set(TOKENS, { ...(item as { pk: string; sk: string }), nextAttemptAt: `2026-01-01T00:00:0${i}.000Z` }));
    const key = w.items()[0]!;
    w.db.set(TOKENS, { ...(key as { pk: string; sk: string }), attempts: RECONCILER_STUCK_ATTEMPTS - 1 });
    w.db.fault({ when: (command) => command instanceof UpdateCommand && (command.input.Key as { sk: string }).sk === w.items()[1]!.sk, mode: "fail_before" });
    const summary = await w.run(async () => { throw new Error("fictional provider down"); }, new Date(), 2);
    expect(summary).toMatchObject({ examined: 2, failed: 2, stuck: 1, more: true });
    if (!summary.released) throw new Error("released");
    expect(summary.failures.map((failure) => failure.outcome).sort()).toEqual(["provider_unavailable", "unrecorded"]);
    expect(JSON.stringify(summary)).not.toMatch(/fictional-access-token|fictional-practitioner|ORG#/);
  });
});

describe("the reconciler's deployment specification", () => {
  type Statement = { Effect: string; Action: string | string[]; Resource: unknown };
  const template = JSON.parse(readFileSync("infra/aws-clinical-core/fullscript-revocation-reconciler.json", "utf8")) as {
    Parameters: Record<string, { Default?: string; AllowedValues?: string[] }>; Conditions: Record<string, unknown>;
    Resources: Record<string, { Type: string; Condition?: string; Properties: Record<string, unknown> }> };
  const actions = (statement: Statement) => ([] as string[]).concat(statement.Action);

  it("deploys nothing: its release accepts only BLOCKED and every resource is conditioned on a value it cannot take", () => {
    expect(template.Parameters.ReconcilerRelease).toMatchObject({ Default: "BLOCKED", AllowedValues: ["BLOCKED"] });
    expect(template.Conditions.ReconcilerReleased).toEqual({ "Fn::Equals": [{ Ref: "ReconcilerRelease" }, "RELEASED"] });
    for (const [name, resource] of Object.entries(template.Resources)) expect([name, resource.Condition]).toEqual([name, "ReconcilerReleased"]);
    expect(template.Parameters.ScheduleState.AllowedValues).toEqual(["DISABLED"]);
    expect(template.Parameters.FullscriptEnvironment.AllowedValues).toEqual(["sandbox_us"]);
    const variables = (template.Resources.ReconcilerFunction!.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(variables).toMatchObject({ FULLSCRIPT_REVOCATION_RECONCILER_RELEASE: "blocked", FULLSCRIPT_PRODUCTION_APPROVED: "false", PHI_ALLOWED: "false" });
    expect(Object.keys(variables).some((name) => /SECRET$|CLIENT_ID$|TOKEN$/.test(name) && !name.endsWith("_ARN") && name !== "FULLSCRIPT_TOKEN_TABLE")).toBe(false);
  });

  it("its own role holds exactly the minimum: Query on the queue index only; Get, Update and Delete items; two secrets; decrypt", () => {
    const role = template.Resources.ReconcilerRole!.Properties as { Policies: Array<{ PolicyName: string; PolicyDocument: { Statement: Statement[] } }> };
    const statements = role.Policies.flatMap((policy) => policy.PolicyDocument.Statement);
    expect(statements.every((statement) => statement.Effect === "Allow")).toBe(true);
    const all = statements.flatMap(actions).sort();
    expect(all).toEqual(["dynamodb:DeleteItem", "dynamodb:GetItem", "dynamodb:Query", "dynamodb:UpdateItem", "kms:Decrypt",
      "logs:CreateLogStream", "logs:PutLogEvents", "secretsmanager:GetSecretValue"]);
    const query = statements.find((statement) => actions(statement).includes("dynamodb:Query"))!;
    expect(actions(query)).toEqual(["dynamodb:Query"]);
    expect(JSON.stringify(query.Resource)).toMatch(/table\/\$\{TokenTableName\}\/index\/RevocationQueue"/);
    const items = statements.find((statement) => actions(statement).includes("dynamodb:GetItem"))!;
    expect(JSON.stringify(items.Resource)).toMatch(/table\/\$\{TokenTableName\}"}$/);
    expect(JSON.stringify(statements)).not.toMatch(/"\*"|Scan|PutItem|BatchWrite|BatchGet|PartiQL|fence/i);
  });

  it("the hosted Desktop's role is unchanged: no Query, no UpdateItem on the token table", () => {
    const hosting = readFileSync("infra/aws-clinical-core/desktop-web-hosting.json", "utf8");
    expect(hosting).not.toMatch(/dynamodb:Query|dynamodb:UpdateItem|dynamodb:Scan/);
  });

  it("the token table's queue index is off by default, keys only (no token), and only the reconciler reads it", () => {
    const connector = JSON.parse(readFileSync("infra/aws-clinical-core/fullscript-connector-extension.json", "utf8")) as {
      Parameters: Record<string, { Default?: string }>; Resources: { TokenTable: { Properties: Record<string, unknown> } } };
    expect(connector.Parameters.RevocationQueueIndex!.Default).toBe("disabled");
    const index = connector.Resources.TokenTable.Properties.GlobalSecondaryIndexes as { "Fn::If": [string, Array<Record<string, unknown>>, unknown] };
    expect(index["Fn::If"][0]).toBe("RevocationQueueIndexEnabled");
    expect(index["Fn::If"][1]).toEqual([expect.objectContaining({ IndexName: "RevocationQueue", Projection: { ProjectionType: "KEYS_ONLY" } })]);
    expect(index["Fn::If"][2]).toEqual({ Ref: "AWS::NoValue" });
  });
});
