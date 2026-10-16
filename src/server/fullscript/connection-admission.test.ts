import { randomUUID } from "node:crypto";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { membershipFenceKey, MEMBERSHIP_FENCE_PROTOCOL } from "@/server/clinical-core/membership-fence";
import type { RequestSession } from "@/server/session";
import { createAwsFullscriptConnectionAdmission } from "./connection-admission";
import type { StoredFullscriptConnection } from "./token-store";

const subject = randomUUID(), clinic = randomUUID(), actorKey = "a".repeat(64);
const token = [{ alg: "RS256" }, { sub: subject, token_use: "id" }]
  .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".") + ".fictional-signature";
const session: RequestSession = { signedIn: true, expired: false, expiresAt: null,
  orgId: clinic, email: "fictional@example.test", token };
const actor = { actorKey, organizationId: clinic };
const connection = (): StoredFullscriptConnection => ({ ...actor,
  accessToken: "fictional-access-token-abcdefghijklmnopqrstuvwxyz",
  refreshToken: "fictional-refresh-token-abcdefghijklmnopqrstuvwxyz",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(), scope: ["catalog:read"],
  resourceOwner: { id: "fictional-practitioner-id", type: "Practitioner" },
  environment: "sandbox_us", connectedAt: new Date().toISOString(),
});
const env = { FULLSCRIPT_TOKEN_TABLE: "fictional-token-table", FULLSCRIPT_MEMBERSHIP_FENCE_TABLE: "fictional-fence-table",
  AWS_REGION: "us-east-2", NODE_ENV: "test" as const };
const key = (pk: string, sk: string) => `${pk}|${sk}`;

function fictionalStore() {
  const records = new Map<string, Record<string, unknown>>();
  const subjectKey = membershipFenceKey({ kind: "subject", subject });
  const clinicKey = membershipFenceKey({ kind: "clinic", organizationId: clinic });
  for (const fenceKey of [subjectKey, clinicKey]) records.set(key(fenceKey.pk, fenceKey.sk), {
    ...fenceKey, fenceProtocol: MEMBERSHIP_FENCE_PROTOCOL, fenceVersion: 1,
  });
  const tokenKey = key(`ORG#${clinic}`, `FULLSCRIPT#${actorKey}`);
  const transactions: TransactWriteCommand[] = [];
  const send = vi.fn(async (command: GetCommand | TransactWriteCommand) => {
    if (command instanceof GetCommand) {
      const lookup = command.input.Key as { pk: string; sk: string };
      return { Item: records.get(key(lookup.pk, lookup.sk)) };
    }
    if (!(command instanceof TransactWriteCommand)) throw new Error("unexpected_command");
    transactions.push(command);
    const writes = command.input.TransactItems ?? [];
    // Fictional all-or-nothing transaction: validate every condition before changing the token item.
    for (const write of writes) {
      if (write.ConditionCheck) {
        const lookup = write.ConditionCheck.Key as { pk: string; sk: string };
        const present = records.get(key(lookup.pk, lookup.sk));
        const expected = write.ConditionCheck.ExpressionAttributeValues;
        if (write.ConditionCheck.ConditionExpression === "attribute_not_exists(pk)") {
          if (present) throw new Error("TransactionCanceledException");
        } else if (!present || present.fenceProtocol !== expected?.[":fenceProtocol"]
          || present.fenceVersion !== expected?.[":fenceVersion"] || present.pendingChanges !== undefined) {
          throw new Error("TransactionCanceledException");
        }
      }
      if (write.Put) {
        const present = records.get(tokenKey);
        if (write.Put.ConditionExpression === "attribute_not_exists(pk)" && present) throw new Error("TransactionCanceledException");
        if (write.Put.ConditionExpression === "payload = :previous"
          && present?.payload !== write.Put.ExpressionAttributeValues?.[":previous"]) throw new Error("TransactionCanceledException");
      }
    }
    const put = writes.find((write) => write.Put)?.Put;
    if (!put) throw new Error("token_put_missing");
    records.set(tokenKey, put.Item as Record<string, unknown>);
    return {};
  });
  const guard = createAwsFullscriptConnectionAdmission(env, send)!;
  return { guard, records, send, transactions, subjectKey, clinicKey, tokenKey };
}

