import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { runExportRetentionAcceptance, ExportAcceptanceError } from "./export-retention-acceptance";

// The transport is a fictional recorder: these cases pin what the hosted run asks for and how it grades what comes back.
const token = (letter: string, authTime?: number) => `eyJ${letter.repeat(12)}.${Buffer.from(JSON.stringify({ sub: letter, ...(authTime ? { auth_time: authTime } : {}) })).toString("base64url")}.${letter.repeat(20)}`;
const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const base = { apiOrigin: "https://abcdefghij.execute-api.us-east-2.amazonaws.com", consumerIdToken: token("c"), workforceIdToken: token("w"), foreignConsumerIdToken: token("f"), expectedExportBucket: "fictional-export-bucket",
  expectedAwsAccountId: "588966314750", observedAwsAccountId: "588966314750", sourceCommit: "a".repeat(40), migrationReleaseHash: "b".repeat(64), now: () => 1_800_000_000_000 };
const job = "11111111-1111-4111-8111-111111111111";
// A fictional prepared copy: two parts, real digests, S3's composite checksum, so the download step can verify what it receives.
const exportObject = Buffer.from(JSON.stringify({ contract: "personal-storage-export-job/1", manifest: { version: "personal-storage-export/1", exportId: job, asOf: "2026-09-21T00:00:00Z", recordCount: 3, consentCount: 0,
  coverage: { completeAccountExport: false, included: [], excluded: [], crossStore: { labs: "not_configured", voice: "not_configured", consistency: "live_read_per_item" } } }, records: [{ a: 1 }, { b: 2 }, { c: 3 }], consents: [] }), "utf8");
