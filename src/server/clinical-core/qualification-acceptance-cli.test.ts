import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FICTIONAL_ACCOUNT, FICTIONAL_COMMIT, FictionalQualificationDeployment, fictionalQualificationManifest } from "./testing/qualification-target-fictional";

/**
 * The real hosted acceptance CLIs (recording, export-retention, voice-shutdown), imported and run as `node` would run
 * them. Only the process boundary is replaced: `git` and `aws` answer from a fictional deployment through the mocked
 * `execFileSync` the observer itself calls, the report file is captured instead of written, the database and inventory
 * readers are fictional, and `fetch` is a fictional API. No AWS call, credential or request; not hosted evidence.
 */
const host = vi.hoisted(() => ({
  deployment: null as null | { runner: (file: string, args: string[]) => string },
  reports: [] as Array<{ path: string; body: Record<string, unknown> }>,
  inventory: 0,
}));
vi.mock("node:child_process", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: (file: string, args: string[]) => { if (!host.deployment) throw new Error("fictional_deployment_absent"); return host.deployment.runner(file, args); } }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, mkdirSync: (path: string, options?: unknown) => (String(path) === "dist/qualification" ? undefined : actual.mkdirSync(path, options as never)),
    writeFileSync: (path: string, data: string, options?: unknown) => {
      if (String(path).startsWith("dist/qualification/")) { host.reports.push({ path: String(path), body: JSON.parse(String(data)) }); return; }
      actual.writeFileSync(path, data, options as never);
    } };
});
vi.mock("./migrations", async (importOriginal) => ({ ...(await importOriginal<typeof import("./migrations")>()), loadClinicalCoreMigrations: () => [] }));
vi.mock("./production-migrations", async (importOriginal) => ({ ...(await importOriginal<typeof import("./production-migrations")>()),
  productionArtifactReleaseHash: () => "b".repeat(64),
  inspectProductionClinicalCoreMigrations: async () => ({ ledgerPresent: true, missing: [], mismatched: [], unknown: [], artifactReleaseHash: "b".repeat(64) }) }));
vi.mock("./rds-data-database", async (importOriginal) => ({ ...(await importOriginal<typeof import("./rds-data-database")>()), createRdsDataAdministrativeDatabase: () => ({ fictional: true }) }));
vi.mock("./recording-acceptance-fixture", async (importOriginal) => ({ ...(await importOriginal<typeof import("./recording-acceptance-fixture")>()),
  provisionRecordingAcceptanceEncounter: async () => ({ encounterId: "11111111-1111-4111-8111-111111111111", reused: false }) }));
vi.mock("./synthetic-fixtures", async (importOriginal) => ({ ...(await importOriginal<typeof import("./synthetic-fixtures")>()),
  loadSyntheticAcceptanceManifest: () => ({ awsAccountId: "111122223333", fixture: { consumerSubject: "fictional-consumer-0001", workforceSubject: "fictional-workforce-0001" } }) }));
vi.mock("./owned-voice-inventory-reader", async (importOriginal) => ({ ...(await importOriginal<typeof import("./owned-voice-inventory-reader")>()),
  readVoiceDrainInventory: async () => {
    await new Promise((resolve) => setTimeout(resolve, 5)); // two inventory reads are apart in time
    host.inventory += 1;
    return { version: "owned-voice-inventory/1", atomicSnapshot: false, deletionCertified: false, counts: { jobMetadata: 1, uncleanJobs: 0, objectVersions: 1, providerJobs: 0 },
      fingerprint: "c".repeat(64), configurationRevision: "fictional-revision-1" };
  } }));

const CLI = {
  recording: () => import("./recording-acceptance-cli"),
  export: () => import("./export-retention-acceptance-cli"),
  voice: () => import("./voice-shutdown-acceptance-cli"),
};
const token = (letter: string, claims: Record<string, unknown> = {}) => `eyJ${letter.repeat(12)}.${Buffer.from(JSON.stringify({ sub: letter, ...claims })).toString("base64url")}.${letter.repeat(20)}`;
const json = (status: number, value: unknown, marked = true) => new Response(JSON.stringify(value), { status,
  headers: { "content-type": "application/json", ...(marked ? { "x-clinical-execution": "qualification" } : {}) } });
const cleanup = () => json(503, { error: "voice_cleanup_only", phiAllowed: false }, false);

type Line = Record<string, unknown> & { ok: boolean };
let manifestPath = "";
let deployment: FictionalQualificationDeployment;
let requests: string[] = [];
const directories: string[] = [];

beforeEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const directory = actual.mkdtempSync(join(tmpdir(), "alp-acceptance-cli-test-"));
  directories.push(directory);
  manifestPath = join(directory, "qualification-target.json");
  const manifest = fictionalQualificationManifest();
  actual.writeFileSync(manifestPath, JSON.stringify(manifest));
  deployment = new FictionalQualificationDeployment(manifest, ["owned-voice"]);
  host.deployment = deployment; host.reports = []; host.inventory = 0; requests = [];
});
afterEach(async () => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); host.deployment = null;
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  for (const directory of directories.splice(0)) actual.rmSync(directory, { recursive: true, force: true });
});

/** Runs one CLI to completion: its single JSON line and the exit status it set. */
async function runCli(kind: keyof typeof CLI, env: Record<string, string>, answer: (url: string, init?: RequestInit) => Response | Promise<Response>, command?: string) {
  vi.resetModules();
  vi.stubEnv("CLINICAL_QUALIFICATION_TARGET", manifestPath);
  for (const name of ["ACCEPTANCE_MODE", "SOURCE_COMMIT", "OBSERVED_AWS_ACCOUNT_ID", "CLINICAL_RECORDING_FIXTURE_BOUNDARY", "CLINICAL_VOICE_INVENTORIES", "SCHEDULED_CLEANUP_WAIT_MINUTES",
    "CLINICAL_API_ORIGIN", "CLINICAL_DATABASE_NAME", "CLINICAL_DATABASE_CLUSTER_ARN", "CLINICAL_DATABASE_SECRET_ARN", "EXPECTED_AWS_ACCOUNT_ID", "AWS_REGION", "CLINICAL_RECORDING_AUDIO_FILE"]) vi.stubEnv(name, "");
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => { requests.push(String(url)); return answer(String(url), init); });
  const lines: Array<{ stream: "out" | "err"; line: Line }> = [];
  const log = vi.spyOn(console, "log").mockImplementation((value: unknown) => { lines.push({ stream: "out", line: JSON.parse(String(value)) }); });
  const error = vi.spyOn(console, "error").mockImplementation((value: unknown) => { lines.push({ stream: "err", line: JSON.parse(String(value)) }); });
  const savedArgv = process.argv, savedExit = process.exitCode;
  process.argv = [savedArgv[0]!, "fictional-acceptance-cli", ...(command ? [command] : [])];
  process.exitCode = undefined;
  try {
    await CLI[kind]();
    await vi.waitFor(() => { if (lines.length === 0) throw new Error("cli_pending"); }, { timeout: 15_000, interval: 5 });
    return { exitCode: process.exitCode ?? 0, ...lines[0]!, lines };
  } finally {
    process.argv = savedArgv; process.exitCode = savedExit;
    log.mockRestore(); error.mockRestore();
  }
}

const recordingTokens = { CLINICAL_WORKFORCE_ID_TOKEN: token("w"), CLINICAL_CONSUMER_ID_TOKEN: token("c") };
const recordingFixture = { ...recordingTokens, CLINICAL_SYNTHETIC_MANIFEST: "/fictional/synthetic-acceptance.json" };
const recordingRun = { ...recordingTokens, CLINICAL_RECORDING_ENCOUNTER_ID: "11111111-1111-4111-8111-111111111111", CLINICAL_RECORDING_JURISDICTION: "US-SYNTHETIC" };
const exportTokens = { CLINICAL_CONSUMER_ID_TOKEN: token("c"), CLINICAL_WORKFORCE_ID_TOKEN: token("w"), CLINICAL_FOREIGN_CONSUMER_ID_TOKEN: token("f"),
  CLINICAL_STALE_CONSUMER_ID_TOKEN: token("s", { auth_time: Math.floor(Date.now() / 1000) - 10 * 60 }) };
const voiceTokens = { CLINICAL_CONSUMER_ID_TOKEN: token("c"), CLINICAL_WORKFORCE_ID_TOKEN: token("w") };
const notActivated = () => json(503, { error: "production_not_activated", phiAllowed: false });
const drainOnly = () => cleanup();

