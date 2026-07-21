"use client";

import { Mic } from "lucide-react";
import type {
  ChartField,
  ChartValue,
  CheckboxTextValue,
  Stroke,
} from "@/adapters/charts.mock";
import { cn } from "@/lib/cn";
import { BodyDiagram } from "./BodyDiagram";

function Check({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <label className={cn("flex items-center gap-[7px] text-[13px]", disabled ? "text-muted" : "cursor-pointer text-body")}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-[15px] w-[15px] shrink-0 accent-action"
      />
      <span>{label}</span>
    </label>
  );
}

function toggle(list: string[], option: string): string[] {
  return list.includes(option) ? list.filter((o) => o !== option) : [...list, option];
}

function Slider({
  field,
  value,
  onChange,
  disabled,
}: {
  field: Extract<ChartField, { type: "slider" }>;
  value: number | undefined;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  const ticks = Array.from({ length: field.max - field.min + 1 }, (_, i) => field.min + i);
  const set = value ?? Math.round((field.min + field.max) / 2);
  return (
    <div>
      <input
        type="range"
        min={field.min}
        max={field.max}
        step={1}
        value={set}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={field.label}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-track accent-action disabled:cursor-default"
      />
      <div className="mt-1 flex justify-between px-[2px] text-[11px] text-subtle">
        {ticks.map((t) => (
          <span key={t} className={cn(t === set && "font-bold text-action")}>
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}

export function ChartFieldRenderer({
  field,
  value,
  onChange,
  disabled,
  scribeTarget,
  onScribeFocus,
}: {
  field: ChartField;
  value: ChartValue | undefined;
  onChange: (v: ChartValue) => void;
  disabled?: boolean;
  scribeTarget?: boolean;
  onScribeFocus?: (fieldId: string) => void;
}) {
  const labelRow = (
    <div className="mb-2 flex items-center gap-2">
      <h3 className="text-[13px] font-bold text-ink">{field.label}</h3>
      {field.type === "textarea" && field.scribe && (
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-[6px] py-px text-[10px] font-semibold",
            scribeTarget ? "bg-ai-tint text-ai-deep" : "text-ghost",
          )}
          title={scribeTarget ? "Scribe will dictate here" : "Focus this box to target the scribe"}
        >
          <Mic size={10} />
          {scribeTarget ? "Scribe target" : "Scribe"}
        </span>
      )}
    </div>
  );

  if (field.type === "checkbox-row") {
    const list = (value as string[] | undefined) ?? [];
    return (
      <section>
        {labelRow}
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {field.options.map((o) => (
            <Check key={o} label={o} disabled={disabled} checked={list.includes(o)} onChange={() => onChange(toggle(list, o))} />
          ))}
        </div>
      </section>
    );
  }

  if (field.type === "checkbox-grid") {
    const list = (value as string[] | undefined) ?? [];
    return (
      <section>
        {labelRow}
        <div
          className={cn(
            "grid gap-x-6 gap-y-[10px]",
            field.columns === 2 ? "sm:grid-cols-2" : "sm:grid-cols-2 lg:grid-cols-3",
          )}
        >
          {field.options.map((o) => (
            <Check key={o} label={o} disabled={disabled} checked={list.includes(o)} onChange={() => onChange(toggle(list, o))} />
          ))}
        </div>
      </section>
    );
  }

  if (field.type === "checkbox-text-list") {
    const map = ((value as CheckboxTextValue | undefined) ?? {}) as CheckboxTextValue;
    const setRow = (opt: string, next: { checked: boolean; text: string }) =>
      onChange({ ...map, [opt]: next });
    return (
      <section>
        {labelRow}
        <div className="flex flex-col gap-[10px]">
          {field.options.map((o) => {
            const row = map[o] ?? { checked: false, text: "" };
            return (
              <div key={o} className="flex items-center gap-3">
                <div className="w-32 shrink-0">
                  <Check label={o} disabled={disabled} checked={row.checked} onChange={(c) => setRow(o, { ...row, checked: c })} />
                </div>
                <input
                  type="text"
                  value={row.text}
                  disabled={disabled}
                  onChange={(e) => setRow(o, { ...row, text: e.target.value })}
                  className="h-8 flex-1 rounded-[8px] border border-line-btn bg-card px-3 text-[13px] text-body placeholder:text-ghost focus:border-action focus:outline-none disabled:bg-sunken"
                  placeholder="Points / notes…"
                />
              </div>
            );
          })}
        </div>
      </section>
    );
  }

  if (field.type === "slider") {
    return (
      <section>
        {labelRow}
        <Slider field={field} value={value as number | undefined} onChange={onChange} disabled={disabled} />
      </section>
    );
  }

  if (field.type === "textarea") {
    return (
      <section>
        {labelRow}
        <textarea
          value={(value as string | undefined) ?? ""}
          disabled={disabled}
          rows={field.rows ?? 4}
          onFocus={() => field.scribe && onScribeFocus?.(field.id)}
          onChange={(e) => onChange(e.target.value)}
          className={cn(
            "w-full resize-y rounded-[10px] border bg-card px-3 py-2 text-[13px] leading-relaxed text-body placeholder:text-ghost focus:outline-none disabled:bg-sunken",
            scribeTarget ? "border-ai focus:border-ai" : "border-line-btn focus:border-action",
          )}
          placeholder="—"
        />
      </section>
    );
  }

  // body-diagram
  return (
    <section>
      {labelRow}
      {field.hint && <p className="-mt-1 mb-2 text-[12px] text-muted">{field.hint}</p>}
      <BodyDiagram
        poses={field.poses}
        disabled={disabled}
        value={(value as Stroke[] | undefined) ?? []}
        onChange={(strokes) => onChange(strokes)}
      />
    </section>
  );
}
