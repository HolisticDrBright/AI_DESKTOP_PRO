"use client";

import Image from "next/image";
import { useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Award,
  BookOpen,
  ChevronRight,
  Eye,
  FileDown,
  FileText,
  GripVertical,
  Headphones,
  Image as ImageIcon,
  ListChecks,
  Lock,
  Pencil,
  Plus,
  Radio,
  Sparkles,
  Video,
} from "lucide-react";
import {
  approveProgramDraft,
  generateProgramDraft,
  getProgramAnalytics,
  LEARNERS,
  LESSON_TYPE_LABEL,
  listPrograms,
  publishProgram,
  saveProgram,
  STANDARD_DISCLAIMER,
  useStudioState,
  type CopilotInput,
  type CopilotVersion,
  type Lesson,
  type LessonType,
  type Program,
} from "@/adapters/programs-studio.mock";
import { useFeedback } from "@/lib/feedback";
import { formatMinor } from "@/lib/money";
import { thumbDataUri } from "@/lib/thumb";
import { toneColor } from "@/lib/tones";
import { cn } from "@/lib/cn";
import { Card, CardTitle, ProgressBar } from "@/components/ui/bits";
import { Btn } from "@/components/ui/Btn";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Drawer } from "@/components/ui/Drawer";
import { Field, Select, TextInput } from "@/components/ui/Field";
import { Metric } from "@/components/ui/Metric";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pill, Tag } from "@/components/ui/Pill";
import { Sparkline } from "@/components/ui/Sparkline";
import { DemoNote } from "@/components/ui/DemoNote";

const LESSON_ICON: Record<LessonType, React.ReactNode> = {
  video: <Video size={13} aria-hidden />,
  audio: <Headphones size={13} aria-hidden />,
  text: <FileText size={13} aria-hidden />,
  image: <ImageIcon size={13} aria-hidden />,
  document: <FileText size={13} aria-hidden />,
  download: <FileDown size={13} aria-hidden />,
  quiz: <ListChecks size={13} aria-hidden />,
  "live-session": <Radio size={13} aria-hidden />,
  assignment: <Pencil size={13} aria-hidden />,
};

/* ------------------------------------------------------------------ catalog */

function Catalog({ onOpen, onCopilot }: { onOpen: (id: string) => void; onCopilot: () => void }) {
  useStudioState();
  const programs = listPrograms();
  const published = programs.filter((p) => p.status === "published");
  const revenue = programs.reduce((n, p) => n + p.revenueMinor, 0);
  const active = programs.reduce((n, p) => n + p.enrollment.active, 0);

  return (
    <section data-screen-label="Programs" className="mx-auto max-w-[1560px] px-[22px] pt-[18px] pb-6">
      <PageHeader
        crumb="Business / Programs"
        title="Programs Studio"
        sub="Create, price, and run practice programs — original AI Longevity Pro catalog, demo data."
        actions={
          <Btn variant="ai" onClick={onCopilot}>
            <Sparkles size={13} aria-hidden /> AI Program Copilot
          </Btn>
        }
      />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Products" value={programs.length} sub={`${published.length} published · ${programs.length - published.length} draft`} />
        <Metric label="Active learners" value={active} sub="Across all programs" />
        <Metric label="Lifetime revenue" value={formatMinor(revenue)} sub="Demo ledger" />
        <Metric label="Avg completion" value="53%" sub="Published programs" />
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {programs.map((p) => (
          <button
            key={p.id}
            onClick={() => onOpen(p.id)}
            className="cursor-pointer overflow-hidden rounded-lg border border-line bg-card text-left transition hover:border-line-hover hover:shadow-[0_4px_16px_rgba(24,42,61,0.08)] focus-visible:outline-2 focus-visible:outline-action"
          >
            <Image src={thumbDataUri(p.thumbSeed, p.title)} alt="" width={320} height={200} unoptimized className="h-[140px] w-full object-cover" />
            <div className="p-[14px]">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[13.5px] font-bold text-ink">{p.title}</span>
                <Pill tone={p.status === "published" ? "positive" : "slate"}>{p.status}</Pill>
                {p.aiDraft && !p.approved && <Pill tone="ai">AI draft</Pill>}
              </div>
              <p className="m-0 mt-1 line-clamp-2 text-[12px] leading-[1.45] text-body">{p.tagline}</p>
              <div className="mt-2 flex items-center gap-3 text-[11.5px] text-subtle">
                <span>{p.modules.length} modules</span>
                <span>{p.modules.reduce((n, m) => n + m.lessons.length, 0)} lessons</span>
                <span>{p.enrollment.active} active</span>
                <span className="ml-auto font-semibold text-ink">{p.offers[0] ? formatMinor(p.offers[0].amountMinor) : "—"}</span>
              </div>
            </div>
          </button>
        ))}
      </div>
      <DemoNote className="mt-4">
        Demo catalog — synthetic programs, learners, and revenue. Thumbnails are locally
        generated bitmaps (no remote assets). Publishing changes this session&apos;s catalog only.
      </DemoNote>
    </section>
  );
}

