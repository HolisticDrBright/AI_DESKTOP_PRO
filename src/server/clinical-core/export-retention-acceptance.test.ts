import { describe, expect, test } from "vitest";
import { runExportRetentionAcceptance, ExportAcceptanceError } from "./export-retention-acceptance";

// The transport is a fictional recorder: these cases pin what the hosted run asks for and how it grades what comes back.
const token = (letter: string, authTime?: number) => `eyJ${letter.repeat(12)}.${Buffer.from(JSON.stringify({ sub: letter, ...(authTime ? { auth_time: authTime } : {}) })).toString("base64url")}.${letter.repeat(20)}`;
const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const base = { apiOrigin: "https://abcdefghij.execute-api.us-east-2.amazonaws.com", consumerIdToken: token("c"), workforceIdToken: token("w"), foreignConsumerIdToken: token("f"),
  expectedAwsAccountId: "588966314750", observedAwsAccountId: "588966314750", sourceCommit: "a".repeat(40), migrationReleaseHash: "b".repeat(64), now: () => 1_800_000_000_000 };
const job = "11111111-1111-4111-8111-111111111111";
const view = (status: string, extra: Record<string, unknown> = {}) => ({ data: { jobId: job, status, retention: status === "ready" ? "downloadable" : "packaging", recordCount: 3, exportedRecords: status === "ready" ? 3 : 1, parts: 2,
  objectChecksum: status === "ready" ? "A".repeat(43) + "=-2" : null, byteLength: status === "ready" ? 4096 : null, ...extra } });
