"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Link2,
  PauseCircle,
  ShieldAlert,
  Sparkles,
  Undo2,
} from "lucide-react";
import { api } from "@/adapters";
import { AdapterError } from "@/adapters/errors";
import type {
  LivePatientSync,
  LiveSyncOutboundResourceType,
  LiveSyncScope,
} from "@/adapters/live-types";
import { Card, CardTitle } from "@/components/ui/bits";
import { Btn } from "@/components/ui/Btn";
import {
  ClinicalEmpty,
  ClinicalError,
  ClinicalLoading,
  ClinicalNote,
} from "@/components/ui/ClinicalStates";
import { useFeedback } from "@/lib/feedback";

const INPUT =
  "h-8 rounded-lg border border-line bg-card px-3 text-[12.5px] text-body outline-none focus-visible:outline-2 focus-visible:outline-action";
const LABEL = "mb-1 block text-[11px] font-bold tracking-[0.02em] text-subtle uppercase";

const SCOPES: { value: LiveSyncScope; label: string; research?: boolean }[] = [
  { value: "programs", label: "Programs & education" },
  { value: "protocols_supplements", label: "Protocols & supplements" },
  { value: "nutrition", label: "Nutrition plans" },
  { value: "appointments", label: "Appointments" },
  { value: "messaging", label: "Secure messaging" },
  { value: "forms_checkins", label: "Forms & check-ins" },
  { value: "symptoms_adherence", label: "Symptoms & adherence" },
  { value: "wearables", label: "Wearables" },
  { value: "lab_summaries", label: "Lab summaries" },
  { value: "billing_links", label: "Billing links" },
  { value: "research_n_of_1", label: "Research / N-of-1 (separate consent)", research: true },
];

const QUEUEABLE: { value: LiveSyncOutboundResourceType; label: string; patientAddressed?: boolean }[] = [
  { value: "program_enrollment", label: "Program enrollment" },
  { value: "protocol_version", label: "Approved protocol version" },
  { value: "supplement_instructions", label: "Supplement instructions" },
  { value: "appointment_summary", label: "Appointment summary" },
  { value: "lab_summary", label: "Patient-safe lab summary", patientAddressed: true },
  { value: "nutrition_plan", label: "Nutrition plan (no live source yet)" },
];