/* ------------------------------------------------------------------ builder */

type BuilderTab = "curriculum" | "pricing" | "learners" | "analytics" | "preview";

function LessonRow({
  lesson,
  onMove,
  onEdit,
  canUp,
  canDown,
}: {
  lesson: Lesson;
  onMove: (dir: -1 | 1) => void;
  onEdit: () => void;
  canUp: boolean;
  canDown: boolean;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-hairline bg-card px-2 py-[6px]">
      <GripVertical size={13} className="shrink-0 cursor-grab text-ghost" aria-hidden />
      <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md bg-sunken text-muted">
        {LESSON_ICON[lesson.type]}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-[6px]">
          <span className="truncate text-[12.5px] font-medium text-ink">{lesson.title}</span>
          {lesson.aiDraft && <Pill tone="ai">AI draft</Pill>}
          {lesson.status === "draft" && <Pill tone="slate">draft</Pill>}
        </span>
        <span className="block text-[10.5px] text-faint">
          {LESSON_TYPE_LABEL[lesson.type]}
          {lesson.durationMin ? ` · ${lesson.durationMin} min` : ""}
          {lesson.drip ? ` · unlocks ${lesson.drip}` : " · available immediately"}
          {lesson.prerequisite ? ` · requires "${lesson.prerequisite}"` : ""}
        </span>
      </span>
      <Btn size="sm" variant="ghost" onClick={() => onMove(-1)} disabled={!canUp} aria-label={`Move ${lesson.title} up`}>
        <ArrowUp size={12} aria-hidden />
      </Btn>
      <Btn size="sm" variant="ghost" onClick={() => onMove(1)} disabled={!canDown} aria-label={`Move ${lesson.title} down`}>
        <ArrowDown size={12} aria-hidden />
      </Btn>
      <Btn size="sm" variant="ghost" onClick={onEdit} aria-label={`Edit ${lesson.title}`}>
        <Pencil size={12} aria-hidden />
      </Btn>
    </div>
  );
}

