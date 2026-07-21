"use client";

import { useMemo, useState } from "react";
import {
  CalendarDays,
  Check,
  CircleDot,
  Mic,
  Plus,
  Square,
  Star,
} from "lucide-react";
import {
  getChartEntries,
  getChartTemplate,
  newChartDraft,
  type ChartEntry,
  type ChartValue,
} from "@/adapters/charts.mock";
import { Card } from "@/components/ui/bits";
import { cn } from "@/lib/cn";
import { ChartFieldRenderer } from "./ChartFields";
import { useScribe } from "./useScribe";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDate(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${MONTHS[Number(m) - 1]} ${Number(d)}, ${y}`;
}

function formatElapsed(ms: number) {
  const total = Math.floor(ms / 1000);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${mm}:${ss.toString().padStart(2, "0")}`;
}

export function ChartWorkspace({
  patientId,
  patientName,
}: {
  patientId: string;
  patientName: string;
}) {
  const template = useMemo(() => getChartTemplate(), []);
  const [entries, setEntries] = useState<ChartEntry[]>(() => getChartEntries(patientId));
  const [activeId, setActiveId] = useState<string>(() => getChartEntries(patientId)[0]?.id ?? "");

  const firstScribeField = useMemo(
    () => template.fields.find((f) => f.type === "textarea" && f.scribe)?.id ?? null,
    [template],
  );
  const [scribeFieldId, setScribeFieldId] = useState<string | null>(firstScribeField);

  const active = entries.find((e) => e.id === activeId) ?? entries[0];
  const readOnly = active?.status === "signed";

  const patchActive = (updater: (e: ChartEntry) => ChartEntry) =>
    setEntries((list) => list.map((e) => (e.id === activeId ? updater(e) : e)));

  const setValue = (fieldId: string, value: ChartValue) =>
    patchActive((e) => ({ ...e, values: { ...e.values, [fieldId]: value } }));

  const appendScribeText = (chunk: string) => {
    const target = scribeFieldId ?? firstScribeField;
    if (!target) return;
    patchActive((e) => {
      const prev = (e.values[target] as string | undefined) ?? "";
      const joined = prev ? `${prev.replace(/\s+$/, "")} ${chunk}` : chunk;
      return { ...e, values: { ...e.values, [target]: joined } };
    });
  };

  const scribe = useScribe(appendScribeText);

  const scribeFieldLabel =
    template.fields.find((f) => f.id === (scribeFieldId ?? firstScribeField))?.label ?? "note";

  const startNewNote = () => {
    scribe.stop();
    const today = new Date().toISOString().slice(0, 10);
    const draft = newChartDraft(patientId, today, "Brandon Bright");
    setEntries((list) => [draft, ...list]);
    setActiveId(draft.id);
    setScribeFieldId(firstScribeField);
  };

  const signNote = () => {
    scribe.stop();
    patchActive((e) => ({ ...e, status: "signed" }));
  };

  if (!active) {
    return (
      <Card className="p-6 text-[13px] text-muted">No chart entries for {patientName}.</Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Entry switcher */}
      <div className="flex flex-wrap items-center gap-2">
        {entries.map((e) => {
          const selected = e.id === active.id;
          return (
            <button
              key={e.id}
              type="button"
              onClick={() => setActiveId(e.id)}
              className={cn(
                "flex items-center gap-2 rounded-[9px] border px-3 py-[7px] text-[12px] transition-colors",
                selected
                  ? "border-action bg-action-tint font-semibold text-action-deep"
                  : "border-line-btn bg-card text-muted hover:border-line-hover hover:text-ink",
              )}
            >
              <CalendarDays size={13} />
              {formatDate(e.date)}
              <span
                className={cn(
                  "rounded-full px-[6px] py-px text-[10px] font-semibold",
                  e.status === "signed" ? "bg-positive-tint text-positive" : "bg-warning-tint text-warning-deep",
                )}
              >
                {e.status === "signed" ? "Signed" : "Draft"}
              </span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={startNewNote}
          className="flex items-center gap-1.5 rounded-[9px] border border-dashed border-line-hover bg-card px-3 py-[7px] text-[12px] font-semibold text-action hover:bg-sunken"
        >
          <Plus size={14} /> New note
        </button>
      </div>

      <Card className="overflow-hidden">
        {/* Chart header */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-sunken px-5 py-3">
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              disabled={readOnly}
              onClick={() => patchActive((e) => ({ ...e, starred: !e.starred }))}
              aria-label={active.starred ? "Unstar note" : "Star note"}
              className="text-ghost hover:text-warning disabled:cursor-default"
            >
              <Star size={16} className={cn(active.starred && "fill-warning text-warning")} />
            </button>
            <span className="text-[14px] font-bold text-ink">{formatDate(active.date)}</span>
            <span className="text-[13px] text-muted">— {active.title}</span>
          </div>
          <div className="flex items-center gap-2.5 text-[12px]">
            <span
              className={cn(
                "rounded-[7px] px-2 py-[3px] font-semibold",
                readOnly ? "bg-positive-tint text-positive" : "bg-warning-tint text-warning-deep",
              )}
            >
              {readOnly ? "Signed" : "Draft"}
            </span>
            <span className="text-body">{active.author}</span>
          </div>
        </div>

        {/* AI Scribe bar */}
        <div
          className={cn(
            "flex flex-wrap items-center gap-3 border-b px-5 py-2.5 transition-colors",
            scribe.recording ? "border-ai/40 bg-ai-tint" : "border-line bg-card",
          )}
        >
          <button
            type="button"
            onClick={scribe.toggle}
            disabled={!scribe.supported || readOnly}
            title={
              !scribe.supported
                ? "Speech recognition isn't available in this browser — try Chrome or Edge."
                : readOnly
                  ? "This note is signed and can't be edited."
                  : undefined
            }
            className={cn(
              "flex items-center gap-2 rounded-[9px] px-3 py-[7px] text-[12px] font-semibold transition-colors",
              scribe.recording
                ? "bg-critical text-white hover:bg-critical/90"
                : "bg-ai text-white hover:bg-ai-deep disabled:cursor-not-allowed disabled:bg-ghost",
            )}
          >
            {scribe.recording ? <Square size={13} className="fill-white" /> : <Mic size={14} />}
            {scribe.recording ? "Stop scribe" : "AI Scribe"}
          </button>

          {scribe.recording ? (
            <div className="flex min-w-0 flex-1 items-center gap-2 text-[12px]">
              <span className="flex items-center gap-1.5 font-semibold text-critical">
                <CircleDot size={12} className="animate-pulse" />
                {formatElapsed(scribe.elapsedMs)}
              </span>
              <span className="text-muted">→ {scribeFieldLabel}</span>
              <span className="min-w-0 flex-1 truncate italic text-subtle">
                {scribe.interim || "Listening…"}
              </span>
            </div>
          ) : (
            <span className="text-[12px] text-muted">
              {scribe.supported
                ? `Records the visit and dictates into the ${scribeFieldLabel} section. Focus any Scribe box to retarget.`
                : "Live transcription needs Chrome or Edge. All other charting works here."}
            </span>
          )}
          {scribe.error && <span className="text-[12px] font-medium text-critical">{scribe.error}</span>}
        </div>

        {/* Chart body */}
        <div className="flex flex-col gap-6 px-5 py-5">
          {template.fields.map((field) => (
            <ChartFieldRenderer
              key={field.id}
              field={field}
              value={active.values[field.id]}
              disabled={readOnly}
              scribeTarget={field.id === (scribeFieldId ?? firstScribeField)}
              onScribeFocus={setScribeFieldId}
              onChange={(v) => setValue(field.id, v)}
            />
          ))}
        </div>

        {/* Footer actions */}
        {!readOnly && (
          <div className="flex items-center justify-end gap-2.5 border-t border-line bg-sunken px-5 py-3">
            <span className="mr-auto text-[12px] text-subtle">Autosaves as draft</span>
            <button
              type="button"
              onClick={signNote}
              className="flex items-center gap-1.5 rounded-[9px] bg-action px-4 py-[9px] text-[12px] font-semibold text-white hover:bg-action-deep"
            >
              <Check size={14} /> Sign &amp; lock note
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}
