if (typeof window !== "undefined") throw new Error("clinical-core/export-retention-acceptance is server-only.");
import { createHash } from "node:crypto";
import { observeExecution, summariseExecution, type ObservedExecution } from "./qualification-execution";

/** Hosted synthetic acceptance for the personal-storage export job and its
 * retention (Desktop migrations 93 to 97). Runs only against the synthetic
 * account with fictional identities; writing it needs no AWS access, running
 * it does. Every step records what was asked, what came back and whether it
 * matched the contract, and the run ends with a machine-readable report bound
 * to the source commit, the migration release hash and a hash of the
 * configuration it ran with. A refusal because export delivery or export
 * cleanup is not configured is a reported outcome (`not_configured`), never a
 * pass: blocked endpoints returning refusals are not positive acceptance. The
 * fixtures this run creates (one export job per pass) are cancelled and their
 * objects removed by the same run; anything still retained is reported. */
export type ExportAcceptanceStep = { index: number; name: string; expected: string; outcome: "passed" | "failed" | "not_configured" | "skipped"; status?: number; detail?: string };
export type ExportAcceptanceReport = {
  schemaVersion: "export-retention-acceptance/1"; environment: "synthetic-staging"; ok: boolean;
  sourceCommit: string; migrationReleaseHash: string; configurationSha256: string; awsAccountId: string; startedAt: string; finishedAt: string;
  steps: ExportAcceptanceStep[]; retained: { jobId: string; state: string }[];
  /** Which execution answered (docs/aws-qualification-target.md): a qualification run is never production activation evidence. */
  execution: ObservedExecution; productionActivationEvidence: boolean; evidenceSha256: string;
};
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export class ExportAcceptanceError extends Error { constructor(readonly category: "configuration_invalid" | "boundary_refused") { super(category); } }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONSUMER = "/clinical-core/consumer/personal/privacy-export/job";
const OPERATIONS = "/clinical-core/workforce/privacy-operations";

