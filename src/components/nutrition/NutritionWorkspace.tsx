"use client";

import Image from "next/image";
import { useState } from "react";
import {
  Barcode,
  Camera,
  Check,
  Mic,
  Pencil,
  ScanLine,
  Search,
  Type,
} from "lucide-react";
import {
  passioMockAdapter,
  useNutritionEntries,
  type CaptureMethod,
  type NutritionEntry,
} from "@/adapters/nutrition.mock";
import { useFeedback } from "@/lib/feedback";
import { thumbDataUri } from "@/lib/thumb";
import { toneColor } from "@/lib/tones";
import { Card, CardTitle, ProgressBar } from "@/components/ui/bits";
import { Btn } from "@/components/ui/Btn";
import { Field, TextArea, TextInput } from "@/components/ui/Field";
import { Pill } from "@/components/ui/Pill";
import { Sparkline } from "@/components/ui/Sparkline";
import { DemoNote } from "@/components/ui/DemoNote";

const METHODS: { id: CaptureMethod; label: string; icon: React.ReactNode }[] = [
  { id: "photo", label: "Photo", icon: <Camera size={13} aria-hidden /> },
  { id: "barcode", label: "Barcode", icon: <Barcode size={13} aria-hidden /> },
  { id: "voice", label: "Voice", icon: <Mic size={13} aria-hidden /> },
  { id: "search", label: "Search", icon: <Search size={13} aria-hidden /> },
  { id: "label", label: "Label scan", icon: <ScanLine size={13} aria-hidden /> },
  { id: "manual", label: "Manual", icon: <Type size={13} aria-hidden /> },
];

function entryTotals(e: NutritionEntry) {
  return e.items.reduce(
    (acc, i) => ({
      kcal: acc.kcal + i.kcal,
      p: acc.p + i.proteinG,
      c: acc.c + i.carbsG,
      f: acc.f + i.fatG,
      fb: acc.fb + i.fiberG,
    }),
    { kcal: 0, p: 0, c: 0, f: 0, fb: 0 },
  );
}

function CorrectionEditor({
  entry,
  patientId,
  patientName,
  onDone,
}: {
  entry: NutritionEntry;
  patientId: string;
  patientName: string;
  onDone: () => void;
}) {
  const { announce } = useFeedback();
  const [description, setDescription] = useState(entry.description);
  const [itemsText, setItemsText] = useState(
    entry.items.map((i) => `${i.name} · ${i.qty} · ${i.kcal} kcal`).join("\n"),
  );
  return (
    <div className="mt-2 rounded-lg border border-line bg-sunken px-3 py-3">
      <Field label="Description">
        <TextInput value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Field label="Items (one per line — name · qty · kcal)" className="mt-2">
        <TextArea value={itemsText} onChange={(e) => setItemsText(e.target.value)} rows={3} />
      </Field>
      <div className="mt-2 flex gap-2">
        <Btn
          size="sm"
          variant="primary"
          onClick={() => {
            const items = itemsText
              .split("\n")
              .map((line) => line.split("·").map((s) => s.trim()))
              .filter((parts) => parts[0])
              .map((parts, idx) => ({
                ...entry.items[idx],
                name: parts[0],
                qty: parts[1] ?? entry.items[idx]?.qty ?? "1 serving",
                kcal: Number.parseInt(parts[2] ?? "", 10) || entry.items[idx]?.kcal || 0,
              }));
            const r = passioMockAdapter.correctEntry(entry.id, patientId, patientName, {
              description,
              items,
            });
            announce(r.message);
            onDone();
          }}
        >
          Save correction
        </Btn>
        <Btn size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Btn>
      </div>
    </div>
  );
}

/**
 * Nutrition workspace behind the typed Passio adapter boundary. Capture is
 * SIMULATED (no camera/microphone/network; no key in the client); entries
 * flow parse → practitioner correction → confirmation, and targets, trends,
 * meal plans, and adherence tie back to the care plan.
 */
