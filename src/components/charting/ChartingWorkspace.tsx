"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, FilePlus2, Lock, Sparkles, Star, Unlock } from "lucide-react";
import {
  getChartTemplate,
  soapTargets,
  type BodyChartValue,
  type ChartEntry,
  type ChartField,
  type ChartValues,
  type PointListValue,
} from "@/adapters/charting.mock";
import {
  draftFromTemplate,
  listChartEntries,
  patchChartValues,
  reopenChartEntry,
  signChartEntry,
  upsertChartEntry,
  useChartEntries,
} from "@/adapters/charting-store";
import { Card } from "@/components/ui/bits";
import { cn } from "@/lib/cn";
import {
  CheckboxGroupInput,
  PointListInput,
  SliderInput,
  SubjectiveTagsInput,
  TextInput,
  TextareaInput,
} from "./ChartFields";
import { BodyChartInput } from "./BodyChartField";
import { AiScribePanel, type StructuredNote } from "./AiScribePanel";

function formatDate(iso: string): string {
  try {
    return new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

export function ChartingWorkspace({
  patientId,
  patientName,
  author,
}: {
  patientId: string;
  patientName: string;
  author: string;
}) {
  const template = useMemo(() => getChartTemplate(), []);
  const targets = useMemo(() => soapTargets(template), [template]);
  const entries = useChartEntries(patientId);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [values, setValues] = useState<ChartValues>({});
  const [scribeOpen, setScribeOpen] = useState(false);
  const [highlighted, setHighlighted] = useState<Set<string>>(new Set());
  const loadedFor = useRef<string | null>(null);
  const seeded = useRef(false);

  // Ensure exactly one active entry (resume the latest, else seed a draft).
  // Read the live store — not the `entries` prop — because during hydration the
  // subscription first yields an empty snapshot even when sessionStorage holds
  // a note; seeding off that would create a spurious duplicate draft on reload.
  // `seeded` also guards against a StrictMode double-invoke.
  useEffect(() => {
    const live = listChartEntries(patientId);
    if (activeId && live.some((e) => e.id === activeId)) return;
    if (live.length) {
      setActiveId(live[0].id);
      return;
    }
    if (seeded.current) return;
    seeded.current = true;
    const draft = draftFromTemplate(template, patientId, author);
    upsertChartEntry(draft);
    setActiveId(draft.id);
  }, [entries, activeId, patientId, author, template]);

  const entry: ChartEntry | null = entries.find((e) => e.id === activeId) ?? null;
  const readOnly = entry?.status === "signed";

  // Load an entry's values into local state when the active entry changes.
  useEffect(() => {
    if (entry && loadedFor.current !== entry.id) {
      setValues(entry.values ?? {});
      loadedFor.current = entry.id;
    }
  }, [entry]);

  if (!entry) return null;

  const setValue = (fieldId: string, v: ChartValues[string]) => {
    setValues((prev) => {
      const next = { ...prev, [fieldId]: v };
      patchChartValues(patientId, entry.id, next);
      return next;
    });
  };

  const appendText = (fieldId: string | undefined, text: string) => {
    if (!fieldId) return;
    const existing = typeof values[fieldId] === "string" ? (values[fieldId] as string) : "";
    setValue(fieldId, existing ? `${existing}\n\n${text}` : text);
  };

  const flash = (ids: string[]) => {
    setHighlighted(new Set(ids));
    setTimeout(() => setHighlighted(new Set()), 2600);
  };

  const applyStructured = (note: StructuredNote) => {
    const written: string[] = [];
    (Object.keys(note) as (keyof StructuredNote)[]).forEach((slot) => {
      const fieldId = targets[slot];
      const text = note[slot].trim();
      if (fieldId && text) {
        appendText(fieldId, text);
        written.push(fieldId);
      }
    });
    if (written.length) flash(written);
    setScribeOpen(false);
  };

  const saveTranscript = (text: string) => {
    upsertChartEntry({ ...entry, transcript: text });
  };

  const newEntry = () => {
    const draft = draftFromTemplate(template, patientId, author);
    upsertChartEntry(draft);
    setActiveId(draft.id);
  };

  const canStructure = Boolean(
    targets.subjective || targets.objective || targets.assessment || targets.plan,
  );

  return (
    <div className="relative pt-1 pb-10">
      {/* toolbar */}
      <Card className="mb-3 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Star size={16} className="text-warning" fill="currentColor" aria-hidden />
            <div>
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  value={entry.date}
                  disabled={readOnly}
                  onChange={(e) => upsertChartEntry({ ...entry, date: e.target.value })}
                  aria-label="Visit date"
                  className="rounded-[7px] border border-line bg-card px-2 py-[3px] text-[13px] font-semibold text-ink focus-visible:border-action focus-visible:outline-none disabled:bg-sunken"
                />
                <span className="text-[13px] font-semibold text-muted">— {template.name}</span>
                <StatusPill status={entry.status} />
              </div>
              <p className="mt-[3px] text-[11px] text-subtle">
                {patientName} · {author}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setScribeOpen(true)}
              className="flex h-9 items-center gap-2 rounded-[10px] bg-ai px-[14px] text-[13px] font-semibold text-white hover:bg-ai-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ai"
            >
              <Sparkles size={15} aria-hidden />
              AI Scribe
            </button>
            {entry.status === "draft" ? (
              <button
                type="button"
                onClick={() => signChartEntry(patientId, entry.id)}
                className="flex h-9 items-center gap-2 rounded-[10px] border border-line-btn bg-card px-[14px] text-[13px] font-semibold text-action hover:bg-sunken"
              >
                <Lock size={14} aria-hidden />
                Sign note
              </button>
            ) : (
              <button
                type="button"
                onClick={() => reopenChartEntry(patientId, entry.id)}
                className="flex h-9 items-center gap-2 rounded-[10px] border border-line-btn bg-card px-[14px] text-[13px] font-semibold text-muted hover:bg-sunken"
              >
                <Unlock size={14} aria-hidden />
                Reopen
              </button>
            )}
          </div>
        </div>

        {/* entry switcher */}
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
          {entries.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => setActiveId(e.id)}
              className={cn(
                "flex items-center gap-[6px] rounded-full border px-[11px] py-[5px] text-[12px] font-semibold",
                e.id === activeId
                  ? "border-action bg-action-tint text-action-deep"
                  : "border-line-btn bg-card text-muted hover:text-ink",
              )}
            >
              {e.status === "signed" && <CheckCircle2 size={13} className="text-positive" aria-hidden />}
              {formatDate(e.date)}
            </button>
          ))}
          <button
            type="button"
            onClick={newEntry}
            className="flex items-center gap-[6px] rounded-full border border-dashed border-line-hover px-[11px] py-[5px] text-[12px] font-semibold text-action hover:bg-sunken"
          >
            <FilePlus2 size={13} aria-hidden />
            New entry
          </button>
        </div>
      </Card>

      {readOnly && (
        <div className="mb-3 flex items-center gap-2 rounded-[10px] border border-positive/40 bg-positive-tint px-3 py-2 text-[12px] font-semibold text-positive">
          <CheckCircle2 size={15} aria-hidden />
          Signed note — read only. Reopen to make changes.
        </div>
      )}

      {/* sections */}
      <div className="flex flex-col gap-3">
        {template.sections.map((section) => (
          <Card key={section.id} className="px-4 py-4">
            {section.title && (
              <h3 className="mb-3 text-[14px] font-bold text-ink">{section.title}</h3>
            )}
            <div className="flex flex-col gap-5">
              {section.fields.map((field) => (
                <FieldRenderer
                  key={field.id}
                  field={field}
                  value={values[field.id]}
                  onChange={(v) => setValue(field.id, v)}
                  readOnly={readOnly}
                  highlight={highlighted.has(field.id)}
                />
              ))}
            </div>
          </Card>
        ))}
      </div>

      <AiScribePanel
        open={scribeOpen}
        onClose={() => setScribeOpen(false)}
        onAppendToSubjective={(text) => {
          appendText(targets.subjective, text);
          if (targets.subjective) flash([targets.subjective]);
          setScribeOpen(false);
        }}
        onApplyStructured={applyStructured}
        onSaveTranscript={saveTranscript}
        canStructure={canStructure}
      />
    </div>
  );
}