describe("the hosted acceptance CLIs refuse a source boundary they cannot vouch for, before the first request", () => {
  test("a dirty checkout is refused in acceptance mode before any AWS call or request, whatever HEAD says", async () => {
    deployment.status = " M src/server/clinical-core/recording-acceptance.ts\n";
    for (const [kind, env, command] of [["recording", recordingRun, "run"], ["recording", recordingFixture, "fixture"], ["export", exportTokens, undefined], ["voice", voiceTokens, undefined]] as const) {
      const result = await runCli(kind, env, notActivated, command);
      expect(result, kind).toMatchObject({ exitCode: 1, stream: "err", line: { ok: false, error: "target_source_dirty:checkout" } });
    }
    expect(requests).toEqual([]); expect(deployment.awsCalls()).toBe(0);
  });
  test("a stale checkout is refused before the account is even asked (coverage: this already refused)", async () => {
    deployment.head = "c".repeat(40);
    const result = await runCli("export", exportTokens, notActivated);
    expect(result).toMatchObject({ exitCode: 1, line: { error: "target_source_mismatch:checkout" } });
    expect(requests).toEqual([]); expect(deployment.awsCalls()).toBe(0);
  });
  test("a missing candidate stack is refused (coverage: this already refused)", async () => {
    deployment.remove("owned-voice");
    const result = await runCli("voice", voiceTokens, drainOnly);
    expect(result).toMatchObject({ exitCode: 1, line: { error: "target_stack_refused:owned-voice" } });
    expect(requests).toEqual([]);
  });
  test("an asserted SOURCE_COMMIT or account that disagrees with the observation is refused, not silently overridden", async () => {
    const commit = await runCli("export", { ...exportTokens, SOURCE_COMMIT: "c".repeat(40) }, notActivated);
    expect(commit).toMatchObject({ exitCode: 1, line: { error: "target_source_mismatch:asserted" } });
    const account = await runCli("recording", { ...recordingRun, OBSERVED_AWS_ACCOUNT_ID: "444455556666" }, notActivated, "run");
    expect(account).toMatchObject({ exitCode: 1, line: { error: "target_account_refused:asserted" } });
    expect(requests).toEqual([]);
    // What the wrapper actually passes (the values it observed) is accepted.
    const agreed = await runCli("export", { ...exportTokens, SOURCE_COMMIT: FICTIONAL_COMMIT, OBSERVED_AWS_ACCOUNT_ID: FICTIONAL_ACCOUNT }, notActivated);
    expect(agreed.line.error).toBeUndefined(); expect(requests.length).toBeGreaterThan(0);
  });
  test("a stack that changed between the recording fixture and the run refuses the run before its first request", async () => {
    const fixture = await runCli("recording", recordingFixture, notActivated, "fixture");
    expect(fixture).toMatchObject({ exitCode: 0, stream: "out", line: { ok: true, mode: "recording_acceptance_fixture", target: { source: "observed" } } });
    expect(fixture.line.boundary).toMatch(/^[a-f0-9]{64}$/);
    // The same deployment: the run proceeds (and stops honestly at the not-activated plane).
    const same = await runCli("recording", { ...recordingRun, CLINICAL_RECORDING_FIXTURE_BOUNDARY: String(fixture.line.boundary) }, notActivated, "run");
    expect(same.line.error).toBeUndefined(); expect(requests).toHaveLength(1);
    deployment.redeploy("recording-transcription", { parameters: { CodeVersion: "fictional-code-version-2" } });
    requests = [];
    const changed = await runCli("recording", { ...recordingRun, CLINICAL_RECORDING_FIXTURE_BOUNDARY: String(fixture.line.boundary) }, notActivated, "run");
    expect(changed).toMatchObject({ exitCode: 1, line: { ok: false, error: "target_changed_between_steps:fixture" } });
    expect(requests).toEqual([]);
  });
});