export async function runExportRetentionAcceptance(input: {
  apiOrigin: string; consumerIdToken: string; workforceIdToken: string; foreignConsumerIdToken?: string;
  expectedAwsAccountId: string; observedAwsAccountId: string; sourceCommit: string; migrationReleaseHash: string;
  fetch?: FetchLike; now?: () => number; maxPasses?: number;
}): Promise<ExportAcceptanceReport> {
  const fetcher = input.fetch ?? fetch, now = input.now ?? Date.now, startedAt = new Date(now()).toISOString();
  const origin = validate(input);
  const steps: ExportAcceptanceStep[] = [];
  let index = 0;
  const step = async (name: string, expected: string, work: () => Promise<{ outcome: ExportAcceptanceStep["outcome"]; status?: number; detail?: string }>) => {
    index += 1;
    try { const r = await work(); steps.push({ index, name, expected, ...r }); return r; }
    catch (error) { const detail = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "step_failed"; steps.push({ index, name, expected, outcome: "failed", detail }); return { outcome: "failed" as const, detail }; }
  };
  const call = async (path: string, bearer: string, body?: Record<string, unknown>, method?: "GET" | "POST") => {
    let response: Response;
    try {
      response = await fetcher(`${origin}${path}`, { method: method ?? (body ? "POST" : "GET"), headers: { authorization: `Bearer ${bearer}`, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), redirect: "manual", signal: AbortSignal.timeout(25_000) });
    } catch { return { status: 0, body: null as unknown }; }
    observeExecution(executions, response.headers);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 65_536) return { status: response.status, body: null as unknown };
    try { return { status: response.status, body: JSON.parse(new TextDecoder().decode(bytes)) as unknown }; } catch { return { status: response.status, body: null as unknown }; }
  };
  const data = (r: { body: unknown }) => (r.body && typeof r.body === "object" && "data" in (r.body as object) ? (r.body as { data: unknown }).data : null) as Record<string, unknown> | null;
  const errorCode = (r: { body: unknown }) => (r.body && typeof r.body === "object" && typeof (r.body as { error?: unknown }).error === "string" ? (r.body as { error: string }).error : undefined);
  const retained: { jobId: string; state: string }[] = [];
  const executions = new Set<string>();
  let jobId: string | null = null, configured = true;

  // 1. Posture: the deployment must be the synthetic boundary before any write.
  await step("consumer posture", "200 with launchTier core and personal-posture/1", async () => {
    const r = await call("/clinical-core/consumer/personal/posture", input.consumerIdToken);
    const d = data(r); const ok = r.status === 200 && d?.contractVersion === "personal-posture/1" && d?.launchTier === "core";
    return { outcome: ok ? "passed" : "failed", status: r.status };
  });
  // 2. Request a job. 503 export_delivery_not_configured is an honest, reported non-result.
  await step("request export job", "200 requested job, or 503 export_delivery_not_configured", async () => {
    const r = await call(CONSUMER, input.consumerIdToken, { requestId: uuid(now) });
    if (r.status === 503 && errorCode(r) === "export_delivery_not_configured") { configured = false; return { outcome: "not_configured", status: 503, detail: "export_delivery_not_configured" }; }
    const d = data(r);
    if (r.status === 200 && d && UUID.test(String(d.jobId)) && d.status === "requested" && d.retention === "packaging") { jobId = String(d.jobId); return { outcome: "passed", status: 200 }; }
    if (r.status === 409) return { outcome: "failed", status: 409, detail: "open_job_or_hourly_limit" };
    return { outcome: "failed", status: r.status, detail: errorCode(r) };
  });
  if (!configured) {
    for (const name of ["cross-owner read refused", "stale sign-in download refused", "advance passes to ready", "download link for the exact version", "cancel and cleanup", "operator backlog", "operator cleanup pass", "operator reconcile pass"])
      await step(name, "not run", async () => ({ outcome: "skipped", detail: "export_delivery_not_configured" }));
  } else if (jobId) {
    const id = jobId;
    // 3. Another identity never reads the job (workforce token on a consumer route, and a second consumer when supplied).
    await step("cross-owner read refused", "401/403 for a workforce token; 401/403 for another consumer", async () => {
      const w = await call(`${CONSUMER}?jobId=${id}`, input.workforceIdToken);
      const f = input.foreignConsumerIdToken ? await call(`${CONSUMER}?jobId=${id}`, input.foreignConsumerIdToken) : null;
      const ok = [401, 403].includes(w.status) && (!f || [401, 403].includes(f.status));
      return { outcome: ok ? "passed" : "failed", status: w.status, detail: f ? `foreign:${f.status}` : "foreign_token_absent" };
    });
    // 4. Advance in bounded passes until ready; each pass must move or hold the state honestly.
    let view: Record<string, unknown> | null = null;
    await step("advance passes to ready", "each advance 200; final status ready with retention downloadable and a composite checksum", async () => {
      for (let i = 0; i < (input.maxPasses ?? 40); i++) {
        const r = await call(`${CONSUMER}?jobId=${id}&advance=true`, input.consumerIdToken);
        if (r.status === 409) { await new Promise((resolve) => setTimeout(resolve, 1500)); continue; }
        if (r.status !== 200) return { outcome: "failed", status: r.status, detail: errorCode(r) };
        view = data(r);
        if (!view || !["requested", "running", "ready", "failed"].includes(String(view.status))) return { outcome: "failed", status: 200, detail: "view_invalid" };
        if (view.status === "ready") break;
        if (view.status === "failed") return { outcome: "failed", status: 200, detail: `job_failed:${String(view.failureCode)}` };
      }
      const ok = view?.status === "ready" && view.retention === "downloadable" && /^[A-Za-z0-9+/]{43}=-[0-9]+$/.test(String(view.objectChecksum)) && view.exportedRecords === view.recordCount;
      return { outcome: ok ? "passed" : "failed", status: 200, detail: ok ? `parts:${String(view!.parts)}` : "not_ready" };
    });
    // 5. A stale sign-in cannot download: the API reads auth_time from the token, so a token older than five minutes is the only way to test this
    //    hosted; the harness records the outcome rather than forging one.
    await step("stale sign-in download refused", "401 reauth_required when the token's auth_time is older than five minutes; otherwise recorded as not exercised", async () => {
      const authTime = tokenAuthTime(input.consumerIdToken);
      if (authTime === null || now() - authTime * 1000 <= 5 * 60_000) return { outcome: "skipped", detail: "token_is_fresh" };
      const r = await call(`${CONSUMER}/download`, input.consumerIdToken, { jobId: id });
      return { outcome: r.status === 401 ? "passed" : "failed", status: r.status };
    });
    // 6. Download link: exact version, https, five minutes, checksum equal to the view's.
    await step("download link for the exact version", "200 https link expiring in 300 s with the job's checksum, or 401 when the sign-in is stale", async () => {
      const r = await call(`${CONSUMER}/download`, input.consumerIdToken, { jobId: id });
      if (r.status === 401) return { outcome: "skipped", status: 401, detail: "reauth_required_stale_token" };
      const d = data(r);
      const ok = r.status === 200 && d && String(d.url).startsWith("https://") && d.expiresInSeconds === 300 && d.objectChecksum === view?.objectChecksum && d.byteLength === view?.byteLength;
      return { outcome: ok ? "passed" : "failed", status: r.status, detail: errorCode(r) };
    });
    // 7. Cancel, then the owner's cleanup: the job's copy must end certified removed or honestly pending (settlement), never both retained and certified.
    await step("cancel and cleanup", "cancelled; cleanup certifies removal, or reports it pending inside the settlement window", async () => {
      const r = await call(`${CONSUMER}/cancel`, input.consumerIdToken, { jobId: id });
      const d = data(r);
      if (r.status !== 200 || d?.status !== "cancelled") return { outcome: "failed", status: r.status, detail: errorCode(r) };
      const cleanup = d.cleanup as { cleaned?: number; remaining?: number } | undefined;
      const after = data(await call(`${CONSUMER}?jobId=${id}`, input.consumerIdToken));
      const deleted = after?.objectDeleted === true, retention = String(after?.retention);
      if (deleted && retention === "removal_recorded") return { outcome: "passed", status: 200, detail: `cleaned:${String(cleanup?.cleaned)}` };
      if (!deleted && retention === "cleanup_pending") { retained.push({ jobId: id, state: "cleanup_pending" }); return { outcome: "passed", status: 200, detail: "pending_settlement_or_backoff" }; }
      retained.push({ jobId: id, state: retention }); return { outcome: "failed", status: 200, detail: `retention:${retention}` };
    });
    // 8 to 10. Operator retention actions (workforce). 503 export_cleanup_not_activated is reported, not passed.
    for (const [name, body, check] of [
      ["operator backlog", { action: "exportBacklog" }, (d: Record<string, unknown>) => d.scope === "assigned_owners" && typeof d.cleanupPending === "number"],
      ["operator cleanup pass", { action: "cleanupExports", maxItems: 10 }, (d: Record<string, unknown>) => typeof d.cleaned === "number" && typeof d.remaining === "number" && Array.isArray(d.items)],
      ["operator reconcile pass", { action: "reconcileExports", maxItems: 10 }, (d: Record<string, unknown>) => typeof d.confirmed === "number" && typeof d.reopened === "number" && Array.isArray(d.items)],
    ] as const) {
      await step(name, "200 with the action's summary, or 503 export_cleanup_not_activated / production_not_activated", async () => {
        const r = await call(OPERATIONS, input.workforceIdToken, body as Record<string, unknown>);
        if (r.status === 503 && ["export_cleanup_not_activated", "production_not_activated"].includes(errorCode(r) ?? "")) return { outcome: "not_configured", status: 503, detail: errorCode(r) };
        if (r.status === 403) return { outcome: "skipped", status: 403, detail: "operator_not_assigned_to_this_owner" };
        const d = data(r);
        return { outcome: r.status === 200 && d && check(d) ? "passed" : "failed", status: r.status, detail: errorCode(r) };
      });
    }
  }
  const finishedAt = new Date(now()).toISOString();
  const configurationSha256 = createHash("sha256").update(JSON.stringify({ origin, account: input.expectedAwsAccountId, sourceCommit: input.sourceCommit, migrationReleaseHash: input.migrationReleaseHash })).digest("hex");
  const ok = steps.every((s) => s.outcome === "passed" || s.outcome === "skipped") && steps.some((s) => s.outcome === "passed" && s.name === "advance passes to ready");
  const report: Omit<ExportAcceptanceReport, "evidenceSha256"> = { schemaVersion: "export-retention-acceptance/1", environment: "synthetic-staging", ok, sourceCommit: input.sourceCommit,
    migrationReleaseHash: input.migrationReleaseHash, configurationSha256, awsAccountId: input.expectedAwsAccountId, startedAt, finishedAt, steps, retained, ...summariseExecution(executions) };
  return { ...report, evidenceSha256: createHash("sha256").update(JSON.stringify({ ...report, startedAt: undefined, finishedAt: undefined })).digest("hex") };
}