const split = Math.floor(exportObject.byteLength / 2);
const partBytes = [exportObject.subarray(0, split), exportObject.subarray(split)];
const parts = partBytes.map((bytes, i) => ({ partNumber: i + 1, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") }));
const composite = createHash("sha256").update(Buffer.concat(parts.map((p) => Buffer.from(p.sha256, "hex")))).digest("base64") + "-2";
const linkUrl = "https://fictional-export-bucket.s3.us-east-2.amazonaws.com/personal-exports/x/copy.json?versionId=v1&X-Amz-Expires=300&X-Amz-Signature=fictional";
const link = (url = linkUrl, patch: Record<string, unknown> = {}) => json(200, { data: { jobId: job, url, expiresInSeconds: 300, byteLength: exportObject.byteLength, objectChecksum: composite, parts, ...patch } });
const object = (bytes: Uint8Array = exportObject, status = 200) => new Response(new Uint8Array(bytes), { status, headers: { "content-type": "application/json" } });
const view = (status: string, extra: Record<string, unknown> = {}) => ({ data: { jobId: job, status, retention: status === "ready" ? "downloadable" : "packaging", recordCount: 3, exportedRecords: status === "ready" ? 3 : 1, parts: 2,
  objectChecksum: status === "ready" ? composite : null, byteLength: status === "ready" ? exportObject.byteLength : null, ...extra } });
describe("hosted export and retention acceptance", () => {
  test("a run answered by qualification execution is reported as such and never as production activation evidence", async () => {
    const marked = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "x-clinical-execution": "qualification" } });
    const queue = [marked(200, { data: { contractVersion: "personal-posture/1", launchTier: "core", enabledScopes: [] } }), marked(503, { error: "export_delivery_not_configured" })];
    const report = await runExportRetentionAcceptance({ ...base, fetch: async () => queue.shift() ?? marked(503, { error: "unexpected" }) });
    expect(report.execution).toBe("qualification"); expect(report.ok).toBe(false); expect(report.verdict.unmet).toContain("advance passes to ready");
    // Mixed answers (one production, one qualification) are neither, and are never production evidence.
    const mixed = [json(200, { data: { contractVersion: "personal-posture/1", launchTier: "core", enabledScopes: [] } }), marked(503, { error: "export_delivery_not_configured" })];
    const report2 = await runExportRetentionAcceptance({ ...base, fetch: async () => mixed.shift() ?? json(503, { error: "unexpected" }) });
    expect(report2.execution).toBe("mixed"); expect(report2.ok).toBe(false);
    expect(report.evidenceSha256).not.toBe(report2.evidenceSha256);
  });
  test("drives request, isolation, passes, download, cancel with cleanup and the operator actions, and binds the report to source, migrations and configuration", async () => {
    const calls: Array<{ url: string; auth: string; body: unknown }> = [];
    const queue = [
      json(200, { data: { contractVersion: "personal-posture/1", launchTier: "core", enabledScopes: [] } }),
      json(200, { data: { jobId: job, status: "requested", retention: "packaging" } }),
      json(401, { error: "owner_required" }), json(403, { error: "owner_required" }),
      json(200, view("running")), json(409, { error: "record_conflict" }), json(200, view("ready")),
      link(), object(),
      json(200, { data: { jobId: job, status: "cancelled", cleanup: { cleaned: 1, remaining: 0 }, reconcile: { confirmed: 0, reopened: 0, pending: 0 } } }),
      json(200, { data: { jobId: job, status: "cancelled", objectDeleted: true, retention: "removal_recorded" } }),
      json(200, { data: { scope: "assigned_owners", cleanupPending: 0, settling: 0 } }),
      json(200, { data: { cleaned: 0, remaining: 0, deferred: 0, items: [] } }),
      json(200, { data: { confirmed: 0, reopened: 0, pending: 0, items: [] } }),
    ];
    const report = await runExportRetentionAcceptance({ ...base, fetch: async (url, init) => { calls.push({ url, auth: String((init?.headers as Record<string, string> | undefined)?.authorization ?? ""), body: init?.body ? JSON.parse(String(init.body)) : null }); return queue.shift()!; } });
    expect(report.ok).toBe(true);
    // Production candidates never send the execution marker; the observation describes the run and is not activation evidence.
    expect(report.execution).toBe("production"); expect(report.unmarkedDenials).toBe(true); expect(report).not.toHaveProperty("productionActivationEvidence");
    expect(report.verdict).toEqual({ mode: "exploratory", expectedExecution: null, mandatory: ["consumer posture", "request export job", "advance passes to ready", "download link for the exact version", "download and verify the delivered object"], unmet: [] });
    expect(report.steps.map((s) => [s.name, s.outcome])).toEqual([
      ["consumer posture", "passed"], ["request export job", "passed"], ["cross-owner read refused", "passed"], ["advance passes to ready", "passed"],
      ["stale sign-in download refused", "skipped"], ["download link for the exact version", "passed"], ["download and verify the delivered object", "passed"], ["cancel and cleanup", "passed"],
      ["operator backlog", "passed"], ["operator cleanup pass", "passed"], ["operator reconcile pass", "passed"]]);
    // The object was fetched through the link exactly once, with no redirect following, and the link never appears in the report.
    const download = calls.find((c) => c.url.startsWith("https://fictional-export-bucket.s3."));
    expect(download).toBeDefined(); expect(JSON.stringify(report)).not.toContain("X-Amz-Signature");
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
  test("a complete run answered by mixed executions never qualifies, and an expected execution that did not answer never qualifies", async () => {
    const marked = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "x-clinical-execution": "qualification" } });
    const full = () => [json(200, { data: { contractVersion: "personal-posture/1", launchTier: "core", enabledScopes: [] } }), marked(200, { data: { jobId: job, status: "requested", retention: "packaging" } }),
      json(401, {}), json(403, {}), marked(200, view("ready")), link(), object(),
      marked(200, { data: { jobId: job, status: "cancelled", cleanup: { cleaned: 1, remaining: 0 } } }), marked(200, { data: { jobId: job, status: "cancelled", objectDeleted: true, retention: "removal_recorded" } }),
      json(200, { data: { scope: "assigned_owners", cleanupPending: 0, settling: 0 } }), json(200, { data: { cleaned: 0, remaining: 0, deferred: 0, items: [] } }), json(200, { data: { confirmed: 0, reopened: 0, pending: 0, items: [] } })];
    let queue = full();
    const mixed = await runExportRetentionAcceptance({ ...base, fetch: async () => queue.shift()! });
    expect(mixed.steps.every((s) => s.outcome === "passed" || s.outcome === "skipped")).toBe(true);
    expect(mixed.execution).toBe("mixed"); expect(mixed.ok).toBe(false);
    queue = full().map((r) => (r.headers.get("x-clinical-execution") ? r : r)); // same queue: expecting qualification while production answered too
    const expected = await runExportRetentionAcceptance({ ...base, expectedExecution: "qualification", fetch: async () => queue.shift()! });
    expect(expected.ok).toBe(false); expect(expected.verdict.expectedExecution).toBe("qualification");
  });
  test("acceptance mode: every case is mandatory, so denied operator actions, a skipped stale-login case or a missing token cannot pass, and the report is still written", async () => {
    await expect(runExportRetentionAcceptance({ ...base, mode: "acceptance", fetch: async () => json(500, {}) })).rejects.toThrow("configuration_invalid");
    const stale = token("s", Math.floor(1_800_000_000_000 / 1000) - 10 * 60);
    const acceptance = { ...base, mode: "acceptance" as const, expectedExecution: "qualification" as const, staleConsumerIdToken: stale };
    const marked = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "x-clinical-execution": "qualification" } });
    // The API answers marked; the authorizer denials (401/403) and the S3 object itself are unmarked, as they are in a hosted run, and neither counts as production.
    const markedLink = () => marked(200, { data: { jobId: job, url: linkUrl, expiresInSeconds: 300, byteLength: exportObject.byteLength, objectChecksum: composite, parts } });
    const queue = [marked(200, { data: { contractVersion: "personal-posture/1", launchTier: "core", enabledScopes: [] } }), marked(200, { data: { jobId: job, status: "requested", retention: "packaging" } }),
      json(401, {}), json(403, {}), marked(200, view("ready")), marked(401, { error: "reauth_required" }), markedLink(), object(),
      marked(200, { data: { jobId: job, status: "cancelled", cleanup: { cleaned: 1, remaining: 0 } } }), marked(200, { data: { jobId: job, status: "cancelled", objectDeleted: true, retention: "removal_recorded" } }),
      json(403, {}), json(403, {}), json(403, {})];
    const denied = await runExportRetentionAcceptance({ ...acceptance, fetch: async () => queue.shift()! });
    expect(denied.steps.find((s) => s.name === "stale sign-in download refused")).toMatchObject({ outcome: "passed", status: 401 });
    expect(denied.steps.filter((s) => s.outcome === "skipped").map((s) => s.name)).toEqual(["operator backlog", "operator cleanup pass", "operator reconcile pass"]);
    expect(denied.ok).toBe(false); expect(denied.verdict).toMatchObject({ mode: "acceptance", expectedExecution: "qualification", unmet: ["operator backlog", "operator cleanup pass", "operator reconcile pass"] });
    expect(denied.verdict.mandatory).toHaveLength(11); expect(denied.execution).toBe("qualification"); expect(denied.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    // A stale token that is not actually stale fails the case rather than skipping it.
    const fresh = [marked(200, { data: { contractVersion: "personal-posture/1", launchTier: "core", enabledScopes: [] } }), marked(503, { error: "export_delivery_not_configured" })];
    const notStale = await runExportRetentionAcceptance({ ...acceptance, staleConsumerIdToken: token("c"), fetch: async () => fresh.shift()! });
    expect(notStale.ok).toBe(false); expect(notStale.verdict.unmet.length).toBeGreaterThan(0);
  });
  test("the delivered object is verified, not just the link: denied, redirected, wrong host, unversioned, truncated, oversized, corrupt and mismatched documents all fail", async () => {
    const run = async (linkResponse: Response, objectResponse: Response | null) => {
      const queue = [json(200, { data: { contractVersion: "personal-posture/1", launchTier: "core", enabledScopes: [] } }), json(200, { data: { jobId: job, status: "requested", retention: "packaging" } }),
        json(401, {}), json(403, {}), json(200, view("ready")), linkResponse, ...(objectResponse ? [objectResponse] : []),
        json(200, { data: { jobId: job, status: "cancelled", cleanup: { cleaned: 1, remaining: 0 } } }), json(200, { data: { jobId: job, status: "cancelled", objectDeleted: true, retention: "removal_recorded" } }),
        json(200, { data: { scope: "assigned_owners", cleanupPending: 0, settling: 0 } }), json(200, { data: { cleaned: 0, remaining: 0, deferred: 0, items: [] } }), json(200, { data: { confirmed: 0, reopened: 0, pending: 0, items: [] } })];
      const report = await runExportRetentionAcceptance({ ...base, fetch: async () => queue.shift() ?? json(500, { error: "queue_exhausted" }) });
      return report.steps.find((s) => s.name === "download and verify the delivered object")!;
    };
    expect(await run(link(), object(exportObject, 403))).toMatchObject({ outcome: "failed", detail: "object_access_denied" });
    expect(await run(link(), new Response(null, { status: 302, headers: { location: "https://elsewhere.example/x" } }))).toMatchObject({ outcome: "failed", detail: "redirect_refused" });
    expect(await run(link("https://other-bucket.s3.us-east-2.amazonaws.com/x?versionId=v1&X-Amz-Expires=300"), null)).toMatchObject({ outcome: "failed", detail: "bucket_host_mismatch" });
    expect(await run(link("https://fictional-export-bucket.s3.us-east-2.amazonaws.com/x?X-Amz-Expires=300"), null)).toMatchObject({ outcome: "failed", detail: "version_or_expiry_missing" });
    expect(await run(link(), object(exportObject.subarray(0, exportObject.byteLength - 5)))).toMatchObject({ outcome: "failed", detail: "object_truncated" });
    expect(await run(link(), object(Buffer.concat([exportObject, Buffer.from("x")])))).toMatchObject({ outcome: "failed", detail: "object_oversized" });
    const corrupt = Buffer.from(exportObject); corrupt[3] = corrupt[3] ^ 0xff;
    expect(await run(link(), object(corrupt))).toMatchObject({ outcome: "failed", detail: "part_digest_mismatch:1" });
    // A part list that does not reproduce the recorded composite never yields a link to download.
    const inconsistent = await run(link(linkUrl, { parts: parts.map((p) => ({ ...p, sha256: "0".repeat(64) })) }), null);
    expect(inconsistent).toMatchObject({ outcome: "skipped", detail: "no_link" });
    // Bytes that verify but describe another job's manifest fail on content.
    const other = Buffer.from(JSON.stringify({ contract: "personal-storage-export-job/1", manifest: { recordCount: 99, coverage: {} }, records: [] }));
    const otherParts = [other.subarray(0, 10), other.subarray(10)].map((b, i) => ({ partNumber: i + 1, bytes: b.byteLength, sha256: createHash("sha256").update(b).digest("hex") }));
    const otherComposite = createHash("sha256").update(Buffer.concat(otherParts.map((p) => Buffer.from(p.sha256, "hex")))).digest("base64") + "-2";
    const queue = [json(200, { data: { contractVersion: "personal-posture/1", launchTier: "core", enabledScopes: [] } }), json(200, { data: { jobId: job, status: "requested", retention: "packaging" } }),
      json(401, {}), json(403, {}), json(200, view("ready", { objectChecksum: otherComposite, byteLength: other.byteLength })),
      json(200, { data: { jobId: job, url: linkUrl, expiresInSeconds: 300, byteLength: other.byteLength, objectChecksum: otherComposite, parts: otherParts } }), object(other)];
    const report = await runExportRetentionAcceptance({ ...base, fetch: async () => queue.shift() ?? json(500, {}) });
    expect(report.steps.find((s) => s.name === "download and verify the delivered object")).toMatchObject({ outcome: "failed", detail: "document_manifest_mismatch" });
  });
});