describe("the hosted acceptance CLIs re-observe the deployment after the last request, and only an unchanged one qualifies", () => {
  test("a complete drain run over an unchanged deployment is qualified, and the report carries both observations", async () => {
    const result = await runCli("voice", voiceTokens, drainOnly);
    expect(result).toMatchObject({ exitCode: 0, stream: "out", line: { ok: true, qualified: true, unverified: [], sourceBoundary: { state: "unchanged", changed: [] }, verdict: { mode: "acceptance" } } });
    expect(requests).toHaveLength(4); expect(host.inventory).toBe(2);
    expect(host.reports).toHaveLength(1);
    const report = host.reports[0]!.body as { sourceBoundary: { before: { sha256: string; stacks: unknown[] }; after: { sha256: string } }; qualified: boolean };
    expect(report.qualified).toBe(true); expect(report.sourceBoundary.before.sha256).toBe(report.sourceBoundary.after.sha256);
    expect(report.sourceBoundary.before.stacks).toHaveLength(1);
  });
  test("a redeploy in the middle of the run invalidates the report, which is still written", async () => {
    const result = await runCli("voice", voiceTokens, () => { if (requests.length === 2) deployment.redeploy("owned-voice"); return cleanup(); });
    expect(result).toMatchObject({ exitCode: 1, line: { ok: false, qualified: false, sourceBoundary: { state: "changed", changed: ["owned-voice"], refusal: "target_changed_mid_run" } } });
    expect(host.reports).toHaveLength(1); expect(host.reports[0]!.body).toMatchObject({ ok: false, qualified: false });
    // Every step itself passed: only the boundary refused the run.
    expect((host.reports[0]!.body.steps as Array<{ outcome: string }>).every((s) => s.outcome === "passed")).toBe(true);
  });
  test("a stack left updating, or a checkout edited, when the run closes is refused, and the run does not qualify", async () => {
    const updating = await runCli("voice", voiceTokens, () => { if (requests.length === 4) deployment.redeploy("owned-voice", { status: "UPDATE_IN_PROGRESS" }); return cleanup(); });
    expect(updating).toMatchObject({ exitCode: 1, line: { qualified: false, sourceBoundary: { state: "refused", refusal: "target_stack_refused:owned-voice" } } });
    // That stack is still updating, so a new run would refuse it before its first request; let the update finish.
    const blocked = await runCli("voice", voiceTokens, drainOnly);
    expect(blocked).toMatchObject({ exitCode: 1, line: { error: "target_stack_refused:owned-voice" } });
    deployment.redeploy("owned-voice"); requests = [];
    const edited = await runCli("voice", voiceTokens, () => { if (requests.length === 4) deployment.status = "?? new-file.ts\n"; return cleanup(); });
    expect(edited).toMatchObject({ exitCode: 1, line: { qualified: false, sourceBoundary: { state: "refused", refusal: "target_source_dirty:checkout" } } });
  });
  test("the hosted shape of the cross-identity drain step, an unmarked authorizer denial, is unverified and fails the run", async () => {
    const result = await runCli("voice", voiceTokens, (url, init) =>
      (String((init?.headers as Record<string, string>).authorization) === `Bearer ${voiceTokens.CLINICAL_WORKFORCE_ID_TOKEN}` ? json(401, { message: "Unauthorized" }, false) : cleanup()));
    expect(result).toMatchObject({ exitCode: 1, line: { ok: false, qualified: false, unverified: ["drain refuses another identity the same way"], sourceBoundary: { state: "unchanged" } } });
  });
  test("skipped mandatory cases and a missing execution marker still fail the run (coverage: both already failed)", async () => {
    const skipped = await runCli("export", exportTokens, (url) => (url.endsWith("/personal/posture")
      ? json(200, { data: { contractVersion: "personal-posture/1", launchTier: "core", enabledScopes: [] } }) : json(503, { error: "export_delivery_not_configured" })));
    expect(skipped).toMatchObject({ exitCode: 1, line: { ok: false, qualified: false, notConfigured: ["request export job"], sourceBoundary: { state: "unchanged" } } });
    expect((host.reports.at(-1)!.body.steps as Array<{ outcome: string }>).filter((s) => s.outcome === "skipped")).toHaveLength(10);
    const unmarked = await runCli("recording", recordingRun, () => json(503, { error: "production_not_activated", phiAllowed: false }, false), "run");
    expect(unmarked).toMatchObject({ exitCode: 1, line: { ok: false, qualified: false, execution: "production" } });
  });
  test("exploratory mode keeps its asserted values and its partial verdict, observes nothing, and is never qualified", async () => {
    deployment.status = " M exploratory-edit.ts\n"; // exploration is allowed on a working tree; it is not evidence
    const result = await runCli("voice", { ...voiceTokens, ACCEPTANCE_MODE: "exploratory", SOURCE_COMMIT: FICTIONAL_COMMIT, OBSERVED_AWS_ACCOUNT_ID: FICTIONAL_ACCOUNT }, drainOnly);
    expect(result).toMatchObject({ exitCode: 0, line: { ok: true, qualified: false, target: { source: "asserted_by_caller" }, verdict: { mode: "exploratory" }, sourceBoundary: { state: "not_observed" } } });
    expect(deployment.calls).toEqual([]);
  });
});
