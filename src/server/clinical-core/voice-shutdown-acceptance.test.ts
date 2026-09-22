import { describe, expect, test } from "vitest";
import { runVoiceShutdownAcceptance, VoiceShutdownAcceptanceError, type VoiceInventoryObservation } from "./voice-shutdown-acceptance";

// A fictional draining deployment: these cases pin what the run asks for and what it refuses to call completion.
const token = (letter: string) => `eyJ${letter.repeat(12)}.${Buffer.from(JSON.stringify({ sub: letter })).toString("base64url")}.${letter.repeat(20)}`;
const json = (status: number, value: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
const cleanup = () => json(503, { error: "voice_cleanup_only", phiAllowed: false });
const base = { apiOrigin: "https://abcdefghij.execute-api.us-east-2.amazonaws.com", consumerIdToken: token("c"), workforceIdToken: token("w"),
  expectedAwsAccountId: "588966314750", observedAwsAccountId: "588966314750", sourceCommit: "a".repeat(40), migrationReleaseHash: "b".repeat(64), now: () => 1_800_000_000_000 };
const inventory = (patch: Omit<Partial<VoiceInventoryObservation>, "counts"> & { counts?: Record<string, number> } = {}): VoiceInventoryObservation => ({
  version: "owned-voice-inventory/1", atomicSnapshot: false, deletionCertified: false, fingerprint: "c".repeat(64), observedAt: "2026-09-21T10:00:00Z",
  ...patch, counts: { jobMetadata: 2, uncleanJobs: 1, objectVersions: 3, providerJobs: 1, ...(patch.counts ?? {}) } as VoiceInventoryObservation["counts"],
});
const drained = (answers: Response[] = []) => { const queue = [...answers]; return async () => queue.shift() ?? cleanup(); };

describe("hosted voice shutdown acceptance", () => {
  test("a draining deployment refuses every public method, and the run records what the inventories still hold without certifying anything", async () => {
    const calls: Array<{ url: string; method: string; auth: string }> = [];
    const report = await runVoiceShutdownAcceptance({ ...base, mode: "acceptance",
      inventories: [inventory(), inventory({ observedAt: "2026-09-21T11:00:00Z", fingerprint: "d".repeat(64), counts: { objectVersions: 2 } })],
      fetch: async (url, init) => { calls.push({ url, method: String(init?.method), auth: String((init?.headers as Record<string, string>).authorization) }); return cleanup(); } });
    expect(report.ok).toBe(true);
    expect(report.steps.map((s) => s.outcome)).toEqual(["passed", "passed", "passed", "passed", "passed", "passed", "passed"]);
    // The owner's own start, read and cancel are all asked for, and the workforce token is asked too.
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET", "DELETE", "GET"]);
    expect(calls.at(-1)!.auth).toBe("Bearer " + token("w"));
    expect(calls[0].url).toBe(base.apiOrigin + "/clinical-core/consumer/chat-transcription/jobs");
    // Retained work is reported honestly, and nothing is ever certified.
    expect(report.retained).toEqual({ jobMetadata: 2, uncleanJobs: 1, objectVersions: 2, providerJobs: 1 });
    expect(report.certifies).toEqual({ deletion: false, atomicSnapshot: false });
    expect(report.verdict).toMatchObject({ mode: "acceptance", unmet: [] });
    expect(report.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(report)).not.toContain(token("c").slice(0, 20));
  });
  test("a deployment that still serves, or answers with anything but the drain refusal, cannot pass", async () => {
    const served = await runVoiceShutdownAcceptance({ ...base, fetch: drained([json(202, { jobId: "x" })]) });
    expect(served.ok).toBe(false);
    expect(served.steps[0]).toMatchObject({ name: "drain refuses starting work", outcome: "failed", status: 202 });
    // An unrelated refusal is not the drain refusal: it does not prove the deployment is draining.
    const other = await runVoiceShutdownAcceptance({ ...base, fetch: drained([json(503, { error: "production_not_activated", phiAllowed: false })]) });
    expect(other.ok).toBe(false); expect(other.steps[0]).toMatchObject({ outcome: "failed", detail: "production_not_activated" });
    // A 404 means routing decided before the drain refusal did.
    const routed = await runVoiceShutdownAcceptance({ ...base, fetch: drained([cleanup(), json(404, { error: "voice_job_not_found" })]) });
    expect(routed.ok).toBe(false); expect(routed.steps[1]).toMatchObject({ outcome: "failed", status: 404 });
  });
  test("qualification execution while draining is a policy violation, not evidence", async () => {
    const marked = await runVoiceShutdownAcceptance({ ...base, mode: "acceptance", inventories: [inventory(), inventory({ observedAt: "2026-09-21T11:00:00Z" })],
      fetch: async () => json(503, { error: "voice_cleanup_only", phiAllowed: false }, { "x-clinical-execution": "qualification" }) });
    expect(marked.ok).toBe(false);
    expect(marked.steps.find((s) => s.name === "drain is not answered by qualification execution")).toMatchObject({ outcome: "failed", detail: "qualification_marker_while_draining" });
    expect(marked.execution).toBe("qualification");
  });
  test("inventories must be two ordered read-only reports, and growth during drain fails", async () => {
    await expect(runVoiceShutdownAcceptance({ ...base, mode: "acceptance", inventories: [inventory()], fetch: drained() })).rejects.toThrow("configuration_invalid");
    const grew = await runVoiceShutdownAcceptance({ ...base, mode: "acceptance", fetch: drained(),
      inventories: [inventory(), inventory({ observedAt: "2026-09-21T11:00:00Z", counts: { providerJobs: 4 } })] });
    expect(grew.ok).toBe(false);
    expect(grew.steps.at(-1)).toMatchObject({ outcome: "failed", detail: "grew:providerJobs" });
    const unordered = await runVoiceShutdownAcceptance({ ...base, mode: "acceptance", fetch: drained(),
      inventories: [inventory({ observedAt: "2026-09-21T11:00:00Z" }), inventory()] });
    expect(unordered.steps.at(-1)).toMatchObject({ outcome: "failed", detail: "observations_not_ordered" });
    // A report that claims certification or an atomic snapshot is refused outright.
    const claimed = await runVoiceShutdownAcceptance({ ...base, mode: "acceptance", fetch: drained(),
      inventories: [inventory({ deletionCertified: true as unknown as false }), inventory({ observedAt: "2026-09-21T11:00:00Z" })] });
    expect(claimed.ok).toBe(false);
    expect(claimed.steps.find((s) => s.name === "inventory reports are read-only and certify nothing")).toMatchObject({ outcome: "failed", detail: "inventory_report_invalid" });
    // Exploratory runs may have no inventory at all; they record the refusals and nothing more.
    const exploratory = await runVoiceShutdownAcceptance({ ...base, fetch: drained() });
    expect(exploratory.ok).toBe(true); expect(exploratory.retained).toBeNull();
    expect(exploratory.steps.slice(-2).every((s) => s.outcome === "skipped")).toBe(true);
    expect(exploratory.verdict.mode).toBe("exploratory");
  });
  test("configuration and boundary refusals happen before the first request", async () => {
    const refused = async (patch: Record<string, unknown>) => {
      let called = false;
      await expect(runVoiceShutdownAcceptance({ ...base, ...patch, fetch: async () => { called = true; return cleanup(); } } as Parameters<typeof runVoiceShutdownAcceptance>[0])).rejects.toBeInstanceOf(VoiceShutdownAcceptanceError);
      expect(called).toBe(false);
    };
    await refused({ apiOrigin: "https://example.com" });
    await refused({ apiOrigin: "http://abcdefghij.execute-api.us-east-2.amazonaws.com" });
    await refused({ expectedAwsAccountId: "173535830222", observedAwsAccountId: "173535830222" });
    await refused({ observedAwsAccountId: "111111111111" });
    await refused({ workforceIdToken: token("c") });
    await refused({ sourceCommit: "nope" });
  });
});
