if (typeof window !== "undefined") throw new Error("clinical-core/voice-shutdown-acceptance is server-only.");
import { createHash } from "node:crypto";
import { observeExecution, summariseExecution, type ObservedExecution } from "./qualification-execution";

/**
 * Hosted acceptance of the reviewed voice shutdown (drain) transition. The drain path has existed in source since the
 * cleanup-only drain and the read-only inventory, but nothing qualified the *transition*: that a deployment set to
 * `draining` really refuses every public request with `voice_cleanup_only`, that no identity gets a privileged way back
 * in, that qualification execution stays refused while draining (the policy forbids serving the fictional identities in
 * that state), and that the operator's inventory reports remain read-only and certify nothing.
 *
 * What this harness is not: it is not erasure evidence. Disabling scheduling or IAM is not object erasure, an empty
 * batch is not an empty inventory, and two inventory reads are not an atomic snapshot. The report records what the
 * deployment refused and what the inventories still hold; completion remains a reviewed human step.
 */
export type VoiceShutdownStep = { index: number; name: string; expected: string; outcome: "passed" | "failed" | "skipped"; status?: number; detail?: string };
export type VoiceShutdownReport = {
  schemaVersion: "voice-shutdown-acceptance/1"; environment: "synthetic-staging"; ok: boolean;
  sourceCommit: string; migrationReleaseHash: string; configurationSha256: string; awsAccountId: string;
  startedAt: string; finishedAt: string; steps: VoiceShutdownStep[];
  /** What the two inventory observations still hold. Present work is honest, never a failure; it is simply not completion. */
  retained: { jobMetadata: number; uncleanJobs: number; objectVersions: number; providerJobs: number } | null;
  /** The deployment answered these responses; a qualification marker while draining is a policy violation. */
  execution: ObservedExecution; unmarkedDenials: boolean;
  /** Stated on every report: this harness never certifies deletion and never observes an atomic snapshot. */
  certifies: { deletion: false; atomicSnapshot: false };
  verdict: { mode: "exploratory" | "acceptance"; mandatory: string[]; unmet: string[] };
  evidenceSha256: string;
};
export const VOICE_SHUTDOWN_ACCEPTANCE_STEPS = ["drain refuses starting work", "drain refuses reading a job", "drain refuses cancelling a job",
  "drain refuses another identity the same way", "drain is not answered by qualification execution", "inventory reports are read-only and certify nothing",
  "inventory did not grow between the two observations"] as const;
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export class VoiceShutdownAcceptanceError extends Error { constructor(readonly category: "configuration_invalid" | "boundary_refused") { super(category); } }
const ROOT = "/clinical-core/consumer/chat-transcription/jobs";
const FICTIONAL_JOB = "a".repeat(64);
/** The shape the read-only inventory CLI prints; only counts and fingerprints, never owners, keys or job ids. */
export type VoiceInventoryObservation = {
  version: "owned-voice-inventory/1"; atomicSnapshot: false; deletionCertified: false;
  counts: { jobMetadata: number; uncleanJobs: number; objectVersions: number; providerJobs: number } & Record<string, number>;
  fingerprint: string; observedAt: string;
};