function CurriculumEditor({ program }: { program: Program }) {
  const { announce } = useFeedback();
  const [editing, setEditing] = useState<{ moduleId: string; lessonId: string } | null>(null);

  const mutate = (fn: (p: Program) => Program, label: string) => {
    saveProgram(fn(program), label);
    announce(`${label}. (demo — this session only)`);
  };

  const moveLesson = (moduleId: string, index: number, dir: -1 | 1) => {
    mutate((p) => {
      const modules = p.modules.map((m) => {
        if (m.id !== moduleId) return m;
        const lessons = [...m.lessons];
        const [item] = lessons.splice(index, 1);
        lessons.splice(index + dir, 0, item);
        return { ...m, lessons };
      });
      return { ...p, modules };
    }, "Lesson reordered");
  };

  const addLesson = (moduleId: string) => {
    mutate((p) => ({
      ...p,
      modules: p.modules.map((m) =>
        m.id === moduleId
          ? {
              ...m,
              lessons: [
                ...m.lessons,
                { id: `${Date.now()}`, title: "New lesson", type: "text" as LessonType, status: "draft" as const },
              ],
            }
          : m,
      ),
    }), "Lesson added");
  };

  const editingLesson = editing
    ? program.modules.find((m) => m.id === editing.moduleId)?.lessons.find((l) => l.id === editing.lessonId)
    : null;

  return (
    <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="flex flex-col gap-3">
        {program.modules.map((m, mi) => (
          <Card key={m.id} className="px-3 py-[10px]">
            <div className="mb-2 flex items-center gap-2">
              <BookOpen size={13} className="text-action" aria-hidden />
              <span className="flex-1 text-[12.5px] font-bold text-ink">{m.title}</span>
              <span className="text-[11px] text-faint">{m.lessons.length} lessons</span>
              <Btn size="sm" variant="ghost" disabled={mi === 0} aria-label={`Move ${m.title} up`}
                onClick={() => mutate((p) => {
                  const modules = [...p.modules];
                  const [x] = modules.splice(mi, 1);
                  modules.splice(mi - 1, 0, x);
                  return { ...p, modules };
                }, "Module reordered")}>
                <ArrowUp size={12} aria-hidden />
              </Btn>
              <Btn size="sm" variant="ghost" disabled={mi === program.modules.length - 1} aria-label={`Move ${m.title} down`}
                onClick={() => mutate((p) => {
                  const modules = [...p.modules];
                  const [x] = modules.splice(mi, 1);
                  modules.splice(mi + 1, 0, x);
                  return { ...p, modules };
                }, "Module reordered")}>
                <ArrowDown size={12} aria-hidden />
              </Btn>
              <Btn size="sm" onClick={() => addLesson(m.id)}>
                <Plus size={12} aria-hidden /> Lesson
              </Btn>
            </div>
            <div className="flex flex-col gap-[6px]">
              {m.lessons.map((l, li) => (
                <LessonRow
                  key={l.id}
                  lesson={l}
                  canUp={li > 0}
                  canDown={li < m.lessons.length - 1}
                  onMove={(dir) => moveLesson(m.id, li, dir)}
                  onEdit={() => setEditing({ moduleId: m.id, lessonId: l.id })}
                />
              ))}
            </div>
          </Card>
        ))}
      </div>

      <Card className="px-4 py-[14px]">
        {editingLesson && editing ? (
          <LessonEditor
            key={editingLesson.id}
            lesson={editingLesson}
            onSave={(patch) => {
              mutate((p) => ({
                ...p,
                modules: p.modules.map((m) =>
                  m.id === editing.moduleId
                    ? { ...m, lessons: m.lessons.map((l) => (l.id === editing.lessonId ? { ...l, ...patch } : l)) }
                    : m,
                ),
              }), "Lesson updated");
              setEditing(null);
            }}
            onClose={() => setEditing(null)}
          />
        ) : (
          <>
            <CardTitle className="mb-2">Lesson editor</CardTitle>
            <p className="m-0 text-[12px] leading-[1.5] text-subtle">
              Select a lesson to edit its title, type, duration, drip rule, and prerequisite.
              Reorder with the arrow buttons (keyboard-accessible) or drag handles.
            </p>
          </>
        )}
      </Card>
    </div>
  );
}

