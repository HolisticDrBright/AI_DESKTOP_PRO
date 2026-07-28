"use client";

import { useMemo, useState, type ChangeEvent } from "react";
import {
  ArrowDown,
  ArrowUp,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  FilePlus2,
  FileText,
  LayoutTemplate,
  Lock,
  Mic,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import {
  createChartEntry,
  createCustomChartTemplate,
  duplicateChartEntry,
  getChartTemplate,
  signChartEntry,
  updateChartEntry,
  useChartEntries,
  useChartTemplates,
  type ChartEntry,
  type ChartFieldDefinition,
  type ChartFieldType,
  type ChartTemplate,
  type ChartValue,
  type BodyMapValue,
} from "@/adapters/charting.mock";
import { useFeedback } from "@/lib/feedback";
import { cn } from "@/lib/cn";
import { Btn } from "@/components/ui/Btn";
import { Card } from "@/components/ui/bits";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { DemoNote } from "@/components/ui/DemoNote";
import { Drawer } from "@/components/ui/Drawer";
import { Field, Select, TextArea, TextInput } from "@/components/ui/Field";
import { Pill, Tag } from "@/components/ui/Pill";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { ChartTimeline } from "./ChartTimeline";
import { BodyMapField } from "./BodyMapField";
import { ChartScribePreview } from "./ChartScribePreview";

type WorkspaceView = "Chart entries" | "Full timeline";
type EntryFilter = "All" | "Draft" | "Signed";
type DrawerMode = "new" | "edit" | "copy" | "templates" | "builder" | "scribe" | null;

const FIELD_TYPE_LABEL: Record<ChartFieldType, string> = {
  "long-text": "Long text",
  "short-text": "Short text",
  number: "Number",
  scale: "0–10 scale",
  checkbox: "Checkbox",
  select: "Choice list",
  "checkbox-group": "Checkbox group",
  "body-map": "Body map / drawing",
  heading: "Section heading",
};

function localDate(offsetDays = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function formatDate(iso: string): string {
  const date = new Date(`${iso}T12:00:00`);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function hasValue(value: ChartValue | undefined): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return Boolean(value.trim());
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value?.annotations.length);
}

function requiredComplete(entry: ChartEntry, template?: ChartTemplate): boolean {
  return (template?.fields ?? [])
    .filter((field) => field.required)
    .every((field) => hasValue(entry.values[field.id]));
}

function preview(entry: ChartEntry, template?: ChartTemplate): string {
  for (const field of template?.fields ?? []) {
    const value = entry.values[field.id];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value) && value.length) return value.join(", ");
  }
  return entry.status === "draft" ? "Empty draft — ready to document." : "Signed chart entry.";
}