describe("Fullscript OAuth installation is admitted at the token write", () => {
  it("writes a token only in the same transaction as both settled fence-version checks", async () => {
    const fixture = fictionalStore();
    const observed = await fixture.guard.observe(session, actor);
    await fixture.guard.install(connection(), observed);
    expect(fixture.transactions).toHaveLength(1);
    const writes = fixture.transactions[0]!.input.TransactItems!;
    expect(writes).toHaveLength(3);
    expect(writes.filter((write) => write.ConditionCheck)).toHaveLength(2);
    expect(writes[2]!.Put?.ConditionExpression).toBe("attribute_not_exists(pk)");
    expect(JSON.parse(String(fixture.records.get(fixture.tokenKey)?.payload))).toMatchObject(actor);
  });

  it.each(["subject", "clinic"] as const)("refuses when the %s changes during the provider exchange", async (kind) => {
    const fixture = fictionalStore();
    const observed = await fixture.guard.observe(session, actor);
    const fenceKey = kind === "subject" ? fixture.subjectKey : fixture.clinicKey;
    fixture.records.set(key(fenceKey.pk, fenceKey.sk), { ...fixture.records.get(key(fenceKey.pk, fenceKey.sk)),
      fenceVersion: 2, pendingChanges: new Set([randomUUID()]) });
    await expect(fixture.guard.install(connection(), observed)).rejects.toThrow("Fullscript is not configured");
    expect(fixture.records.has(fixture.tokenKey)).toBe(false);
  });

  it("refuses a fence already changing before the clinical membership read", async () => {
    const fixture = fictionalStore();
    fixture.records.set(key(fixture.subjectKey.pk, fixture.subjectKey.sk), {
      ...fixture.records.get(key(fixture.subjectKey.pk, fixture.subjectKey.sk)),
      pendingChanges: new Set([randomUUID()]),
    });
    await expect(fixture.guard.observe(session, actor)).rejects.toThrow("Fullscript is not configured");
    expect(fixture.transactions).toHaveLength(0);
  });

  it("refuses to resurrect a connection deleted after OAuth started", async () => {
    const fixture = fictionalStore();
    fixture.records.set(fixture.tokenKey, { pk: `ORG#${clinic}`, sk: `FULLSCRIPT#${actorKey}`,
      payload: JSON.stringify(connection()) });
    const observed = await fixture.guard.observe(session, actor);
    fixture.records.delete(fixture.tokenKey);
    await expect(fixture.guard.install(connection(), observed)).rejects.toThrow("Fullscript is not configured");
    expect(fixture.records.has(fixture.tokenKey)).toBe(false);
  });

  it("refuses to overwrite a connection another callback replaced after observation", async () => {
    const fixture = fictionalStore();
    fixture.records.set(fixture.tokenKey, { pk: `ORG#${clinic}`, sk: `FULLSCRIPT#${actorKey}`,
      payload: JSON.stringify(connection()) });
    const observed = await fixture.guard.observe(session, actor);
    const replacement = { ...connection(), installationId: randomUUID() };
    fixture.records.set(fixture.tokenKey, { pk: `ORG#${clinic}`, sk: `FULLSCRIPT#${actorKey}`,
      payload: JSON.stringify(replacement) });
    await expect(fixture.guard.install(connection(), observed)).rejects.toThrow("Fullscript is not configured");
    expect(JSON.parse(String(fixture.records.get(fixture.tokenKey)?.payload))).toMatchObject(replacement);
  });

  it("refuses missing fence configuration instead of falling back to an unfenced PutItem", () => {
    expect(createAwsFullscriptConnectionAdmission({ ...env, FULLSCRIPT_MEMBERSHIP_FENCE_TABLE: "" })).toBeNull();
  });
});