export async function runVoiceShutdownAcceptance(input: {
  apiOrigin: string; consumerIdToken: string; workforceIdToken: string;
  expectedAwsAccountId: string; observedAwsAccountId: string; sourceCommit: string; migrationReleaseHash: string;
  /** Two read-only inventory reports, taken apart in time after old invocations ended (`owned-voice/inventory.cjs --read-only`). */
  inventories?: readonly VoiceInventoryObservation[];
  mode?: "exploratory" | "acceptance";
  fetch?: FetchLike; now?: () => number;
}): Promise<VoiceShutdownReport> {
  const fetcher = input.fetch ?? fetch, now = input.now ?? Date.now, startedAt = new Date(now()).toISOString();
  const origin = validate(input);
  const mode = input.mode ?? "exploratory";
  const inventories = input.inventories ?? [];
  if (mode === "acceptance" && inventories.length < 2) throw new VoiceShutdownAcceptanceError("configuration_invalid");
  const steps: VoiceShutdownStep[] = [];
  const executions = new Set<string>();
  let index = 0;
  const step = async (name: string, expected: string, work: () => Promise<{ outcome: VoiceShutdownStep["outcome"]; status?: number; detail?: string }>) => {
    index += 1;
    try { const result = await work(); steps.push({ index, name, expected, ...result }); return result; }
    catch (error) { const detail = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "step_failed"; steps.push({ index, name, expected, outcome: "failed", detail }); return { outcome: "failed" as const, detail }; }
  };
  const call = async (path: string, bearer: string, method: "GET" | "POST" | "DELETE", body?: Record<string, unknown>) => {
    let response: Response;
    try {
      response = await fetcher(`${origin}${path}`, { method, headers: { authorization: `Bearer ${bearer}`, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), redirect: "manual", signal: AbortSignal.timeout(25_000) });
    } catch { return { status: 0, body: null as unknown, marked: false }; }
    observeExecution(executions, response.headers, response.status);
    const marked = response.headers.get("x-clinical-execution") === "qualification";
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 65_536) return { status: response.status, body: null as unknown, marked };
    try { return { status: response.status, body: JSON.parse(new TextDecoder().decode(bytes)) as unknown, marked }; } catch { return { status: response.status, body: null as unknown, marked }; }
  };
  const cleanupOnly = (r: { status: number; body: unknown }) => {
    const data = r.body as { error?: unknown; phiAllowed?: unknown } | null;
    // The refusal must be the drain refusal, not an incidental error, and it must not disclose PHI posture as enabled.
    return r.status === 503 && data?.error === "voice_cleanup_only" && data?.phiAllowed === false;
  };

  // 1 to 3. Every public method is refused while draining: starting work, reading a job, and the owner's own cancellation
  //         (the cleanup worker cancels on their behalf; an owner-facing cancel would be a write path back in).
  const first = await step("drain refuses starting work", "503 voice_cleanup_only for a start request from the owner", async () => {
    const r = await call(ROOT, input.consumerIdToken, "POST", { contentType: "audio/wav", byteLength: 1 });
    return { outcome: cleanupOnly(r) ? "passed" : "failed", status: r.status, detail: cleanupOnly(r) ? undefined : errorCode(r) };
  });
  await step("drain refuses reading a job", "503 voice_cleanup_only for a status read, before routing decides the job exists", async () => {
    const r = await call(`${ROOT}/${FICTIONAL_JOB}`, input.consumerIdToken, "GET");
    return { outcome: cleanupOnly(r) ? "passed" : "failed", status: r.status, detail: cleanupOnly(r) ? undefined : errorCode(r) };
  });
  await step("drain refuses cancelling a job", "503 voice_cleanup_only for the owner's own cancellation", async () => {
    const r = await call(`${ROOT}/${FICTIONAL_JOB}`, input.consumerIdToken, "DELETE");
    return { outcome: cleanupOnly(r) ? "passed" : "failed", status: r.status, detail: cleanupOnly(r) ? undefined : errorCode(r) };
  });
  // 4. No identity has a way back in: a workforce token is refused exactly as the owner is, and never served.
  await step("drain refuses another identity the same way", "503 voice_cleanup_only for a workforce token; never 200", async () => {
    const r = await call(`${ROOT}/${FICTIONAL_JOB}`, input.workforceIdToken, "GET");
    const ok = cleanupOnly(r) || (r.status === 503 && (r.body as { error?: unknown } | null)?.error === "production_not_activated");
    return { outcome: ok ? "passed" : "failed", status: r.status, detail: ok ? undefined : errorCode(r) };
  });
  // 5. Qualification execution is refused while draining, by policy. A marked response here means a deployment that
  //    serves the fictional identities in a state that is supposed to serve no one.
  await step("drain is not answered by qualification execution", "no response carries x-clinical-execution: qualification", async () => {
    const marked = steps.length > 0 && executions.has("qualification");
    return { outcome: marked ? "failed" : "passed", detail: marked ? "qualification_marker_while_draining" : undefined };
  });
  // 6 and 7. The operator's inventories: read-only, certifying nothing, and not growing while the deployment drains.
  await step("inventory reports are read-only and certify nothing", "each report is owned-voice-inventory/1 with deletionCertified and atomicSnapshot false", async () => {
    if (inventories.length === 0) return { outcome: "skipped", detail: "no_inventory_supplied" };
    const ok = inventories.every((report) => report?.version === "owned-voice-inventory/1" && report.deletionCertified === false && report.atomicSnapshot === false
      && /^[a-f0-9]{64}$/.test(String(report.fingerprint)) && typeof report.counts?.jobMetadata === "number");
    return { outcome: ok ? "passed" : "failed", detail: ok ? `reports:${inventories.length}` : "inventory_report_invalid" };
  });
  const latest = inventories.at(-1) ?? null;
  await step("inventory did not grow between the two observations", "two reports taken apart in time; no count increased while draining", async () => {
    if (inventories.length < 2) return { outcome: "skipped", detail: "fewer_than_two_inventories" };
    const [before, after] = [inventories[0]!, inventories.at(-1)!];
    if (!(Date.parse(after.observedAt) > Date.parse(before.observedAt))) return { outcome: "failed", detail: "observations_not_ordered" };
    const grew = (["jobMetadata", "uncleanJobs", "objectVersions", "providerJobs"] as const).filter((key) => Number(after.counts[key]) > Number(before.counts[key]));
    return { outcome: grew.length === 0 ? "passed" : "failed", detail: grew.length === 0 ? `unchanged_or_lower:${before.fingerprint === after.fingerprint ? "same" : "different"}` : `grew:${grew.join(",")}` };
  });

  const finishedAt = new Date(now()).toISOString();
  const configurationSha256 = createHash("sha256").update(JSON.stringify({ origin, account: input.expectedAwsAccountId, sourceCommit: input.sourceCommit, migrationReleaseHash: input.migrationReleaseHash })).digest("hex");
  const observed = summariseExecution(executions);
  const mandatory: string[] = mode === "acceptance" ? [...VOICE_SHUTDOWN_ACCEPTANCE_STEPS] : ["drain refuses starting work", "drain refuses reading a job", "drain refuses cancelling a job", "drain is not answered by qualification execution"];
  const unmet = mandatory.filter((name) => !steps.some((s) => s.name === name && s.outcome === "passed"));
  // The deployment must have answered, and never as qualification: draining serves no one.
  const executionOk = observed.execution !== "unobserved" && observed.execution !== "qualification" && observed.execution !== "mixed";
  const ok = steps.every((s) => s.outcome === "passed" || s.outcome === "skipped") && unmet.length === 0 && executionOk && first.outcome === "passed";
  const report: Omit<VoiceShutdownReport, "evidenceSha256"> = {
    schemaVersion: "voice-shutdown-acceptance/1", environment: "synthetic-staging", ok, sourceCommit: input.sourceCommit, migrationReleaseHash: input.migrationReleaseHash,
    configurationSha256, awsAccountId: input.expectedAwsAccountId, startedAt, finishedAt, steps,
    retained: latest ? { jobMetadata: latest.counts.jobMetadata, uncleanJobs: latest.counts.uncleanJobs, objectVersions: latest.counts.objectVersions, providerJobs: latest.counts.providerJobs } : null,
    ...observed, certifies: { deletion: false, atomicSnapshot: false }, verdict: { mode, mandatory, unmet },
  };
  return { ...report, evidenceSha256: createHash("sha256").update(JSON.stringify({ ...report, startedAt: undefined, finishedAt: undefined })).digest("hex") };
}

