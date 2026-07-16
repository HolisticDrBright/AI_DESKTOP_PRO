/**
 * Client-safe bridge to the `/api/live/*` route handlers.
 *
 * This is the ONLY thing the facade calls in live mode from client components.
 * It does same-origin `fetch` and never imports server-only code, so no tRPC
 * client or credentials reach the browser bundle. Every failure surfaces as an
 * AdapterError with a safe message.
 */
import { AdapterError, codeFromHttpStatus, type AdapterErrorCode } from "./errors";
import type { LabWorkspace } from "./labs.mock";
import type {
  LiveAuditEvent,
  LiveReviewResult,
  LiveTaskResult,
  ReviewDecision,
} from "./live-types";

interface Envelope<T> {
  data?: T;
  error?: { code?: AdapterErrorCode; message?: string };
}

async function liveFetch<T>(
  path: string,
  init: { method: "GET" | "POST"; body?: unknown },
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/live/${path}`, {
      method: init.method,
      headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch (e) {
    throw new AdapterError("unavailable", undefined, e instanceof Error ? e.message : undefined);
  }

  let json: Envelope<T> = {};
  try {
    json = (await res.json()) as Envelope<T>;
  } catch {
    /* leave json empty; handled below */
  }

  if (!res.ok || json.error) {
    const code = json.error?.code ?? codeFromHttpStatus(res.status);
    throw new AdapterError(code, json.error?.message);
  }
  return json.data as T;
}

export const liveClient = {
  labsWorkspace: (patientId: string) =>
    liveFetch<LabWorkspace>("labs/workspace", { method: "POST", body: { patientId } }),

  reviewMarker: (observationId: string, decision: ReviewDecision, note?: string) =>
    liveFetch<LiveReviewResult>("labs/review", {
      method: "POST",
      body: { observationId, decision, note },
    }),

  listAuditEvents: (limit = 50) =>
    liveFetch<LiveAuditEvent[]>(`actions/audit?limit=${limit}`, { method: "GET" }),

  recordAudit: (input: {
    action: string;
    resourceType?: string;
    resourceId?: string;
    safeMessage?: string;
    patientId?: string;
    metadata?: Record<string, unknown>;
  }) => liveFetch<{ id: string }>("actions/audit", { method: "POST", body: input }),

  createReviewTask: (input: {
    patientId: string;
    title: string;
    itemType?: string;
    priority?: "low" | "medium" | "high";
    refId?: string;
  }) => liveFetch<LiveTaskResult>("actions/task", { method: "POST", body: input }),
};
