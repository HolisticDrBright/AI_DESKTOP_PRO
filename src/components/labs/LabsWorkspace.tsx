"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  Download,
  FileText,
  FlaskConical,
  ListChecks,
  SlidersHorizontal,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import { api } from "@/adapters";
import {
  type BiomarkerMarker,
  type ExtractionConfidenceBand,
  type LabWorkspace,
  type MarkerStatus,
  type MarkerTrendKind,
  type OptimalRange,
} from "@/adapters/labs.mock";
import { isAdapterError } from "@/adapters/errors";
import type { LiveUploadResult } from "@/adapters/live-types";
import { USE_LIVE_API } from "@/adapters/mode";
import { useReviewOutcome, type ReviewOutcome } from "@/adapters/session-store";
import type { ReviewState, Tone } from "@/adapters/types";
import { ActionBar } from "@/components/ui/ActionBar";
import { ClinicalEmpty, ClinicalError, ClinicalLoading } from "@/components/ui/ClinicalStates";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Provenance } from "@/components/ui/Provenance";
import { Sparkline } from "@/components/ui/Sparkline";
import { Card } from "@/components/ui/bits";
import { cn } from "@/lib/cn";
import { useFeedback } from "@/lib/feedback";
import { toneColor, toneText, toneTint } from "@/lib/tones";

/* --------------------------------------------------------------- meta maps */

const STATUS_META: Record<MarkerStatus, { label: string; tone: Tone }> = {
  optimal: { label: "Optimal", tone: "positive" },
  low: { label: "Below optimal", tone: "warning" },
  high: { label: "Above optimal", tone: "warning" },
  "critical-low": { label: "Critical low", tone: "critical" },
  "critical-high": { label: "Critical high", tone: "critical" },
  normal: { label: "Within range", tone: "slate" },
};

const TREND_META: Record<MarkerTrendKind, { label: string; tone: Tone }> = {
  improving: { label: "Improving", tone: "positive" },
  worsening: { label: "Worsening", tone: "critical" },
  stable: { label: "Stable", tone: "slate" },
  "newly-abnormal": { label: "Newly abnormal", tone: "warning" },
  "needs-review": { label: "Needs review", tone: "warning" },
};

const CONF_META: Record<ExtractionConfidenceBand, { label: string; tone: Tone }> = {
  high: { label: "High", tone: "positive" },
  medium: { label: "Medium", tone: "warning" },
  low: { label: "Low", tone: "critical" },
};

const REVIEW_META: Record<ReviewState, { label: string; tone: Tone }> = {
  reviewed: { label: "Reviewed", tone: "positive" },
  "awaiting-review": { label: "Awaiting", tone: "warning" },
  "not-reviewed": { label: "Not reviewed", tone: "warning" },
};

/** Effective review display = session outcome overrides the seed state. */
function effectiveReview(
  marker: BiomarkerMarker,
  outcome?: ReviewOutcome,
): { label: string; tone: Tone } {
  if (outcome === "reviewed") return { label: "Reviewed", tone: "positive" };
  if (outcome === "flagged") return { label: "Flagged", tone: "critical" };
  return REVIEW_META[marker.reviewState];
}

function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span
      className="w-fit rounded-full px-[7px] py-px text-[10px] font-semibold whitespace-nowrap"
      style={{ color: toneText[tone], background: toneTint[tone] }}
    >
      {children}
    </span>
  );
}

/* ------------------------------------------------------------- root screen */

