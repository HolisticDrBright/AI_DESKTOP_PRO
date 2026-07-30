"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  BrainCircuit,
  Check,
  CircleHelp,
  Clock,
  FileQuestion,
  ShieldAlert,
  X,
} from "lucide-react";
import { api } from "@/adapters";
import { isAdapterError } from "@/adapters/errors";
import type {
  LiveEvidenceItem,
  LiveHypothesis,
  LiveReasoningWorkspace,
} from "@/adapters/live-types";
import { Btn } from "@/components/ui/Btn";
import { Card, CardTitle } from "@/components/ui/bits";
import { ClinicalError, ClinicalLoading, ClinicalNote } from "@/components/ui/ClinicalStates";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Pill } from "@/components/ui/Pill";
import { useFeedback } from "@/lib/feedback";
import { patientPath } from "@/lib/routes";

/**
 * Clinical Reasoning workspace — CLINICAL, real data only.
 *
 * Reads `get_reasoning_workspace` (practitioner JWT, RLS, membership + patient
 * access enforced in the database). Guarantees encoded here:
 *
 *   * The snapshot header shows version + generated time, and a STALE banner
 *     when source data changed after generation.
 *   * Every hypothesis is labelled an INFERENCE — never a diagnosis.
 *   * The internal evidence-strength wording from the record is shown
 *     verbatim; it is never presented as a medical probability.
 *   * Supporting, conflicting, and missing evidence render as separate lists;
 *     every evidence item links to its source with its date.
 *   * Review actions (accept / reject / request data) persist through one
 *     atomic RPC (review row + hypothesis state + audit event). Accepting
 *     does NOT insert anything into a note or care plan — adding to a note is
 *     a separate, explicit practitioner action elsewhere.
 *   * Urgent safety questions are lens-invariant and shown unconditionally.
 *   * Unknown values render as "Unknown" — nothing is inferred client-side.
 *   * AI generation is not configured; the header says so. No fixture output
 *     is ever substituted.
 */

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "Unknown";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "Unknown"
    : d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function EvidenceList({
  title,
  tone,
  items,
  patientId,
}: {
  title: string;
  tone: "positive" | "critical" | "slate";
  items: LiveEvidenceItem[];
  patientId: string;
}) {
  return (
    <div>
      <div className="mb-1 text-[10.5px] font-bold tracking-[0.04em] text-faint uppercase">{title}</div>
      {items.length === 0 ? (
        <p className="m-0 text-[11.5px] text-faint">None recorded.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-[4px] p-0">
          {items.map((ev) => (
            <li key={ev.id} className="flex items-baseline justify-between gap-2 text-[12px]">
              <span className="min-w-0">
                <Pill tone={tone}>{ev.factType.replace("_", " ")}</Pill>{" "}
                <span className="font-medium text-body">{ev.label}</span>
              </span>
              {ev.source ? (
                <Link
                  href={
                    ev.source.kind === "biomarker_observations"
                      ? patientPath(patientId, "labs")
                      : patientPath(patientId, "chart")
                  }
                  className="shrink-0 text-[10.5px] font-semibold text-action hover:underline"
                >
                  source · {fmtDateTime(ev.source.at)}
                </Link>
              ) : (
                <span className="shrink-0 text-[10.5px] text-faint">
                  {ev.observedAt ? fmtDateTime(ev.observedAt) : "Unknown"}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const REVIEW_LABEL: Record<string, string> = {
  unreviewed: "Unreviewed",
  accepted: "Accepted (inference)",
  rejected: "Rejected",
  needs_data: "More data requested",
};

function HypothesisCard({
  hyp,
  patientId,
  onReview,
  busy,
}: {
  hyp: LiveHypothesis;
  patientId: string;
  onReview: (action: "accepted" | "rejected" | "needs_data", note?: string) => void;
  busy: boolean;
}) {
  const [dataNote, setDataNote] = useState("");
  const [askingData, setAskingData] = useState(false);
  const reviewed = hyp.review.state !== "unreviewed";

  return (
    <Card className="px-4 py-[13px]">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="m-0 text-[13.5px] font-bold text-ink">{hyp.title}</h3>
            <Pill tone="ai">Inference — not a diagnosis</Pill>
            <Pill tone={hyp.review.state === "accepted" ? "positive" : hyp.review.state === "rejected" ? "slate" : hyp.review.state === "needs_data" ? "warning" : "navy"}>
              {REVIEW_LABEL[hyp.review.state]}
            </Pill>
          </div>
          <p className="m-0 mt-1 text-[11.5px] text-subtle">
            {hyp.strengthLabel === "Unknown" ? (
              <>Evidence weighting: <span className="font-semibold">Unknown</span></>
            ) : (
              hyp.strengthLabel
            )}
          </p>
        </div>
        <span className="text-[10.5px] text-faint">status: {hyp.status.replace("_", " ")}</span>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <EvidenceList title="Supporting" tone="positive" items={hyp.supporting} patientId={patientId} />
        <EvidenceList title="Conflicting" tone="critical" items={hyp.conflicting} patientId={patientId} />
        <div>
          <div className="mb-1 text-[10.5px] font-bold tracking-[0.04em] text-faint uppercase">Missing</div>
          {hyp.missing.length === 0 ? (
            <p className="m-0 text-[11.5px] text-faint">None recorded.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-[4px] p-0">
              {hyp.missing.map((m) => (
                <li key={m.id} className="text-[12px]">
                  <Pill tone="warning">missing</Pill>{" "}
                  <span className="font-medium text-body">{m.label}</span>
                  {m.recommendation && <span className="text-subtle"> — {m.recommendation}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {reviewed && (
        <p className="m-0 mt-3 rounded-lg bg-sunken px-3 py-[7px] text-[11.5px] text-subtle">
          Reviewed by <span className="font-semibold text-body">{hyp.review.reviewedBy ?? "Practitioner"}</span>{" "}
          · {fmtDateTime(hyp.review.reviewedAt)}
          {hyp.review.note && <> · “{hyp.review.note}”</>}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
        <Btn size="sm" variant="primary" disabled={busy} onClick={() => onReview("accepted")}>
          <Check size={12} aria-hidden /> Accept inference
        </Btn>
        <Btn size="sm" disabled={busy} onClick={() => onReview("rejected")}>
          <X size={12} aria-hidden /> Reject
        </Btn>
        <Btn size="sm" disabled={busy} onClick={() => setAskingData((v) => !v)}>
          <FileQuestion size={12} aria-hidden /> Request data
        </Btn>
        <span className="text-[10.5px] text-faint">
          Accepting records your review — it never adds content to a note or care plan.
        </span>
      </div>

      {askingData && (
        <div className="mt-2 flex gap-2">
          <input
            value={dataNote}
            onChange={(e) => setDataNote(e.target.value)}
            placeholder="What data is needed? (saved as an open request)"
            className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-card px-[10px] text-[12px] text-body outline-none focus-visible:border-action"
          />
          <Btn
            size="sm"
            variant="primary"
            disabled={busy || !dataNote.trim()}
            onClick={() => {
              onReview("needs_data", dataNote.trim());
              setAskingData(false);
              setDataNote("");
            }}
          >
            Save request
          </Btn>
        </div>
      )}
    </Card>
  );
}

export function ReasoningWorkspace({
  patientId,
  patientName,
}: {
  patientId: string;
  patientName: string;
}) {
  const { announce } = useFeedback();
  const [data, setData] = useState<LiveReasoningWorkspace | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [confirmReject, setConfirmReject] = useState<LiveHypothesis | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    api.reasoning
      .getWorkspace(patientId)
      .then((w) => {
        if (alive) setData(w as LiveReasoningWorkspace);
      })
      .catch((e) => {
        if (alive)
          setError(
            isAdapterError(e)
              ? { message: e.safeMessage, code: e.code }
              : { message: "Unable to load the reasoning workspace." },
          );
      });
    return () => {
      alive = false;
    };
  }, [patientId, reloadKey]);

  const review = async (
    hypothesisId: string,
    action: "accepted" | "rejected" | "needs_data",
    note?: string,
  ) => {
    setBusy(true);
    try {
      const r = await api.reasoning.reviewHypothesis({ hypothesisId, action, note });
      announce(r.message);
      setReloadKey((k) => k + 1);
    } catch (e) {
      announce(
        isAdapterError(e) ? e.safeMessage : "The review could not be saved. Nothing was recorded.",
      );
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <div className="pt-4">
        <ClinicalError message={error.message} onRetry={() => setReloadKey((k) => k + 1)} />
      </div>
    );
  }
  if (!data) return <ClinicalLoading label="Loading reasoning record…" />;

  return (
    <section data-screen-label="Clinical reasoning (live)" className="flex flex-col gap-3 pt-3 pb-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <BrainCircuit size={16} strokeWidth={2} className="text-ai" aria-hidden />
            <h2 className="m-0 text-[16px] font-bold text-ink">Clinical reasoning</h2>
            <Pill tone="ai">Inferences for review</Pill>
          </div>
          <p className="m-0 mt-1 text-[11.5px] text-subtle">
            {patientName} ·{" "}
            {data.snapshot ? (
              <>snapshot v{data.snapshot.version} · generated {fmtDateTime(data.snapshot.generatedAt)}</>
            ) : (
              "no reasoning snapshot on the record"
            )}
          </p>
        </div>
      </header>

      {data.snapshot?.stale && (
        <div className="flex items-start gap-2 rounded-[10px] border border-[rgba(199,126,20,0.3)] bg-warning-tint px-3 py-[9px]">
          <Clock size={13} strokeWidth={2} className="mt-[1px] shrink-0 text-warning-deep" aria-hidden />
          <p className="m-0 text-[12px] leading-[1.5] text-warning-deep">
            <span className="font-bold">Stale:</span>{" "}
            {data.snapshot.staleReason ?? "Source data changed after this snapshot was generated."}{" "}
            Review the underlying record before acting on these inferences.
          </p>
        </div>
      )}

      <ClinicalNote>
        {data.aiGeneration.message} The deterministic safety and lens layers operate independently
        when their governed inputs are available.
      </ClinicalNote>

      {data.urgentQuestions.length > 0 && (
        <Card className="border-[rgba(184,54,54,0.35)] px-4 py-[13px]">
          <CardTitle className="mb-1">
            <ShieldAlert size={13} strokeWidth={2} className="text-critical" aria-hidden />
            Urgent safety questions (lens-invariant)
          </CardTitle>
          <ul className="m-0 flex list-none flex-col gap-[5px] p-0">
            {data.urgentQuestions.map((q) => (
              <li key={q.id} className="flex items-baseline justify-between gap-2 text-[12.5px]">
                <span className="font-medium text-body">{q.text}</span>
                <Pill tone="critical">{q.status}</Pill>
              </li>
            ))}
          </ul>
          <p className="m-0 mt-2 text-[10.5px] text-faint">
            Urgent safety questions are identical under every clinical lens — a lens can reframe
            terminology, never remove a safety concern.
          </p>
        </Card>
      )}

      {data.hypotheses.length === 0 ? (
        <Card className="px-5 py-8 text-center">
          <CircleHelp size={18} strokeWidth={1.75} className="mx-auto mb-2 text-slate-badge" aria-hidden />
          <p className="m-0 text-[13px] font-semibold text-body">No hypotheses on the record</p>
          <p className="m-0 mt-1 text-[12px] text-subtle">
            Hypotheses appear here once the reasoning engine (or a practitioner) records them with
            their evidence. Nothing is generated on this screen.{" "}
            <Link href={patientPath(patientId, "labs")} className="font-semibold text-action hover:underline">
              Open labs →
            </Link>
          </p>
        </Card>
      ) : (
        data.hypotheses.map((hyp) => (
          <HypothesisCard
            key={hyp.id}
            hyp={hyp}
            patientId={patientId}
            busy={busy}
            onReview={(action, note) => {
              if (action === "rejected") {
                setConfirmReject(hyp);
                return;
              }
              void review(hyp.id, action, note);
            }}
          />
        ))
      )}

      <ConfirmDialog
        open={Boolean(confirmReject)}
        title="Reject this hypothesis?"
        body="Rejecting records your review decision with an audit trail. The hypothesis and its evidence remain on the record for reference."
        confirmLabel="Reject hypothesis"
        onCancel={() => setConfirmReject(null)}
        onConfirm={() => {
          const target = confirmReject;
          setConfirmReject(null);
          if (target) void review(target.id, "rejected");
        }}
      />

      <p className="m-0 flex items-start gap-1.5 text-[10.5px] leading-[1.5] text-faint">
        <AlertTriangle size={11} strokeWidth={2} className="mt-[1px] shrink-0" aria-hidden />
        Evidence strength wording is the record’s internal weighting, never a medical probability.
        Unknown values stay “Unknown”. Every review action persists with its audit event atomically.
      </p>
    </section>
  );
}
