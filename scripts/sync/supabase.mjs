/**
 * Service-role RPC client for the sync worker.
 *
 * The service-role key lives ONLY in the worker process's environment
 * (SYNC_WORKER_SERVICE_ROLE_KEY). Nothing under src/ imports this module;
 * the mock-import and bundle scanners keep it out of every browser path
 * structurally, and this module refuses to run inside a browser.
 */
import { SyncError } from "./errors.mjs";

export function createRpcClient({ url, serviceKey, fetchImpl = fetch }) {
  if (typeof window !== "undefined") {
    throw new SyncError("security", "browser_context", "service-role client must never run in a browser");
  }
  if (!url || !serviceKey) {
    throw new SyncError("security", "missing_worker_credentials",
      "SYNC_WORKER_SUPABASE_URL and SYNC_WORKER_SERVICE_ROLE_KEY are required");
  }
  const base = url.replace(/\/$/, "");
  return {
    async rpc(name, args) {
      let response;
      try {
        response = await fetchImpl(`${base}/rest/v1/rpc/${name}`, {
          method: "POST",
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(args),
        });
      } catch {
        throw new SyncError("retryable", "backend_unreachable", "sync backend unreachable");
      }
      let payload;
      try {
        payload = response.status === 204 ? undefined : await response.json();
      } catch {
        throw new SyncError("retryable", "backend_non_json", `backend returned non-JSON (${response.status})`);
      }
      if (!response.ok) {
        const code = payload && typeof payload === "object" ? payload.code : undefined;
        const cls =
          code === "42501" || code === "28000" ? "security"
          : code === "22023" || code === "P0002" ? "permanent"
          : response.status >= 500 ? "retryable"
          : "permanent";
        throw new SyncError(cls, `rpc_${code ?? response.status}`, `rpc ${name} failed`);
      }
      return payload;
    },
  };
}