export function LabsWorkspace({
  patientId,
  patientName,
}: {
  patientId: string;
  patientName: string;
}) {
  const [ws, setWs] = useState<LabWorkspace | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [errorCode, setErrorCode] = useState<string | undefined>(undefined);
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedId, setSelectedId] = useState<string>("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [configMarker, setConfigMarker] = useState<BiomarkerMarker | null>(null);
  const [overrides, setOverrides] = useState<Record<string, OptimalRange>>({});

  // Real workspace read through the façade: mock in demo mode, the live
  // biomarker_observations query (RLS-scoped) when NEXT_PUBLIC_USE_LIVE_API is on.
  useEffect(() => {
    let alive = true;
    setLoadState("loading");
    api.labs
      .getWorkspace(patientId, patientName)
      .then((w) => {
        if (!alive) return;
        setWs(w);
        setSelectedId(w.markers[0]?.id ?? "");
        setLoadState("ready");
      })
      .catch((e) => {
        if (!alive) return;
        setErrorMsg(isAdapterError(e) ? e.safeMessage : "Unable to load labs right now.");
        setErrorCode(isAdapterError(e) ? e.code : undefined);
        setLoadState("error");
      });
    return () => {
      alive = false;
    };
  }, [patientId, patientName, reloadKey]);

  if (loadState === "loading") {
    return (
      <section data-screen-label="Labs & Biomarkers" className="relative px-6 pt-[22px] pb-6">
        <ClinicalLoading label="Loading labs & biomarkers…" />
      </section>
    );
  }
  if (loadState === "error") {
    const signedOut = errorCode === "unauthenticated";
    return (
      <section data-screen-label="Labs & Biomarkers" className="relative px-6 pt-[22px] pb-6">
        <ClinicalError
          message={errorMsg}
          onRetry={() => setReloadKey((k) => k + 1)}
          actionHref={signedOut ? "/login" : undefined}
          actionLabel={signedOut ? "Sign in" : undefined}
        />
      </section>
    );
  }
  if (!ws) return null;

  const empty = ws.markers.length === 0;
  const selected = ws.markers.find((m) => m.id === selectedId) ?? null;
  const optimalOf = (m: BiomarkerMarker) => overrides[m.id] ?? m.optimalRange;

  return (
    <section data-screen-label="Labs & Biomarkers" className="relative pb-6">
      <WorkspaceHeader ws={ws} onUpload={() => setUploadOpen(true)} />

      {empty ? (
        // Upload stays available — a fresh live patient starts exactly here.
        <div className="mt-4">
          <ClinicalEmpty
            icon={<FlaskConical size={20} strokeWidth={1.75} className="text-slate-badge" aria-hidden />}
            title="No lab results yet"
            message={`There are no lab markers on file for ${patientName}. Upload a lab report to run extraction and practitioner review.`}
          />
        </div>
      ) : (
        <>
          <QueueStrip ws={ws} />

          <div className="mt-4 grid grid-cols-[minmax(0,1fr)_340px] items-start gap-4">
            <MarkerTable
              markers={ws.markers}
              patientId={patientId}
              selectedId={selectedId}
              optimalOf={optimalOf}
              onSelect={setSelectedId}
            />
            <MarkerInspector
              marker={selected}
              patientId={patientId}
              patientName={patientName}
              optimalRange={selected ? optimalOf(selected) : undefined}
              onConfigure={() => selected && setConfigMarker(selected)}
            />
          </div>
        </>
      )}

      {uploadOpen && (
        <UploadDrawer
          patientId={patientId}
          patientName={patientName}
          onClose={() => setUploadOpen(false)}
          onUploaded={() => {
            setUploadOpen(false);
            setReloadKey((k) => k + 1);
          }}
        />
      )}
      {configMarker && (
        <OptimalRangeModal
          marker={configMarker}
          patientId={patientId}
          patientName={patientName}
          current={optimalOf(configMarker)}
          onSave={(range) => {
            setOverrides((o) => ({ ...o, [configMarker.id]: range }));
            setConfigMarker(null);
          }}
          onCancel={() => setConfigMarker(null)}
        />
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ header */

function WorkspaceHeader({ ws, onUpload }: { ws: LabWorkspace; onUpload: () => void }) {
  const { announce } = useFeedback();
  const btn =
    "flex h-8 cursor-pointer items-center gap-[6px] rounded-lg border border-line bg-card px-3 text-[12px] font-semibold text-body hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action";
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <div className="flex items-center gap-[7px]">
          <FlaskConical size={17} strokeWidth={2} className="text-brand" aria-hidden />
          <h1 className="m-0 text-[19px] font-bold tracking-[-0.015em]">Labs &amp; Biomarkers</h1>
        </div>
        <div className="mt-[4px] flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-subtle">
          <span>Last upload {ws.lastUpload}</span>
          <span aria-hidden>·</span>
          <span>Synced {ws.lastSynced}</span>
          <span aria-hidden>·</span>
          <span className="font-semibold text-warning-deep">{ws.reviewSummary.awaiting} awaiting review</span>
          <span aria-hidden>·</span>
          <span className="font-semibold text-critical">{ws.reviewSummary.abnormal} abnormal</span>
          <span aria-hidden>·</span>
          <span className="font-semibold text-warning-deep">{ws.reviewSummary.lowConfidence} low-confidence</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={onUpload} className="flex h-8 cursor-pointer items-center gap-[6px] rounded-lg border-none bg-action px-3 text-[12px] font-semibold text-white hover:bg-action-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
          <Upload size={13} strokeWidth={2} aria-hidden />
          Upload lab
        </button>
        <Link href="/tasks?filter=extraction-review" className={btn}>
          <ListChecks size={13} strokeWidth={2} aria-hidden />
          Review extraction queue
        </Link>
        <button onClick={() => announce("Optimal ranges are configured per marker from the inspector. (demo)")} className={btn}>
          <SlidersHorizontal size={13} strokeWidth={2} aria-hidden />
          Configure optimal ranges
        </button>
        <button onClick={() => announce("Exported reviewed markers to CSV. (demo — not persisted)")} className={btn}>
          <Download size={13} strokeWidth={2} aria-hidden />
          Export reviewed
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- queue strip */

function QueueStrip({ ws }: { ws: LabWorkspace }) {
  return (
    <div className="mt-3 flex gap-2 overflow-x-auto pb-1" aria-label="Processing and review queue">
      {ws.queue.map((q) => (
        <div
          key={q.id}
          className="flex min-w-[190px] shrink-0 items-center gap-[10px] rounded-[11px] border border-line bg-card px-[12px] py-[9px]"
        >
          <span
            className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg text-[12px] font-bold"
            style={{ color: toneText[q.tone], background: toneTint[q.tone] }}
          >
            {q.count}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12px] font-semibold text-ink">{q.label}</span>
            <span className="block truncate text-[10.5px] text-subtle">
              {q.source} · {q.date}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------- marker table */

function MarkerTable({
  markers,
  patientId,
  selectedId,
  optimalOf,
  onSelect,
}: {
  markers: BiomarkerMarker[];
  patientId: string;
  selectedId: string;
  optimalOf: (m: BiomarkerMarker) => OptimalRange;
  onSelect: (id: string) => void;
}) {
  const th =
    "sticky top-0 z-10 whitespace-nowrap bg-[#F6F9FC] px-[10px] py-[8px] text-left text-[10px] font-bold tracking-[0.03em] text-faint uppercase";
  return (
    <Card className="overflow-hidden">
      <div className="max-h-[560px] overflow-auto">
        <table className="w-full border-collapse text-[12px]">
          <caption className="sr-only">
            Biomarker results with laboratory and configured optimal ranges, extraction
            confidence, and review state
          </caption>
          <thead>
            <tr>
              <th scope="col" className={cn(th, "left-0 z-20")}>Marker</th>
              <th scope="col" className={th}>Result</th>
              <th scope="col" className={th}>Unit</th>
              <th scope="col" className={th}>Lab range</th>
              <th scope="col" className={th}>Optimal</th>
              <th scope="col" className={th}>Prior</th>
              <th scope="col" className={th}>Change</th>
              <th scope="col" className={th}>Trend</th>
              <th scope="col" className={th}>Status</th>
              <th scope="col" className={th}>Source</th>
              <th scope="col" className={th}>Conf.</th>
              <th scope="col" className={th}>Reviewed</th>
            </tr>
          </thead>
          <tbody>
            {markers.map((m) => (
              <MarkerRow
                key={m.id}
                marker={m}
                patientId={patientId}
                optimal={optimalOf(m)}
                selected={m.id === selectedId}
                onSelect={() => onSelect(m.id)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function fmtOptimal(r: OptimalRange): string {
  if (r.min != null && r.max != null) return `${r.min}–${r.max}`;
  if (r.max != null) return `< ${r.max}`;
  if (r.min != null) return `> ${r.min}`;
  return "—";
}

function MarkerRow({
  marker,
  patientId,
  optimal,
  selected,
  onSelect,
}: {
  marker: BiomarkerMarker;
  patientId: string;
  optimal: OptimalRange;
  selected: boolean;
  onSelect: () => void;
}) {
  const outcome = useReviewOutcome(`lab:${patientId}:${marker.id}`);
  const status = STATUS_META[marker.status];
  const trend = TREND_META[marker.trend];
  const conf = CONF_META[marker.confidenceBand];
  const review = effectiveReview(marker, outcome);
  const td = "whitespace-nowrap px-[10px] py-[7px] align-middle";

  return (
    <tr
      aria-selected={selected}
      className={cn(
        "border-t border-[#F1F5F9]",
        selected ? "bg-action-tint" : "hover:bg-sunken",
      )}
    >
      <th scope="row" className={cn(td, "sticky left-0 z-[1] font-normal", selected ? "bg-action-tint" : "bg-card")}>
        <button
          onClick={onSelect}
          aria-label={`Select ${marker.name}`}
          aria-pressed={selected}
          className="text-left text-[12px] font-semibold text-ink hover:text-action focus-visible:outline-2 focus-visible:outline-action"
        >
          {marker.name}
        </button>
      </th>
      <td className={cn(td, "font-bold")} style={{ color: toneColor[status.tone] }}>{marker.currentDisplay}</td>
      <td className={cn(td, "text-muted")}>{marker.unit}</td>
      <td className={cn(td, "text-muted")}>{marker.labRangeText}</td>
      <td className={cn(td, "text-body")}>{fmtOptimal(optimal)}</td>
      <td className={cn(td, "text-muted")}>{marker.priorDisplay ?? "—"}</td>
      <td className={td}>{marker.changeDisplay ?? "—"}</td>
      <td className={td}>
        <span className="flex items-center gap-[6px]">
          <Sparkline
            values={marker.series.map((p) => p.value)}
            width={46}
            height={16}
            stroke={toneColor[trend.tone]}
            strokeWidth={1.5}
            label={`${marker.name} trend: ${trend.label}`}
            className="w-[46px] shrink-0"
          />
          <span className="text-[10.5px] font-semibold" style={{ color: toneText[trend.tone] }}>
            {trend.label}
          </span>
        </span>
      </td>
      <td className={td}><Pill tone={status.tone}>{status.label}</Pill></td>
      <td className={cn(td, "text-[11px] text-muted")}>{marker.source.location}</td>
      <td className={td}>
        <span className="flex items-center gap-[5px]">
          <span className="text-[11px] font-semibold text-body">{marker.confidence}%</span>
          <Pill tone={conf.tone}>{conf.label}</Pill>
        </span>
      </td>
      <td className={td}><Pill tone={review.tone}>{review.label}</Pill></td>
    </tr>
  );
}

/* ---------------------------------------------------------------- inspector */

const INSPECTOR_ACTIONS = [
  "request_recheck",
  "add_to_note",
  "insert_into_report",
  "convert_to_task",
  "add_evidence",
  "add_contradiction",
  "open_source",
] as const;

function MarkerInspector({
  marker,
  patientId,
  patientName,
  optimalRange,
  onConfigure,
}: {
  marker: BiomarkerMarker | null;
  patientId: string;
  patientName: string;
  optimalRange?: OptimalRange;
  onConfigure: () => void;
}) {
  const { announce } = useFeedback();
  const outcome = useReviewOutcome(marker ? `lab:${patientId}:${marker.id}` : "");
  const [confirming, setConfirming] = useState(false);

  if (!marker) {
    return (
      <Card className="flex flex-col items-center gap-[8px] px-5 py-[60px] text-center">
        <FileText size={22} strokeWidth={1.5} className="text-ghost" aria-hidden />
        <p className="m-0 text-[12.5px] text-subtle">Select a marker to inspect its source, ranges, trend, and review actions.</p>
      </Card>
    );
  }

  const status = STATUS_META[marker.status];
  const trend = TREND_META[marker.trend];
  const conf = CONF_META[marker.confidenceBand];
  const review = effectiveReview(marker, outcome);
  const reviewed = outcome === "reviewed";
  const needsConfirm = marker.confidenceBand === "low" || marker.status.startsWith("critical");

  const doReview = () => {
    setConfirming(false);
    void api.labs
      .reviewMarker(marker.id, { patientId, patientName, markerName: marker.name })
      .then((r) => announce(r.message));
  };
  const onMarkReviewed = () => (needsConfirm ? setConfirming(true) : doReview());
  const onFlag = () =>
    void api.labs
      .flagMarker(marker.id, { patientId, patientName, markerName: marker.name })
      .then((r) => announce(r.message));
  const onCreateTask = () =>
    void api.labs
      .createReviewTask({
        markerId: marker.id,
        markerName: marker.name,
        patientId,
        patientName,
        priority: marker.status.startsWith("critical") ? "High" : "Medium",
      })
      .then((r) => announce(r.message));

  const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div>
      <div className="text-[9.5px] font-bold tracking-[0.04em] text-faint uppercase">{label}</div>
      <div className="mt-[1px] text-[12px] font-semibold text-body">{children}</div>
    </div>
  );

  return (
    <Card className="sticky top-[6px] flex flex-col overflow-hidden">
      <div className="border-b border-hairline px-4 pt-[13px] pb-[11px]">
        <div className="flex items-start justify-between gap-2">
          <h2 className="m-0 text-[14px] font-bold">{marker.name}</h2>
          <Pill tone={status.tone}>{status.label}</Pill>
        </div>

        {/* Trend panel */}
        <div className="mt-[10px] rounded-[10px] border border-line bg-[rgba(248,250,252,0.6)] p-[11px]">
          <div className="flex items-end justify-between">
            <div>
              <span className="text-[20px] font-bold text-ink">{marker.currentDisplay}</span>
              <span className="ml-1 text-[11px] text-muted">{marker.unit}</span>
            </div>
            <Sparkline
              values={marker.series.map((p) => p.value)}
              width={90}
              height={26}
              stroke={toneColor[trend.tone]}
              strokeWidth={1.75}
              label={`${marker.name} trend over ${marker.series.length} points: ${trend.label}`}
              className="w-[90px]"
            />
          </div>
          <div className="mt-[7px] flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-subtle">
            <span>Prior {marker.priorDisplay ?? "—"}</span>
            <span>Change {marker.changeDisplay ?? "—"}{marker.changePct != null ? ` (${marker.changePct > 0 ? "+" : ""}${marker.changePct}%)` : ""}</span>
            <Pill tone={trend.tone}>{trend.label}</Pill>
          </div>
          <div className="mt-[6px] text-[10px] text-faint">
            Descriptive of observed values only — not a cause or a prediction.
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-[12px]">
        {/* Key facts */}
        <div className="grid grid-cols-2 gap-x-3 gap-y-[9px]">
          <Field label="Lab reference range">{marker.labRangeText}</Field>
          <Field label="Configured optimal">{optimalRange ? fmtOptimal(optimalRange) : fmtOptimal(marker.optimalRange)} {marker.unit}</Field>
          <Field label="Extraction confidence">
            <span className="flex items-center gap-[5px]">
              {marker.confidence}% <Pill tone={conf.tone}>{conf.label}</Pill>
            </span>
          </Field>
          <Field label="Review state"><Pill tone={review.tone}>{review.label}</Pill></Field>
        </div>
        <p className="mt-[7px] mb-0 text-[10px] leading-[1.4] text-faint">
          Lab reference range is the laboratory&rsquo;s original interval and is never replaced.
          Confidence is extraction/data confidence, not medical certainty.
        </p>

        {/* Provenance */}
        <div className="mt-[12px] border-t border-hairline-2 pt-[11px]">
          <Provenance data={marker.provenance} onOpenSource={() => announce("Opened source document (demo — no file).")} />
        </div>

        {/* Source preview */}
        <div className="mt-[12px]">
          <div className="mb-[6px] text-[10px] font-bold tracking-[0.04em] text-faint uppercase">Source preview</div>
          <div className="rounded-[10px] border border-line bg-[rgba(248,250,252,0.6)] p-[11px]">
            <div className="flex items-center gap-[6px] text-[11.5px] font-semibold text-body">
              <FileText size={13} strokeWidth={2} className="text-muted" aria-hidden />
              {marker.source.reportName}
            </div>
            <div className="mt-[2px] text-[10.5px] text-subtle">{marker.source.location}</div>
            <pre className="mt-[7px] overflow-x-auto rounded-[7px] border border-hairline bg-card px-[8px] py-[6px] font-mono text-[10.5px] leading-[1.5] text-body">
{marker.source.snippet}
            </pre>
            <div className="mt-[6px] flex items-start gap-[5px] text-[10.5px] leading-[1.4] text-subtle">
              {marker.confidenceBand === "low" && (
                <TriangleAlert size={11} strokeWidth={2} className="mt-[2px] shrink-0 text-warning" aria-hidden />
              )}
              {marker.source.confidenceNote}
            </div>
          </div>
        </div>

        {/* Clinical context */}
        <div className="mt-[12px]">
          <div className="mb-[6px] text-[10px] font-bold tracking-[0.04em] text-faint uppercase">Clinical context</div>
          <div className="flex flex-col gap-[7px]">
            <ContextRow label="Systems" items={marker.relatedSystems} />
            <ContextRow label="Symptoms / goals" items={marker.relatedContext} />
            <ContextRow label="Hypotheses" items={marker.relatedHypotheses} />
            <ContextRow label="Protocols" items={marker.relatedProtocols} />
          </div>
        </div>

        {/* Extraction-review note for low confidence */}
        {marker.confidenceBand === "low" && !reviewed && (
          <div className="mt-[12px] flex items-start gap-[7px] rounded-[9px] border border-[rgba(199,126,20,0.28)] bg-warning-tint px-[11px] py-[9px]">
            <TriangleAlert size={14} strokeWidth={2} className="mt-px shrink-0 text-warning-deep" aria-hidden />
            <span className="text-[11px] leading-[1.45] text-warning-deep">
              Low extraction confidence. Confirm the value and unit against the source snippet
              before marking reviewed.
            </span>
          </div>
        )}
      </div>

      {/* Review + configure controls */}
      <div className="shrink-0 border-t border-hairline bg-[rgba(247,250,252,0.6)] px-4 py-[11px]">
        <div className="mb-[9px] flex flex-wrap items-center gap-2">
          <button
            onClick={onMarkReviewed}
            disabled={reviewed}
            className="flex h-[30px] cursor-pointer items-center gap-[6px] rounded-lg border-none bg-positive px-[12px] text-[12px] font-semibold text-white hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            {reviewed ? "Reviewed" : "Mark reviewed"}
          </button>
          <button
            onClick={onFlag}
            className="flex h-[30px] cursor-pointer items-center gap-[6px] rounded-lg border border-line bg-card px-[12px] text-[12px] font-semibold text-warning-deep hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action"
          >
            Flag for review
          </button>
          <button
            onClick={onCreateTask}
            className="flex h-[30px] cursor-pointer items-center gap-[6px] rounded-lg border border-line bg-card px-[12px] text-[12px] font-semibold text-body hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action"
          >
            <ListChecks size={12} strokeWidth={2} aria-hidden />
            Create follow-up task
          </button>
          <Link
            href={`/patients/${patientId}/lab-orders`}
            className="flex h-[30px] cursor-pointer items-center gap-[6px] rounded-lg border border-line bg-card px-[12px] text-[12px] font-semibold text-body hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action"
          >
            <FlaskConical size={12} strokeWidth={2} aria-hidden />
            Create lab order draft
          </Link>
          <button
            onClick={onConfigure}
            className="flex h-[30px] cursor-pointer items-center gap-[6px] rounded-lg border border-line bg-card px-[12px] text-[12px] font-semibold text-body hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action"
          >
            <SlidersHorizontal size={12} strokeWidth={2} aria-hidden />
            Configure optimal range
          </button>
        </div>
        <ActionBar
          size="sm"
          actions={[...INSPECTOR_ACTIONS]}
          context={{
            subjectType: "lab marker",
            subjectLabel: marker.name,
            patientName,
            seeds: marker.seeds,
          }}
        />
      </div>

      {confirming && (
        <ConfirmDialog
          open
          destructive={marker.status.startsWith("critical")}
          title={`Mark ${marker.name} reviewed?`}
          body={
            marker.confidenceBand === "low"
              ? "This marker has low extraction confidence. Confirm you have checked the value and unit against the source snippet."
              : "This is a critical result. Confirm you have reviewed it before marking reviewed."
          }
          confirmLabel="Mark reviewed"
          onCancel={() => setConfirming(false)}
          onConfirm={doReview}
        />
      )}
    </Card>
  );
}

function ContextRow({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="flex items-start gap-2">
      <span className="w-[92px] shrink-0 text-[10.5px] text-faint">{label}</span>
      <span className="flex flex-1 flex-wrap gap-[4px]">
        {items.length === 0 ? (
          <span className="text-[11px] text-faint">—</span>
        ) : (
          items.map((it) => (
            <span key={it} className="rounded-[5px] bg-sunken-2 px-[6px] py-px text-[10.5px] text-muted">
              {it}
            </span>
          ))
        )}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------- upload drawer */

function UploadDrawer({
  patientId,
  patientName,
  onClose,
  onUploaded,
}: {
  patientId: string;
  patientName: string;
  onClose: () => void;
  onUploaded: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside
      role="dialog"
      aria-label="Upload lab report"
      className="glass-overlay animate-fade-up fixed top-3 right-3 bottom-3 z-[95] flex w-[420px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-[20px] border border-[rgba(255,255,255,0.7)] bg-[rgba(255,255,255,0.95)] shadow-[0_20px_56px_rgba(24,42,61,0.2)] outline-1 outline-[rgba(203,214,224,0.6)]"
    >
      <div className="flex items-start gap-[9px] border-b border-hairline px-4 pt-[14px] pb-3">
        <span className="mt-px flex h-7 w-7 items-center justify-center rounded-lg bg-action-tint">
          <Upload size={14} strokeWidth={1.75} className="text-action" aria-hidden />
        </span>
        <div className="flex-1">
          <h2 ref={headingRef} tabIndex={-1} className="m-0 text-[14px] font-bold outline-none">Upload lab</h2>
          <div className="text-[11px] text-subtle">Patient · {patientName}</div>
        </div>
        <button onClick={onClose} aria-label="Close upload" className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-faint hover:bg-[rgba(90,107,126,0.1)] hover:text-ink focus-visible:outline-2 focus-visible:outline-action">
          <X size={14} strokeWidth={2} aria-hidden />
        </button>
      </div>

      {USE_LIVE_API ? (
        <LiveUploadBody patientId={patientId} onUploaded={onUploaded} />
      ) : (
        <DemoUploadBody patientName={patientName} onClose={onClose} />
      )}
    </aside>
  );
}

/** LIVE upload: real PDF → backend ingestion pipeline → honest result panel. */
function LiveUploadBody({ patientId, onUploaded }: { patientId: string; onUploaded: () => void }) {
  const { announce } = useFeedback();
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<"idle" | "working" | "done">("idle");
  const [result, setResult] = useState<LiveUploadResult | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  const submit = () => {
    if (!file || phase === "working") return;
    setPhase("working");
    setErrorMsg("");
    api.labs
      .uploadDocument(patientId, file)
      .then((r) => {
        setResult(r);
        setPhase("done");
        announce(
          r.status === "extracted"
            ? `Lab report extracted: ${r.inserted} markers. (saved to record + audit)`
            : "Lab report stored, but extraction failed — it is queued for manual review.",
        );
      })
      .catch((e) => {
        setPhase("idle");
        setErrorMsg(isAdapterError(e) ? e.safeMessage : "Upload failed. Please try again.");
      });
  };

  const FAILURE_COPY: Record<string, string> = {
    unreadable_pdf: "The PDF could not be read (it may be scanned or encrypted).",
    no_text_extracted: "No text could be extracted (image-only PDFs are not supported yet).",
    no_markers_found: "No lab results were recognized in the document.",
  };

  if (phase === "done" && result) {
    const ok = result.status === "extracted";
    return (
      <div className="flex flex-1 flex-col">
        <div className="flex-1 overflow-y-auto px-4 py-[13px]">
          <div
            className={cn(
              "rounded-[12px] border px-4 py-[14px]",
              ok ? "border-[rgba(31,138,90,0.3)] bg-positive-tint" : "border-[rgba(199,126,20,0.28)] bg-warning-tint",
            )}
            role="status"
          >
            <div className="text-[13px] font-bold text-ink">
              {ok ? `${result.inserted} markers extracted` : "Stored — extraction failed"}
            </div>
            <p className="m-0 mt-[6px] text-[12px] leading-[1.5] text-body">
              {ok
                ? `${result.matched ?? 0} matched known biomarkers · ${result.lowConfidence ?? 0} flagged low-confidence${
                    (result.lowConfidence ?? 0) > 0 ? " and queued for your review" : ""
                  }. Every extracted value keeps the lab's original text and needs practitioner review before use.`
                : `${FAILURE_COPY[result.failureReason ?? ""] ?? "Extraction failed."} The original PDF is stored with the patient record for manual review, and the failure was audited.`}
            </p>
          </div>
        </div>
        <div className="shrink-0 border-t border-hairline bg-[rgba(247,250,252,0.7)] px-4 py-3">
          <button
            onClick={onUploaded}
            className="h-9 w-full cursor-pointer rounded-lg border-none bg-action text-[12.5px] font-semibold text-white hover:bg-action-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            {ok ? "View extracted markers" : "Back to workspace"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex-1 overflow-y-auto px-4 py-[13px]">
        <label className="flex cursor-pointer flex-col items-center gap-[7px] rounded-[12px] border border-dashed border-line-btn bg-[rgba(247,250,252,0.6)] px-4 py-[26px] text-center hover:border-action focus-within:outline-2 focus-within:outline-action">
          <Upload size={22} strokeWidth={1.5} className="text-muted" aria-hidden />
          <span className="text-[12.5px] font-semibold text-body">
            {file ? file.name : "Choose a lab report PDF"}
          </span>
          <span className="text-[11px] text-faint">PDF only · 15 MB max</span>
          <input
            type="file"
            accept="application/pdf,.pdf"
            aria-label="Lab report PDF"
            className="sr-only"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>

        {errorMsg && (
          <p role="alert" className="mt-[12px] rounded-[9px] bg-critical-tint px-[11px] py-[9px] text-[12px] font-medium text-critical">
            {errorMsg}
          </p>
        )}

        <div className="mt-[13px] rounded-[9px] border border-line bg-[rgba(247,250,252,0.6)] px-[11px] py-[9px] text-[11px] leading-[1.5] text-subtle">
          The PDF is stored with the patient record; values are extracted with
          per-marker confidence. Low-confidence extractions go to your review
          queue — nothing is used clinically until you review it.
        </div>
      </div>

      <div className="shrink-0 border-t border-hairline bg-[rgba(247,250,252,0.7)] px-4 py-3">
        <button
          onClick={submit}
          disabled={!file || phase === "working"}
          className="h-9 w-full cursor-pointer rounded-lg border-none bg-action text-[12.5px] font-semibold text-white hover:bg-action-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          {phase === "working" ? "Uploading & extracting…" : "Upload & extract"}
        </button>
      </div>
    </div>
  );
}

/** DEMO upload: unchanged behavior — no file leaves the browser. */
function DemoUploadBody({ patientName, onClose }: { patientName: string; onClose: () => void }) {
  const { announce } = useFeedback();
  const [lab, setLab] = useState("Quest Diagnostics");
  const steps = ["Upload received", "OCR / extraction", "Marker matching", "Confidence scoring", "Practitioner review queue"];

  const queue = () =>
    void api.labs
      .queueUploadDemo({ source: "manual upload", lab, patientName })
      .then((r) => {
        announce(r.message);
        onClose();
      });

  return (
    <>
      <div className="flex-1 overflow-y-auto px-4 py-[13px]">
        <div className="flex flex-col items-center gap-[7px] rounded-[12px] border border-dashed border-line-btn bg-[rgba(247,250,252,0.6)] px-4 py-[26px] text-center">
          <Upload size={22} strokeWidth={1.5} className="text-muted" aria-hidden />
          <span className="text-[12.5px] font-semibold text-body">Drop a lab report or browse</span>
          <span className="text-[11px] text-faint">PDF · Image · HL7 / FHIR · CSV</span>
        </div>

        <div className="mt-[13px]">
          <label htmlFor="lab-select" className="mb-[5px] block text-[10px] font-bold tracking-[0.04em] text-faint uppercase">Provider / lab</label>
          <select
            id="lab-select"
            value={lab}
            onChange={(e) => setLab(e.target.value)}
            className="h-9 w-full rounded-lg border border-line bg-card px-[10px] text-[12.5px] text-body outline-none focus-visible:border-action focus-visible:outline-2 focus-visible:outline-action"
          >
            {["Quest Diagnostics", "LabCorp", "OmegaQuant", "Boston Heart", "Other / manual"].map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </div>

        <div className="mt-[13px]">
          <div className="mb-[6px] text-[10px] font-bold tracking-[0.04em] text-faint uppercase">Processing steps</div>
          <ol className="m-0 flex list-none flex-col gap-[6px] p-0">
            {steps.map((s, i) => (
              <li key={s} className="flex items-center gap-[8px] text-[12px] text-body">
                <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-number-tint text-[10px] font-semibold text-muted">{i + 1}</span>
                {s}
              </li>
            ))}
          </ol>
        </div>

        <div className="mt-[13px] flex items-start gap-[7px] rounded-[9px] border border-[rgba(199,126,20,0.28)] bg-warning-tint px-[11px] py-[9px] text-[11px] leading-[1.45] text-warning-deep">
          <TriangleAlert size={13} strokeWidth={2} className="mt-px shrink-0" aria-hidden />
          No file is uploaded in this demo. Queuing records a demo audit event only — no file or PHI is stored.
        </div>
      </div>

      <div className="shrink-0 border-t border-hairline bg-[rgba(247,250,252,0.7)] px-4 py-3">
        <button onClick={queue} className="h-9 w-full cursor-pointer rounded-lg border-none bg-action text-[12.5px] font-semibold text-white hover:bg-action-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
          Queue for review (demo)
        </button>
      </div>
    </>
  );
}

/* --------------------------------------------------------- optimal-range modal */

function OptimalRangeModal({
  marker,
  patientId,
  patientName,
  current,
  onSave,
  onCancel,
}: {
  marker: BiomarkerMarker;
  patientId: string;
  patientName: string;
  current: OptimalRange;
  onSave: (range: OptimalRange) => void;
  onCancel: () => void;
}) {
  const { announce } = useFeedback();
  const [min, setMin] = useState(current.min?.toString() ?? "");
  const [max, setMax] = useState(current.max?.toString() ?? "");
  const [note, setNote] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const save = () => {
    const range: OptimalRange = {
      min: min.trim() === "" ? undefined : Number(min),
      max: max.trim() === "" ? undefined : Number(max),
      unit: marker.unit,
      source: note.trim() || "Practice optimal",
    };
    void api.labs
      .configureOptimalRange(marker.id, range, { patientId, patientName, markerName: marker.name })
      .then((r) => announce(r.message));
    onSave(range);
  };

  const input =
    "h-9 w-full rounded-lg border border-line bg-card px-[10px] text-[12.5px] text-body outline-none focus-visible:border-action focus-visible:outline-2 focus-visible:outline-action";

  return (
    <div onClick={onCancel} className="fixed inset-0 z-[150] flex items-center justify-center bg-[rgba(24,42,61,0.32)] px-4 backdrop-blur-[3px]">
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Configure optimal range for ${marker.name}`}
        className="glass-overlay animate-fade-up w-[440px] max-w-full overflow-hidden rounded-2xl border border-[rgba(255,255,255,0.7)] bg-[rgba(255,255,255,0.97)] shadow-[0_24px_64px_rgba(24,42,61,0.22)]"
      >
        <div className="border-b border-hairline px-5 pt-[15px] pb-3">
          <h2 ref={headingRef} tabIndex={-1} className="m-0 text-[15px] font-bold outline-none">Configure optimal range</h2>
          <div className="text-[12px] text-subtle">{marker.name} · {marker.unit}</div>
        </div>

        <div className="px-5 py-4">
          <div className="mb-3 flex items-center justify-between rounded-[9px] border border-line bg-[rgba(248,250,252,0.6)] px-[11px] py-[9px]">
            <span className="text-[11.5px] text-muted">Laboratory reference range (unchanged)</span>
            <span className="text-[12.5px] font-semibold text-body">{marker.labRangeText}</span>
          </div>

          <div className="mb-3 grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-[5px] block text-[10px] font-bold tracking-[0.04em] text-faint uppercase">Optimal min</span>
              <input value={min} onChange={(e) => setMin(e.target.value)} inputMode="decimal" placeholder="—" className={input} aria-label="Optimal minimum" />
            </label>
            <label className="block">
              <span className="mb-[5px] block text-[10px] font-bold tracking-[0.04em] text-faint uppercase">Optimal max</span>
              <input value={max} onChange={(e) => setMax(e.target.value)} inputMode="decimal" placeholder="—" className={input} aria-label="Optimal maximum" />
            </label>
          </div>

          <label className="block">
            <span className="mb-[5px] block text-[10px] font-bold tracking-[0.04em] text-faint uppercase">Reason / source</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="e.g. practice guideline, cited reference…" className={cn(input, "h-auto resize-none py-[7px]")} />
          </label>

          <p className="mt-[9px] mb-0 text-[10.5px] leading-[1.45] text-faint">
            Requires practitioner or admin role. This sets the practice optimal window only — it
            does not change the laboratory reference interval. Saving records a demo audit event.
          </p>
        </div>

        <div className="flex justify-end gap-2 border-t border-hairline bg-[rgba(247,250,252,0.6)] px-5 py-3">
          <button onClick={onCancel} className="h-8 cursor-pointer rounded-lg border border-line bg-card px-3 text-[12.5px] font-semibold text-body hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action">
            Cancel
          </button>
          <button onClick={save} className="h-8 cursor-pointer rounded-lg border-none bg-action px-3 text-[12.5px] font-semibold text-white hover:bg-action-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
            Save optimal range
          </button>
        </div>
      </div>
    </div>
  );
}
