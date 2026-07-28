"use client";

import { useMemo, useState } from "react";
import { BookOpen, Check, ClipboardCheck, Pencil, Search } from "lucide-react";
import {
  passioMockAdapter,
  useDietPlanTemplates,
  type DietPlan,
} from "@/adapters/nutrition.mock";
import { useFeedback } from "@/lib/feedback";
import { Btn } from "@/components/ui/Btn";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Drawer } from "@/components/ui/Drawer";
import { Field, TextArea, TextInput } from "@/components/ui/Field";
import { Pill, Tag } from "@/components/ui/Pill";
import { cn } from "@/lib/cn";

type View = "library" | "edit" | null;

function clone(plan: DietPlan): DietPlan {
  return JSON.parse(JSON.stringify(plan)) as DietPlan;
}

function lines(value: string): string[] {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}

export function DietPlanAuthoring({
  patientId,
  patientName,
  current,
}: {
  patientId: string;
  patientName: string;
  current: DietPlan | null;
}) {
  const { announce } = useFeedback();
  const templates = useDietPlanTemplates();
  const [view, setView] = useState<View>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(templates[0]?.id ?? "");
  const [draft, setDraft] = useState<DietPlan | null>(null);
  const [confirmApproval, setConfirmApproval] = useState(false);
  const firstName = patientName.split(" ")[0];
  const visibleTemplates = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return templates;
    return templates.filter((template) =>
      `${template.name} ${template.category} ${template.summary} ${template.pattern}`.toLowerCase().includes(normalized),
    );
  }, [query, templates]);
  const selected = templates.find((template) => template.id === selectedId) ?? visibleTemplates[0];

  const beginEdit = () => {
    if (!current) return;
    setDraft(clone(current));
    setView("edit");
  };

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Btn size="sm" onClick={() => setView("library")}><BookOpen size={13} aria-hidden /> Diet plan library</Btn>
        {current && (
          <Btn size="sm" onClick={beginEdit}><Pencil size={13} aria-hidden /> {current.status === "draft" ? "Edit draft" : "Create draft version"}</Btn>
        )}
        {current?.status === "draft" && (
          <Btn size="sm" variant="primary" onClick={() => setConfirmApproval(true)}><ClipboardCheck size={13} aria-hidden /> Approve plan</Btn>
        )}
      </div>

      <Drawer
        open={view === "library"}
        onClose={() => setView(null)}
        width={900}
        title="Diet plan library"
        sub="Preview patient education, food guidance, phases, and safety notes before creating a draft"
        labelledBy="diet-plan-library-title"
        footer={selected ? (
          <div className="flex items-center gap-3">
            <span className="mr-auto text-[10.5px] text-faint">Creates an independent patient draft. It is not sent or activated.</span>
            <Btn onClick={() => setView(null)}>Cancel</Btn>
            <Btn
              variant="primary"
              aria-label={`Use ${selected.name} for ${firstName}`}
              onClick={() => {
                const assigned = passioMockAdapter.assignDietPlan(patientId, patientName, selected.id);
                if (!assigned) return;
                setView(null);
                announce(`${assigned.name} added as a patient-specific draft.`);
              }}
            >
              Use for {firstName}
            </Btn>
          </div>
        ) : undefined}
      >
        <div className="grid min-h-full md:grid-cols-[280px_minmax(0,1fr)]">
          <div className="border-b border-hairline bg-sunken md:border-r md:border-b-0">
            <div className="border-b border-hairline p-3">
              <div className="relative">
                <Search size={13} className="pointer-events-none absolute top-[9px] left-2.5 text-faint" aria-hidden />
                <TextInput value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search diet plans" placeholder="Search plans…" className="pl-8" />
              </div>
            </div>
            <div className="divide-y divide-hairline">
              {visibleTemplates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  aria-pressed={selected?.id === template.id}
                  onClick={() => setSelectedId(template.id)}
                  className={cn(
                    "w-full cursor-pointer border-0 px-4 py-3 text-left",
                    selected?.id === template.id ? "bg-action-tint" : "bg-transparent hover:bg-card",
                  )}
                >
                  <span className="block text-[12.5px] font-bold text-ink">{template.name}</span>
                  <span className="mt-1 block text-[10.5px] text-subtle">{template.category}</span>
                  <span className="mt-1 block text-[10px] text-faint">{template.evidenceLabel}</span>
                </button>
              ))}
              {visibleTemplates.length === 0 && <p className="m-0 px-4 py-6 text-center text-[11.5px] text-faint">No diet plans match that search.</p>}
            </div>
          </div>

          {selected && (
            <div className="flex flex-col gap-5 p-5">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="m-0 text-[18px] font-bold text-ink">{selected.name}</h2>
                  <Tag>{selected.category}</Tag>
                </div>
                <p className="mt-1 mb-0 text-[11px] font-semibold text-subtle">{selected.pattern}</p>
                <p className="mt-2 mb-0 text-[12.5px] leading-[1.6] text-body">{selected.summary}</p>
                <div className="mt-3"><Pill tone={selected.evidenceLabel.includes("Insufficient") || selected.evidenceLabel.includes("Limited") ? "warning" : "slate"}>{selected.evidenceLabel}</Pill></div>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <section>
                  <h3 className="m-0 mb-2 text-[10px] font-bold text-faint uppercase">May be considered for</h3>
                  <ul className="m-0 flex list-none flex-col gap-2 p-0">{selected.appropriateFor.map((item) => <li key={item} className="flex gap-2 text-[11.5px] text-body"><Check size={12} className="mt-[2px] shrink-0 text-positive" aria-hidden />{item}</li>)}</ul>
                </section>
                <section className="rounded-lg border border-warning bg-warning-tint px-3 py-3">
                  <h3 className="m-0 mb-2 text-[10px] font-bold text-warning uppercase">Review before use</h3>
                  <ul className="m-0 flex flex-col gap-1.5 pl-4 text-[11px] leading-[1.45] text-body">{selected.cautions.map((item) => <li key={item}>{item}</li>)}</ul>
                </section>
              </div>

              <section>
                <h3 className="m-0 mb-2 text-[10px] font-bold text-faint uppercase">Plan phases</h3>
                <div className="grid gap-2 sm:grid-cols-2">{selected.phases.map((phase, index) => <div key={phase.name} className="rounded-lg border border-line bg-sunken px-3 py-2"><p className="m-0 text-[11.5px] font-bold text-ink">{index + 1}. {phase.name}</p><p className="mt-1 mb-0 text-[10.5px] text-faint">{phase.duration}</p><p className="mt-1 mb-0 text-[11px] leading-[1.4] text-body">{phase.focus}</p></div>)}</div>
              </section>

              <div className="grid gap-4 sm:grid-cols-3">
                <PlanList title="Eat / emphasize" items={selected.emphasize} tone="positive" />
                <PlanList title="Limit" items={selected.limit} tone="warning" />
                <PlanList title="Avoid / configure" items={[...selected.avoid, ...selected.restrictions]} tone="slate" />
              </div>

              <a href={selected.sourceUrl} target="_blank" rel="noreferrer" className="text-[11px] font-semibold text-action hover:underline">Education source: {selected.sourceLabel}</a>
            </div>
          )}
        </div>
      </Drawer>

      <Drawer
        open={view === "edit" && draft != null}
        onClose={() => setView(null)}
        width={720}
        title={draft?.name ?? "Diet plan draft"}
        sub={`${patientName} · patient-specific education and instructions`}
        labelledBy="diet-plan-editor-title"
        footer={draft ? <div className="flex justify-end gap-2"><Btn onClick={() => setView(null)}>Cancel</Btn><Btn variant="primary" onClick={() => { const saved = passioMockAdapter.saveDietPlan(patientId, patientName, draft); setDraft(clone(saved)); setView(null); announce(`${saved.name} saved as a review-required draft.`); }}>Save diet plan draft</Btn></div> : undefined}
      >
        {draft && (
          <div className="flex flex-col gap-4 p-5">
            <div className="rounded-lg border border-warning bg-warning-tint px-3 py-2 text-[11.5px] text-body">Saving creates a draft. It does not assign, send, or activate patient-facing guidance until a practitioner approves it.</div>
            <Field label="Plan name"><TextInput value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field>
            <Field label="Patient explanation"><TextArea rows={4} value={draft.summary ?? ""} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} /></Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Goals (one per line)"><TextArea rows={6} value={draft.goals.join("\n")} onChange={(event) => setDraft({ ...draft, goals: lines(event.target.value) })} /></Field>
              <Field label="Patient-specific cautions (one per line)"><TextArea rows={6} value={(draft.cautions ?? []).join("\n")} onChange={(event) => setDraft({ ...draft, cautions: lines(event.target.value) })} /></Field>
              <Field label="Eat / emphasize (one per line)"><TextArea rows={7} value={draft.emphasize.join("\n")} onChange={(event) => setDraft({ ...draft, emphasize: lines(event.target.value) })} /></Field>
              <Field label="Limit (one per line)"><TextArea rows={7} value={draft.limit.join("\n")} onChange={(event) => setDraft({ ...draft, limit: lines(event.target.value) })} /></Field>
              <Field label="Avoid (one per line)"><TextArea rows={7} value={draft.avoid.join("\n")} onChange={(event) => setDraft({ ...draft, avoid: lines(event.target.value) })} /></Field>
              <Field label="Restrictions and preferences (one per line)"><TextArea rows={7} value={draft.restrictions.join("\n")} onChange={(event) => setDraft({ ...draft, restrictions: lines(event.target.value) })} /></Field>
            </div>
            <Field label="Hydration guidance"><TextArea rows={3} value={draft.hydration} onChange={(event) => setDraft({ ...draft, hydration: event.target.value })} /></Field>
            <Field label="Additional instructions (one per line)"><TextArea rows={4} value={draft.notes.join("\n")} onChange={(event) => setDraft({ ...draft, notes: lines(event.target.value) })} /></Field>
          </div>
        )}
      </Drawer>

      <ConfirmDialog
        open={confirmApproval}
        title="Approve this diet plan?"
        body={`Confirm that you reviewed ${current?.name ?? "this plan"} for ${patientName}, including allergies, medications, diagnoses, nutrition adequacy, contraindications, and reintroduction or exit criteria. This demo records approval but does not send the plan.`}
        confirmLabel="Approve diet plan"
        onCancel={() => setConfirmApproval(false)}
        onConfirm={() => {
          const approved = passioMockAdapter.approveDietPlan(patientId, patientName);
          setConfirmApproval(false);
          if (approved) announce(`${approved.name} approved this session. Nothing was sent.`);
        }}
      />
    </>
  );
}

function PlanList({ title, items, tone }: { title: string; items: string[]; tone: "positive" | "warning" | "slate" }) {
  return <section><h3 className="m-0 mb-2 text-[10px] font-bold text-faint uppercase">{title}</h3><div className="flex flex-wrap gap-1.5">{items.map((item) => <Pill key={item} tone={tone}>{item}</Pill>)}</div></section>;
}