function errorCode(r: { status: number; body: unknown }): string {
  const data = r.body as { error?: unknown } | null;
  return typeof data?.error === "string" && /^[a-z_]{1,64}$/.test(data.error) ? data.error : `status_${r.status}`;
}

function validate(input: { apiOrigin: string; consumerIdToken: string; workforceIdToken: string; expectedAwsAccountId: string; observedAwsAccountId: string; sourceCommit: string; migrationReleaseHash: string }): string {
  let url: URL;
  try { url = new URL(input.apiOrigin); } catch { throw new VoiceShutdownAcceptanceError("configuration_invalid"); }
  if (url.protocol !== "https:" || !/\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname) || url.pathname !== "/") throw new VoiceShutdownAcceptanceError("configuration_invalid");
  if (!/^\d{12}$/.test(input.expectedAwsAccountId) || input.expectedAwsAccountId !== input.observedAwsAccountId) throw new VoiceShutdownAcceptanceError("configuration_invalid");
  if (input.expectedAwsAccountId === "173535830222") throw new VoiceShutdownAcceptanceError("boundary_refused");
  if (!/^[a-f0-9]{40}$/.test(input.sourceCommit) || !/^[a-f0-9]{64}$/.test(input.migrationReleaseHash)) throw new VoiceShutdownAcceptanceError("configuration_invalid");
  const tokens = [input.consumerIdToken, input.workforceIdToken];
  if (tokens.some((t) => !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(t)) || new Set(tokens).size !== tokens.length) throw new VoiceShutdownAcceptanceError("configuration_invalid");
  return url.origin;
}
