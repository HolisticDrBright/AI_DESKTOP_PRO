"use client";

import { useState } from "react";
import { FlaskConical, TestTube, TriangleAlert } from "lucide-react";
import {
  BUILDER_STEPS,
  DESIGNS,
  EXP_CONCLUSION_TONE,
  getActiveExperiments,
  getCompletedExperiments,
  type ExperimentDesign,
} from "@/adapters/experiments.mock";
import { recordAuditEntry } from "@/adapters/session-store";
import type { Tone } from "@/adapters/types";
import { ActionBar } from "@/components/ui/ActionBar";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Card } from "@/components/ui/bits";
import { cn } from "@/lib/cn";
import { useFeedback } from "@/lib/feedback";
import { toneText, toneTint } from "@/lib/tones";

type View = "active" | "completed" | "builder";

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

export function Nof1Lab({
  patientName,
}: {
  patientId: string;
  patientName: string;
}) {
  const [view, setView] = useState<View>("active");
  const active = getActiveExperiments();
  const completed = getCompletedExperiments();

  return (
    <section data-screen-label="N-of-1 Lab" className="relative flex flex-col gap-4 pb-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-[7px]">
            <TestTube size={17} strokeWidth={2} className="text-brand" aria-hidden />
            <h1 className="m-0 text-[19px] font-bold tracking-[-0.015em]">N-of-1 Lab</h1>
          </div>
          <p className="mt-[3px] mb-0 text-[11.5px] text-subtle">
            Single-patient experiments. Results describe observed change in this patient —
            never causation, never a general efficacy claim. Launch requires practitioner approval.
          </p>
        </div>
        <div className="flex items-center gap-1" role="group" aria-label="N-of-1 views">
          {(
            [
              ["active", `Active (${active.length})`],
              ["completed", `Completed (${completed.length})`],
              ["builder", "Experiment builder"],
            ] as [View, string][]
          ).map(([v, label]) => (
            <button
              key={v}
              onClick={() => setView(v)}
              aria-pressed={view === v}
              className={cn(
                "h-8 cursor-pointer rounded-lg border px-3 text-[12px] font-semibold focus-visible:outline-2 focus-visible:outline-action",
                view === v
                  ? "border-action bg-action-tint text-action-deep"
                  : "border-line bg-card text-body-2 hover:border-line-hover",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {view === "active" && (
        <div className="grid grid-cols-2 gap-4">
          {active.map((e) => (
            <Card key={e.id} className="p-[14px]">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="m-0 text-[13.5px] font-bold">{e.hypothesis}</h2>
                  <p className="mt-[2px] mb-0 text-[11.5px] text-subtle">{e.intervention}</p>
                </div>
                <Pill tone={e.review === "Approved" ? "positive" : "warning"}>{e.review}</Pill>
              </div>
              <div className="mt-[9px] grid grid-cols-2 gap-x-3 gap-y-[6px] text-[11.5px]">
                <span><span className="text-faint">Design</span> <span className="text-body">{e.design}</span></span>
                <span><span className="text-faint">Phase</span> <span className="text-body">{e.phase} · {e.day}</span></span>
                <span><span className="text-faint">Primary outcome</span> <span className="text-body">{e.primaryOutcome}</span></span>
                <span><span className="text-faint">Direction</span> <span className="font-semibold text-body">{e.direction}</span></span>
                <span><span className="text-faint">Safety</span> <Pill tone={e.safety === "No concerns" ? "positive" : "warning"}>{e.safety}</Pill></span>
                <span><span className="text-faint">Completion</span> <span className="font-semibold text-body">{e.completionPct}%</span></span>
              </div>
              <div className="mt-[8px] h-[5px] overflow-hidden rounded-full bg-track" role="img" aria-label={`Completion ${e.completionPct} percent`}>
                <div className="h-full rounded-full bg-action" style={{ width: `${e.completionPct}%` }} />
              </div>
              <p className="mt-[7px] mb-0 text-[10.5px] leading-[1.45] text-subtle">
                <span className="font-semibold text-body-2">Confounders:</span> {e.confounders.join("; ")}
              </p>
              <ActionBar
                size="sm"
                className="mt-[9px] border-t border-hairline-2 pt-[9px]"
                actions={["modify", "flag", "add_to_note", "view_audit"]}
                context={{
                  subjectType: "experiment",
                  subjectLabel: e.hypothesis,
                  patientName,
                  seeds: [`${e.intervention} — ${e.primaryOutcome} ${e.direction} (${e.day})`, `Confounders: ${e.confounders.join("; ")}`],
                }}
              />
            </Card>
          ))}
        </div>
      )}

      {view === "completed" && (
        <div className="flex flex-col gap-4">
          {completed.map((r) => (
            <Card key={r.id} className="p-[15px]">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="m-0 text-[13.5px] font-bold">{r.hypothesis}</h2>
                  <p className="mt-[2px] mb-0 text-[11.5px] text-subtle">
                    {r.intervention} · {r.design} · {r.window}
                  </p>
                </div>
                <Pill tone={EXP_CONCLUSION_TONE[r.conclusion]}>{r.conclusion}</Pill>
              </div>

              <div className="mt-[11px] grid grid-cols-6 gap-3">
                {[
                  ["Baseline", r.baseline],
                  ["Intervention", r.interventionValue],
                  ["Absolute change", r.absoluteChange],
                  ["Relative change", r.relativeChange],
                  ["Data completeness", `${r.completenessPct}%`],
                  ["Adherence", `${r.adherencePct}%`],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-[9px] border border-line bg-[rgba(248,250,252,0.6)] px-[10px] py-[8px]">
                    <div className="text-[9.5px] font-bold tracking-[0.03em] text-faint uppercase">{label}</div>
                    <div className="mt-[2px] text-[14px] font-bold text-ink">{value}</div>
                  </div>
                ))}
              </div>

              <div className="mt-[10px] grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4 text-[11.5px]">
                <div>
                  <span className="font-semibold text-body-2">Confounders: </span>
                  <span className="text-body">{r.confounders.join("; ") || "None identified"}</span>
                </div>
                <div>
                  <span className="font-semibold text-body-2">Adverse events: </span>
                  <span className="text-body">{r.adverseEvents.length ? r.adverseEvents.join("; ") : "None recorded"}</span>
                </div>
              </div>

              <p className="mt-[8px] mb-0 rounded-[9px] bg-sunken px-[11px] py-[8px] text-[11.5px] leading-[1.5] text-body">
                <span className="font-semibold">Interpretation (practitioner-reviewed): </span>
                {r.interpretation}
              </p>

              <ActionBar
                size="sm"
                className="mt-[10px] border-t border-hairline-2 pt-[10px]"
                actions={["approve", "add_to_note", "insert_into_report", "convert_to_task", "view_audit"]}
                context={{
                  subjectType: "experiment result",
                  subjectLabel: r.hypothesis,
                  patientName,
                  seeds: [
                    `${r.intervention}: ${r.primaryOutcome} ${r.baseline} → ${r.interventionValue} (${r.relativeChange})`,
                    `Conclusion: ${r.conclusion} — ${r.interpretation}`,
                  ],
                  reviewKey: `experiment:${r.id}`,
                }}
              />
            </Card>
          ))}
        </div>
      )}

      {view === "builder" && <ExperimentBuilder patientName={patientName} />}
    </section>
  );
}

function ExperimentBuilder({ patientName }: { patientName: string }) {
  const { announce } = useFeedback();
  const [design, setDesign] = useState<ExperimentDesign>("Before-and-after");
  const [fields, setFields] = useState<Record<string, string>>({
    goal: "Improve sleep quality",
    hypothesis: "L-theanine 200 mg in the evening shortens sleep latency",
    intervention: "L-theanine 200 mg, 60 min before bed",
    baseline: "14 days",
    duration: "21 days",
    primary: "Sleep latency (min, wearable)",
    secondary: "Deep sleep minutes; evening HRV",
    stable: "Caffeine cutoff 12:00; consistent bedtime ±30 min; training load unchanged",
    confounders: "Concurrent magnesium; seasonal daylight; work stress",
    stopping: "New daytime somnolence; any adverse reaction; patient request",
  });
  const [approved, setApproved] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [launched, setLaunched] = useState(false);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setFields((f) => ({ ...f, [k]: e.target.value }));

  const launch = () => {
    setConfirming(false);
    setLaunched(true);
    recordAuditEntry({
      kind: "approve",
      subjectType: "experiment design",
      subjectLabel: fields.hypothesis,
      patientName,
      reviewed: true,
      outcome: "approved",
    });
    announce("Experiment approved and launched. (demo — not persisted)");
  };

  const input =
    "h-8 w-full rounded-lg border border-line bg-card px-[9px] text-[12px] text-body outline-none focus-visible:border-action focus-visible:outline-2 focus-visible:outline-action";

  const stepFor = (n: number): React.ReactNode => {
    switch (n) {
      case 1: return <input value={fields.goal} onChange={set("goal")} aria-label="Goal" className={input} />;
      case 2: return <input value={fields.hypothesis} onChange={set("hypothesis")} aria-label="Hypothesis" className={input} />;
      case 3: return <input value={fields.intervention} onChange={set("intervention")} aria-label="Primary intervention" className={input} />;
      case 4: return <input value={fields.baseline} onChange={set("baseline")} aria-label="Baseline duration" className={input} />;
      case 5: return <input value={fields.duration} onChange={set("duration")} aria-label="Intervention duration" className={input} />;
      case 6: return (
        <div className="flex flex-col gap-[6px]">
          <input value={fields.primary} onChange={set("primary")} aria-label="Primary outcome" className={input} />
          <input value={fields.secondary} onChange={set("secondary")} aria-label="Secondary outcomes" className={input} />
        </div>
      );
      case 7: return <textarea value={fields.stable} onChange={set("stable")} rows={2} aria-label="Variables to keep stable" className={cn(input, "h-auto resize-none py-[6px]")} />;
      case 8: return <textarea value={fields.confounders} onChange={set("confounders")} rows={2} aria-label="Confounders" className={cn(input, "h-auto resize-none py-[6px]")} />;
      case 9: return <textarea value={fields.stopping} onChange={set("stopping")} rows={2} aria-label="Stopping rules" className={cn(input, "h-auto resize-none py-[6px]")} />;
      case 10: return (
        <div className="rounded-[9px] bg-sunken px-[10px] py-[8px] text-[11.5px] leading-[1.55] text-body">
          <strong>{fields.hypothesis}</strong> — {design}; baseline {fields.baseline}, intervention {fields.duration};
          primary outcome {fields.primary}. Stable: {fields.stable}. Confounders: {fields.confounders}.
          Stops on: {fields.stopping}.
        </div>
      );
      case 11: return (
        <label className="flex items-start gap-[8px] text-[12px] text-body">
          <input
            type="checkbox"
            checked={approved}
            onChange={(e) => setApproved(e.target.checked)}
            className="mt-[2px] h-4 w-4 accent-[#2563C7]"
          />
          I have reviewed this design, its stopping rules, and its safety considerations. (Practitioner approval — required before launch.)
        </label>
      );
      case 12: return (
        <button
          onClick={() => setConfirming(true)}
          disabled={!approved || launched}
          className="h-9 cursor-pointer rounded-lg border-none bg-action px-4 text-[12.5px] font-semibold text-white hover:bg-action-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          {launched ? "Launched (demo)" : "Launch experiment"}
        </button>
      );
      default: return null;
    }
  };

  return (
    <div className="grid grid-cols-[260px_minmax(0,1fr)] items-start gap-4">
      <Card className="p-[13px]">
        <h2 className="m-0 mb-[8px] text-[12.5px] font-bold">Design</h2>
        <div className="flex flex-col gap-[5px]" role="radiogroup" aria-label="Experiment design">
          {DESIGNS.map((d) => (
            <button
              key={d.id}
              role="radio"
              aria-checked={design === d.id}
              onClick={() => setDesign(d.id)}
              className={cn(
                "rounded-[9px] border px-[10px] py-[7px] text-left focus-visible:outline-2 focus-visible:outline-action",
                design === d.id ? "border-action bg-action-tint" : "border-line bg-card hover:border-line-hover",
              )}
            >
              <span className={cn("block text-[12px] font-semibold", design === d.id ? "text-action-deep" : "text-ink")}>{d.id}</span>
              <span className="block text-[10.5px] leading-[1.4] text-subtle">{d.blurb}</span>
            </button>
          ))}
        </div>
        <div className="mt-[11px] flex items-start gap-[6px] rounded-[9px] border border-[rgba(199,126,20,0.28)] bg-warning-tint px-[9px] py-[7px] text-[10.5px] leading-[1.45] text-warning-deep">
          <TriangleAlert size={12} strokeWidth={2} className="mt-px shrink-0" aria-hidden />
          One variable at a time. Results describe observed change, not causation, and never
          replace clinical judgment.
        </div>
      </Card>

      <Card className="p-[15px]">
        <div className="mb-[10px] flex items-center gap-[7px]">
          <FlaskConical size={14} strokeWidth={2} className="text-brand" aria-hidden />
          <h2 className="m-0 text-[13px] font-bold">Builder — {design}</h2>
          {launched && <Pill tone="positive">Launched this session</Pill>}
        </div>
        <ol className="m-0 flex list-none flex-col gap-[12px] p-0">
          {BUILDER_STEPS.map((s) => (
            <li key={s.n} className="grid grid-cols-[24px_170px_minmax(0,1fr)] items-start gap-3">
              <span className="mt-[2px] flex h-[20px] w-[20px] items-center justify-center rounded-full bg-number-tint text-[10.5px] font-semibold text-muted">{s.n}</span>
              <span>
                <span className="block text-[12px] font-semibold text-ink">{s.title}</span>
                <span className="block text-[10px] leading-[1.4] text-faint">{s.hint}</span>
              </span>
              <div>{stepFor(s.n)}</div>
            </li>
          ))}
        </ol>
      </Card>

      {confirming && (
        <ConfirmDialog
          open
          title="Launch this experiment?"
          body="Practitioner approval will be recorded and baseline tracking begins. Demo boundary: nothing is persisted to a backend."
          confirmLabel="Approve & launch"
          onCancel={() => setConfirming(false)}
          onConfirm={launch}
        />
      )}
    </div>
  );
}