function EntryField({
  field,
  value,
  disabled,
  onChange,
}: {
  field: ChartFieldDefinition;
  value: ChartValue | undefined;
  disabled: boolean;
  onChange: (value: ChartValue) => void;
}) {
  if (field.type === "heading") {
    return (
      <div className="border-b border-line pt-2 pb-2">
        <h3 className="m-0 text-[14px] font-bold text-ink">{field.label}</h3>
        {field.prompt && <p className="mt-1 mb-0 text-[11.5px] text-subtle">{field.prompt}</p>}
      </div>
    );
  }

  if (field.type === "body-map") {
    const mapValue = typeof value === "object" && !Array.isArray(value)
      ? value as BodyMapValue
      : { annotations: [] };
    return (
      <Field label={`${field.label}${field.required ? " *" : ""}`}>
        <BodyMapField value={mapValue} disabled={disabled} onChange={onChange} />
        {field.prompt && <p className="mt-1 mb-0 text-[11px] text-faint">{field.prompt}</p>}
      </Field>
    );
  }

  if (field.type === "checkbox-group") {
    const selected = Array.isArray(value) ? value : [];
    return (
      <Field label={`${field.label}${field.required ? " *" : ""}`}>
        <div className="grid grid-cols-2 gap-2 rounded-lg border border-line bg-sunken p-3 sm:grid-cols-3">
          {(field.options ?? []).map((option) => (
            <label key={option} className="flex items-start gap-2 text-[12px] font-medium text-body">
              <input
                type="checkbox"
                checked={selected.includes(option)}
                disabled={disabled}
                onChange={(event) => onChange(event.target.checked ? [...selected, option] : selected.filter((item) => item !== option))}
                className="mt-px accent-action"
              />
              {option}
            </label>
          ))}
        </div>
        {field.prompt && <p className="mt-1 mb-0 text-[11px] text-faint">{field.prompt}</p>}
      </Field>
    );
  }

  if (field.type === "checkbox") {
    return (
      <label className="flex items-start gap-2 rounded-lg border border-line bg-sunken px-3 py-[10px] text-[12.5px] text-body">
        <input
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          className="mt-[2px] accent-action"
        />
        <span>
          <span className="font-semibold text-ink">{field.label}{field.required ? " *" : ""}</span>
          {field.prompt && <span className="mt-[2px] block text-[11.5px] text-subtle">{field.prompt}</span>}
        </span>
      </label>
    );
  }

  if (field.type === "scale") {
    const scale = typeof value === "string" && value ? value : "0";
    return (
      <Field label={`${field.label}${field.required ? " *" : ""}`}>
        <div className="rounded-lg border border-line bg-sunken px-3 py-[10px]">
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-faint">0</span>
            <input
              type="range"
              min="0"
              max="10"
              value={scale}
              disabled={disabled}
              onChange={(event) => onChange(event.target.value)}
              aria-label={field.label}
              className="min-w-0 flex-1 accent-action"
            />
            <output className="w-10 text-right text-[13px] font-bold tabular-nums text-ink">{scale}/10</output>
          </div>
          {field.prompt && <p className="mt-1 mb-0 text-[11px] text-faint">{field.prompt}</p>}
        </div>
      </Field>
    );
  }

  if (field.type === "select") {
    return (
      <Field label={`${field.label}${field.required ? " *" : ""}`}>
        <Select
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">Select…</option>
          {(field.options ?? []).map((option) => <option key={option}>{option}</option>)}
        </Select>
      </Field>
    );
  }

  const common = {
    value: typeof value === "string" ? value : "",
    disabled,
    placeholder: field.prompt,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(event.target.value),
  };
  return (
    <Field label={`${field.label}${field.required ? " *" : ""}`}>
      {field.type === "long-text" ? (
        <TextArea {...common} rows={5} />
      ) : (
        <TextInput {...common} type={field.type === "number" ? "number" : "text"} />
      )}
    </Field>
  );
}