function errText(e: unknown): string {
  return e instanceof AdapterError ? e.message : "Something went wrong. Try again.";
}
function fmt(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function StatePill({ state }: { state: string }) {
  const tone =
    state === "verified" || state === "acknowledged" || state === "delivered" || state === "processed"
      ? "bg-positive-tint text-positive-deep"
      : state === "failed" || state === "dead_letter" || state === "revoked" || state === "conflict"
        ? "bg-critical-tint text-critical"
        : state === "paused" || state === "review_pending" || state === "invitation_pending"
          ? "bg-warning-tint text-warning-deep"
          : "bg-slate-tint text-slate-badge";
  return (
    <span
      className={`inline-flex h-[18px] items-center rounded-full px-2 text-[10px] font-bold ${tone}`}
      data-testid={`sync-state-${state}`}
    >
      {state.replace(/_/g, " ")}
    </span>
  );
}

/**
 * Patient App Connection surface (phase 5): the practitioner-facing side of
 * the AI Longevity Pro delivery & synchronization gateway. Everything shown
 * is a persisted row; sending fails closed without a provider; nothing is
 * ever shown as delivered or acknowledged without provider evidence.
 */
export function PatientSyncPanel({ patientId }: { patientId: string }) {
  const { announce } = useFeedback();
  const [data, setData] = useState<LivePatientSync | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The one-time token lives ONLY in this component's memory after creation.
  const [oneTimeToken, setOneTimeToken] = useState<{ token: string; expiresAt: string } | null>(null);

  const [scopeToGrant, setScopeToGrant] = useState<LiveSyncScope>("programs");
  const [artifactTitle, setArtifactTitle] = useState("ALP sync consent");
  const [artifactVersion, setArtifactVersion] = useState("v1");
  const [jurisdiction, setJurisdiction] = useState("");
  const [method, setMethod] = useState("in_person");
  const [authority, setAuthority] = useState("self");

  const [queueType, setQueueType] = useState<LiveSyncOutboundResourceType>("appointment_summary");
  const [queueResourceId, setQueueResourceId] = useState("");
  const [queueOutcome, setQueueOutcome] = useState<string | null>(null);

  const [revokeReason, setRevokeReason] = useState("");
  const [retryReason, setRetryReason] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [conflictNote, setConflictNote] = useState("");
  const [conflictResolution, setConflictResolution] = useState<
    "resolved_keep_desktop" | "resolved_keep_external" | "resolved_manual" | "dismissed"
  >("resolved_manual");
  const [correctionText, setCorrectionText] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [aiMessage, setAiMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.sync.forPatient(patientId));
    } catch (e) {
      setError(errText(e));
    }
  }, [patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<{ message: string }>) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fn();
      announce(res.message);
      await load();
    } catch (e) {
      announce(errText(e));
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <div className="pt-4">
        <ClinicalError message={error} onRetry={load} />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="pt-4">
        <ClinicalLoading label="Loading the patient-app connection…" />
      </div>
    );
  }

  const c = data.connection;
  const grantedScopes = data.scopes.filter((s) => s.status === "granted");
  const pendingInbound = data.inbound.filter((i) => i.state === "review_pending");
  const openConflicts = data.conflicts.filter((x) => x.state === "open");

  return (
    <div className="grid gap-3 pt-4 xl:grid-cols-[minmax(0,1fr)_360px]" data-testid="sync-panel">
      {/* ------------------------------------------------- main column */}
      <div className="flex min-w-0 flex-col gap-3">
        {!data.providerConfigured && (
          <div data-testid="sync-provider-note">
            <ClinicalNote>
              <strong>AI Longevity Pro connection not configured.</strong> Connection records,
              invitations, and consent scopes are real persisted rows, but nothing can be queued,
              sent, delivered, or received until an approved provider is registered — approval is a
              reviewed operational act, never an environment flag.
            </ClinicalNote>
          </div>
        )}

        {/* Connection state */}
        <Card className="px-4 py-3" data-testid="sync-connection">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="mb-0">
              <Link2 size={13} strokeWidth={2} className="text-brand" aria-hidden />
              Patient app connection
            </CardTitle>
            {c ? <StatePill state={c.state} /> : (
              <span className="inline-flex h-[18px] items-center rounded-full bg-slate-tint px-2 text-[10px] font-bold text-slate-badge" data-testid="sync-state-unlinked">
                unlinked
              </span>
            )}
            {c && <span className="text-[11.5px] text-subtle">contract {c.contractVersion} · {c.externalSystem}</span>}
          </div>

          {!c ? (
            <div className="mt-2">
              <ClinicalEmpty
                title="This patient's app is not linked"
                message="Linking uses an explicit, expiring, single-use invitation verified by the patient app — never matching by email, name, phone, or date of birth."
              />
              <div className="mt-2 flex justify-center">
                <Btn
                  variant="primary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const res = await api.sync.createInvitation(patientId);
                      if (res.token && res.expiresAt) {
                        setOneTimeToken({ token: res.token, expiresAt: res.expiresAt });
                      }
                      return res;
                    })
                  }
                  data-testid="sync-connect"
                >
                  Create connection invitation
                </Btn>
              </div>
            </div>
          ) : (
            <div className="mt-2 flex flex-col gap-2">
              <p className="m-0 text-[12px] text-subtle">
                Verified {fmt(c.verifiedAt)} · last successful sync{" "}
                <span data-testid="sync-last-success">{fmt(data.lastSuccessfulSyncAt)}</span>
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {c.state === "verified" && (
                  <Btn
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        api.sync.connectionAction({
                          connectionId: c.id,
                          action: "pause",
                          expectedVersion: c.version,
                        }),
                      )
                    }
                    data-testid="sync-pause"
                  >
                    <PauseCircle size={12} strokeWidth={2} aria-hidden /> Pause
                  </Btn>
                )}
                {c.state === "paused" && (
                  <Btn
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        api.sync.connectionAction({
                          connectionId: c.id,
                          action: "resume",
                          expectedVersion: c.version,
                        }),
                      )
                    }
                    data-testid="sync-resume"
                  >
                    Resume
                  </Btn>
                )}
                {c.state === "invitation_pending" && (
                  <Btn
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const res = await api.sync.createInvitation(patientId);
                        if (res.token && res.expiresAt) {
                          setOneTimeToken({ token: res.token, expiresAt: res.expiresAt });
                        }
                        return res;
                      })
                    }
                    data-testid="sync-reinvite"
                  >
                    Issue a new invitation
                  </Btn>
                )}
                {c.state !== "revoked" && (
                  <>
                    <input
                      className={`${INPUT} w-[220px]`}
                      value={revokeReason}
                      placeholder="Revocation reason (required)"
                      aria-label="Revocation reason"
                      onChange={(e) => setRevokeReason(e.target.value)}
                      data-testid="sync-revoke-reason"
                    />
                    <Btn
                      size="sm"
                      variant="danger"
                      disabled={busy || !revokeReason.trim()}
                      onClick={() =>
                        void run(async () => {
                          const res = await api.sync.connectionAction({
                            connectionId: c.id,
                            action: "revoke",
                            expectedVersion: c.version,
                            reason: revokeReason.trim(),
                          });
                          setRevokeReason("");
                          return res;
                        })
                      }
                      data-testid="sync-revoke"
                    >
                      Revoke connection
                    </Btn>
                  </>
                )}
              </div>
              {data.invitation && c.state === "invitation_pending" && (
                <p className="m-0 text-[12px] text-subtle" data-testid="sync-invitation-facts">
                  Invitation created {fmt(data.invitation.createdAt)} · expires{" "}
                  {fmt(data.invitation.expiresAt)}
                  {data.invitation.expired && (
                    <span className="ml-2 font-bold text-critical">expired</span>
                  )}
                </p>
              )}
            </div>
          )}

          {oneTimeToken && (
            <div className="mt-2 rounded-[10px] border border-warning bg-warning-tint px-3 py-2" data-testid="sync-one-time-token">
              <p className="m-0 text-[12px] font-semibold text-warning-deep">
                One-time connection code (shown ONCE — only its hash is stored):
              </p>
              <code className="mt-1 block break-all text-[11px]" data-testid="sync-token-value">
                {oneTimeToken.token}
              </code>
              <p className="m-0 mt-1 text-[11.5px] text-subtle">
                Expires {fmt(oneTimeToken.expiresAt)}. Delivery provider not configured — this code
                was not transmitted anywhere; convey it to the patient directly.
              </p>
            </div>
          )}
        </Card>

        {/* Resource-level sync status + queueing */}
        <Card className="px-4 py-3" data-testid="sync-resources">
          <CardTitle className="mb-2">Resource synchronization</CardTitle>
          {c && c.state === "verified" ? (
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <label htmlFor="sync-queue-type" className={LABEL}>Resource type</label>
                <select
                  id="sync-queue-type"
                  className={INPUT}
                  value={queueType}
                  onChange={(e) => setQueueType(e.target.value as LiveSyncOutboundResourceType)}
                  data-testid="sync-queue-type"
                >
                  {QUEUEABLE.map((q) => (
                    <option key={q.value} value={q.value}>{q.label}</option>
                  ))}
                </select>
              </div>
              {!QUEUEABLE.find((q) => q.value === queueType)?.patientAddressed && (
                <div className="min-w-[240px] flex-1">
                  <label htmlFor="sync-queue-id" className={LABEL}>Resource id</label>
                  <input
                    id="sync-queue-id"
                    className={`${INPUT} w-full`}
                    value={queueResourceId}
                    placeholder="The record id to export"
                    onChange={(e) => setQueueResourceId(e.target.value)}
                    data-testid="sync-queue-id"
                  />
                </div>
              )}
              <Btn
                size="sm"
                variant="primary"
                disabled={busy || (!QUEUEABLE.find((q) => q.value === queueType)?.patientAddressed && !queueResourceId.trim())}
                onClick={() =>
                  void run(async () => {
                    setQueueOutcome(null);
                    const res = await api.sync.queueExport({
                      connectionId: c.id,
                      resourceType: queueType,
                      resourceId: QUEUEABLE.find((q) => q.value === queueType)?.patientAddressed
                        ? patientId
                        : queueResourceId.trim(),
                    });
                    if (res.ok === false) setQueueOutcome(res.message);
                    return res;
                  })
                }
                data-testid="sync-queue-submit"
              >
                Queue for delivery
              </Btn>
            </div>
          ) : (
            <p className="m-0 text-[12px] text-faint">
              Exports require a verified connection{c?.state === "paused" ? " (currently paused)" : ""}.
            </p>
          )}
          {queueOutcome && (
            <p className="m-0 mt-2 text-[12.5px] font-semibold text-warning-deep" role="status" data-testid="sync-queue-outcome">
              {queueOutcome}
            </p>
          )}
          {data.resources.length > 0 && (
            <ul className="m-0 mt-3 list-none divide-y divide-line p-0" data-testid="sync-resource-list">
              {data.resources.map((r) => (
                <li key={`${r.resourceType}:${r.resourceId}`} className="flex items-center gap-2 py-2">
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-body">
                    {r.resourceType.replace(/_/g, " ")} · v{r.resourceVersion}
                  </span>
                  <StatePill state={r.state} />
                  {c && r.state !== "withdrawn" && (
                    <Btn
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          api.sync.withdrawResource({
                            connectionId: c.id,
                            resourceType: r.resourceType,
                            resourceId: r.resourceId,
                            reason: "Withdrawn by practitioner from the sync panel",
                          }),
                        )
                      }
                      data-testid={`sync-withdraw-${r.resourceType}`}
                    >
                      <Undo2 size={12} strokeWidth={2} aria-hidden /> Withdraw
                    </Btn>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="m-0 mt-2 text-[11.5px] text-subtle">
            Queued means queued. A resource shows delivered or acknowledged ONLY after the provider
            confirms it — never before.
          </p>
        </Card>

        {/* Outbound events */}
        <Card className="px-4 py-3" data-testid="sync-outbound">
          <CardTitle className="mb-2">
            Outbound events · {data.counts.pendingOutbound} pending · {data.counts.failedOutbound}{" "}
            failed · {data.counts.deadLetter} dead-letter
          </CardTitle>
          {data.outbound.length === 0 ? (
            <p className="m-0 text-[12px] text-faint">No outbound events for this connection.</p>
          ) : (
            <ul className="m-0 list-none divide-y divide-line p-0">
              {data.outbound.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-2 py-2" data-testid={`sync-event-${e.id}`}>
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-body">
                    {e.resourceType.replace(/_/g, " ")} · v{e.resourceVersion} · {fmt(e.occurredAt)}
                  </span>
                  <StatePill state={e.state} />
                  <span className="text-[11px] text-faint">attempts {e.attempts}</span>
                  {e.acknowledgedAt && (
                    <span className="text-[10.5px] text-positive-deep" data-testid="sync-ack-evidence">
                      ack {fmt(e.acknowledgedAt)}
                    </span>
                  )}
                  {e.lastError && <span className="text-[11px] text-critical">{e.lastError}</span>}
                  {(e.state === "failed" || e.state === "dead_letter") && (
                    <span className="flex items-center gap-1">
                      <input
                        className={`${INPUT} h-7 w-[170px] text-[11.5px]`}
                        value={retryReason}
                        placeholder="Retry reason (required)"
                        aria-label="Retry reason"
                        onChange={(ev) => setRetryReason(ev.target.value)}
                        data-testid="sync-retry-reason"
                      />
                      <Btn
                        size="sm"
                        disabled={busy || !retryReason.trim()}
                        onClick={() =>
                          void run(async () => {
                            const res = await api.sync.retryEvent(e.id, retryReason.trim());
                            setRetryReason("");
                            return res;
                          })
                        }
                        data-testid={`sync-retry-${e.id}`}
                      >
                        Retry
                      </Btn>
                      <Btn
                        size="sm"
                        variant="ghost"
                        disabled={busy || !retryReason.trim()}
                        onClick={() =>
                          void run(async () => {
                            const res = await api.sync.cancelEvent(e.id, retryReason.trim());
                            setRetryReason("");
                            return res;
                          })
                        }
                        data-testid={`sync-cancel-${e.id}`}
                      >
                        Discard
                      </Btn>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Inbound from the patient app */}
        <Card className="px-4 py-3" data-testid="sync-inbound">
          <CardTitle className="mb-2">
            Inbound from the patient app · {pendingInbound.length} awaiting review
          </CardTitle>
          {data.inbound.length === 0 ? (
            <p className="m-0 text-[12px] text-faint">
              No inbound submissions. Patient-app data appears here with full provenance once the
              connection is live.
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {data.inbound.map((i) => (
                <li
                  key={i.id}
                  className="rounded-[10px] border border-line bg-surface px-3 py-2"
                  data-testid={`sync-inbound-${i.id}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[12.5px] font-semibold text-body">
                      {i.resourceType.replace(/_/g, " ")}
                    </span>
                    <StatePill state={i.state} />
                    <span className="text-[11px] text-faint" data-testid="sync-inbound-provenance">
                      provider event {i.providerEventId} · occurred {fmt(i.occurredAt)} · received{" "}
                      {fmt(i.receivedAt)} · scope {i.scope}
                    </span>
                  </div>
                  {/* Patient content is UNTRUSTED — rendered as plain text only. */}
                  <p className="m-0 mt-1 text-[12px] whitespace-pre-wrap text-body" data-testid="sync-inbound-payload">
                    {Object.entries(i.payload)
                      .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
                      .join("\n")}
                  </p>
                  {i.corrections.length > 0 && (
                    <ul className="m-0 mt-1 list-none p-0" data-testid="sync-inbound-corrections">
                      {i.corrections.map((cr) => (
                        <li key={cr.version} className="text-[11.5px] text-subtle">
                          Correction v{cr.version} ({cr.reason}):{" "}
                          {Object.entries(cr.overlay)
                            .map(([k, v]) => `${k}: ${String(v)}`)
                            .join(" · ")}
                        </li>
                      ))}
                    </ul>
                  )}
                  {i.rejectionReason && (
                    <p className="m-0 mt-1 text-[11.5px] text-critical">Rejected: {i.rejectionReason}</p>
                  )}
                  {i.state === "review_pending" && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Btn
                        size="sm"
                        variant="primary"
                        disabled={busy}
                        onClick={() =>
                          void run(() => api.sync.reviewInbound({ eventId: i.id, action: "accept" }))
                        }
                        data-testid={`sync-accept-${i.id}`}
                      >
                        Accept
                      </Btn>
                      <input
                        className={`${INPUT} h-7 w-[200px] text-[11.5px]`}
                        value={reviewNote}
                        placeholder="Rejection note (required)"
                        aria-label="Rejection note"
                        onChange={(ev) => setReviewNote(ev.target.value)}
                        data-testid="sync-review-note"
                      />
                      <Btn
                        size="sm"
                        variant="ghost"
                        disabled={busy || !reviewNote.trim()}
                        onClick={() =>
                          void run(async () => {
                            const res = await api.sync.reviewInbound({
                              eventId: i.id,
                              action: "reject",
                              note: reviewNote.trim(),
                            });
                            setReviewNote("");
                            return res;
                          })
                        }
                        data-testid={`sync-reject-${i.id}`}
                      >
                        Reject
                      </Btn>
                    </div>
                  )}
                  {(i.state === "processed" || i.state === "review_pending") && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <input
                        className={`${INPUT} h-7 flex-1 text-[11.5px]`}
                        value={correctionText}
                        placeholder="Correction (recorded as a versioned overlay; the original stays intact)"
                        aria-label="Correction overlay"
                        onChange={(ev) => setCorrectionText(ev.target.value)}
                        data-testid="sync-correction-text"
                      />
                      <input
                        className={`${INPUT} h-7 w-[170px] text-[11.5px]`}
                        value={correctionReason}
                        placeholder="Reason (required)"
                        aria-label="Correction reason"
                        onChange={(ev) => setCorrectionReason(ev.target.value)}
                        data-testid="sync-correction-reason"
                      />
                      <Btn
                        size="sm"
                        disabled={busy || !correctionText.trim() || !correctionReason.trim()}
                        onClick={() =>
                          void run(async () => {
                            const res = await api.sync.recordCorrection({
                              inboundEventId: i.id,
                              overlay: { correction: correctionText.trim() },
                              reason: correctionReason.trim(),
                            });
                            setCorrectionText("");
                            setCorrectionReason("");
                            return res;
                          })
                        }
                        data-testid={`sync-correct-${i.id}`}
                      >
                        Record correction
                      </Btn>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Conflicts */}
        <Card className="px-4 py-3" data-testid="sync-conflicts">
          <CardTitle className="mb-2">
            <ShieldAlert size={13} strokeWidth={2} className="text-critical" aria-hidden />
            Conflicts · {openConflicts.length} open
          </CardTitle>
          {data.conflicts.length === 0 ? (
            <p className="m-0 text-[12px] text-faint">
              No conflicts. Two authoritative changes that cannot be safely reconciled land here for
              explicit review — never a silent merge.
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {data.conflicts.map((x) => (
                <li key={x.id} className="rounded-[10px] border border-line px-3 py-2" data-testid={`sync-conflict-${x.id}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[12.5px] font-semibold text-body">
                      {x.resourceType.replace(/_/g, " ")} · {x.resourceRef}
                    </span>
                    <StatePill state={x.state} />
                    <span className="text-[11px] text-faint">
                      desktop v{x.desktopVersion ?? "—"} vs app v{x.externalVersion ?? "—"}
                    </span>
                  </div>
                  <p className="m-0 mt-1 text-[12px] text-subtle">{x.reason}</p>
                  {x.resolutionNote && (
                    <p className="m-0 mt-1 text-[11.5px] text-subtle">Resolution: {x.resolutionNote}</p>
                  )}
                  {x.state === "open" && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <select
                        className={INPUT}
                        value={conflictResolution}
                        aria-label="Conflict resolution"
                        onChange={(ev) =>
                          setConflictResolution(ev.target.value as typeof conflictResolution)
                        }
                        data-testid="sync-conflict-resolution"
                      >
                        <option value="resolved_keep_desktop">Keep desktop version</option>
                        <option value="resolved_keep_external">Keep patient-app version</option>
                        <option value="resolved_manual">Resolved manually</option>
                        <option value="dismissed">Dismiss</option>
                      </select>
                      <input
                        className={`${INPUT} h-8 flex-1`}
                        value={conflictNote}
                        placeholder="Resolution note (required)"
                        aria-label="Resolution note"
                        onChange={(ev) => setConflictNote(ev.target.value)}
                        data-testid="sync-conflict-note"
                      />
                      <Btn
                        size="sm"
                        variant="primary"
                        disabled={busy || !conflictNote.trim()}
                        onClick={() =>
                          void run(async () => {
                            const res = await api.sync.resolveConflict({
                              conflictId: x.id,
                              resolution: conflictResolution,
                              note: conflictNote.trim(),
                              expectedVersion: x.version,
                            });
                            setConflictNote("");
                            return res;
                          })
                        }
                        data-testid={`sync-resolve-${x.id}`}
                      >
                        Resolve
                      </Btn>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="m-0 mt-2 text-[11.5px] text-subtle">
            Resolution decides which version future synchronization proceeds from. Neither original
            record is ever overwritten.
          </p>
        </Card>
      </div>

      {/* ------------------------------------------------- side column */}
      <div className="flex min-w-0 flex-col gap-3">
        {/* Consent scopes */}
        <Card className="px-4 py-3" data-testid="sync-scopes">
          <CardTitle className="mb-2">Consent scopes</CardTitle>
          <ul className="m-0 list-none divide-y divide-line p-0">
            {SCOPES.map((s) => {
              const active = grantedScopes.find((g) => g.scope === s.value);
              const lastRevoked = data.scopes.find(
                (g) => g.scope === s.value && g.status === "revoked",
              );
              return (
                <li key={s.value} className={`flex items-center gap-2 py-[7px] ${s.research ? "border-t-2 border-t-hairline-2" : ""}`}>
                  <span className="min-w-0 flex-1 text-[12px] text-body">{s.label}</span>
                  {active ? (
                    <>
                      <span
                        className="inline-flex h-[18px] items-center rounded-full bg-positive-tint px-2 text-[10px] font-bold text-positive-deep"
                        data-testid={`sync-scope-granted-${s.value}`}
                        title={`${active.artifactTitle} ${active.artifactVersion} · ${active.method} · ${active.authority}`}
                      >
                        granted
                      </span>
                      {c && (
                        <Btn
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            void run(() =>
                              api.sync.setConsentScope({
                                connectionId: c.id,
                                scope: s.value,
                                grant: false,
                              }),
                            )
                          }
                          data-testid={`sync-scope-revoke-${s.value}`}
                        >
                          Revoke
                        </Btn>
                      )}
                    </>
                  ) : (
                    <span
                      className="inline-flex h-[18px] items-center rounded-full bg-slate-tint px-2 text-[10px] font-bold text-slate-badge"
                      data-testid={`sync-scope-off-${s.value}`}
                    >
                      {lastRevoked ? "revoked" : "not granted"}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {c && (c.state === "verified" || c.state === "paused") && (
            <div className="mt-3 border-t border-hairline-2 pt-2">
              <p className={LABEL}>Grant a scope (records the presented artifact)</p>
              <div className="flex flex-col gap-2">
                <select
                  className={INPUT}
                  value={scopeToGrant}
                  aria-label="Scope to grant"
                  onChange={(e) => setScopeToGrant(e.target.value as LiveSyncScope)}
                  data-testid="sync-grant-scope"
                >
                  {SCOPES.map((s) => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
                <div className="flex gap-2">
                  <input className={`${INPUT} flex-1`} value={artifactTitle} aria-label="Consent artifact title"
                    onChange={(e) => setArtifactTitle(e.target.value)} data-testid="sync-grant-artifact" />
                  <input className={`${INPUT} w-[70px]`} value={artifactVersion} aria-label="Consent artifact version"
                    onChange={(e) => setArtifactVersion(e.target.value)} data-testid="sync-grant-version" />
                </div>
                <div className="flex gap-2">
                  <input className={`${INPUT} w-[90px]`} value={jurisdiction} placeholder="Jurisdiction"
                    aria-label="Jurisdiction" onChange={(e) => setJurisdiction(e.target.value)} data-testid="sync-grant-jurisdiction" />
                  <select className={`${INPUT} flex-1`} value={method} aria-label="Consent method"
                    onChange={(e) => setMethod(e.target.value)} data-testid="sync-grant-method">
                    <option value="in_person">In person</option>
                    <option value="patient_app">Patient app</option>
                    <option value="portal">Portal</option>
                    <option value="verbal_documented">Verbal (documented)</option>
                    <option value="written">Written</option>
                  </select>
                  <select className={`${INPUT} flex-1`} value={authority} aria-label="Representative authority"
                    onChange={(e) => setAuthority(e.target.value)} data-testid="sync-grant-authority">
                    <option value="self">Self</option>
                    <option value="guardian">Guardian</option>
                    <option value="healthcare_proxy">Healthcare proxy</option>
                    <option value="legal_representative">Legal representative</option>
                  </select>
                </div>
                <Btn
                  size="sm"
                  disabled={busy || !artifactTitle.trim() || !artifactVersion.trim()}
                  onClick={() =>
                    void run(() =>
                      api.sync.setConsentScope({
                        connectionId: c.id,
                        scope: scopeToGrant,
                        grant: true,
                        artifactTitle: artifactTitle.trim(),
                        artifactVersion: artifactVersion.trim(),
                        jurisdiction: jurisdiction.trim() || null,
                        method,
                        authority,
                      }),
                    )
                  }
                  data-testid="sync-grant-submit"
                >
                  Grant scope
                </Btn>
              </div>
            </div>
          )}
          <p className="m-0 mt-2 text-[11.5px] text-subtle">
            Each scope is independent and versioned. Revoking one stops future synchronization for
            that scope only — nothing historical is deleted. Research participation is consented
            entirely separately from care delivery.
          </p>
        </Card>

        {/* AI summary — fails closed */}
        <Card className="px-4 py-3" data-testid="sync-ai">
          <div className="flex items-center gap-2">
            <CardTitle className="mb-0">
              <Sparkles size={13} strokeWidth={2} className="text-ai-deep" aria-hidden />
              AI sync summary
            </CardTitle>
            <span className="flex-1" />
            <Btn
              size="sm"
              variant="ai"
              onClick={async () => {
                try {
                  await api.sync.summaryAI({ connectionId: c?.id ?? "" });
                } catch (e) {
                  setAiMessage(errText(e));
                }
              }}
              data-testid="sync-ai-generate"
            >
              Summarize inbound data
            </Btn>
          </div>
          {aiMessage && (
            <p className="m-0 mt-2 text-[12px] font-semibold text-warning-deep" data-testid="sync-ai-not-configured">
              {aiMessage}
            </p>
          )}
          <p className="m-0 mt-2 text-[11.5px] text-subtle">
            Human review continues without AI. A future summary stays a draft, cites the exact
            inbound records used, and never sends, changes a plan, orders, diagnoses, or hides
            urgent information.
          </p>
        </Card>

        {/* History / provenance */}
        {data.history.length > 0 && (
          <Card className="px-4 py-3" data-testid="sync-history">
            <CardTitle className="mb-1">Connection history</CardTitle>
            <ul className="m-0 flex list-none flex-col gap-[2px] p-0">
              {data.history.slice(0, 15).map((h, idx) => (
                <li key={idx} className="text-[11.5px] text-subtle">
                  {fmt(h.createdAt)} — {h.kind.replace(/_/g, " ")}
                  {h.toValue ? `: ${h.toValue}` : ""}
                  {h.note ? ` (${h.note})` : ""}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}