function LessonEditor({
  lesson,
  onSave,
  onClose,
}: {
  lesson: Lesson;
  onSave: (patch: Partial<Lesson>) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(lesson.title);
  const [type, setType] = useState<LessonType>(lesson.type);
  const [duration, setDuration] = useState(String(lesson.durationMin ?? ""));
  const [drip, setDrip] = useState(lesson.drip ?? "");
  const [prereq, setPrereq] = useState(lesson.prerequisite ?? "");
  const [status, setStatus] = useState(lesson.status);
  return (
    <div className="flex flex-col gap-2">
      <CardTitle>Edit lesson {lesson.aiDraft && <Pill tone="ai">AI draft — review required</Pill>}</CardTitle>
      <Field label="Title"><TextInput value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
      <Field label="Content type">
        <Select value={type} onChange={(e) => setType(e.target.value as LessonType)}>
          {(Object.keys(LESSON_TYPE_LABEL) as LessonType[]).map((t) => (
            <option key={t} value={t}>{LESSON_TYPE_LABEL[t]}</option>
          ))}
        </Select>
      </Field>
      <Field label="Duration (min, optional)"><TextInput value={duration} onChange={(e) => setDuration(e.target.value)} inputMode="numeric" /></Field>
      <Field label="Drip / unlock rule (e.g. Day 7 — empty = immediate)"><TextInput value={drip} onChange={(e) => setDrip(e.target.value)} /></Field>
      <Field label="Prerequisite lesson title (optional)"><TextInput value={prereq} onChange={(e) => setPrereq(e.target.value)} /></Field>
      <Field label="Status">
        <Select value={status} onChange={(e) => setStatus(e.target.value as "draft" | "published")}>
          <option value="draft">Draft</option>
          <option value="published">Published</option>
        </Select>
      </Field>
      <div className="mt-1 flex justify-end gap-2">
        <Btn size="sm" variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn size="sm" variant="primary" onClick={() =>
          onSave({
            title,
            type,
            durationMin: duration ? Number(duration) : undefined,
            drip: drip || undefined,
            prerequisite: prereq || undefined,
            status,
            aiDraft: lesson.aiDraft ? false : undefined, // practitioner edit clears the AI-draft flag
          })
        }>
          Save lesson
        </Btn>
      </div>
    </div>
  );
}

function PricingPanel({ program }: { program: Program }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card className="px-4 py-[14px]">
        <CardTitle className="mb-2">Offers</CardTitle>
        {program.offers.map((o) => (
          <div key={o.id} className="mb-2 rounded-lg border border-hairline bg-sunken px-3 py-[9px]">
            <div className="flex items-center gap-2">
              <span className="flex-1 text-[12.5px] font-semibold text-ink">{o.label}</span>
              <Tag>{o.kind}</Tag>
              <span className="text-[14px] font-bold text-ink">{formatMinor(o.amountMinor)}</span>
            </div>
            <p className="m-0 mt-[2px] text-[11.5px] text-subtle">{o.detail}</p>
          </div>
        ))}
        <p className="m-0 text-[11px] text-faint">One-time · subscription · payment-plan offers supported; checkout runs through the Stripe test-mode POS.</p>
      </Card>
      <Card className="px-4 py-[14px]">
        <CardTitle className="mb-2">Certificate & disclaimers</CardTitle>
        <div className="mb-2 flex items-center gap-2 text-[12.5px] text-body">
          <Award size={14} className={program.certificate.enabled ? "text-positive" : "text-faint"} aria-hidden />
          {program.certificate.enabled ? `Completion certificate: "${program.certificate.title}"` : "No certificate for this program"}
        </div>
        {program.disclaimers.map((d) => (
          <p key={d} className="m-0 mb-1 rounded-lg border border-hairline bg-sunken px-3 py-[7px] text-[11.5px] leading-[1.5] text-body">{d}</p>
        ))}
      </Card>
    </div>
  );
}

function LearnersPanel({ program }: { program: Program }) {
  const learners = LEARNERS.filter((l) => l.programId === program.id);
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2 border-b border-hairline px-4 py-[10px]">
        <CardTitle className="flex-1">Learners ({learners.length})</CardTitle>
        <span className="text-[11.5px] text-subtle">
          {program.enrollment.active} active · {program.enrollment.completed} completed · avg {program.enrollment.avgProgressPct}%
        </span>
      </div>
      {learners.length === 0 ? (
        <p className="m-0 px-4 py-6 text-center text-[12.5px] text-faint">No enrollments yet.</p>
      ) : (
        learners.map((l) => (
          <div key={l.id} className="flex items-center gap-3 border-b border-hairline px-4 py-[8px] last:border-b-0">
            <span className="w-[160px] shrink-0 truncate text-[12.5px] font-medium text-ink">{l.name}</span>
            <ProgressBar pct={l.progressPct} color={toneColor[l.completed ? "positive" : "action"]} className="flex-1" label={`${l.name} progress`} />
            <span className="w-[42px] text-right text-[11.5px] text-muted tabular-nums">{l.progressPct}%</span>
            <span className="w-[80px] text-right text-[11px] text-faint">{l.lastActiveLabel}</span>
            {l.completed && <Pill tone="positive">Completed</Pill>}
            {l.certificateIssued && <Pill tone="navy">Certificate</Pill>}
          </div>
        ))
      )}
    </Card>
  );
}