export function NutritionWorkspace({
  patientId,
  patientName,
}: {
  patientId: string;
  patientName: string;
}) {
  const { announce } = useFeedback();
  const entries = useNutritionEntries(patientId);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const targets = passioMockAdapter.targets(patientId);
  const trends = passioMockAdapter.trends(patientId);
  const plans = passioMockAdapter.mealPlans(patientId);

  const todayTotals = entries
    .filter((e) => e.dayLabel === "Today")
    .map(entryTotals)
    .reduce((a, b) => ({ kcal: a.kcal + b.kcal, p: a.p + b.p, c: a.c + b.c, f: a.f + b.f, fb: a.fb + b.fb }), { kcal: 0, p: 0, c: 0, f: 0, fb: 0 });

  const capture = (method: CaptureMethod) => {
    const r = passioMockAdapter.captureEntry(patientId, patientName, method, query);
    announce(r.message);
    setQuery("");
  };

  return (
    <div className="flex flex-col gap-4" data-screen-label="Nutrition">
      <Card className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="mr-1">Log a food entry</CardTitle>
          <TextInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search foods or describe the meal…"
            aria-label="Food search"
            className="w-[240px]"
          />
          {METHODS.map((m) => (
            <Btn key={m.id} size="sm" onClick={() => capture(m.id)}>
              {m.icon}
              {m.label}
            </Btn>
          ))}
        </div>
        <DemoNote className="mt-2">
          Capture is simulated — no camera, microphone, upload, or Passio call happens in the
          demo. The Passio adapter is a typed server-side boundary; its key never ships to this
          client.
        </DemoNote>
      </Card>

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card className="overflow-hidden">
            <div className="flex items-center gap-2 border-b border-hairline px-4 py-[10px]">
              <CardTitle className="flex-1">Entries</CardTitle>
              <span className="text-[11.5px] text-subtle">
                Today: {todayTotals.kcal} kcal · P {todayTotals.p} g · C {todayTotals.c} g · F {todayTotals.f} g
              </span>
            </div>
            <div className="flex flex-col">
              {entries.map((e) => {
                const t = entryTotals(e);
                return (
                  <div key={e.id} className="border-b border-hairline px-4 py-[10px] last:border-b-0">
                    <div className="flex items-start gap-3">
                      <Image
                        src={thumbDataUri(e.thumbSeed ?? e.id)}
                        alt=""
                        width={56}
                        height={35}
                        unoptimized
                        className="mt-[2px] h-[35px] w-[56px] shrink-0 rounded-md border border-hairline object-cover"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-[7px]">
                          <span className="truncate text-[13px] font-semibold text-ink">{e.description}</span>
                          <Pill tone={e.status === "confirmed" ? "positive" : e.status === "corrected" ? "action" : e.status === "needs-review" ? "warning" : "slate"}>
                            {e.status === "needs-review" ? "Needs review" : e.status === "corrected" ? "Corrected" : e.status === "confirmed" ? "Confirmed" : "Parsed"}
                          </Pill>
                        </div>
                        <p className="m-0 mt-[2px] text-[11.5px] text-subtle">
                          {e.dayLabel} {e.atLabel} · {e.meal} · via {e.method} · parse confidence {e.confidence}%
                        </p>
                        <p className="m-0 mt-1 text-[12px] text-body">
                          {e.items.map((i) => `${i.name} (${i.qty})`).join(" · ")} — {t.kcal} kcal · P {t.p} · C {t.c} · F {t.f} · fiber {t.fb}
                        </p>
                        {editing === e.id && (
                          <CorrectionEditor entry={e} patientId={patientId} patientName={patientName} onDone={() => setEditing(null)} />
                        )}
                      </div>
                      <div className="flex shrink-0 flex-col gap-1">
                        {e.status !== "confirmed" && (
                          <Btn size="sm" onClick={() => setEditing(editing === e.id ? null : e.id)}>
                            <Pencil size={12} aria-hidden /> Correct
                          </Btn>
                        )}
                        {e.status !== "confirmed" && (
                          <Btn
                            size="sm"
                            variant="primary"
                            onClick={() => {
                              const r = passioMockAdapter.confirmEntry(e.id, patientId, patientName);
                              announce(r.message);
                            }}
                          >
                            <Check size={12} aria-hidden /> Confirm
                          </Btn>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          {plans.length > 0 && (
            <Card className="px-4 py-[14px]">
              <div className="mb-2 flex items-center gap-2">
                <CardTitle className="flex-1">Meal plans</CardTitle>
              </div>
              {plans.map((mp) => (
                <div key={mp.id} className="rounded-lg border border-hairline bg-sunken px-3 py-[10px]">
                  <div className="flex items-center gap-2">
                    <span className="flex-1 text-[12.5px] font-semibold text-ink">{mp.name}</span>
                    <Pill tone="positive">{mp.adherencePct}% adherence</Pill>
                  </div>
                  <p className="m-0 mt-[2px] text-[11.5px] text-subtle">Linked to: {mp.linkedProtocol}</p>
                  <div className="mt-2 grid grid-cols-1 gap-1 md:grid-cols-3">
                    {mp.days.map((d) => (
                      <div key={d.day} className="rounded-md border border-hairline bg-card px-2 py-[6px]">
                        <span className="block text-[11px] font-bold text-subtle">{d.day}</span>
                        {d.meals.map((m) => (
                          <span key={m} className="block truncate text-[11.5px] text-body">{m}</span>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </Card>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Card className="px-4 py-[14px]">
            <CardTitle className="mb-2">Targets vs today</CardTitle>
            {(
              [
                ["Calories", todayTotals.kcal, targets.kcal, "kcal"],
                ["Protein", todayTotals.p, targets.proteinG, "g"],
                ["Carbs", todayTotals.c, targets.carbsG, "g"],
                ["Fat", todayTotals.f, targets.fatG, "g"],
                ["Fiber", todayTotals.fb, targets.fiberG, "g"],
              ] as [string, number, number, string][]
            ).map(([label, cur, target, unit]) => (
              <div key={label} className="mb-2">
                <div className="mb-[3px] flex items-baseline justify-between">
                  <span className="text-[11.5px] font-semibold text-subtle">{label}</span>
                  <span className="text-[11.5px] text-muted tabular-nums">
                    {cur} / {target} {unit}
                  </span>
                </div>
                <ProgressBar pct={Math.min(100, (cur / target) * 100)} color={toneColor[cur > target * 1.1 ? "warning" : "positive"]} label={`${label} progress`} />
              </div>
            ))}
            <CardTitle className="mt-3 mb-1">Micronutrient focus</CardTitle>
            {targets.micros.map((m) => (
              <div key={m.name} className="flex items-center gap-2 border-b border-hairline py-[5px] text-[12px] last:border-b-0">
                <span className="flex-1 text-body">{m.name}</span>
                <span className="text-subtle">{m.current} / {m.target}</span>
                <Pill tone={m.ok ? "positive" : "warning"}>{m.ok ? "On track" : "Below"}</Pill>
              </div>
            ))}
          </Card>

          <Card className="px-4 py-[14px]">
            <CardTitle className="mb-2">7-day trends</CardTitle>
            {(
              [
                ["Calories", trends.kcal, "navy"],
                ["Protein (g)", trends.proteinG, "action"],
                ["Fiber (g)", trends.fiberG, "positive"],
                ["Plan adherence (%)", trends.adherencePct, "teal"],
              ] as [string, number[], "navy" | "action" | "positive" | "teal"][]
            ).map(([label, series, tone]) => (
              <div key={label} className="mb-2">
                <div className="flex items-baseline justify-between">
                  <span className="text-[11.5px] font-semibold text-subtle">{label}</span>
                  <span className="text-[11.5px] text-muted tabular-nums">{series[series.length - 1]}</span>
                </div>
                <Sparkline values={series} width={260} height={30} stroke={toneColor[tone]} strokeWidth={1.75} label={`${label} 7-day trend`} />
              </div>
            ))}
            <p className="m-0 text-[10.5px] text-faint">Today is partial — totals accrue as entries land.</p>
          </Card>
        </div>
      </div>
    </div>
  );
}