function StatusPill({ status }: { status: ChartEntry["status"] }) {
  const signed = status === "signed";
  return (
    <span
      className={cn(
        "rounded-full px-[9px] py-[2px] text-[10.5px] font-bold tracking-wide uppercase",
        signed ? "bg-positive-tint text-positive" : "bg-warning-tint text-warning-deep",
      )}
    >
      {signed ? "Signed" : "Draft"}
    </span>
  );
}

function FieldRenderer({
  field,
  value,
  onChange,
  readOnly,
  highlight,
}: {
  field: ChartField;
  value: ChartValues[string];
  onChange: (v: ChartValues[string]) => void;
  readOnly?: boolean;
  highlight?: boolean;
}) {
  switch (field.type) {
    case "subjective-tags":
      return (
        <SubjectiveTagsInput
          field={field}
          value={Array.isArray(value) ? (value as string[]) : []}
          onChange={onChange}
          readOnly={readOnly}
        />
      );
    case "checkbox-group":
      return (
        <CheckboxGroupInput
          field={field}
          value={Array.isArray(value) ? (value as string[]) : []}
          onChange={onChange}
          readOnly={readOnly}
        />
      );
    case "slider":
      return (
        <SliderInput
          field={field}
          value={typeof value === "number" ? value : undefined}
          onChange={onChange}
          readOnly={readOnly}
        />
      );
    case "text":
      return (
        <TextInput
          field={field}
          value={typeof value === "string" ? value : ""}
          onChange={onChange}
          readOnly={readOnly}
        />
      );
    case "textarea":
      return (
        <TextareaInput
          field={field}
          value={typeof value === "string" ? value : ""}
          onChange={onChange}
          readOnly={readOnly}
          highlight={highlight}
        />
      );
    case "point-list":
      return (
        <PointListInput
          field={field}
          value={(value && typeof value === "object" && !Array.isArray(value)
            ? value
            : {}) as PointListValue}
          onChange={onChange}
          readOnly={readOnly}
        />
      );
    case "body-chart":
      return (
        <BodyChartInput
          field={field}
          value={(value && typeof value === "object" && "ops" in (value as object)
            ? value
            : { ops: [] }) as BodyChartValue}
          onChange={onChange}
          readOnly={readOnly}
        />
      );
    default:
      return null;
  }
}