function AnalyticsPanel({ program }: { program: Program }) {
  const a = getProgramAnalytics(program.id);
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card className="px-4 py-[14px]">
        <CardTitle className="mb-1">Enrollments ({a.seriesLabels[0]} → {a.seriesLabels[a.seriesLabels.length - 1]})</CardTitle>
        <Sparkline values={a.enrollmentsBySeries} width={320} height={48} stroke={toneColor.action} strokeWidth={2} label="Enrollment trend" />
        <div className="mt-2 flex items-center gap-4 text-[12px] text-body">
          <span>Revenue <span className="font-bold text-ink">{formatMinor(program.revenueMinor)}</span></span>
          <span>Completion <span className="font-bold text-ink">{a.completionPct}%</span></span>
        </div>
      </Card>
      <Card className="px-4 py-[14px]">
        <CardTitle className="mb-2">Lesson engagement</CardTitle>
        {a.lessonEngagement.map((row) => (
          <div key={row.lesson} className="mb-[7px]">
            <div className="mb-[2px] flex justify-between text-[11.5px]">
              <span className="truncate text-body">{row.lesson}</span>
              <span className="text-muted tabular-nums">{row.pct}%</span>
            </div>
            <ProgressBar pct={row.pct} color={toneColor.teal} label={`${row.lesson} engagement`} />
          </div>
        ))}
      </Card>
    </div>
  );
}

