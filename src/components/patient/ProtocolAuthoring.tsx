"use client";

import { useState } from "react";
import { CopyPlus, FilePlus2, LayoutTemplate, Plus, Save, Trash2 } from "lucide-react";
import {
  createBlankProtocol,
  createProtocolFromTemplate,
  saveProtocol,
  saveProtocolAsTemplate,
  useProtocolTemplates,
  type CarePlanProtocol,
  type ProtocolItem,
} from "@/adapters/careplan.mock";
import { useFeedback } from "@/lib/feedback";
import { Btn } from "@/components/ui/Btn";
import { Drawer } from "@/components/ui/Drawer";
import { Field, Select, TextArea, TextInput } from "@/components/ui/Field";
import { Pill, Tag } from "@/components/ui/Pill";

type AuthoringView = "new" | "templates" | "edit" | "save-template" | null;

function cloneProtocol(protocol: CarePlanProtocol): CarePlanProtocol {
  return JSON.parse(JSON.stringify(protocol)) as CarePlanProtocol;
}

function lines(value: string): string[] {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}

function newIntervention(): ProtocolItem {
  return {
    label: "",
    detail: "",
    kind: "supplement",
    schedule: "Practitioner configured",
    status: "planned",
  };
}

export function ProtocolAuthoring({
  patientId,
  patientName,
  selected,
  onSelect,
}: {
  patientId: string;
  patientName: string;
  selected?: CarePlanProtocol;
  onSelect: (id: string) => void;
}) {
  const { announce } = useFeedback();
  const templates = useProtocolTemplates();
  const [view, setView] = useState<AuthoringView>(null);
  const [draft, setDraft] = useState<CarePlanProtocol | null>(null);
  const [templateName, setTemplateName] = useState("");
  const [templateDescription, setTemplateDescription] = useState("");

  const openEditor = (protocol: CarePlanProtocol) => {
    setDraft(cloneProtocol(protocol));
    setView("edit");
  };

  const beginFromTemplate = (templateId: string) => {
    const created = createProtocolFromTemplate(patientId, templateId);
    if (!created) return;
    onSelect(created.id);
    openEditor(created);
    announce(`${created.name} added as a patient-specific draft.`);
  };

  const beginBlank = () => {
    const created = createBlankProtocol(patientId);
    onSelect(created.id);
    openEditor(created);
    announce("Blank protocol draft created.");
  };

  const updateItem = (index: number, patch: Partial<ProtocolItem>) => {
    setDraft((current) => current ? {
      ...current,
      items: current.items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item),
    } : current);
  };

  const templateList = (
    <div className="divide-y divide-hairline">
      {templates.map((template) => (
        <div key={template.id} className="flex items-start gap-3 px-5 py-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-action-tint text-action"><LayoutTemplate size={16} aria-hidden /></span>
          <div className="min-w-0 flex-1">
            <p className="m-0 flex flex-wrap items-center gap-2 text-[12.5px] font-bold text-ink">
              {template.name}
              <Tag>{template.builtIn ? "Premade" : "Practice template"}</Tag>
            </p>
            <p className="mt-1 mb-0 text-[11.5px] leading-[1.45] text-subtle">{template.description}</p>
            <p className="mt-2 mb-0 text-[10.5px] text-faint">{template.category} · {template.content.phases.length} phases · {template.content.items.length} interventions</p>
            <p className="mt-1 mb-0 text-[10.5px] text-faint">{template.sourceLabel}</p>
          </div>
          <Btn size="sm" aria-label={`Use ${template.name} for ${patientName.split(" ")[0]}`} onClick={() => beginFromTemplate(template.id)}>Use for {patientName.split(" ")[0]}</Btn>
        </div>
      ))}
    </div>
  );

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Btn size="sm" onClick={() => setView("templates")}><LayoutTemplate size={13} aria-hidden /> Protocol templates</Btn>
        {selected && (
          <>
            <Btn size="sm" onClick={() => openEditor(selected)}><CopyPlus size={13} aria-hidden /> {selected.status === "pending-approval" ? "Edit draft" : "Create draft version"}</Btn>
            <Btn size="sm" onClick={() => {
              setTemplateName(`${selected.name} template`);
              setTemplateDescription(selected.summary);
              setView("save-template");
            }}><Save size={13} aria-hidden /> Save as template</Btn>
          </>
        )}
        <Btn size="sm" variant="primary" onClick={() => setView("new")}><FilePlus2 size={13} aria-hidden /> New protocol</Btn>
      </div>

      <Drawer
        open={view === "new"}
        onClose={() => setView(null)}
        width={650}
        title="Create a patient protocol"
        sub={`Start blank or reuse a reviewed structure for ${patientName}`}
        labelledBy="new-protocol-title"
        footer={<div className="flex justify-between"><Btn onClick={beginBlank}><FilePlus2 size={13} aria-hidden /> Start blank</Btn><Btn onClick={() => setView(null)}>Cancel</Btn></div>}
      >
        <div className="border-b border-hairline bg-sunken px-5 py-3 text-[11.5px] leading-[1.5] text-subtle">
          A template supplies the reusable structure. The new protocol is a separate patient draft, so changing herbs, supplements, schedules, or goals never changes the template.
        </div>
        {templateList}
      </Drawer>

      <Drawer
        open={view === "templates"}
        onClose={() => setView(null)}
        width={650}
        title="Protocol templates"
        sub="Premade and practice-saved protocol structures"
        labelledBy="protocol-template-library-title"
        footer={<div className="flex justify-between"><Btn onClick={beginBlank}><Plus size={13} aria-hidden /> Blank protocol</Btn><Btn onClick={() => setView(null)}>Close</Btn></div>}
      >
        {templateList}
      </Drawer>

      <Drawer
        open={view === "edit" && draft != null}
        onClose={() => setView(null)}
        width={720}
        title={draft?.name ?? "Protocol draft"}
        sub={`${patientName} · patient-specific draft`}
        labelledBy="protocol-editor-title"
        footer={draft && (
          <div className="flex items-center gap-2">
            <span className="mr-auto text-[10.5px] text-faint">Saving creates or updates a review-gated draft.</span>
            <Btn onClick={() => setView(null)}>Cancel</Btn>
            <Btn
              variant="primary"
              disabled={!draft.name.trim() || !draft.summary.trim()}
              onClick={() => {
                const saved = saveProtocol(draft);
                onSelect(saved.id);
                setDraft(cloneProtocol(saved));
                setView(null);
                announce(`${saved.name} saved as a patient-specific draft.`);
              }}
            >
              Save protocol draft
            </Btn>
          </div>
        )}
      >
        {draft && (
          <div className="flex flex-col gap-4 p-5">
            <div className="rounded-lg border border-warning bg-warning-tint px-3 py-2 text-[11.5px] leading-[1.45] text-warning">
              Draft only — editing does not activate, prescribe, order, or send anything. Practitioner approval and safety review remain required.
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Protocol name"><TextInput value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field>
              <Field label="Current phase"><TextInput value={draft.phase} onChange={(event) => setDraft({ ...draft, phase: event.target.value })} /></Field>
            </div>
            <Field label="Protocol summary"><TextArea rows={3} value={draft.summary} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} /></Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Goals (one per line)"><TextArea rows={5} value={draft.goals.join("\n")} onChange={(event) => setDraft({ ...draft, goals: lines(event.target.value) })} /></Field>
              <Field label="Success criteria (one per line)"><TextArea rows={5} value={draft.successCriteria.join("\n")} onChange={(event) => setDraft({ ...draft, successCriteria: lines(event.target.value) })} /></Field>
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <div>
                  <p className="m-0 text-[12.5px] font-bold text-ink">Herbs, supplements, and interventions</p>
                  <p className="mt-1 mb-0 text-[10.5px] text-faint">These rows belong only to this patient protocol.</p>
                </div>
                <Btn size="sm" onClick={() => setDraft({ ...draft, items: [...draft.items, newIntervention()] })}><Plus size={12} aria-hidden /> Add intervention</Btn>
              </div>
              <div className="flex flex-col gap-2">
                {draft.items.map((item, index) => (
                  <div key={index} data-testid={`protocol-intervention-${index}`} className="rounded-lg border border-line bg-sunken p-3">
                    <div className="grid grid-cols-[minmax(0,1fr)_140px_auto] items-end gap-2">
                      <Field label="Intervention"><TextInput value={item.label} onChange={(event) => updateItem(index, { label: event.target.value })} placeholder="Herb, supplement, food, lifestyle…" /></Field>
                      <Field label="Type"><Select value={item.kind} onChange={(event) => updateItem(index, { kind: event.target.value as ProtocolItem["kind"] })}><option value="supplement">Supplement / herb</option><option value="nutrition">Nutrition</option><option value="lifestyle">Lifestyle</option><option value="monitoring">Monitoring</option></Select></Field>
                      <Btn size="sm" variant="ghost" aria-label={`Remove ${item.label || `intervention ${index + 1}`}`} onClick={() => setDraft({ ...draft, items: draft.items.filter((_, itemIndex) => itemIndex !== index) })}><Trash2 size={13} aria-hidden /></Btn>
                    </div>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      <Field label="Schedule / dose"><TextInput value={item.schedule ?? ""} onChange={(event) => updateItem(index, { schedule: event.target.value })} placeholder="Patient-specific" /></Field>
                      <Field label="Instructions and rationale"><TextInput value={item.detail} onChange={(event) => updateItem(index, { detail: event.target.value })} /></Field>
                    </div>
                  </div>
                ))}
                {draft.items.length === 0 && <p className="m-0 rounded-lg border border-dashed border-line px-3 py-5 text-center text-[11.5px] text-faint">No interventions yet. Add only what belongs in this patient’s plan.</p>}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Linked nutrition plan"><TextInput value={draft.linkedNutritionPlan ?? ""} onChange={(event) => setDraft({ ...draft, linkedNutritionPlan: event.target.value })} /></Field>
              <Field label="Next review"><TextInput value={draft.nextReviewLabel} onChange={(event) => setDraft({ ...draft, nextReviewLabel: event.target.value })} /></Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Linked labs and sources (one per line)"><TextArea rows={4} value={draft.linkedLabs.join("\n")} onChange={(event) => setDraft({ ...draft, linkedLabs: lines(event.target.value) })} /></Field>
              <Field label="Stop criteria (one per line)"><TextArea rows={4} value={draft.stopCriteria.join("\n")} onChange={(event) => setDraft({ ...draft, stopCriteria: lines(event.target.value) })} /></Field>
            </div>
          </div>
        )}
      </Drawer>

      <Drawer
        open={view === "save-template" && selected != null}
        onClose={() => setView(null)}
        width={500}
        title="Save as practice template"
        sub="Reuse the structure with other patients"
        labelledBy="save-protocol-template-title"
        footer={<div className="flex justify-end gap-2"><Btn onClick={() => setView(null)}>Cancel</Btn><Btn variant="primary" disabled={!templateName.trim()} onClick={() => {
          if (!selected) return;
          const template = saveProtocolAsTemplate(selected, templateName.trim(), templateDescription.trim() || selected.summary);
          setView(null);
          announce(`${template.name} saved to protocol templates.`);
        }}>Save template</Btn></div>}
      >
        {selected && (
          <div className="flex flex-col gap-4 p-5">
            <p className="m-0 text-[12px] leading-[1.5] text-body">
              This copies the protocol structure, phases, monitoring, safety gates, and interventions into a reusable template. Future patient protocols are independent copies.
            </p>
            <Field label="Template name"><TextInput value={templateName} onChange={(event) => setTemplateName(event.target.value)} /></Field>
            <Field label="Description"><TextArea rows={3} value={templateDescription} onChange={(event) => setTemplateDescription(event.target.value)} /></Field>
            <div className="rounded-lg border border-line bg-sunken px-3 py-3 text-[11.5px] text-subtle">
              <div className="flex items-center gap-2"><Pill tone="slate">Template copy</Pill><span>{selected.phases.length} phases · {selected.items.length} interventions · {selected.safety.length} safety checks</span></div>
              <p className="mt-2 mb-0">Review patient-specific doses, products, contraindications, and instructions each time this template is used.</p>
            </div>
          </div>
        )}
      </Drawer>
    </>
  );
}
