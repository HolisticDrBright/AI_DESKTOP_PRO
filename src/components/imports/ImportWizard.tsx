"use client";

import { useState } from "react";
import {
  ArrowRight,
  Check,
  CircleAlert,
  Database,
  FileUp,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { api } from "@/adapters";
import {
  IMPORT_SOURCES,
  type ImportPlan,
  type ImportRecordPreview,
  type ImportSourceId,
} from "@/adapters/imports.mock";
import { Card } from "@/components/ui/bits";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/cn";
import { useFeedback } from "@/lib/feedback";

const STEPS = ["Source", "Detect", "Map fields", "Conflicts", "Preview", "Done"] as const;

const RESOLUTION_LABEL: Record<ImportRecordPreview["resolution"], string> = {
  create: "Create new",
  merge: "Merge into existing",
  skip: "Skip",
};

export function ImportWizard() {
  const { announce } = useFeedback();
  const [step, setStep] = useState(0);
  const [sourceId, setSourceId] = useState<ImportSourceId | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [records, setRecords] = useState<ImportRecordPreview[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);

  const detect = async (id: ImportSourceId) => {
    setLoading(true);
    const p = await api.imports.plan(id);
    setPlan(p);
    setRecords(p.records);
    setLoading(false);
    setStep(1);
  };

  const setResolution = (id: string, resolution: ImportRecordPreview["resolution"]) => {
    setRecords((rs) => rs.map((r) => (r.sourceRecordId === id ? { ...r, resolution } : r)));
  };

  const queued = records.filter((r) => r.resolution !== "skip");
  const skipped = records.filter((r) => r.resolution === "skip");

  const commit = () => {
    setConfirming(false);
    announce(
      `${queued.length} record(s) queued for practitioner review from ${plan?.source.name}. (demo — nothing inserted)`,
    );
    setStep(5);
  };

  return (
    <section
      data-screen-label="Imports & Migration"
      className="relative mx-auto max-w-[920px] px-6 pt-[24px] pb-10"
    >
      <div className="mb-1 text-[11.5px] font-semibold text-faint">Operations / Imports</div>
      <h1 className="m-0 text-[22px] font-bold tracking-[-0.015em]">Import &amp; migration</h1>
      <p className="mt-[6px] mb-5 max-w-[640px] text-[13px] leading-[1.5] text-subtle">
        Bring records in from another system. Every record keeps its origin id and is queued
        for practitioner review — the importer never inserts directly or overwrites silently.
      </p>

      <Stepper step={step} />

      {step === 0 && (
        <SourceStep
          selected={sourceId}
          onSelect={setSourceId}
          loading={loading}
          onContinue={() => sourceId && detect(sourceId)}
        />
      )}
      {step === 1 && plan && <DetectStep plan={plan} onContinue={() => setStep(2)} />}
      {step === 2 && plan && <MapStep plan={plan} onContinue={() => setStep(3)} />}
      {step === 3 && (
        <ConflictStep
          records={records}
          onResolve={setResolution}
          onContinue={() => setStep(4)}
        />
      )}
      {step === 4 && plan && (
        <PreviewStep
          plan={plan}
          records={records}
          queuedCount={queued.length}
          skippedCount={skipped.length}
          onCommit={() => setConfirming(true)}
        />
      )}
      {step === 5 && plan && (
        <SummaryStep
          plan={plan}
          queued={queued}
          skippedCount={skipped.length}
          onRestart={() => {
            setStep(0);
            setSourceId(null);
            setPlan(null);
            setRecords([]);
          }}
        />
      )}

      {confirming && (
        <ConfirmDialog
          open
          title="Queue these records for review?"
          body={`${queued.length} record(s) will be added to the review queue with their source ids preserved. Nothing is written to a patient chart until a practitioner approves each one.`}
          confirmLabel="Queue for review"
          onCancel={() => setConfirming(false)}
          onConfirm={commit}
        />
      )}
    </section>
  );
}

function Stepper({ step }: { step: number }) {
  return (
    <ol className="mb-5 flex list-none flex-wrap items-center gap-2 p-0">
      {STEPS.map((label, i) => {
        const done = i < step;
        const active = i === step;
        return (
          <li key={label} className="flex items-center gap-2">
            <span
              className={cn(
                "flex items-center gap-[6px] rounded-full border px-[10px] py-[4px] text-[11.5px] font-semibold",
                active
                  ? "border-action bg-action-tint text-action-deep"
                  : done
                    ? "border-transparent bg-positive-tint text-positive"
                    : "border-line bg-card text-faint",
              )}
            >
              <span
                className={cn(
                  "flex h-[16px] w-[16px] items-center justify-center rounded-full text-[9.5px]",
                  active ? "bg-action text-white" : done ? "bg-positive text-white" : "bg-sunken-2 text-muted",
                )}
              >
                {done ? <Check size={10} strokeWidth={3} aria-hidden /> : i + 1}
              </span>
              {label}
            </span>
            {i < STEPS.length - 1 && (
              <ArrowRight size={12} strokeWidth={2} className="text-ghost" aria-hidden />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function PrimaryButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex h-9 cursor-pointer items-center gap-[6px] rounded-lg border-none bg-action px-[16px] text-[12.5px] font-semibold text-white hover:bg-action-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function SourceStep({
  selected,
  onSelect,
  onContinue,
  loading,
}: {
  selected: ImportSourceId | null;
  onSelect: (id: ImportSourceId) => void;
  onContinue: () => void;
  loading: boolean;
}) {
  return (
    <div>
      <div className="grid grid-cols-2 gap-3">
        {IMPORT_SOURCES.map((s) => {
          const active = s.id === selected;
          return (
            <button
              key={s.id}
              onClick={() => onSelect(s.id)}
              aria-pressed={active}
              className={cn(
                "flex items-start gap-3 rounded-[12px] border bg-card p-[14px] text-left focus-visible:outline-2 focus-visible:outline-action",
                active ? "border-action shadow-[0_2px_10px_rgba(37,99,199,0.12)]" : "border-line hover:border-line-hover",
              )}
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-action-tint">
                <Database size={16} strokeWidth={1.75} className="text-action" aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="block text-[13.5px] font-bold">{s.name}</span>
                <span className="block text-[11.5px] text-subtle">{s.kind}</span>
                <span className="mt-[3px] block text-[11px] text-faint">{s.note}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-4 flex items-center gap-3 rounded-[12px] border border-dashed border-line-btn bg-[rgba(247,250,252,0.6)] px-4 py-[14px]">
        <FileUp size={18} strokeWidth={1.75} className="text-muted" aria-hidden />
        <span className="flex-1 text-[12px] text-subtle">
          {selected
            ? "File selection is simulated in this demo — continue to detect the format."
            : "Select a source above, then upload its export."}
        </span>
        <PrimaryButton onClick={onContinue} disabled={!selected || loading}>
          {loading ? "Detecting…" : "Upload & detect"}
          {!loading && <ArrowRight size={14} strokeWidth={2} aria-hidden />}
        </PrimaryButton>
      </div>
    </div>
  );
}

function DetectStep({ plan, onContinue }: { plan: ImportPlan; onContinue: () => void }) {
  return (
    <Card className="p-[18px]">
      <h2 className="m-0 mb-[6px] text-[14px] font-bold">Detected format</h2>
      <p className="m-0 mb-4 text-[12.5px] text-subtle">{plan.detectedFormat}</p>
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Records found" value={String(plan.recordCount)} tone="action" />
        <Stat
          label="Potential conflicts"
          value={String(plan.conflictCount)}
          tone={plan.conflictCount ? "warning" : "positive"}
        />
        <Stat label="Field mappings" value={String(plan.mappings.length)} tone="slate" />
      </div>
      <div className="mt-4 flex justify-end">
        <PrimaryButton onClick={onContinue}>
          Continue to mapping
          <ArrowRight size={14} strokeWidth={2} aria-hidden />
        </PrimaryButton>
      </div>
    </Card>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: string }) {
  const color =
    tone === "warning" ? "text-warning-deep" : tone === "positive" ? "text-positive" : tone === "slate" ? "text-muted" : "text-action";
  return (
    <div className="rounded-[10px] border border-line bg-[rgba(247,250,252,0.5)] px-[14px] py-3">
      <div className="text-[11px] font-semibold text-faint">{label}</div>
      <div className={cn("text-[22px] font-bold", color)}>{value}</div>
    </div>
  );
}

function MapStep({ plan, onContinue }: { plan: ImportPlan; onContinue: () => void }) {
  const needsReview = plan.mappings.filter((m) => !m.confident).length;
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-hairline px-[18px] py-[13px]">
        <h2 className="m-0 text-[14px] font-bold">Map fields</h2>
        {needsReview > 0 && (
          <span className="flex items-center gap-[5px] rounded-full bg-warning-tint px-[9px] py-[3px] text-[11px] font-semibold text-warning-deep">
            <TriangleAlert size={11} strokeWidth={2} aria-hidden />
            {needsReview} to confirm
          </span>
        )}
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_28px_minmax(0,1fr)_120px] items-center gap-2 border-b border-hairline bg-[rgba(247,250,252,0.6)] px-[18px] py-[9px] text-[10.5px] font-bold tracking-[0.03em] text-faint uppercase">
        <span>Source field</span>
        <span />
        <span>Target field</span>
        <span>Status</span>
      </div>
      {plan.mappings.map((m) => (
        <div
          key={m.source}
          className="grid grid-cols-[minmax(0,1fr)_28px_minmax(0,1fr)_120px] items-center gap-2 border-b border-[#F3F7FA] px-[18px] py-[10px]"
        >
          <span className="text-[12.5px] font-semibold text-body">
            {m.source}
            {m.required && <span className="ml-1 text-critical">*</span>}
          </span>
          <ArrowRight size={13} strokeWidth={2} className="text-ghost" aria-hidden />
          <span className="font-mono text-[12px] text-muted">{m.target}</span>
          {m.confident ? (
            <span className="w-fit rounded-full bg-positive-tint px-[8px] py-[2px] text-[10.5px] font-semibold text-positive">
              Auto-mapped
            </span>
          ) : (
            <span className="w-fit rounded-full bg-warning-tint px-[8px] py-[2px] text-[10.5px] font-semibold text-warning-deep">
              Confirm
            </span>
          )}
        </div>
      ))}
      <div className="flex items-center justify-between px-[18px] py-[13px]">
        <span className="text-[11px] text-faint">* required field</span>
        <PrimaryButton onClick={onContinue}>
          Continue to conflicts
          <ArrowRight size={14} strokeWidth={2} aria-hidden />
        </PrimaryButton>
      </div>
    </Card>
  );
}

function ConflictStep({
  records,
  onResolve,
  onContinue,
}: {
  records: ImportRecordPreview[];
  onResolve: (id: string, r: ImportRecordPreview["resolution"]) => void;
  onContinue: () => void;
}) {
  const conflicts = records.filter((r) => r.conflict);
  return (
    <Card className="p-[18px]">
      <h2 className="m-0 mb-1 text-[14px] font-bold">Review conflicts</h2>
      <p className="m-0 mb-4 text-[12.5px] text-subtle">
        {conflicts.length === 0
          ? "No conflicts detected. You can still choose how each record is handled in the preview."
          : "Each conflicting record must be resolved before anything is queued."}
      </p>
      <div className="flex flex-col gap-[10px]">
        {conflicts.map((r) => (
          <div
            key={r.sourceRecordId}
            className="flex flex-wrap items-center gap-3 rounded-[11px] border border-line bg-[rgba(247,250,252,0.5)] px-[14px] py-[11px]"
          >
            <CircleAlert size={16} strokeWidth={2} className="shrink-0 text-warning" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold">{r.name}</div>
              <div className="text-[11.5px] text-subtle">
                {r.conflict} · source id {r.sourceRecordId}
              </div>
            </div>
            <ResolutionPicker
              value={r.resolution}
              onChange={(v) => onResolve(r.sourceRecordId, v)}
            />
          </div>
        ))}
      </div>
      <div className="mt-4 flex justify-end">
        <PrimaryButton onClick={onContinue}>
          Continue to preview
          <ArrowRight size={14} strokeWidth={2} aria-hidden />
        </PrimaryButton>
      </div>
    </Card>
  );
}

function ResolutionPicker({
  value,
  onChange,
}: {
  value: ImportRecordPreview["resolution"];
  onChange: (v: ImportRecordPreview["resolution"]) => void;
}) {
  const opts: ImportRecordPreview["resolution"][] = ["create", "merge", "skip"];
  return (
    <div className="flex gap-1" role="group" aria-label="Conflict resolution">
      {opts.map((o) => (
        <button
          key={o}
          onClick={() => onChange(o)}
          aria-pressed={value === o}
          className={cn(
            "rounded-[7px] border px-[9px] py-[5px] text-[11px] font-semibold capitalize focus-visible:outline-2 focus-visible:outline-action",
            value === o
              ? "border-action bg-action-tint text-action-deep"
              : "border-line bg-card text-body-2 hover:border-line-hover",
          )}
        >
          {RESOLUTION_LABEL[o]}
        </button>
      ))}
    </div>
  );
}

function PreviewStep({
  plan,
  records,
  queuedCount,
  skippedCount,
  onCommit,
}: {
  plan: ImportPlan;
  records: ImportRecordPreview[];
  queuedCount: number;
  skippedCount: number;
  onCommit: () => void;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-hairline px-[18px] py-[13px]">
        <h2 className="m-0 text-[14px] font-bold">Preview — {plan.source.name}</h2>
        <span className="text-[11.5px] text-muted">
          {queuedCount} to queue · {skippedCount} skipped
        </span>
      </div>

      <div className="flex items-start gap-[9px] border-b border-hairline bg-warning-tint px-[18px] py-[11px]">
        <ShieldCheck size={15} strokeWidth={2} className="mt-px shrink-0 text-warning-deep" aria-hidden />
        <span className="text-[12px] leading-[1.45] text-warning-deep">
          Nothing is written to a patient chart here. Queued records enter the review queue
          with their source id preserved; a practitioner approves each before it lands.
        </span>
      </div>

      {records.map((r) => (
        <div
          key={r.sourceRecordId}
          className="grid grid-cols-[minmax(0,1fr)_150px_130px] items-center gap-3 border-b border-[#F3F7FA] px-[18px] py-[10px]"
        >
          <span className="min-w-0">
            <span className="block text-[12.5px] font-semibold text-ink">{r.name}</span>
            <span className="block text-[11px] text-faint">
              {r.summary} · source id {r.sourceRecordId}
            </span>
          </span>
          <span className="font-mono text-[11px] text-muted">source_record_id</span>
          <span
            className={cn(
              "w-fit rounded-full px-[9px] py-[2px] text-[10.5px] font-semibold",
              r.resolution === "skip"
                ? "bg-slate-tint text-slate-badge"
                : r.resolution === "merge"
                  ? "bg-action-tint text-action-deep"
                  : "bg-positive-tint text-positive",
            )}
          >
            {RESOLUTION_LABEL[r.resolution]}
          </span>
        </div>
      ))}

      <div className="flex items-center justify-between px-[18px] py-[13px]">
        <span className="text-[11px] text-faint">
          Committing queues {queuedCount} record(s) for review.
        </span>
        <PrimaryButton onClick={onCommit} disabled={queuedCount === 0}>
          Queue {queuedCount} for review
        </PrimaryButton>
      </div>
    </Card>
  );
}

function SummaryStep({
  plan,
  queued,
  skippedCount,
  onRestart,
}: {
  plan: ImportPlan;
  queued: ImportRecordPreview[];
  skippedCount: number;
  onRestart: () => void;
}) {
  const created = queued.filter((r) => r.resolution === "create").length;
  const merged = queued.filter((r) => r.resolution === "merge").length;
  return (
    <Card className="p-[18px]">
      <div className="mb-3 flex items-center gap-[9px]">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-positive-tint">
          <Check size={18} strokeWidth={2.5} className="text-positive" aria-hidden />
        </span>
        <div>
          <h2 className="m-0 text-[15px] font-bold">Queued for review</h2>
          <p className="m-0 text-[12px] text-subtle">Audit summary · {plan.source.name}</p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Stat label="New patients" value={String(created)} tone="positive" />
        <Stat label="Merges" value={String(merged)} tone="action" />
        <Stat label="Skipped" value={String(skippedCount)} tone="slate" />
      </div>

      <ul className="mt-4 flex list-none flex-col gap-2 p-0">
        <AuditLine>Each queued record kept its <code className="font-mono">source_record_id</code> from {plan.source.name}.</AuditLine>
        <AuditLine>No record was written to a patient chart; all entered the review queue.</AuditLine>
        <AuditLine>A practitioner must approve each record before it becomes part of the chart.</AuditLine>
        <AuditLine>This action would be written to the audit log with actor and timestamp.</AuditLine>
      </ul>

      <div className="mt-4 flex justify-end">
        <button
          onClick={onRestart}
          className="h-9 cursor-pointer rounded-lg border border-line bg-card px-[16px] text-[12.5px] font-semibold text-body hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action"
        >
          Start another import
        </button>
      </div>
    </Card>
  );
}

function AuditLine({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-[12px] leading-[1.5] text-body">
      <Check size={13} strokeWidth={2.5} className="mt-[2px] shrink-0 text-positive" aria-hidden />
      <span>{children}</span>
    </li>
  );
}