describe("hosted export and retention acceptance", () => {
  test("a run answered by qualification execution is reported as such and never as production activation evidence", async () => {
    const marked = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "x-clinical-execution": "qualification" } });
    const queue = [marked(200, { data: { contractVersion: "personal-posture/1", launchTier: "core", enabledScopes: [] } }), marked(503, { error: "export_delivery_not_configured" })];
    const report = await runExportRetentionAcceptance({ ...base, fetch: async () => queue.shift() ?? marked(503, { error: "unexpected" }) });
    expect(report.execution).toBe("qualification"); expect(report.productionActivationEvidence).toBe(false); expect(report.ok).toBe(false);
    // Mixed answers (one production, one qualification) are neither, and are never production evidence.
    const mixed = [json(200, { data: { contractVersion: "personal-posture/1", launchTier: "core", enabledScopes: [] } }), marked(503, { error: "export_delivery_not_configured" })];
    const report2 = await runExportRetentionAcceptance({ ...base, fetch: async () => mixed.shift() ?? json(503, { error: "unexpected" }) });
    expect(report2.execution).toBe("mixed"); expect(report2.productionActivationEvidence).toBe(false);
    expect(report.evidenceSha256).not.toBe(report2.evidenceSha256);
  });
  test("drives request, isolation, passes, download, cancel with cleanup and the operator actions, and binds the report to source, migrations and configuration", async () => {
    const calls: Array<{ url: string; auth: string; body: unknown }> = [];
    const queue = [
      json(200, { data: { contractVersion: "personal-posture/1", launchTier: "core", enabledScopes: [] } }),
      json(200, { data: { jobId: job, status: "requested", retention: "packaging" } }),
      json(401, { error: "owner_required" }), json(403, { error: "owner_required" }),
      json(200, view("running")), json(409, { error: "record_conflict" }), json(200, view("ready")),
      json(200, { data: { jobId: job, url: "https://fictional-export-bucket.s3.us-east-2.amazonaws.com/x?X-Amz-Expires=300", expiresInSeconds: 300, byteLength: 4096, objectChecksum: "A".repeat(43) + "=-2" } }),
      json(200, { data: { jobId: job, status: "cancelled", cleanup: { cleaned: 1, remaining: 0 }, reconcile: { confirmed: 0, reopened: 0, pending: 0 } } }),
      json(200, { data: { jobId: job, status: "cancelled", objectDeleted: true, retention: "removal_recorded" } }),
      json(200, { data: { scope: "assigned_owners", cleanupPending: 0, settling: 0 } }),
      json(200, { data: { cleaned: 0, remaining: 0, deferred: 0, items: [] } }),
      json(200, { data: { confirmed: 0, reopened: 0, pending: 0, items: [] } }),
    ];
    const report = await runExportRetentionAcceptance({ ...base, fetch: async (url, init) => { calls.push({ url, auth: String((init?.headers as Record<string, string>).authorization), body: init?.body ? JSON.parse(String(init.body)) : null }); return queue.shift()!; } });
    expect(report.ok).toBe(true);
    // Production candidates never send the execution marker: this run counts toward production activation evidence.
    expect(report.execution).toBe("production"); expect(report.productionActivationEvidence).toBe(true);
    expect(report.steps.map((s) => [s.name, s.outcome])).toEqual([
      ["consumer posture", "passed"], ["request export job", "passed"], ["cross-owner read refused", "passed"], ["advance passes to ready", "passed"],
      ["stale sign-in download refused", "skipped"], ["download link for the exact version", "passed"], ["cancel and cleanup", "passed"],
      ["operator backlog", "passed"], ["operator cleanup pass", "passed"], ["operator reconcile pass", "passed"]]);
    expect(report.retained).toEqual([]);
    expect(calls[1]).toMatchObject({ url: base.apiOrigin + "/clinical-core/consumer/personal/privacy-export/job", auth: "Bearer " + token("c") });
    expect(calls[2].auth).toBe("Bearer " + token("w")); expect(calls[3].auth).toBe("Bearer " + token("f"));
    expect(calls[4].url).toContain("advance=true");
    expect(calls.at(-3)!.body).toEqual({ action: "exportBacklog" }); expect(calls.at(-3)!.auth).toBe("Bearer " + token("w"));
    expect(report).toMatchObject({ schemaVersion: "export-retention-acceptance/1", environment: "synthetic-staging", sourceCommit: "a".repeat(40), migrationReleaseHash: "b".repeat(64), awsAccountId: "588966314750" });
    expect(report.configurationSha256).toMatch(/^[a-f0-9]{64}$/); expect(report.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(report)).not.toContain(token("c").slice(0, 20));
  });
  test("reports export delivery that is not configured as not_configured and skips the rest; never a pass", async () => {
    const queue = [json(200, { data: { contractVersion: "personal-posture/1", launchTier: "core", enabledScopes: [] } }), json(503, { error: "export_delivery_not_configured" })];
    const report = await runExportRetentionAcceptance({ ...base, fetch: async () => queue.shift()! });
    expect(report.ok).toBe(false);
    expect(report.steps[1]).toMatchObject({ outcome: "not_configured", detail: "export_delivery_not_configured" });
    expect(report.steps.slice(2).every((s) => s.outcome === "skipped")).toBe(true);
  });
  test("records a retained copy and fails when cleanup certifies but the job is neither recorded removed nor honestly pending; operator refusals are not_configured", async () => {
    const queue = [
      json(200, { data: { contractVersion: "personal-posture/1", launchTier: "core", enabledScopes: [] } }),
      json(200, { data: { jobId: job, status: "requested", retention: "packaging" } }),
      json(403, {}), json(403, {}), json(200, view("ready")),
      json(200, { data: { jobId: job, url: "https://x", expiresInSeconds: 300, byteLength: 4096, objectChecksum: "A".repeat(43) + "=-2" } }),
      json(200, { data: { jobId: job, status: "cancelled", cleanup: { cleaned: 0, remaining: 1 } } }),
      json(200, { data: { jobId: job, status: "cancelled", objectDeleted: false, retention: "removal_verified" } }),
      json(503, { error: "export_cleanup_not_activated" }), json(503, { error: "export_cleanup_not_activated" }), json(503, { error: "production_not_activated" }),
    ];
    const report = await runExportRetentionAcceptance({ ...base, fetch: async () => queue.shift()! });
    expect(report.ok).toBe(false);
    expect(report.steps.find((s) => s.name === "cancel and cleanup")).toMatchObject({ outcome: "failed", detail: "retention:removal_verified" });
    expect(report.retained).toEqual([{ jobId: job, state: "removal_verified" }]);
    expect(report.steps.slice(-3).every((s) => s.outcome === "not_configured")).toBe(true);
  });
  test("refuses the production account, an account that does not match STS, non-execute-api origins and reused tokens before any request", async () => {
    let requests = 0; const fetcher = async () => { requests++; return json(200, {}); };
    await expect(runExportRetentionAcceptance({ ...base, observedAwsAccountId: "173535830222", expectedAwsAccountId: "173535830222", fetch: fetcher })).rejects.toBeInstanceOf(ExportAcceptanceError);
    await expect(runExportRetentionAcceptance({ ...base, observedAwsAccountId: "000000000001", fetch: fetcher })).rejects.toThrow("boundary_refused");
    await expect(runExportRetentionAcceptance({ ...base, apiOrigin: "https://example.com", fetch: fetcher })).rejects.toThrow("configuration_invalid");
    await expect(runExportRetentionAcceptance({ ...base, workforceIdToken: base.consumerIdToken, fetch: fetcher })).rejects.toThrow("configuration_invalid");
    expect(requests).toBe(0);
  });
});
