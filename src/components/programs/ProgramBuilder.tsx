"use client";

import { useMemo, useState } from "react";
import { GitBranch, Layers, Plus } from "lucide-react";
import {
  STEP_KINDS,
  getProgramTemplates,
  type ProgramStep,
  type ProgramStepKind,
} from "@/adapters/programs.mock";
import { recordAuditEntry } from "@/adapters/session-store";
import type { Tone } from "@/adapters/types";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Card } from "@/components/ui/bits";
import { cn } from "@/lib/cn";
import { useFeedback } from "@/lib/feedback";
import { toneText, toneTint } from "@/lib/tones";

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

const kindMeta = (k: ProgramStepKind) => STEP_KINDS.find((s) => s.kind === k)!;

export function ProgramBuilder() {
  const { announce } = useFeedback();
  const templates = useMemo(() => getProgramTemplates(), []);
  const [templateId, setTemplateId] = useState(templates[0].id);
  const [addedSteps, setAddedSteps] = useState<Record<string, ProgramStep[]>>({});
  const [addKind, setAddKind] = useState<ProgramStepKind>("Habit");
  const [addWeek, setAddWeek] = useState("2");
  const [addTitle, setAddTitle] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState<Set<string>>(new Set());

  const template = templates.find((t) => t.id === templateId)!;
  const steps = useMemo(
    () =>
      [...template.steps, ...(addedSteps[templateId] ?? [])].sort((a, b) => a.week - b.week),
    [template, addedSteps, templateId],
  );

  const weeks = Array.from({ length: template.weeks }, (_, i) => i + 1);

  const addStep = () => {
    const meta = kindMeta(addKind);
    const week = Math.min(Math.max(1, Number(addWeek) || 1), template.weeks);
    const step: ProgramStep = {
      id: `added-${Date.now()}`,
      week,
      kind: addKind,
      title: addTitle.trim() || `${addKind} (new step)`,
      patientFacing: meta.patientFacing,
      reviewGated: meta.patientFacing,
      release: "Scheduled",
    };
    setAddedSteps((s) => ({ ...s, [templateId]: [...(s[templateId] ?? []), step] }));
    setAddTitle("");
    announce(`Step added to week ${week} (session only — not persisted).`);
  };

  const publish = () => {
    setPublishing(false);
    setPublished((p) => new Set(p).add(templateId));
    recordAuditEntry({
      kind: "approve",
      subjectType: "program template",
      subjectLabel: template.name,
      reviewed: true,
      outcome: "approved",
    });
    announce(`Program "${template.name}" published. (demo — not persisted)`);
  };

  return (
    <section data-screen-label="Program Builder" className="relative mx-auto max-w-[1240px] px-6 pt-[22px] pb-10">
      <div className="mb-1 text-[11.5px] font-semibold text-faint">Operations / Programs</div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-[7px]">
            <Layers size={17} strokeWidth={2} className="text-brand" aria-hidden />
            <h1 className="m-0 text-[21px] font-bold tracking-[-0.015em]">Program builder</h1>
          </div>
          <p className="mt-[4px] mb-0 text-[12.5px] text-subtle">
            Timeline-based care programs. Patient-facing steps are review-gated; edits here are
            session-only demo state.
          </p>
        </div>
        <button
          onClick={() => setPublishing(true)}
          disabled={published.has(templateId)}
          className="h-9 cursor-pointer rounded-lg border-none bg-action px-4 text-[12.5px] font-semibold text-white hover:bg-action-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          {published.has(templateId) ? "Published (demo)" : "Publish program"}
        </button>
      </div>

      <div className="grid grid-cols-[250px_minmax(0,1fr)] items-start gap-4">
        {/* Template list */}
        <div className="flex flex-col gap-3">
          <Card className="p-[12px]">
            <h2 className="m-0 mb-[8px] text-[12.5px] font-bold">Templates</h2>
            <div className="flex flex-col gap-[5px]" role="radiogroup" aria-label="Program templates">
              {templates.map((t) => (
                <button
                  key={t.id}
                  role="radio"
                  aria-checked={templateId === t.id}
                  onClick={() => setTemplateId(t.id)}
                  className={cn(
                    "rounded-[9px] border px-[10px] py-[8px] text-left focus-visible:outline-2 focus-visible:outline-action",
                    templateId === t.id ? "border-action bg-action-tint" : "border-line bg-card hover:border-line-hover",
                  )}
                >
                  <span className={cn("block text-[12.5px] font-bold", templateId === t.id ? "text-action-deep" : "text-ink")}>{t.name}</span>
                  <span className="block text-[10.5px] text-subtle">{t.weeks} weeks · {t.enrolled} enrolled</span>
                </button>
              ))}
            </div>
          </Card>

          <Card className="p-[12px]">
            <h2 className="m-0 mb-[7px] flex items-center gap-[6px] text-[12.5px] font-bold">
              <GitBranch size={13} strokeWidth={2} className="text-ai" aria-hidden />
              Branching (preview)
            </h2>
            <p className="m-0 text-[11px] leading-[1.5] text-subtle">
              Condition example: <span className="font-semibold text-body">if mid-point HbA1c &gt; 5.7%</span> →
              add CGM window + nutrition review. Branch execution lands with the backend;
              shown here as design preview only.
            </p>
          </Card>

          <Card className="p-[12px]">
            <h2 className="m-0 mb-[7px] text-[12.5px] font-bold">Completion criteria</h2>
            <ul className="m-0 flex list-none flex-col gap-[5px] p-0">
              {template.completionCriteria.map((c) => (
                <li key={c} className="text-[11.5px] leading-[1.45] text-body">• {c}</li>
              ))}
            </ul>
            <h2 className="m-0 mt-[10px] mb-[7px] text-[12.5px] font-bold">Automations</h2>
            <p className="m-0 text-[11px] leading-[1.5] text-subtle">
              Reminders create internal review tasks only — nothing reaches the patient without
              practitioner review (see Operations → Automations).
            </p>
          </Card>
        </div>

        {/* Timeline */}
        <Card className="p-[15px]">
          <div className="mb-[10px] flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="m-0 text-[13.5px] font-bold">{template.name}</h2>
              <p className="mt-[2px] mb-0 text-[11.5px] text-subtle">{template.description}</p>
            </div>
          </div>

          {/* Add step */}
          <div className="mb-[13px] flex flex-wrap items-end gap-2 rounded-[10px] border border-dashed border-line-btn bg-[rgba(247,250,252,0.6)] px-[12px] py-[10px]">
            <label className="block">
              <span className="mb-[3px] block text-[9.5px] font-bold tracking-[0.04em] text-faint uppercase">Step type</span>
              <select
                value={addKind}
                onChange={(e) => setAddKind(e.target.value as ProgramStepKind)}
                className="h-8 rounded-lg border border-line bg-card px-[8px] text-[12px] text-body outline-none focus-visible:outline-2 focus-visible:outline-action"
              >
                {STEP_KINDS.map((s) => (
                  <option key={s.kind}>{s.kind}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-[3px] block text-[9.5px] font-bold tracking-[0.04em] text-faint uppercase">Week</span>
              <input
                value={addWeek}
                onChange={(e) => setAddWeek(e.target.value)}
                inputMode="numeric"
                aria-label="Week number"
                className="h-8 w-[64px] rounded-lg border border-line bg-card px-[8px] text-[12px] text-body outline-none focus-visible:outline-2 focus-visible:outline-action"
              />
            </label>
            <label className="block min-w-[200px] flex-1">
              <span className="mb-[3px] block text-[9.5px] font-bold tracking-[0.04em] text-faint uppercase">Title</span>
              <input
                value={addTitle}
                onChange={(e) => setAddTitle(e.target.value)}
                placeholder={`${addKind} title…`}
                aria-label="Step title"
                className="h-8 w-full rounded-lg border border-line bg-card px-[8px] text-[12px] text-body outline-none focus-visible:outline-2 focus-visible:outline-action"
              />
            </label>
            <button
              onClick={addStep}
              className="flex h-8 cursor-pointer items-center gap-[5px] rounded-lg border-none bg-action px-3 text-[12px] font-semibold text-white hover:bg-action-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            >
              <Plus size={13} strokeWidth={2.5} aria-hidden />
              Add step
            </button>
          </div>

          {/* Weeks */}
          <ol className="m-0 flex list-none flex-col gap-[10px] p-0">
            {weeks.map((w) => {
              const weekSteps = steps.filter((s) => s.week === w);
              const milestone = template.milestones.find((m) => m.week === w);
              if (weekSteps.length === 0 && !milestone) return null;
              return (
                <li key={w} className="grid grid-cols-[64px_minmax(0,1fr)] gap-3">
                  <div className="pt-[6px]">
                    <span className="text-[11px] font-bold text-muted">Week {w}</span>
                    {milestone && (
                      <span className="mt-[3px] block">
                        <Pill tone="action">◆ {milestone.label}</Pill>
                      </span>
                    )}
                  </div>
                  <div className="flex flex-col gap-[6px]">
                    {weekSteps.map((s) => {
                      const meta = kindMeta(s.kind);
                      return (
                        <div key={s.id} className="flex flex-wrap items-center gap-[8px] rounded-[10px] border border-line bg-card px-[11px] py-[8px]">
                          <Pill tone={meta.tone}>{s.kind}</Pill>
                          <span className="min-w-0 flex-1 text-[12px] font-semibold text-ink">{s.title}</span>
                          {s.patientFacing && <Pill tone="teal">Patient-facing</Pill>}
                          {s.reviewGated && <Pill tone="warning">Review-gated</Pill>}
                          <span className="text-[10px] text-faint">{s.release}</span>
                        </div>
                      );
                    })}
                  </div>
                </li>
              );
            })}
          </ol>
        </Card>
      </div>

      {publishing && (
        <ConfirmDialog
          open
          title={`Publish "${template.name}"?`}
          body="Publishing records a demo audit event. Patient-facing steps stay review-gated at delivery time. Demo boundary: not persisted to a backend."
          confirmLabel="Publish (demo)"
          onCancel={() => setPublishing(false)}
          onConfirm={publish}
        />
      )}
    </section>
  );
}
