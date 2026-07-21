"use client";

import { Check } from "lucide-react";
import type {
  CheckboxGroupField,
  PointListField,
  PointListValue,
  SliderField,
  SubjectiveTagsField,
  TextareaField,
  TextField,
} from "@/adapters/charting.mock";
import { cn } from "@/lib/cn";

/* ---- shared bits ------------------------------------------------------- */

export function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 text-[11px] font-bold tracking-[0.04em] text-muted uppercase">
      {children}
    </div>
  );
}

function CheckBox({ checked, onToggle, label }: { checked: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={onToggle}
      className="flex items-center gap-[9px] py-[3px] text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action"
    >
      <span
        className={cn(
          "flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-[5px] border transition-colors",
          checked ? "border-action bg-action text-white" : "border-line-hover bg-card",
        )}
      >
        {checked && <Check size={12} strokeWidth={3} aria-hidden />}
      </span>
      <span className={cn("text-[12.5px] leading-tight", checked ? "font-semibold text-ink" : "text-body")}>
        {label}
      </span>
    </button>
  );
}

/* ---- subjective tags (inline quick-select strip) ----------------------- */

export function SubjectiveTagsInput({
  field,
  value,
  onChange,
  readOnly,
}: {
  field: SubjectiveTagsField;
  value: string[];
  onChange: (next: string[]) => void;
  readOnly?: boolean;
}) {
  const toggle = (opt: string) =>
    onChange(value.includes(opt) ? value.filter((v) => v !== opt) : [...value, opt]);
  return (
    <div className="flex flex-wrap gap-[7px]">
      {field.options.map((opt) => {
        const on = value.includes(opt);
        return (
          <button
            key={opt}
            type="button"
            aria-pressed={on}
            disabled={readOnly}
            onClick={() => toggle(opt)}
            className={cn(
              "rounded-full border px-[11px] py-[5px] text-[12px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-action disabled:cursor-default",
              on
                ? "border-action bg-action-tint text-action-deep"
                : "border-line-btn bg-card text-muted hover:border-line-hover hover:text-ink",
            )}
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}

/* ---- checkbox group (columned symptom grid) ---------------------------- */

export function CheckboxGroupInput({
  field,
  value,
  onChange,
  readOnly,
}: {
  field: CheckboxGroupField;
  value: string[];
  onChange: (next: string[]) => void;
  readOnly?: boolean;
}) {
  const cols = field.columns ?? 3;
  const toggle = (opt: string) => {
    if (readOnly) return;
    onChange(value.includes(opt) ? value.filter((v) => v !== opt) : [...value, opt]);
  };
  return (
    <div>
      {field.label && <FieldLabel>{field.label}</FieldLabel>}
      <div
        className="grid gap-x-5 gap-y-px"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))` }}
      >
        {field.options.map((opt) => (
          <CheckBox key={opt} label={opt} checked={value.includes(opt)} onToggle={() => toggle(opt)} />
        ))}
      </div>
    </div>
  );
}

/* ---- 0..10 slider ------------------------------------------------------ */

export function SliderInput({
  field,
  value,
  onChange,
  readOnly,
}: {
  field: SliderField;
  value: number | undefined;
  onChange: (next: number) => void;
  readOnly?: boolean;
}) {
  const set = value ?? Math.round((field.min + field.max) / 2);
  const touched = value !== undefined;
  const ticks = Array.from({ length: field.max - field.min + 1 }, (_, i) => field.min + i);
  return (
    <div>
      {field.label && (
        <div className="mb-[6px] flex items-baseline justify-between">
          <FieldLabel>{field.label}</FieldLabel>
          <span className={cn("text-[13px] font-bold tabular-nums", touched ? "text-action" : "text-ghost")}>
            {touched ? set : "—"}
            <span className="text-[11px] font-medium text-faint">/{field.max}</span>
          </span>
        </div>
      )}
      <input
        type="range"
        min={field.min}
        max={field.max}
        step={1}
        value={set}
        disabled={readOnly}
        aria-label={field.label}
        onChange={(e) => onChange(Number(e.target.value))}
        className="aidp-slider block w-full"
        style={{ ["--pct" as string]: `${((set - field.min) / (field.max - field.min)) * 100}%` }}
      />
      <div className="mt-[3px] flex justify-between px-[2px]">
        {ticks.map((t) => (
          <span key={t} className="text-[10px] tabular-nums text-faint">
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ---- text + textarea --------------------------------------------------- */

export function TextInput({
  field,
  value,
  onChange,
  readOnly,
}: {
  field: TextField;
  value: string;
  onChange: (next: string) => void;
  readOnly?: boolean;
}) {
  return (
    <div>
      {field.label && <FieldLabel>{field.label}</FieldLabel>}
      <input
        type="text"
        value={value}
        readOnly={readOnly}
        placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full rounded-[9px] border border-line bg-card px-3 text-[13px] text-ink placeholder:text-ghost focus-visible:border-action focus-visible:outline-none read-only:bg-sunken"
      />
    </div>
  );
}

export function TextareaInput({
  field,
  value,
  onChange,
  readOnly,
  highlight,
}: {
  field: TextareaField;
  value: string;
  onChange: (next: string) => void;
  readOnly?: boolean;
  /** Briefly ring the box when the scribe writes into it. */
  highlight?: boolean;
}) {
  return (
    <div>
      {field.label && <FieldLabel>{field.label}</FieldLabel>}
      <textarea
        value={value}
        readOnly={readOnly}
        placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value)}
        rows={4}
        className={cn(
          "w-full resize-y rounded-[10px] border bg-card px-3 py-[10px] text-[13px] leading-relaxed text-ink placeholder:text-ghost focus-visible:border-action focus-visible:outline-none read-only:bg-sunken",
          highlight ? "border-ai ring-2 ring-ai/30" : "border-line",
        )}
      />
    </div>
  );
}

/* ---- point / modality list (checkbox + free text) --------------------- */

export function PointListInput({
  field,
  value,
  onChange,
  readOnly,
}: {
  field: PointListField;
  value: PointListValue;
  onChange: (next: PointListValue) => void;
  readOnly?: boolean;
}) {
  const rowFor = (row: string) => value[row] ?? { checked: false, text: "" };
  const patch = (row: string, next: Partial<{ checked: boolean; text: string }>) => {
    if (readOnly) return;
    onChange({ ...value, [row]: { ...rowFor(row), ...next } });
  };
  return (
    <div>
      {field.label && <FieldLabel>{field.label}</FieldLabel>}
      <div className="flex flex-col gap-[6px]">
        {field.rows.map((row) => {
          const r = rowFor(row);
          return (
            <div key={row} className="flex items-center gap-[10px]">
              <button
                type="button"
                role="checkbox"
                aria-checked={r.checked}
                onClick={() => patch(row, { checked: !r.checked })}
                className="flex shrink-0 items-center gap-[7px] focus-visible:outline-2 focus-visible:outline-action"
              >
                <span
                  className={cn(
                    "flex h-[17px] w-[17px] items-center justify-center rounded-[5px] border",
                    r.checked ? "border-action bg-action text-white" : "border-line-hover bg-card",
                  )}
                >
                  {r.checked && <Check size={12} strokeWidth={3} aria-hidden />}
                </span>
                <span
                  className={cn(
                    "w-[92px] text-[12.5px] font-semibold",
                    r.checked ? "text-ink" : "text-muted",
                  )}
                >
                  {row}
                </span>
              </button>
              <input
                type="text"
                value={r.text}
                readOnly={readOnly}
                onChange={(e) => patch(row, { text: e.target.value })}
                placeholder="Points, method, notes…"
                className="h-8 min-w-0 flex-1 rounded-[8px] border border-line bg-card px-[10px] text-[12.5px] text-ink placeholder:text-ghost focus-visible:border-action focus-visible:outline-none read-only:bg-sunken"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