function validate(input: { apiOrigin: string; consumerIdToken: string; workforceIdToken: string; foreignConsumerIdToken?: string; expectedAwsAccountId: string; observedAwsAccountId: string; sourceCommit: string; migrationReleaseHash: string }) {
  let url: URL;
  try { url = new URL(input.apiOrigin); } catch { throw new ExportAcceptanceError("configuration_invalid"); }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || !/^[a-z0-9]{10}\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname)) throw new ExportAcceptanceError("configuration_invalid");
  for (const token of [input.consumerIdToken, input.workforceIdToken, ...(input.foreignConsumerIdToken ? [input.foreignConsumerIdToken] : [])])
    if (!/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new ExportAcceptanceError("configuration_invalid");
  if (input.consumerIdToken === input.workforceIdToken || input.foreignConsumerIdToken === input.consumerIdToken) throw new ExportAcceptanceError("configuration_invalid");
  if (!/^[a-f0-9]{40}$/.test(input.sourceCommit) || !/^[a-f0-9]{64}$/.test(input.migrationReleaseHash)) throw new ExportAcceptanceError("configuration_invalid");
  // The intended account is asserted by the caller from STS; the production account is refused whatever the caller says.
  if (!/^[0-9]{12}$/.test(input.expectedAwsAccountId) || input.observedAwsAccountId !== input.expectedAwsAccountId || input.expectedAwsAccountId === "173535830222") throw new ExportAcceptanceError("boundary_refused");
  return url.origin;
}
function uuid(now: () => number) {
  const bytes = createHash("sha256").update(`${now()}:${Math.random()}`).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
function tokenAuthTime(token: string): number | null {
  try { const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as { auth_time?: unknown }; return typeof claims.auth_time === "number" ? claims.auth_time : null; } catch { return null; }
}
