"use client";

import { useCallback, useEffect, useState } from "react";
import { Link2 } from "lucide-react";
import { api } from "@/adapters";
import { AdapterError } from "@/adapters/errors";
import type { LiveOrgSyncOperations } from "@/adapters/live-types";
import { Card, CardTitle } from "@/components/ui/bits";
import { Btn } from "@/components/ui/Btn";
import { ClinicalError, ClinicalLoading, ClinicalNote } from "@/components/ui/ClinicalStates";
import { useFeedback } from "@/lib/feedback";

const INPUT =
  "h-8 rounded-lg border border-line bg-card px-3 text-[12.5px] text-body outline-none focus-visible:outline-2 focus-visible:outline-action";

function errText(e: unknown): string {
  return e instanceof AdapterError ? e.message : "Something went wrong. Try again.";
}
function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * Organization-level synchronization operations (phase 5): provider posture,
 * connected-patient counts, queue/failure/dead-letter totals, contract
 * versions in use, and manual reconciliation controls. Every number is a
 * count of persisted rows — no engagement or delivery metric is fabricated.
 */
export function SyncOperationsPanel() {
  const { announce } = useFeedback();
  const [data, setData] = useState<LiveOrgSyncOperations | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retryReason, setRetryReason] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.sync.orgOperations());
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ClinicalError message={error} onRetry={load} />;
  if (!data) return <ClinicalLoading label="Loading synchronization operations…" />;

  return (
    <div className="flex flex-col gap-3" data-testid="sync-ops">
      <Card className="px-4 py-3" data-testid="sync-ops-provider">
        <div className="flex items-center gap-2">
          <CardTitle className="mb-0">
            <Link2 size={13} strokeWidth={2} className="text-brand" aria-hidden />
            AI Longevity Pro patient synchronization
          </CardTitle>
          <span
            className={`inline-flex h-[18px] items-center rounded-full px-2 text-[10px] font-bold ${
              data.posture === "approved"
                ? "bg-positive-tint text-positive-deep"
                : data.posture === "fixture"
                  ? "bg-warning-tint text-warning-deep"
                  : "bg-slate-tint text-slate-badge"
            }`}
            data-testid="sync-ops-provider-state"
          >
            {data.posture === "approved"
              ? `Approved provider (${data.provider})`
              : data.posture === "fixture"
                ? "Fixture test"
                : "not configured"}
          </span>
          <span className="text-[11.5px] text-subtle">
            contracts in use:{" "}
            {data.contractVersions.length > 0 ? data.contractVersions.join(", ") : "none"}
          </span>
        </div>
        {data.posture === "disabled" && (
          <p className="m-0 mt-2 text-[12px] text-subtle" data-testid="sync-ops-not-configured">
            AI Longevity Pro connection not configured. Registering a provider is a reviewed
            operational act (code change + database connector registration) — no environment flag
            enables it.
          </p>
        )}
        {data.posture === "fixture" && (
          <p className="m-0 mt-2 text-[12px] font-semibold text-warning-deep" data-testid="sync-ops-fixture-note">
            Deterministic contract fixture — TEST behavior only. This is NOT a real AI Longevity
            Pro connection; no patient data leaves this system.
          </p>
        )}
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="px-4 py-3">
          <p className="m-0 text-[11px] font-bold tracking-[0.02em] text-subtle uppercase">Connected patients</p>
          <p className="m-0 mt-1 text-[20px] font-bold text-body" data-testid="sync-ops-connected">
            {data.connections.verified}
          </p>
          <p className="m-0 text-[11.5px] text-subtle">
            {data.connections.invitationPending} invited · {data.connections.paused} paused ·{" "}
            {data.connections.revoked} revoked
          </p>
        </Card>
        <Card className="px-4 py-3">
          <p className="m-0 text-[11px] font-bold tracking-[0.02em] text-subtle uppercase">Outbound queue</p>
          <p className="m-0 mt-1 text-[20px] font-bold text-body" data-testid="sync-ops-queued">
            {data.outbound.queued}
          </p>
          <p className="m-0 text-[11.5px] text-subtle">
            {data.outbound.sending} in flight · {data.outbound.delivered} provider-confirmed
          </p>
        </Card>
        <Card className="px-4 py-3">
          <p className="m-0 text-[11px] font-bold tracking-[0.02em] text-subtle uppercase">Failed / dead-letter</p>
          <p className="m-0 mt-1 text-[20px] font-bold text-critical" data-testid="sync-ops-failed">
            {data.outbound.failed + data.outbound.deadLetter}
          </p>
          <p className="m-0 text-[11.5px] text-subtle">{data.outbound.deadLetter} dead-lettered</p>
        </Card>
        <Card className="px-4 py-3">
          <p className="m-0 text-[11px] font-bold tracking-[0.02em] text-subtle uppercase">Inbound review</p>
          <p className="m-0 mt-1 text-[20px] font-bold text-body" data-testid="sync-ops-inbound">
            {data.inbound.pendingReview}
          </p>
          <p className="m-0 text-[11.5px] text-subtle">
            {data.inbound.processed} processed · {data.inbound.conflicts} conflicts
          </p>
        </Card>
      </div>

      <Card className="px-4 py-3" data-testid="sync-ops-worker">
        <CardTitle className="mb-1">Worker &amp; circuit</CardTitle>
        {data.lastWorkerCycle ? (
          <p className="m-0 text-[12.5px] text-body" data-testid="sync-ops-last-cycle">
            Last cycle {fmt(data.lastWorkerCycle.completedAt)} — claimed{" "}
            {data.lastWorkerCycle.claimed}, succeeded {data.lastWorkerCycle.succeeded}, retried{" "}
            {data.lastWorkerCycle.retried}, dead-lettered {data.lastWorkerCycle.deadLettered}
            {data.lastWorkerCycle.leaseReclaims > 0
              ? `, lease reclaims ${data.lastWorkerCycle.leaseReclaims}`
              : ""}
            {" · provider "}
            {data.lastWorkerCycle.provider} ({data.lastWorkerCycle.contractVersion})
          </p>
        ) : (
          <p className="m-0 text-[12px] text-faint" data-testid="sync-ops-no-cycle">
            No worker cycle has run. The web application does not depend on the worker — its
            absence is not an error.
          </p>
        )}
        <p className="m-0 mt-1 text-[12px] text-subtle" data-testid="sync-ops-circuit">
          Circuit:{" "}
          <span
            className={`font-bold ${
              (data.circuit?.state ?? "closed") === "closed" ? "text-positive-deep" : "text-critical"
            }`}
          >
            {data.circuit?.state ?? "closed"}
          </span>
          {data.circuit && data.circuit.failureCount > 0
            ? ` (${data.circuit.failureCount} consecutive failures)`
            : ""}
          {" · oldest queued work "}
          {data.maxQueueAgeSeconds}s
        </p>
      </Card>

      <Card className="px-4 py-3" data-testid="sync-ops-dead-letters">
        <CardTitle className="mb-2">Dead-letter queue</CardTitle>
        {data.deadLetters.length === 0 ? (
          <p className="m-0 text-[12px] text-faint">
            Empty. Deliveries that exhaust their bounded retries land here for manual, reasoned
            reconciliation.
          </p>
        ) : (
          <ul className="m-0 list-none divide-y divide-line p-0">
            {data.deadLetters.map((d) => (
              <li key={d.eventId} className="flex flex-wrap items-center gap-2 py-2">
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-body">{d.reason}</span>
                <span className="text-[11px] text-faint">
                  entered {fmt(d.enteredAt)}
                  {d.retriedAt ? ` · retried ${fmt(d.retriedAt)}` : ""}
                </span>
                <input
                  className={`${INPUT} h-7 w-[180px] text-[11.5px]`}
                  value={retryReason}
                  placeholder="Retry reason (required)"
                  aria-label="Retry reason"
                  onChange={(e) => setRetryReason(e.target.value)}
                  data-testid="sync-ops-retry-reason"
                />
                <Btn
                  size="sm"
                  disabled={busy || !retryReason.trim()}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const res = await api.sync.retryEvent(d.eventId, retryReason.trim());
                      announce(res.message);
                      setRetryReason("");
                      await load();
                    } catch (e) {
                      announce(errText(e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                  data-testid={`sync-ops-retry-${d.eventId}`}
                >
                  Retry
                </Btn>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ClinicalNote>
        Every count above is a persisted row. Nothing here estimates engagement, projects delivery,
        or claims a message reached a patient without provider acknowledgment.
      </ClinicalNote>
    </div>
  );
}