export function ChartWorkspace({
  patientId,
  patientName,
}: {
  patientId: string;
  patientName: string;
}) {
  const { announce } = useFeedback();
  const entries = useChartEntries(patientId);
  const templates = useChartTemplates();
  const [view, setView] = useState<WorkspaceView>("Chart entries");
  const [filter, setFilter] = useState<EntryFilter>("All");
  const [q, setQ] = useState("");
  const [drawer, setDrawer] = useState<DrawerMode>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState(templates[0]?.id ?? "");
  const [entryDate, setEntryDate] = useState(localDate());
  const [expandedId, setExpandedId] = useState<string | null>(entries[0]?.id ?? null);
  const [signingId, setSigningId] = useState<string | null>(null);
  const [customName, setCustomName] = useState("");
  const [customCategory, setCustomCategory] = useState("Progress note");
  const [customDescription, setCustomDescription] = useState("");
  const [customFields, setCustomFields] = useState<ChartFieldDefinition[]>([
    { id: "", label: "Clinical note", type: "long-text", required: true },
  ]);

  const selected = entries.find((entry) => entry.id === selectedId) ?? null;
  const selectedTemplate = selected ? templates.find((template) => template.id === selected.templateId) : undefined;
  const draftCount = entries.filter((entry) => entry.status === "draft").length;
  const signedCount = entries.filter((entry) => entry.status === "signed").length;

  const visible = useMemo(() => entries.filter((entry) => {
    if (filter === "Draft" && entry.status !== "draft") return false;
    if (filter === "Signed" && entry.status !== "signed") return false;
    if (q && !`${entry.templateName} ${preview(entry, getChartTemplate(entry.templateId))}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  }), [entries, filter, q]);

  const openEditor = (entry: ChartEntry) => {
    setSelectedId(entry.id);
    setDrawer("edit");
  };

  const createFrom = (templateId = selectedTemplateId) => {
    const entry = createChartEntry(patientId, templateId, entryDate);
    setSelectedId(entry.id);
    setExpandedId(entry.id);
    setDrawer("edit");
    announce(`${entry.templateName} draft created.`);
  };

  const updateValue = (fieldId: string, value: ChartValue) => {
    if (!selected) return;
    updateChartEntry(selected.id, { values: { ...selected.values, [fieldId]: value } });
  };

  const resetBuilder = () => {
    setCustomName("");
    setCustomCategory("Progress note");
    setCustomDescription("");
    setCustomFields([{ id: "", label: "Clinical note", type: "long-text", required: true }]);
  };

  const moveCustomField = (index: number, direction: -1 | 1) => {
    setCustomFields((fields) => {
      const target = index + direction;
      if (target < 0 || target >= fields.length) return fields;
      const next = [...fields];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const saveCustomTemplate = () => {
    const fields = customFields.filter((field) => field.label.trim()).map((field) => ({
      ...field,
      id: field.id || `field-${Math.random().toString(36).slice(2)}`,
      label: field.label.trim(),
      options: field.type === "select" || field.type === "checkbox-group"
        ? field.options?.filter(Boolean).length
          ? field.options.filter(Boolean)
          : ["Option 1", "Option 2", "Option 3"]
        : undefined,
    }));
    if (!customName.trim() || fields.length === 0) return;
    const template = createCustomChartTemplate({
      name: customName.trim(),
      category: customCategory.trim() || "Custom",
      description: customDescription.trim() || "Practice-created chart template.",
      fields,
    });
    setSelectedTemplateId(template.id);
    resetBuilder();
    setDrawer("templates");
    announce(`${template.name} saved to practice templates.`);
  };

  return (
    <div data-screen-label="Chart entries" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="m-0 text-[18px] font-bold text-ink">Patient chart</h2>
          <p className="mt-1 mb-0 max-w-[660px] text-[12.5px] text-subtle">
            Document visits, reuse practice templates, and copy a prior note into a new editable draft.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Btn onClick={() => setDrawer("templates")}><LayoutTemplate size={14} aria-hidden /> Templates</Btn>
          <Btn onClick={() => setDrawer("scribe")}><Mic size={14} aria-hidden /> AI Scribe</Btn>
          <Btn
            variant="primary"
            onClick={() => {
              setEntryDate(localDate());
              setDrawer("new");
            }}
          >
            <FilePlus2 size={14} aria-hidden /> New chart entry
          </Btn>
        </div>
      </div>

      <Card className="flex flex-wrap items-center gap-5 px-4 py-3">
        <div><span className="block text-[19px] font-bold tabular-nums text-ink">{entries.length}</span><span className="text-[11px] text-subtle">Chart entries</span></div>
        <div className="h-8 w-px bg-line" aria-hidden />
        <div><span className="block text-[19px] font-bold tabular-nums text-warning">{draftCount}</span><span className="text-[11px] text-subtle">Drafts to finish</span></div>
        <div className="h-8 w-px bg-line" aria-hidden />
        <div><span className="block text-[19px] font-bold tabular-nums text-positive">{signedCount}</span><span className="text-[11px] text-subtle">Signed and locked</span></div>
        <div className="ml-auto"><SegmentedControl options={["Chart entries", "Full timeline"]} value={view} onChange={(value) => setView(value as WorkspaceView)} ariaLabel="Chart view" /></div>
      </Card>

      {view === "Full timeline" ? (
        <ChartTimeline patientId={patientId} patientName={patientName} />
      ) : (
        <>
          <Card className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative mr-1">
                <Search size={13} className="absolute top-1/2 left-[9px] -translate-y-1/2 text-faint" aria-hidden />
                <TextInput value={q} onChange={(event) => setQ(event.target.value)} placeholder="Search chart entries…" aria-label="Search chart entries" className="w-[230px] pl-[28px]" />
              </div>
              {(["All", "Draft", "Signed"] as EntryFilter[]).map((option) => (
                <button
                  key={option}
                  onClick={() => setFilter(option)}
                  aria-pressed={filter === option}
                  className={cn(
                    "h-7 cursor-pointer rounded-full border px-[10px] text-[11.5px] font-semibold focus-visible:outline-2 focus-visible:outline-action",
                    filter === option ? "border-nav-active-line bg-nav-active text-action-deep" : "border-line bg-card text-muted hover:border-line-hover",
                  )}
                >
                  {option}
                </button>
              ))}
            </div>
          </Card>

          {visible.length === 0 ? (
            <Card className="px-4 py-10 text-center">
              <FileText size={22} className="mx-auto mb-2 text-faint" aria-hidden />
              <p className="m-0 text-[13px] font-semibold text-ink">No matching chart entries</p>
              <p className="mt-1 mb-0 text-[12px] text-subtle">Clear the filters or create a new chart entry.</p>
            </Card>
          ) : visible.map((entry) => {
            const template = templates.find((item) => item.id === entry.templateId);
            const expanded = expandedId === entry.id;
            return (
              <Card key={entry.id} className="overflow-hidden">
                <div className="flex items-start gap-3 px-4 py-3">
                  <button
                    onClick={() => setExpandedId(expanded ? null : entry.id)}
                    aria-label={`${expanded ? "Collapse" : "Expand"} ${entry.templateName}`}
                    className="mt-[1px] flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-line bg-card text-muted hover:bg-sunken focus-visible:outline-2 focus-visible:outline-action"
                  >
                    {expanded ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
                  </button>
                  <button onClick={() => setExpandedId(expanded ? null : entry.id)} className="min-w-0 flex-1 cursor-pointer text-left focus-visible:outline-2 focus-visible:outline-action">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-[13.5px] font-bold text-ink">{entry.templateName}</span>
                      <Tag>{template?.category ?? "Clinical note"}</Tag>
                      <Pill tone={entry.status === "signed" ? "positive" : "warning"}>{entry.status}</Pill>
                      {entry.copiedFrom && <Tag>Copied forward</Tag>}
                    </span>
                    <span className="mt-[3px] block line-clamp-2 text-[12px] leading-[1.45] text-body">{preview(entry, template)}</span>
                    <span className="mt-[3px] flex items-center gap-2 text-[11px] text-faint">
                      <CalendarDays size={11} aria-hidden /> {formatDate(entry.encounterDate)} · {entry.author} · {entry.updatedLabel}
                    </span>
                  </button>
                  <div className="flex shrink-0 gap-1">
                    {entry.status === "draft" && <Btn size="sm" onClick={() => openEditor(entry)}>Edit</Btn>}
                    <Btn size="sm" onClick={() => { setSelectedId(entry.id); setEntryDate(localDate(1)); setDrawer("copy"); }} aria-label={`Duplicate ${entry.templateName} forward`}>
                      <Copy size={12} aria-hidden /> Duplicate
                    </Btn>
                  </div>
                </div>
                {expanded && (
                  <div className="border-t border-hairline bg-sunken px-5 py-4">
                    {entry.copiedFrom && (
                      <p className="mt-0 mb-3 rounded-lg border border-line bg-card px-3 py-2 text-[11.5px] text-subtle">
                        Copied from the {formatDate(entry.copiedFrom.encounterDate)} entry. This is a separate draft; editing it never changes the source.
                      </p>
                    )}
                    <div className="grid gap-4 md:grid-cols-2">
                      {(template?.fields ?? []).map((field) => {
                        const value = entry.values[field.id];
                        if (field.type === "heading") {
                          return <h3 key={field.id} className="m-0 border-b border-line pb-2 text-[13px] font-bold text-ink md:col-span-2">{field.label}</h3>;
                        }
                        if (!hasValue(value)) return null;
                        if (field.type === "body-map") {
                          return (
                            <div key={field.id} className="md:col-span-2">
                              <p className="m-0 mb-2 text-[11px] font-bold tracking-[0.04em] text-faint uppercase">{field.label}</p>
                              <BodyMapField value={value as BodyMapValue} disabled onChange={() => undefined} />
                            </div>
                          );
                        }
                        return (
                          <div key={field.id} className={field.type === "long-text" ? "md:col-span-2" : ""}>
                            <p className="m-0 text-[11px] font-bold tracking-[0.04em] text-faint uppercase">{field.label}</p>
                            <p className="mt-1 mb-0 whitespace-pre-wrap text-[12.5px] leading-[1.55] text-body">{typeof value === "boolean" ? (value ? "Yes" : "No") : Array.isArray(value) ? value.join(" · ") : typeof value === "string" ? value : "Annotated body map"}</p>
                          </div>
                        );
                      })}
                    </div>
                    {entry.status === "signed" && <p className="mt-4 mb-0 flex items-center gap-1 text-[11.5px] font-semibold text-positive"><Lock size={12} aria-hidden /> {entry.signedLabel}</p>}
                  </div>
                )}
              </Card>
            );
          })}
        </>
      )}

      <DemoNote>
        Demo charting workspace — drafts and custom templates persist for this browser session only. In live mode, autosave, signatures, locking, addenda, and audit history remain enforced by the clinical backend.
      </DemoNote>

      <Drawer
        open={drawer === "new"}
        onClose={() => setDrawer(null)}
        width={600}
        title="New chart entry"
        sub={`Choose a structure for ${patientName}`}
        labelledBy="new-chart-entry-title"
        footer={<div className="flex justify-end gap-2"><Btn onClick={() => setDrawer(null)}>Cancel</Btn><Btn variant="primary" onClick={() => createFrom()} disabled={!selectedTemplateId}>Create draft</Btn></div>}
      >
        <div className="flex flex-col gap-4 p-5">
          <Field label="Encounter date"><TextInput type="date" value={entryDate} onChange={(event) => setEntryDate(event.target.value)} /></Field>
          <div>
            <p className="mt-0 mb-2 text-[11.5px] font-semibold text-subtle">Chart template</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {templates.map((template) => (
                <button
                  key={template.id}
                  onClick={() => setSelectedTemplateId(template.id)}
                  aria-pressed={selectedTemplateId === template.id}
                  className={cn(
                    "cursor-pointer rounded-lg border p-3 text-left focus-visible:outline-2 focus-visible:outline-action",
                    selectedTemplateId === template.id ? "border-action bg-action-tint" : "border-line bg-card hover:border-line-hover",
                  )}
                >
                  <span className="block text-[12.5px] font-bold text-ink">{template.name}</span>
                  <span className="mt-1 block text-[11.5px] leading-[1.4] text-subtle">{template.description}</span>
                  <span className="mt-2 block text-[10.5px] font-semibold text-faint">{template.category} · {template.fields.length} fields{template.builtIn ? " · Premade" : " · Practice template"}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </Drawer>

      <Drawer
        open={drawer === "scribe"}
        onClose={() => setDrawer(null)}
        width={760}
        title="AI Scribe"
        sub={`${patientName} · in-person visit capture`}
        labelledBy="chart-scribe-title"
      >
        <ChartScribePreview
          patientName={patientName}
          onCreateDraft={(transcript) => {
            const entry = createChartEntry(patientId, "chart-soap-followup", localDate());
            updateChartEntry(entry.id, {
              values: {
                ...entry.values,
                subjective: transcript,
                objective: "Review transcript-derived details against the encounter, chart, and observed findings.",
                assessment: "Practitioner assessment required before signing.",
                plan: "Practitioner plan required before signing.",
              },
            });
            setSelectedId(entry.id);
            setExpandedId(entry.id);
            setDrawer("edit");
            announce("Scribe content added to a practitioner-review draft. Nothing was signed.");
          }}
        />
      </Drawer>

      <Drawer
        open={drawer === "edit" && selected != null}
        onClose={() => setDrawer(null)}
        width={960}
        title={selected?.templateName ?? "Chart entry"}
        sub={selected ? `${patientName} · ${formatDate(selected.encounterDate)}` : undefined}
        labelledBy="chart-editor-title"
        footer={selected && (
          <div className="flex items-center gap-2">
            <span className="mr-auto text-[11px] text-faint">{selected.status === "draft" ? "Autosaved · demo session" : selected.signedLabel}</span>
            <Btn onClick={() => setDrawer(null)}>Close</Btn>
            {selected.status === "draft" && (
              <Btn variant="primary" disabled={!requiredComplete(selected, selectedTemplate)} onClick={() => setSigningId(selected.id)}>
                <Lock size={12} aria-hidden /> Review and sign
              </Btn>
            )}
          </div>
        )}
      >
        {selected && (
          <div className="flex flex-col gap-4 p-5">
            {selected.status === "signed" ? (
              <div className="flex items-start gap-2 rounded-lg border border-positive bg-positive-tint px-3 py-[10px] text-[12px] text-positive">
                <CheckCircle2 size={15} className="mt-px shrink-0" aria-hidden />
                <span><strong>Signed and locked.</strong> Corrections belong in an append-only addendum; the original entry cannot be changed.</span>
              </div>
            ) : !requiredComplete(selected, selectedTemplate) ? (
              <p className="m-0 rounded-lg border border-warning bg-warning-tint px-3 py-2 text-[11.5px] text-warning">Complete every field marked * before signing.</p>
            ) : null}
            {selected.copiedFrom && (
              <p className="m-0 rounded-lg border border-line bg-sunken px-3 py-2 text-[11.5px] text-subtle">
                Copied forward from {formatDate(selected.copiedFrom.encounterDate)}. Review every carried-forward statement for today’s visit.
              </p>
            )}
            <Field label="Encounter date">
              <TextInput type="date" value={selected.encounterDate} disabled={selected.status === "signed"} onChange={(event) => updateChartEntry(selected.id, { encounterDate: event.target.value })} />
            </Field>
            {(selectedTemplate?.fields ?? []).map((field) => (
              <EntryField key={field.id} field={field} value={selected.values[field.id]} disabled={selected.status === "signed"} onChange={(value) => updateValue(field.id, value)} />
            ))}
          </div>
        )}
      </Drawer>

      <Drawer
        open={drawer === "copy" && selected != null}
        onClose={() => setDrawer(null)}
        width={480}
        title="Duplicate forward"
        sub="Create a separate editable draft"
        labelledBy="copy-chart-entry-title"
        footer={<div className="flex justify-end gap-2"><Btn onClick={() => setDrawer(null)}>Cancel</Btn><Btn variant="primary" onClick={() => {
          if (!selected) return;
          const copy = duplicateChartEntry(selected.id, entryDate);
          if (!copy) return;
          setSelectedId(copy.id);
          setExpandedId(copy.id);
          setDrawer("edit");
          announce("Chart entry copied forward into a new draft.");
        }}><Copy size={12} aria-hidden /> Create copied draft</Btn></div>}
      >
        {selected && (
          <div className="flex flex-col gap-4 p-5">
            <p className="m-0 text-[12.5px] leading-[1.55] text-body">
              Copy <strong>{selected.templateName}</strong> from {formatDate(selected.encounterDate)}. The original remains unchanged and signed entries stay locked.
            </p>
            <Field label="New encounter date"><TextInput type="date" value={entryDate} onChange={(event) => setEntryDate(event.target.value)} /></Field>
            <p className="m-0 rounded-lg border border-warning bg-warning-tint px-3 py-2 text-[11.5px] text-warning">Review all carried-forward information and remove anything that is no longer true before signing.</p>
          </div>
        )}
      </Drawer>

      <Drawer
        open={drawer === "templates"}
        onClose={() => setDrawer(null)}
        width={600}
        title="Chart templates"
        sub={`${templates.length} premade and practice-created structures`}
        labelledBy="chart-templates-title"
        footer={<div className="flex justify-end"><Btn variant="primary" onClick={() => setDrawer("builder")}><Plus size={13} aria-hidden /> Create custom chart</Btn></div>}
      >
        <div className="divide-y divide-hairline">
          {templates.map((template) => (
            <div key={template.id} className="flex items-start gap-3 px-5 py-4">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-action-tint text-action"><FileText size={15} aria-hidden /></span>
              <div className="min-w-0 flex-1">
                <p className="m-0 flex flex-wrap items-center gap-2 text-[12.5px] font-bold text-ink">{template.name}<Tag>{template.builtIn ? "Premade" : "Practice"}</Tag></p>
                <p className="mt-1 mb-0 text-[11.5px] leading-[1.45] text-subtle">{template.description}</p>
                <p className="mt-1 mb-0 text-[10.5px] text-faint">{template.category} · {template.fields.length} fields</p>
              </div>
              <Btn size="sm" onClick={() => { setSelectedTemplateId(template.id); setEntryDate(localDate()); setDrawer("new"); }}>Use</Btn>
            </div>
          ))}
        </div>
      </Drawer>

      <Drawer
        open={drawer === "builder"}
        onClose={() => { resetBuilder(); setDrawer(null); }}
        width={780}
        title="Create custom chart"
        sub="Build a reusable practice template"
        labelledBy="custom-chart-builder-title"
        footer={<div className="flex justify-end gap-2"><Btn onClick={() => setDrawer("templates")}>Cancel</Btn><Btn variant="primary" disabled={!customName.trim() || customFields.every((field) => !field.label.trim())} onClick={saveCustomTemplate}>Save template</Btn></div>}
      >
        <div className="flex flex-col gap-4 p-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Template name"><TextInput value={customName} onChange={(event) => setCustomName(event.target.value)} placeholder="e.g. Acupuncture follow-up" /></Field>
            <Field label="Category"><TextInput value={customCategory} onChange={(event) => setCustomCategory(event.target.value)} /></Field>
          </div>
          <Field label="Description"><TextArea value={customDescription} onChange={(event) => setCustomDescription(event.target.value)} rows={2} placeholder="When should practitioners use this chart?" /></Field>
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="m-0 text-[11.5px] font-semibold text-subtle">Chart fields</p>
              <Btn size="sm" onClick={() => setCustomFields((fields) => [...fields, { id: "", label: "", type: "long-text", required: false }])}><Plus size={12} aria-hidden /> Add field</Btn>
            </div>
            <div className="flex flex-col gap-2">
              {customFields.map((field, index) => (
                <div key={index} data-testid={`chart-builder-field-${index + 1}`} className="grid grid-cols-[minmax(0,1fr)_180px_auto] items-end gap-2 rounded-lg border border-line bg-sunken p-3">
                  <Field label={`Field ${index + 1}`}><TextInput value={field.label} onChange={(event) => setCustomFields((fields) => fields.map((item, i) => i === index ? { ...item, label: event.target.value } : item))} placeholder="Field label" /></Field>
                  <Field label="Input type"><Select value={field.type} onChange={(event) => setCustomFields((fields) => fields.map((item, i) => i === index ? { ...item, type: event.target.value as ChartFieldType, required: event.target.value === "heading" ? false : item.required } : item))}>{Object.entries(FIELD_TYPE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>
                  <div className="flex items-center gap-1">
                    <Btn size="sm" variant="ghost" aria-label={`Move field ${index + 1} up`} disabled={index === 0} onClick={() => moveCustomField(index, -1)}><ArrowUp size={13} aria-hidden /></Btn>
                    <Btn size="sm" variant="ghost" aria-label={`Move field ${index + 1} down`} disabled={index === customFields.length - 1} onClick={() => moveCustomField(index, 1)}><ArrowDown size={13} aria-hidden /></Btn>
                    <Btn size="sm" variant="ghost" aria-label={`Remove field ${index + 1}`} disabled={customFields.length === 1} onClick={() => setCustomFields((fields) => fields.filter((_, i) => i !== index))}><Trash2 size={13} aria-hidden /></Btn>
                  </div>
                  {field.type !== "heading" && (
                    <Field label="Prompt / instructions" className="col-span-3"><TextInput value={field.prompt ?? ""} onChange={(event) => setCustomFields((fields) => fields.map((item, i) => i === index ? { ...item, prompt: event.target.value } : item))} placeholder="Optional guidance shown under the field" /></Field>
                  )}
                  {(field.type === "select" || field.type === "checkbox-group") && (
                    <Field label="Choices (comma separated)" className="col-span-3"><TextInput value={(field.options ?? []).join(", ")} onChange={(event) => setCustomFields((fields) => fields.map((item, i) => i === index ? { ...item, options: event.target.value.split(",").map((option) => option.trim()) } : item))} placeholder="Improved, Stable, Worsened" /></Field>
                  )}
                  {field.type !== "heading" && <label className="col-span-3 flex items-center gap-2 text-[11.5px] text-subtle"><input type="checkbox" checked={Boolean(field.required)} onChange={(event) => setCustomFields((fields) => fields.map((item, i) => i === index ? { ...item, required: event.target.checked } : item))} className="accent-action" /> Required before signing</label>}
                </div>
              ))}
            </div>
          </div>
        </div>
      </Drawer>

      <ConfirmDialog
        open={signingId != null}
        title="Sign and lock this chart entry?"
        body="Signing finalizes the clinical record. The original entry can no longer be edited; later corrections must be documented as an addendum."
        confirmLabel="Sign chart entry"
        onCancel={() => setSigningId(null)}
        onConfirm={() => {
          if (!signingId) return;
          signChartEntry(signingId);
          setSigningId(null);
          announce("Chart entry signed and locked for this demo session.");
        }}
      />
    </div>
  );
}