function PreviewPanel({ program }: { program: Program }) {
  const [mode, setMode] = useState<"storefront" | "learner">("storefront");
  const lessons = program.modules.flatMap((m) => m.lessons);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Btn size="sm" variant={mode === "storefront" ? "primary" : "outline"} onClick={() => setMode("storefront")}>
          <Eye size={12} aria-hidden /> Storefront preview
        </Btn>
        <Btn size="sm" variant={mode === "learner" ? "primary" : "outline"} onClick={() => setMode("learner")}>
          <BookOpen size={12} aria-hidden /> Learner preview
        </Btn>
        <span className="ml-auto text-[11px] text-faint">Preview only — nothing is published from here.</span>
      </div>

      {mode === "storefront" ? (
        <Card className="overflow-hidden">
          <div className="grid grid-cols-1 lg:grid-cols-[380px_minmax(0,1fr)]">
            <Image src={thumbDataUri(program.thumbSeed, "")} alt="" width={320} height={200} unoptimized className="h-full min-h-[220px] w-full object-cover" />
            <div className="p-5">
              <div className="text-[11px] font-bold tracking-[0.08em] text-brand uppercase">AI Longevity Pro program</div>
              <h2 className="m-0 mt-1 text-[20px] font-bold tracking-[-0.01em]">{program.title}</h2>
              <p className="mt-1 mb-0 text-[13px] leading-[1.5] text-body">{program.tagline}</p>
              <p className="mt-1 mb-0 text-[12px] text-subtle">For: {program.audience}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {program.offers.map((o) => (
                  <span key={o.id} className="rounded-lg border border-line bg-sunken px-3 py-[6px] text-[12.5px]">
                    <span className="font-bold text-ink">{formatMinor(o.amountMinor)}</span>{" "}
                    <span className="text-subtle">· {o.label}</span>
                  </span>
                ))}
                <Btn size="md" variant="primary" disabled title="Demo storefront — enrollment happens through checkout">
                  Enroll (demo)
                </Btn>
              </div>
              <div className="mt-3 text-[12px] text-body">
                {program.modules.length} modules · {lessons.length} lessons ·{" "}
                {program.certificate.enabled ? "Certificate on completion" : "No certificate"}
              </div>
              {program.disclaimers[0] && (
                <p className="mt-2 mb-0 text-[10.5px] leading-[1.5] text-faint">{program.disclaimers[0]}</p>
              )}
            </div>
          </div>
        </Card>
      ) : (
        <Card className="px-4 py-[14px]">
          <div className="mb-2 flex items-center gap-2">
            <CardTitle className="flex-1">Week-1 learner view</CardTitle>
            <span className="text-[11.5px] text-subtle">Drip & prerequisites enforced</span>
          </div>
          <div className="flex flex-col gap-[6px]">
            {lessons.map((l, i) => {
              const locked = Boolean(l.drip && l.drip !== "Day 0") || Boolean(l.prerequisite);
              return (
                <div key={l.id} className={cn("flex items-center gap-2 rounded-lg border px-3 py-[8px]", locked ? "border-hairline bg-sunken opacity-70" : "border-line bg-card")}>
                  <span className="flex h-[22px] w-[22px] items-center justify-center rounded-md bg-card text-muted">
                    {locked ? <Lock size={12} aria-hidden /> : LESSON_ICON[l.type]}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium text-ink">{i + 1}. {l.title}</span>
                    <span className="block text-[10.5px] text-faint">
                      {locked ? `Locked — ${l.drip ? `unlocks ${l.drip}` : `requires "${l.prerequisite}"`}` : `${LESSON_TYPE_LABEL[l.type]}${l.durationMin ? ` · ${l.durationMin} min` : ""}`}
                    </span>
                  </span>
                  {!locked && <ChevronRight size={13} className="text-faint" aria-hidden />}
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ copilot */

const COPILOT_DEFAULT: CopilotInput = {
  audience: "Busy professionals 40–60",
  transformation: "Consistent, restorative sleep",
  scope: "mini",
  durationWeeks: 4,
  lens: "functional-medicine",
  evidence: "citations-required",
  format: ["video", "worksheets"],
  assessments: true,
  pricingIntent: "one-time",
  disclaimers: true,
};

function CopilotDrawer({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (programId: string) => void;
}) {
  const { announce } = useFeedback();
  const [input, setInput] = useState<CopilotInput>(COPILOT_DEFAULT);
  const [result, setResult] = useState<CopilotVersion | null>(null);
  const versions = useStudioState().copilotVersions;
  const set = <K extends keyof CopilotInput>(k: K, v: CopilotInput[K]) => setInput((s) => ({ ...s, [k]: v }));

  return (
    <Drawer open={open} onClose={onClose} width={520} title="AI Program Copilot" sub="Guided draft — everything it produces is labeled, versioned, and needs your approval" labelledBy="copilot-title">
      <div className="flex flex-col gap-3 p-5">
        {!result ? (
          <>
            <Field label="Who is this for? (audience)"><TextInput value={input.audience} onChange={(e) => set("audience", e.target.value)} /></Field>
            <Field label="What transformation does it deliver?"><TextInput value={input.transformation} onChange={(e) => set("transformation", e.target.value)} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Scope">
                <Select value={input.scope} onChange={(e) => set("scope", e.target.value as CopilotInput["scope"])}>
                  <option value="mini">Mini-course</option>
                  <option value="flagship">Flagship program</option>
                  <option value="membership">Membership hub</option>
                </Select>
              </Field>
              <Field label="Duration (weeks)">
                <TextInput inputMode="numeric" value={String(input.durationWeeks)} onChange={(e) => set("durationWeeks", Number(e.target.value) || 4)} />
              </Field>
              <Field label="Practitioner lens">
                <Select value={input.lens} onChange={(e) => set("lens", e.target.value)}>
                  <option value="functional-medicine">Functional medicine</option>
                  <option value="integrative">Integrative</option>
                  <option value="lifestyle-medicine">Lifestyle medicine</option>
                  <option value="naturopathic">Naturopathic</option>
                </Select>
              </Field>
              <Field label="Evidence expectations">
                <Select value={input.evidence} onChange={(e) => set("evidence", e.target.value as CopilotInput["evidence"])}>
                  <option value="citations-required">Citations required (slots stay empty)</option>
                  <option value="practitioner-experience">Practitioner experience framing</option>
                </Select>
              </Field>
              <Field label="Pricing intent">
                <Select value={input.pricingIntent} onChange={(e) => set("pricingIntent", e.target.value as CopilotInput["pricingIntent"])}>
                  <option value="one-time">One-time</option>
                  <option value="subscription">Subscription</option>
                  <option value="payment-plan">Payment plan</option>
                </Select>
              </Field>
              <Field label="Lesson formats">
                <Select
                  value={input.format[0] ?? "video"}
                  onChange={(e) => set("format", e.target.value === "video" ? ["video", "worksheets"] : e.target.value === "audio" ? ["audio", "worksheets"] : ["text", "worksheets"])}
                >
                  <option value="video">Video + worksheets</option>
                  <option value="audio">Audio + worksheets</option>
                  <option value="text">Text + worksheets</option>
                </Select>
              </Field>
            </div>
            <label className="flex cursor-pointer items-center gap-[7px] text-[12px] font-medium text-body-2">
              <input type="checkbox" checked={input.assessments} onChange={(e) => set("assessments", e.target.checked)} />
              Include check-in quizzes / assessments
            </label>
            <label className="flex cursor-pointer items-center gap-[7px] text-[12px] font-medium text-body-2">
              <input type="checkbox" checked={input.disclaimers} onChange={(e) => set("disclaimers", e.target.checked)} />
              Include the standard education disclaimer
            </label>
            <DemoNote>
              The copilot drafts STRUCTURE and copy skeletons only: no citations, no outcome
              claims, no individualized medical advice. You review, edit, and approve everything
              before it can publish.
            </DemoNote>
            <Btn
              variant="ai"
              onClick={() => {
                const v = generateProgramDraft(input);
                setResult(v);
                announce("AI draft generated — review required before it can publish. (demo)");
              }}
            >
              <Sparkles size={13} aria-hidden /> Generate draft (v{versions.length + 1})
            </Btn>
          </>
        ) : (
          <>
            <div className="rounded-lg border border-[rgba(116,97,201,0.3)] bg-[rgba(116,97,201,0.06)] px-3 py-[8px]">
              <p className="m-0 flex items-center gap-2 text-[12px] font-bold text-ai-deep">
                <Sparkles size={12} aria-hidden /> AI draft v{versions.findIndex((x) => x.id === result.id) === -1 ? versions.length : versions.length - versions.findIndex((x) => x.id === result.id)} — practitioner approval required
              </p>
              <p className="m-0 mt-[2px] text-[11.5px] text-body">
                Provenance: AI inference from your 10 answers · editable · versioned · never
                publishes without approval.
              </p>
            </div>
            <div>
              <p className="m-0 mb-1 text-[11px] font-bold tracking-[0.05em] text-faint uppercase">Sales copy draft</p>
              <pre className="m-0 rounded-lg border border-hairline bg-sunken px-3 py-[8px] text-[11.5px] leading-[1.55] whitespace-pre-wrap text-body">{result.salesCopy}</pre>
            </div>
            <div>
              <p className="m-0 mb-1 text-[11px] font-bold tracking-[0.05em] text-faint uppercase">Email sequence draft</p>
              {result.emailSequence.map((e) => (
                <p key={e.day} className="m-0 mb-1 rounded-lg border border-hairline bg-sunken px-3 py-[6px] text-[11.5px] text-body">
                  <span className="font-semibold">Day {e.day}:</span> {e.subject} — <span className="text-subtle">{e.preview}</span>
                </p>
              ))}
            </div>
            <div className="flex gap-2">
              <Btn variant="primary" onClick={() => { onCreated(result.programId); onClose(); setResult(null); }}>
                Open in builder
              </Btn>
              <Btn variant="ghost" onClick={() => setResult(null)}>Ask again (new version)</Btn>
            </div>
          </>
        )}
      </div>
    </Drawer>
  );
}

/* -------------------------------------------------------------------- shell */

export function ProgramsStudio({ initialProgramId }: { initialProgramId?: string }) {
  const { announce } = useFeedback();
  const [openId, setOpenId] = useState<string | null>(initialProgramId ?? null);
  const [tab, setTab] = useState<BuilderTab>("curriculum");
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);
  // Derive from the LIVE session state so edits/approve/publish re-render.
  const studio = useStudioState();
  const program = openId ? listPrograms(studio).find((p) => p.id === openId) : undefined;

  if (!program) {
    return (
      <>
        <Catalog onOpen={setOpenId} onCopilot={() => setCopilotOpen(true)} />
        <CopilotDrawer open={copilotOpen} onClose={() => setCopilotOpen(false)} onCreated={(id) => setOpenId(id)} />
      </>
    );
  }

  const TABS: { id: BuilderTab; label: string }[] = [
    { id: "curriculum", label: "Curriculum" },
    { id: "pricing", label: "Pricing & offers" },
    { id: "learners", label: "Learners" },
    { id: "analytics", label: "Analytics" },
    { id: "preview", label: "Previews" },
  ];

  return (
    <section data-screen-label="Program builder" className="mx-auto max-w-[1560px] px-[22px] pt-[18px] pb-6">
      <div className="mb-3 flex items-center gap-3">
        <Btn variant="ghost" onClick={() => setOpenId(null)}>
          <ArrowLeft size={13} aria-hidden /> Catalog
        </Btn>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="m-0 truncate text-[17px] font-bold tracking-[-0.01em]">{program.title}</h1>
            <Pill tone={program.status === "published" ? "positive" : "slate"}>{program.status}</Pill>
            {program.aiDraft && !program.approved && <Pill tone="ai">AI draft — approval required</Pill>}
            {program.aiDraft && program.approved && <Pill tone="positive">Approved</Pill>}
            <Tag>v{program.version}</Tag>
          </div>
          <p className="m-0 truncate text-[12px] text-subtle">{program.tagline}</p>
        </div>
        {program.aiDraft && !program.approved && (
          <Btn
            onClick={() => {
              const r = approveProgramDraft(program.id);
              announce(r.message);
            }}
          >
            Approve AI draft
          </Btn>
        )}
        {program.status === "draft" && (
          <Btn variant="primary" onClick={() => setConfirmPublish(true)}>Publish</Btn>
        )}
      </div>

      <div role="tablist" aria-label="Builder sections" className="mb-4 flex gap-[2px] border-b border-line">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "-mb-px cursor-pointer border-b-2 bg-transparent px-3 pt-[8px] pb-[9px] text-[13px] whitespace-nowrap focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-action",
              tab === t.id ? "border-action font-[650] text-action-deep" : "border-transparent font-medium text-muted hover:text-ink",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "curriculum" && <CurriculumEditor program={program} />}
      {tab === "pricing" && <PricingPanel program={program} />}
      {tab === "learners" && <LearnersPanel program={program} />}
      {tab === "analytics" && <AnalyticsPanel program={program} />}
      {tab === "preview" && <PreviewPanel program={program} />}

      <DemoNote className="mt-4">
        Demo studio — edits, approvals, and publishing update this browser session&apos;s catalog
        only. Disclaimers: {STANDARD_DISCLAIMER}
      </DemoNote>

      <ConfirmDialog
        open={confirmPublish}
        title={`Publish "${program.title}"?`}
        body={
          program.aiDraft && !program.approved
            ? "This program is an unapproved AI draft — approve it first. Publishing is blocked."
            : "Publishing lists it in the demo storefront/catalog for this session. No real storefront exists yet."
        }
        confirmLabel="Publish"
        onCancel={() => setConfirmPublish(false)}
        onConfirm={() => {
          const r = publishProgram(program.id);
          announce(r.message);
          setConfirmPublish(false);
        }}
      />
      <CopilotDrawer open={copilotOpen} onClose={() => setCopilotOpen(false)} onCreated={(id) => setOpenId(id)} />
    </section>
  );
}
