"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  CheckCircle2,
  History,
  Lock,
  Sparkles,
  Users,
} from "lucide-react";
import { api } from "@/adapters";
import { AdapterError } from "@/adapters/errors";
import type {
  LiveProgramDraftPayload,
  LiveProgramBlockKind,
  LiveProgramModule,
  LiveProgramStudio,
  LiveProgramVersionDetail,
} from "@/adapters/live-types";
import { Card, CardTitle } from "@/components/ui/bits";
import { Btn } from "@/components/ui/Btn";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  ClinicalError,
  ClinicalLoading,
  ClinicalNote,
} from "@/components/ui/ClinicalStates";
import { useFeedback } from "@/lib/feedback";
import { patientPath } from "@/lib/routes";

/* ---------------------------------------------------------------- shared */

const INPUT =
  "h-8 w-full rounded-lg border border-line bg-card px-3 text-[12.5px] text-body outline-none focus-visible:outline-2 focus-visible:outline-action";
const AREA =
  "min-h-[64px] w-full rounded-lg border border-line bg-card px-3 py-2 text-[12.5px] leading-normal text-body outline-none focus-visible:outline-2 focus-visible:outline-action";
const LABEL = "mb-1 block text-[11px] font-bold tracking-[0.02em] text-subtle uppercase";

const BLOCK_KINDS: { kind: LiveProgramBlockKind; label: string }[] = [
  { kind: "text", label: "Text" },
  { kind: "image", label: "Image" },
  { kind: "video_url", label: "Video URL" },
  { kind: "document_link", label: "Document link" },
  { kind: "quiz", label: "Quiz" },
  { kind: "check_in", label: "Check-in" },
  { kind: "resource", label: "Resource" },
];

function errText(e: unknown): string {
  return e instanceof AdapterError ? e.message : "Something went wrong. Try again.";
}
function isConflict(e: unknown): boolean {
  return e instanceof AdapterError && e.code === "conflict";
}

/* --------------------------------------------------- editable draft model */

interface DraftQuizQuestion {
  prompt: string;
  options: string[];
  answerIndex: number | null;
}
interface DraftBlock {
  key: string;
  kind: LiveProgramBlockKind;
  title: string;
  body: string; // text
  url: string; // image / video_url / document_link / resource
  questions: DraftQuizQuestion[]; // quiz
  prompt: string; // check_in
  responseType: "text" | "scale_1_5" | "yes_no" | "number"; // check_in
  isCommercial: boolean;
}
interface DraftLesson {
  key: string;
  title: string;
  summary: string;
  blocks: DraftBlock[];
}
interface DraftModule {
  key: string;
  name: string;
  summary: string;
  lessons: DraftLesson[];
}
interface DraftModel {
  title: string;
  summary: string;
  audience: string;
  disclaimer: string;
  modules: DraftModule[];
}

let keyCounter = 1;
const nextKey = () => `k${keyCounter++}`;

function contentString(content: Record<string, unknown>, field: string): string {
  const v = content[field];
  return typeof v === "string" ? v : "";
}

function draftFromVersion(v: LiveProgramVersionDetail): DraftModel {
  return {
    title: v.title ?? "",
    summary: v.summary ?? "",
    audience: v.audience ?? "",
    disclaimer: v.disclaimer ?? "",
    modules: v.modules.map((m) => ({
      key: nextKey(),
      name: m.name,
      summary: m.summary ?? "",
      lessons: m.lessons.map((l) => ({
        key: nextKey(),
        title: l.title,
        summary: l.summary ?? "",
        blocks: l.blocks.map((b) => {
          const questionsRaw = Array.isArray(b.content.questions) ? b.content.questions : [];
          return {
            key: nextKey(),
            kind: b.kind,
            title: b.title ?? "",
            body: contentString(b.content, "body"),
            url: contentString(b.content, "url"),
            questions: questionsRaw.map((q) => {
              const qq = q as { prompt?: unknown; options?: unknown; answerIndex?: unknown };
              return {
                prompt: typeof qq.prompt === "string" ? qq.prompt : "",
                options: Array.isArray(qq.options)
                  ? qq.options.map((o) => (typeof o === "string" ? o : ""))
                  : ["", ""],
                answerIndex: typeof qq.answerIndex === "number" ? qq.answerIndex : null,
              };
            }),
            prompt: contentString(b.content, "prompt"),
            responseType:
              (contentString(b.content, "responseType") as DraftBlock["responseType"]) || "text",
            isCommercial: b.isCommercial,
          };
        }),
      })),
    })),
  };
}

function blockContent(b: DraftBlock): Record<string, unknown> {
  switch (b.kind) {
    case "text":
      return { body: b.body };
    case "quiz":
      return {
        questions: b.questions.map((q) => ({
          prompt: q.prompt,
          options: q.options,
          ...(q.answerIndex !== null ? { answerIndex: q.answerIndex } : {}),
        })),
      };
    case "check_in":
      return { prompt: b.prompt, responseType: b.responseType };
    default:
      return { url: b.url };
  }
}

function payloadFromDraft(d: DraftModel): LiveProgramDraftPayload {
  return {
    title: d.title,
    summary: d.summary || null,
    audience: d.audience || null,
    disclaimer: d.disclaimer || null,
    modules: d.modules.map((m) => ({
      name: m.name,
      summary: m.summary || null,
      lessons: m.lessons.map((l) => ({
        title: l.title,
        summary: l.summary || null,
        blocks: l.blocks.map((b) => ({
          kind: b.kind,
          title: b.title || null,
          content: blockContent(b),
          isCommercial: b.isCommercial,
        })),
      })),
    })),
  };
}

function move<T>(arr: T[], index: number, delta: -1 | 1): T[] {
  const next = [...arr];
  const j = index + delta;
  if (j < 0 || j >= next.length) return next;
  [next[index], next[j]] = [next[j], next[index]];
  return next;
}

/* -------------------------------------------------------------- SaveBadge */

type SaveState = "idle" | "saving" | "saved" | "conflict" | "failed";

function SaveBadge({ state }: { state: SaveState }) {
  const text =
    state === "saving"
      ? "Saving…"
      : state === "saved"
        ? "Saved"
        : state === "conflict"
          ? "Conflict — draft changed elsewhere"
          : state === "failed"
            ? "Save failed"
            : "";
  if (!text) return <span data-testid="save-state" data-state="idle" />;
  const tone =
    state === "saved"
      ? "bg-positive-tint text-positive-deep"
      : state === "saving"
        ? "bg-slate-tint text-slate-badge"
        : "bg-critical-tint text-critical";
  return (
    <span
      className={`inline-flex h-[22px] items-center rounded-full px-[10px] text-[11px] font-bold ${tone}`}
      role="status"
      data-testid="save-state"
      data-state={state}
    >
      {text}
    </span>
  );
}

/* ------------------------------------------------------- preview renderer */

function CurriculumPreview({ modules }: { modules: LiveProgramModule[] }) {
  if (modules.length === 0) {
    return <p className="m-0 text-[12px] text-faint">This version has no curriculum content.</p>;
  }
  return (
    <div className="flex flex-col gap-3" data-testid="program-preview">
      {modules.map((m) => (
        <div key={m.id} className="rounded-[10px] border border-hairline-2 bg-surface px-3 py-2">
          <p className="m-0 text-[13px] font-bold text-ink">{m.name}</p>
          {m.summary && <p className="m-0 text-[12px] text-subtle">{m.summary}</p>}
          {m.lessons.map((l) => (
            <div key={l.id} className="mt-2 border-t border-hairline-2 pt-2">
              <p className="m-0 text-[12.5px] font-semibold text-body">{l.title}</p>
              {l.blocks.map((b) => (
                <div key={b.id} className="mt-1 text-[12px] text-body-2">
                  {b.kind === "text" && <p className="m-0 whitespace-pre-wrap">{contentString(b.content, "body")}</p>}
                  {(b.kind === "image" || b.kind === "video_url" || b.kind === "document_link" || b.kind === "resource") && (
                    <p className="m-0">
                      <span className="font-semibold">{b.title || BLOCK_KINDS.find((k) => k.kind === b.kind)?.label}:</span>{" "}
                      <span className="break-all text-subtle">{contentString(b.content, "url")}</span>
                      {b.isCommercial && (
                        <span className="ml-2 inline-flex h-[18px] items-center rounded-full bg-warning-tint px-2 text-[10px] font-bold text-warning-deep">
                          commercial
                        </span>
                      )}
                    </p>
                  )}
                  {b.kind === "quiz" && (
                    <div>
                      <p className="m-0 font-semibold">{b.title || "Quiz"}</p>
                      {(Array.isArray(b.content.questions) ? b.content.questions : []).map((q, i) => {
                        const qq = q as { prompt?: string; options?: string[] };
                        return (
                          <p key={i} className="m-0 text-subtle">
                            {i + 1}. {qq.prompt} ({(qq.options ?? []).join(" / ")})
                          </p>
                        );
                      })}
                    </div>
                  )}
                  {b.kind === "check_in" && (
                    <p className="m-0">
                      <span className="font-semibold">Check-in:</span>{" "}
                      {contentString(b.content, "prompt")}{" "}
                      <span className="text-faint">({contentString(b.content, "responseType")})</span>
                    </p>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ the studio */

export function ProgramStudio({ programId }: { programId: string }) {
  const { announce } = useFeedback();
  const [studio, setStudio] = useState<LiveProgramStudio | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftModel | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const [checklist, setChecklist] = useState({ content: false, disclaimer: false, commercial: false });
  const [confirm, setConfirm] = useState<null | "approve" | "publish">(null);
  const [returnNote, setReturnNote] = useState("");
  const [aiMessage, setAiMessage] = useState<string | null>(null);
  const [lastProgressId, setLastProgressId] = useState<string | null>(null);
  const [templateName, setTemplateName] = useState("");

  const tokenRef = useRef<string | null>(null);
  const draftRef = useRef<DraftModel | null>(null);
  const editableIdRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);
  draftRef.current = draft;

  const load = useCallback(async () => {
    setError(null);
    try {
      const s = await api.programs.studio(programId);
      setStudio(s);
      editableIdRef.current = s.editable?.id ?? null;
      tokenRef.current = s.editable?.updatedAt ?? null;
      setDraft(s.editable ? draftFromVersion(s.editable) : null);
      setSaveState("idle");
      setChecklist({ content: false, disclaimer: false, commercial: false });
    } catch (e) {
      setError(errText(e));
    }
  }, [programId]);

  useEffect(() => {
    void load();
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [load]);

  const saveNow = useCallback(async () => {
    const d = draftRef.current;
    const versionId = editableIdRef.current;
    if (!d || !versionId) return;
    setSaveState("saving");
    try {
      const res = await api.programs.saveDraft({
        versionId,
        payload: payloadFromDraft(d),
        expectedUpdatedAt: tokenRef.current,
      });
      tokenRef.current = res.updatedAt ?? tokenRef.current;
      setSaveState("saved");
    } catch (e) {
      setSaveState(isConflict(e) ? "conflict" : "failed");
    }
  }, []);

  const touch = useCallback(
    (updater: (d: DraftModel) => DraftModel) => {
      setDraft((d) => (d ? updater(d) : d));
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => void saveNow(), 700);
    },
    [saveNow],
  );

  const runAction = async (fn: () => Promise<{ message: string }>) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fn();
      announce(res.message);
      await load();
    } catch (e) {
      announce(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const approvedEntry = useMemo(
    () => studio?.history.find((h) => h.status === "approved") ?? null,
    [studio],
  );

  if (error && !studio) return <ClinicalError message={error} onRetry={() => void load()} />;
  if (!studio) return <ClinicalLoading label="Loading the program studio…" />;

  const editable = studio.editable;
  const published = studio.published;
  const checklistDone = checklist.content && checklist.disclaimer && checklist.commercial;

  return (
    <div className="flex flex-col gap-3" data-testid="program-studio">
      {/* ------------------------------------------------ header + actions */}
      <Card className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="mb-0">
            <BookOpen size={13} strokeWidth={2} className="text-brand" aria-hidden />
            {studio.program.name}
          </CardTitle>
          <span className="text-[11.5px] text-subtle">
            {studio.program.status}
            {published ? ` · published v${published.version}` : " · never published"}
            {editable ? ` · ${editable.status.replace("_", " ")} v${editable.version}` : ""}
          </span>
          <span className="flex-1" />
          <SaveBadge state={saveState} />
          <Btn onClick={() => setPreview((v) => !v)} data-testid="preview-toggle">
            {preview ? "Close preview" : "Preview"}
          </Btn>
          {studio.program.status !== "archived" ? (
            <Btn
              variant="danger"
              disabled={busy}
              onClick={() => void runAction(() => api.programs.archive(studio.program.id, true))}
              data-testid="program-archive"
            >
              Archive
            </Btn>
          ) : (
            <Btn
              disabled={busy}
              onClick={() => void runAction(() => api.programs.archive(studio.program.id, false))}
              data-testid="program-restore"
            >
              Restore
            </Btn>
          )}
        </div>
        {studio.program.status === "archived" && (
          <ClinicalNote className="mt-2">
            This program is archived: it takes no new enrollments. Published history and existing
            enrollments are preserved exactly as they were.
          </ClinicalNote>
        )}
      </Card>

      {saveState === "conflict" && (
        <Card className="border-critical px-4 py-3" data-testid="conflict-banner">
          <p className="m-0 text-[12.5px] font-semibold text-critical">
            This draft changed elsewhere since it was loaded. Nothing was overwritten.
          </p>
          <p className="m-0 mt-1 text-[12px] text-subtle">
            Reload to pick up the latest saved draft, then re-apply your edit.
          </p>
          <Btn className="mt-2" onClick={() => void load()} data-testid="conflict-reload">
            Reload latest draft
          </Btn>
        </Card>
      )}

      {preview && (
        <Card className="px-4 py-3">
          <CardTitle className="mb-2">Practitioner preview</CardTitle>
          <p className="m-0 mb-2 text-[11.5px] text-subtle">
            {editable
              ? `Previewing the ${editable.status.replace("_", " ")} draft as a patient would read it.`
              : published
                ? `Previewing published v${published.version}.`
                : "Nothing to preview yet."}
          </p>
          <CurriculumPreview modules={(editable ?? published)?.modules ?? []} />
        </Card>
      )}

      {/* ------------------------------------------------------ draft editor */}
      {editable && draft && !preview && (
        <Card className="px-4 py-3" data-testid="draft-editor">
          <div className="flex items-center gap-2">
            <CardTitle className="mb-0">
              Draft v{editable.version} ({editable.status.replace("_", " ")})
            </CardTitle>
            <span className="flex-1" />
            {editable.status === "draft" && (
              <Btn
                variant="primary"
                disabled={busy}
                onClick={() => void runAction(() => api.programs.submit(editable.id))}
                data-testid="submit-review"
              >
                Submit for review
              </Btn>
            )}
          </div>
          {editable.reviewNote && (
            <ClinicalNote className="mt-2">Reviewer note: {editable.reviewNote}</ClinicalNote>
          )}

          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <div>
              <label className={LABEL} htmlFor="pv-title">Title</label>
              <input
                id="pv-title"
                className={INPUT}
                value={draft.title}
                onChange={(e) => touch((d) => ({ ...d, title: e.target.value }))}
                data-testid="draft-title"
              />
            </div>
            <div>
              <label className={LABEL} htmlFor="pv-audience">Audience</label>
              <input
                id="pv-audience"
                className={INPUT}
                value={draft.audience}
                onChange={(e) => touch((d) => ({ ...d, audience: e.target.value }))}
              />
            </div>
            <div>
              <label className={LABEL} htmlFor="pv-summary">Summary</label>
              <textarea
                id="pv-summary"
                className={AREA}
                value={draft.summary}
                onChange={(e) => touch((d) => ({ ...d, summary: e.target.value }))}
                data-testid="draft-summary"
              />
            </div>
            <div>
              <label className={LABEL} htmlFor="pv-disclaimer">Disclaimer</label>
              <textarea
                id="pv-disclaimer"
                className={AREA}
                value={draft.disclaimer}
                onChange={(e) => touch((d) => ({ ...d, disclaimer: e.target.value }))}
                data-testid="draft-disclaimer"
              />
            </div>
          </div>

          {/* modules */}
          <div className="mt-3 flex flex-col gap-3" data-testid="module-list">
            {draft.modules.map((m, mi) => (
              <div key={m.key} className="rounded-[10px] border border-hairline-2 bg-surface px-3 py-2">
                <div className="flex items-center gap-2">
                  <input
                    className={`${INPUT} font-semibold`}
                    value={m.name}
                    placeholder="Module name"
                    aria-label={`Module ${mi + 1} name`}
                    onChange={(e) =>
                      touch((d) => ({
                        ...d,
                        modules: d.modules.map((x, i) => (i === mi ? { ...x, name: e.target.value } : x)),
                      }))
                    }
                    data-testid={`module-name-${mi}`}
                  />
                  <Btn
                    size="sm"
                    aria-label={`Move module ${mi + 1} up`}
                    disabled={mi === 0}
                    onClick={() => touch((d) => ({ ...d, modules: move(d.modules, mi, -1) }))}
                    data-testid={`module-up-${mi}`}
                  >
                    <ArrowUp size={12} aria-hidden />
                  </Btn>
                  <Btn
                    size="sm"
                    aria-label={`Move module ${mi + 1} down`}
                    disabled={mi === draft.modules.length - 1}
                    onClick={() => touch((d) => ({ ...d, modules: move(d.modules, mi, 1) }))}
                    data-testid={`module-down-${mi}`}
                  >
                    <ArrowDown size={12} aria-hidden />
                  </Btn>
                  <Btn
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove module ${mi + 1}`}
                    onClick={() =>
                      touch((d) => ({ ...d, modules: d.modules.filter((_, i) => i !== mi) }))
                    }
                  >
                    Remove
                  </Btn>
                </div>

                {/* lessons */}
                <div className="mt-2 flex flex-col gap-2">
                  {m.lessons.map((l, li) => (
                    <div key={l.key} className="rounded-lg border border-hairline-2 bg-card px-3 py-2">
                      <div className="flex items-center gap-2">
                        <input
                          className={INPUT}
                          value={l.title}
                          placeholder="Lesson title"
                          aria-label={`Lesson ${li + 1} title in module ${mi + 1}`}
                          onChange={(e) =>
                            touch((d) => ({
                              ...d,
                              modules: d.modules.map((x, i) =>
                                i === mi
                                  ? {
                                      ...x,
                                      lessons: x.lessons.map((y, j) =>
                                        j === li ? { ...y, title: e.target.value } : y,
                                      ),
                                    }
                                  : x,
                              ),
                            }))
                          }
                          data-testid={`lesson-title-${mi}-${li}`}
                        />
                        <Btn
                          size="sm"
                          aria-label={`Move lesson ${li + 1} up`}
                          disabled={li === 0}
                          onClick={() =>
                            touch((d) => ({
                              ...d,
                              modules: d.modules.map((x, i) =>
                                i === mi ? { ...x, lessons: move(x.lessons, li, -1) } : x,
                              ),
                            }))
                          }
                        >
                          <ArrowUp size={12} aria-hidden />
                        </Btn>
                        <Btn
                          size="sm"
                          aria-label={`Move lesson ${li + 1} down`}
                          disabled={li === m.lessons.length - 1}
                          onClick={() =>
                            touch((d) => ({
                              ...d,
                              modules: d.modules.map((x, i) =>
                                i === mi ? { ...x, lessons: move(x.lessons, li, 1) } : x,
                              ),
                            }))
                          }
                        >
                          <ArrowDown size={12} aria-hidden />
                        </Btn>
                        <Btn
                          size="sm"
                          variant="ghost"
                          aria-label={`Remove lesson ${li + 1}`}
                          onClick={() =>
                            touch((d) => ({
                              ...d,
                              modules: d.modules.map((x, i) =>
                                i === mi
                                  ? { ...x, lessons: x.lessons.filter((_, j) => j !== li) }
                                  : x,
                              ),
                            }))
                          }
                        >
                          Remove
                        </Btn>
                      </div>

                      {/* blocks */}
                      <div className="mt-2 flex flex-col gap-2">
                        {l.blocks.map((b, bi) => {
                          const setBlock = (patch: Partial<DraftBlock>) =>
                            touch((d) => ({
                              ...d,
                              modules: d.modules.map((x, i) =>
                                i === mi
                                  ? {
                                      ...x,
                                      lessons: x.lessons.map((y, j) =>
                                        j === li
                                          ? {
                                              ...y,
                                              blocks: y.blocks.map((z, k) =>
                                                k === bi ? { ...z, ...patch } : z,
                                              ),
                                            }
                                          : y,
                                      ),
                                    }
                                  : x,
                              ),
                            }));
                          return (
                            <div
                              key={b.key}
                              className="rounded-lg border border-hairline-2 bg-surface px-3 py-2"
                              data-testid={`block-${mi}-${li}-${bi}`}
                            >
                              <div className="flex flex-wrap items-center gap-2">
                                <select
                                  className="h-7 rounded-[7px] border border-line bg-card px-2 text-[11.5px] font-semibold"
                                  value={b.kind}
                                  aria-label={`Block ${bi + 1} kind`}
                                  onChange={(e) =>
                                    setBlock({ kind: e.target.value as LiveProgramBlockKind })
                                  }
                                  data-testid={`block-kind-${mi}-${li}-${bi}`}
                                >
                                  {BLOCK_KINDS.map((k) => (
                                    <option key={k.kind} value={k.kind}>{k.label}</option>
                                  ))}
                                </select>
                                <input
                                  className={`${INPUT} !w-auto flex-1`}
                                  value={b.title}
                                  placeholder="Block title (optional)"
                                  aria-label={`Block ${bi + 1} title`}
                                  onChange={(e) => setBlock({ title: e.target.value })}
                                />
                                <Btn
                                  size="sm"
                                  aria-label={`Move block ${bi + 1} up`}
                                  disabled={bi === 0}
                                  onClick={() =>
                                    touch((d) => ({
                                      ...d,
                                      modules: d.modules.map((x, i) =>
                                        i === mi
                                          ? {
                                              ...x,
                                              lessons: x.lessons.map((y, j) =>
                                                j === li ? { ...y, blocks: move(y.blocks, bi, -1) } : y,
                                              ),
                                            }
                                          : x,
                                      ),
                                    }))
                                  }
                                >
                                  <ArrowUp size={12} aria-hidden />
                                </Btn>
                                <Btn
                                  size="sm"
                                  aria-label={`Move block ${bi + 1} down`}
                                  disabled={bi === l.blocks.length - 1}
                                  onClick={() =>
                                    touch((d) => ({
                                      ...d,
                                      modules: d.modules.map((x, i) =>
                                        i === mi
                                          ? {
                                              ...x,
                                              lessons: x.lessons.map((y, j) =>
                                                j === li ? { ...y, blocks: move(y.blocks, bi, 1) } : y,
                                              ),
                                            }
                                          : x,
                                      ),
                                    }))
                                  }
                                >
                                  <ArrowDown size={12} aria-hidden />
                                </Btn>
                                <Btn
                                  size="sm"
                                  variant="ghost"
                                  aria-label={`Remove block ${bi + 1}`}
                                  onClick={() =>
                                    touch((d) => ({
                                      ...d,
                                      modules: d.modules.map((x, i) =>
                                        i === mi
                                          ? {
                                              ...x,
                                              lessons: x.lessons.map((y, j) =>
                                                j === li
                                                  ? { ...y, blocks: y.blocks.filter((_, k) => k !== bi) }
                                                  : y,
                                              ),
                                            }
                                          : x,
                                      ),
                                    }))
                                  }
                                >
                                  Remove
                                </Btn>
                              </div>

                              <div className="mt-2">
                                {b.kind === "text" && (
                                  <textarea
                                    className={AREA}
                                    value={b.body}
                                    placeholder="Lesson text…"
                                    aria-label="Text block body"
                                    onChange={(e) => setBlock({ body: e.target.value })}
                                    data-testid={`block-body-${mi}-${li}-${bi}`}
                                  />
                                )}
                                {(b.kind === "image" ||
                                  b.kind === "video_url" ||
                                  b.kind === "document_link" ||
                                  b.kind === "resource") && (
                                  <div className="flex flex-wrap items-center gap-2">
                                    <input
                                      className={`${INPUT} !w-auto flex-1`}
                                      value={b.url}
                                      placeholder="https://…"
                                      aria-label="Block URL"
                                      onChange={(e) => setBlock({ url: e.target.value })}
                                      data-testid={`block-url-${mi}-${li}-${bi}`}
                                    />
                                    {b.kind === "resource" && (
                                      <label className="flex items-center gap-[6px] text-[11.5px] font-semibold text-body-2">
                                        <input
                                          type="checkbox"
                                          checked={b.isCommercial}
                                          onChange={(e) => setBlock({ isCommercial: e.target.checked })}
                                        />
                                        Commercial resource
                                      </label>
                                    )}
                                  </div>
                                )}
                                {b.kind === "check_in" && (
                                  <div className="flex flex-wrap items-center gap-2">
                                    <input
                                      className={`${INPUT} !w-auto flex-1`}
                                      value={b.prompt}
                                      placeholder="Check-in prompt"
                                      aria-label="Check-in prompt"
                                      onChange={(e) => setBlock({ prompt: e.target.value })}
                                      data-testid={`block-prompt-${mi}-${li}-${bi}`}
                                    />
                                    <select
                                      className="h-7 rounded-[7px] border border-line bg-card px-2 text-[11.5px]"
                                      value={b.responseType}
                                      aria-label="Check-in response type"
                                      onChange={(e) =>
                                        setBlock({ responseType: e.target.value as DraftBlock["responseType"] })
                                      }
                                    >
                                      <option value="text">Free text</option>
                                      <option value="scale_1_5">Scale 1–5</option>
                                      <option value="yes_no">Yes / No</option>
                                      <option value="number">Number</option>
                                    </select>
                                  </div>
                                )}
                                {b.kind === "quiz" && (
                                  <div className="flex flex-col gap-2">
                                    {b.questions.map((q, qi) => (
                                      <div key={qi} className="rounded-lg border border-hairline-2 px-2 py-2">
                                        <input
                                          className={INPUT}
                                          value={q.prompt}
                                          placeholder={`Question ${qi + 1}`}
                                          aria-label={`Quiz question ${qi + 1}`}
                                          onChange={(e) =>
                                            setBlock({
                                              questions: b.questions.map((x, i) =>
                                                i === qi ? { ...x, prompt: e.target.value } : x,
                                              ),
                                            })
                                          }
                                          data-testid={`quiz-q-${mi}-${li}-${bi}-${qi}`}
                                        />
                                        <div className="mt-1 flex flex-col gap-1">
                                          {q.options.map((o, oi) => (
                                            <div key={oi} className="flex items-center gap-2">
                                              <input
                                                type="radio"
                                                name={`answer-${b.key}-${qi}`}
                                                checked={q.answerIndex === oi}
                                                aria-label={`Mark option ${oi + 1} as the answer`}
                                                onChange={() =>
                                                  setBlock({
                                                    questions: b.questions.map((x, i) =>
                                                      i === qi ? { ...x, answerIndex: oi } : x,
                                                    ),
                                                  })
                                                }
                                              />
                                              <input
                                                className={`${INPUT} !h-7`}
                                                value={o}
                                                placeholder={`Option ${oi + 1}`}
                                                aria-label={`Question ${qi + 1} option ${oi + 1}`}
                                                onChange={(e) =>
                                                  setBlock({
                                                    questions: b.questions.map((x, i) =>
                                                      i === qi
                                                        ? {
                                                            ...x,
                                                            options: x.options.map((y, j) =>
                                                              j === oi ? e.target.value : y,
                                                            ),
                                                          }
                                                        : x,
                                                    ),
                                                  })
                                                }
                                              />
                                            </div>
                                          ))}
                                        </div>
                                        <div className="mt-1 flex gap-2">
                                          <Btn
                                            size="sm"
                                            onClick={() =>
                                              setBlock({
                                                questions: b.questions.map((x, i) =>
                                                  i === qi ? { ...x, options: [...x.options, ""] } : x,
                                                ),
                                              })
                                            }
                                          >
                                            Add option
                                          </Btn>
                                          <Btn
                                            size="sm"
                                            variant="ghost"
                                            onClick={() =>
                                              setBlock({
                                                questions: b.questions.filter((_, i) => i !== qi),
                                              })
                                            }
                                          >
                                            Remove question
                                          </Btn>
                                        </div>
                                      </div>
                                    ))}
                                    <Btn
                                      size="sm"
                                      onClick={() =>
                                        setBlock({
                                          questions: [
                                            ...b.questions,
                                            { prompt: "", options: ["", ""], answerIndex: null },
                                          ],
                                        })
                                      }
                                      data-testid={`quiz-add-q-${mi}-${li}-${bi}`}
                                    >
                                      Add question
                                    </Btn>
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                        <Btn
                          size="sm"
                          onClick={() =>
                            touch((d) => ({
                              ...d,
                              modules: d.modules.map((x, i) =>
                                i === mi
                                  ? {
                                      ...x,
                                      lessons: x.lessons.map((y, j) =>
                                        j === li
                                          ? {
                                              ...y,
                                              blocks: [
                                                ...y.blocks,
                                                {
                                                  key: nextKey(),
                                                  kind: "text",
                                                  title: "",
                                                  body: "",
                                                  url: "",
                                                  questions: [],
                                                  prompt: "",
                                                  responseType: "text",
                                                  isCommercial: false,
                                                },
                                              ],
                                            }
                                          : y,
                                      ),
                                    }
                                  : x,
                              ),
                            }))
                          }
                          data-testid={`add-block-${mi}-${li}`}
                        >
                          Add block
                        </Btn>
                      </div>
                    </div>
                  ))}
                  <Btn
                    size="sm"
                    onClick={() =>
                      touch((d) => ({
                        ...d,
                        modules: d.modules.map((x, i) =>
                          i === mi
                            ? {
                                ...x,
                                lessons: [
                                  ...x.lessons,
                                  { key: nextKey(), title: "", summary: "", blocks: [] },
                                ],
                              }
                            : x,
                        ),
                      }))
                    }
                    data-testid={`add-lesson-${mi}`}
                  >
                    Add lesson
                  </Btn>
                </div>
              </div>
            ))}
            <Btn
              onClick={() =>
                touch((d) => ({
                  ...d,
                  modules: [...d.modules, { key: nextKey(), name: "", summary: "", lessons: [] }],
                }))
              }
              data-testid="add-module"
            >
              Add module
            </Btn>
          </div>

          {/* AI builder — provider-neutral, fails closed. */}
          <div className="mt-3 border-t border-hairline-2 pt-3">
            <Btn
              variant="ai"
              onClick={async () => {
                try {
                  await api.programs.builderAI({ instruction: "draft", versionId: editable.id });
                } catch (e) {
                  setAiMessage(errText(e));
                }
              }}
              data-testid="ai-builder"
            >
              <Sparkles size={13} strokeWidth={2} aria-hidden /> Draft with AI
            </Btn>
            {aiMessage && (
              <p className="m-0 mt-2 text-[12px] font-semibold text-warning-deep" data-testid="ai-not-configured">
                {aiMessage}
              </p>
            )}
          </div>

          {/* review workflow (in_review only) */}
          {editable.status === "in_review" && (
            <div className="mt-3 border-t border-hairline-2 pt-3" data-testid="review-panel">
              <CardTitle className="mb-2">Review checklist</CardTitle>
              <div className="flex flex-col gap-1 text-[12.5px] text-body">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={checklist.content}
                    onChange={(e) => setChecklist((c) => ({ ...c, content: e.target.checked }))}
                    data-testid="check-content"
                  />
                  Every module, lesson, and block was read in full.
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={checklist.disclaimer}
                    onChange={(e) => setChecklist((c) => ({ ...c, disclaimer: e.target.checked }))}
                    data-testid="check-disclaimer"
                  />
                  The disclaimer is present and accurate for this audience.
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={checklist.commercial}
                    onChange={(e) => setChecklist((c) => ({ ...c, commercial: e.target.checked }))}
                    data-testid="check-commercial"
                  />
                  Commercial resources are labeled and none is presented as clinical evidence.
                </label>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  className={`${INPUT} !w-[260px]`}
                  value={returnNote}
                  placeholder="Return note (what needs to change)"
                  aria-label="Return note"
                  onChange={(e) => setReturnNote(e.target.value)}
                  data-testid="return-note"
                />
                <Btn
                  disabled={busy}
                  onClick={() =>
                    void runAction(() => api.programs.returnToDraft(editable.id, returnNote || null))
                  }
                  data-testid="return-to-draft"
                >
                  Return to draft
                </Btn>
                <Btn
                  variant="primary"
                  disabled={busy || !checklistDone}
                  onClick={() => setConfirm("approve")}
                  data-testid="approve-open"
                >
                  Approve version…
                </Btn>
              </div>
            </div>
          )}
        </Card>
      )}

      {/* -------------------------------------------- approved, not published */}
      {!editable && approvedEntry && (
        <Card className="px-4 py-3" data-testid="approved-panel">
          <CardTitle className="mb-1">
            <CheckCircle2 size={13} strokeWidth={2} className="text-positive-deep" aria-hidden />
            Approved v{approvedEntry.version} — frozen, NOT published
          </CardTitle>
          <p className="m-0 mb-2 text-[12px] text-subtle">
            This version is approved and immutable, but patients see nothing until it is explicitly
            published. Publishing has no side effects: no enrollment, charge, invoice, or message.
          </p>
          <Btn variant="primary" disabled={busy} onClick={() => setConfirm("publish")} data-testid="publish-open">
            Publish v{approvedEntry.version}…
          </Btn>
        </Card>
      )}

      {/* ------------------------------------------------------ published lock */}
      {published && !preview && (
        <Card className="px-4 py-3" data-testid="published-panel">
          <div className="flex items-center gap-2">
            <CardTitle className="mb-0">
              <Lock size={13} strokeWidth={2} className="text-brand" aria-hidden />
              Published v{published.version} — locked
            </CardTitle>
            <span className="flex-1" />
            {!editable && (
              <Btn
                disabled={busy}
                onClick={() => void runAction(() => api.programs.revise(published.id))}
                data-testid="revise-published"
              >
                Revise into new draft
              </Btn>
            )}
          </div>
          <p className="m-0 mt-1 text-[12px] text-subtle">
            Published content is immutable. Corrections go into a new draft version; enrollments
            stay pinned to the exact version they enrolled under.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-hairline-2 pt-2">
            <input
              className={`${INPUT} !w-[240px]`}
              value={templateName}
              placeholder="Template name"
              aria-label="Template name"
              onChange={(e) => setTemplateName(e.target.value)}
              data-testid="template-name"
            />
            <Btn
              size="sm"
              disabled={busy || !templateName.trim()}
              onClick={() =>
                void runAction(async () => {
                  const res = await api.programs.templates.create({
                    name: templateName.trim(),
                    fromVersionId: published.id,
                  });
                  setTemplateName("");
                  return res;
                })
              }
              data-testid="save-as-template"
            >
              Save as template (detached copy)
            </Btn>
          </div>
        </Card>
      )}

      {/* ------------------------------------------------------------ offers */}
      <OffersPanel studio={studio} onChanged={load} />

      {/* ------------------------------------------------------------ roster */}
      <Card className="px-4 py-3" data-testid="roster-panel">
        <CardTitle className="mb-2">
          <Users size={13} strokeWidth={2} className="text-brand" aria-hidden />
          Enrollment roster
        </CardTitle>
        {studio.roster.length === 0 ? (
          <p className="m-0 text-[12px] text-faint">
            No enrollments. Enroll a patient from their chart&apos;s Programs card.
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {studio.roster.map((r) => (
              <li
                key={r.enrollmentId}
                className="rounded-[10px] border border-hairline-2 bg-surface px-3 py-2"
                data-testid={`roster-${r.enrollmentId}`}
              >
                <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                  <Link
                    href={patientPath(r.patientId, "overview")}
                    className="font-semibold text-action hover:underline"
                    data-testid="roster-patient-link"
                  >
                    {r.patientName || "Unnamed patient"}
                  </Link>
                  <span className="inline-flex h-[20px] items-center rounded-full bg-slate-tint px-2 text-[10.5px] font-bold text-slate-badge">
                    {r.status}
                  </span>
                  <span className="text-subtle">
                    pinned v{r.pinnedVersion ?? "—"} · {r.progressCount} progress records
                    {r.needsReviewCount > 0 ? ` · ${r.needsReviewCount} need review` : ""}
                  </span>
                  {r.compReason && (
                    <span className="text-[11.5px] text-subtle">comp: {r.compReason}</span>
                  )}
                  <span className="flex-1" />
                  {(r.status === "active" || r.status === "paused" || r.status === "invited") && (
                    <>
                      {r.status === "invited" && (
                        <Btn
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            void runAction(() =>
                              api.programs.setEnrollmentStatus({
                                enrollmentId: r.enrollmentId,
                                status: "active",
                              }),
                            )
                          }
                        >
                          Activate
                        </Btn>
                      )}
                      {r.status === "active" && (
                        <Btn
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            void runAction(() =>
                              api.programs.setEnrollmentStatus({
                                enrollmentId: r.enrollmentId,
                                status: "paused",
                              }),
                            )
                          }
                          data-testid="enrollment-pause"
                        >
                          Pause
                        </Btn>
                      )}
                      {r.status === "paused" && (
                        <Btn
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            void runAction(() =>
                              api.programs.setEnrollmentStatus({
                                enrollmentId: r.enrollmentId,
                                status: "active",
                              }),
                            )
                          }
                          data-testid="enrollment-resume"
                        >
                          Resume
                        </Btn>
                      )}
                      {r.status !== "invited" && (
                        <Btn
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            void runAction(() =>
                              api.programs.setEnrollmentStatus({
                                enrollmentId: r.enrollmentId,
                                status: "completed",
                              }),
                            )
                          }
                          data-testid="enrollment-complete"
                        >
                          Complete
                        </Btn>
                      )}
                      <Btn
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          void runAction(() =>
                            api.programs.setEnrollmentStatus({
                              enrollmentId: r.enrollmentId,
                              status: "cancelled",
                            }),
                          )
                        }
                      >
                        Cancel
                      </Btn>
                    </>
                  )}
                </div>
                {r.status === "active" && published && r.pinnedVersion === published.version && (
                  <RecordProgressRow
                    enrollmentId={r.enrollmentId}
                    published={published}
                    busy={busy}
                    onRecorded={(pid) => {
                      setLastProgressId(pid);
                      void load();
                    }}
                    announce={announce}
                  />
                )}
                {r.status === "active" && published && r.pinnedVersion !== published.version && (
                  <p className="m-0 mt-1 text-[11.5px] text-subtle">
                    Pinned to v{r.pinnedVersion}; lesson recording here targets the current
                    published version only, so it is unavailable for this enrollment.
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
        {lastProgressId && (
          <div className="mt-2 flex items-center gap-2">
            <Btn
              size="sm"
              disabled={busy}
              onClick={() =>
                void runAction(async () => {
                  const res = await api.programs.reviewProgress(lastProgressId);
                  setLastProgressId(null);
                  return res;
                })
              }
              data-testid="review-progress"
            >
              Mark last recorded entry reviewed
            </Btn>
          </div>
        )}
      </Card>

      {/* ----------------------------------------------------------- history */}
      <Card className="px-4 py-3" data-testid="history-panel">
        <CardTitle className="mb-2">
          <History size={13} strokeWidth={2} className="text-brand" aria-hidden />
          Version history
        </CardTitle>
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {studio.history.map((h) => (
            <li key={h.id} className="flex items-baseline gap-2 text-[12px]">
              <span className="font-semibold text-body">v{h.version}</span>
              <span className="inline-flex h-[18px] items-center rounded-full bg-slate-tint px-2 text-[10px] font-bold text-slate-badge">
                {h.status}
              </span>
              <span className="text-subtle">{h.title ?? ""}</span>
              {h.status !== "draft" && h.status !== "in_review" && !editable && h.status === "superseded" && (
                <Btn
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void runAction(() => api.programs.revise(h.id))}
                >
                  Revise from this version
                </Btn>
              )}
            </li>
          ))}
        </ul>
        {studio.events.length > 0 && (
          <div className="mt-2 border-t border-hairline-2 pt-2">
            <p className={LABEL}>Event log</p>
            <ul className="m-0 flex list-none flex-col gap-[2px] p-0" data-testid="event-log">
              {studio.events.slice(0, 12).map((e, i) => (
                <li key={i} className="text-[11.5px] text-subtle">
                  {new Date(e.createdAt).toLocaleString()} — {e.fromStatus ?? "created"} →{" "}
                  {e.toStatus}
                  {e.note ? ` · “${e.note}”` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {/* ------------------------------------------------------ confirmations */}
      <ConfirmDialog
        open={confirm === "approve"}
        title="Approve this version?"
        body="Approval freezes the content permanently. It does NOT publish: patients see nothing until you publish it in a separate step."
        confirmLabel="Approve (does not publish)"
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null);
          if (editable) void runAction(() => api.programs.approve(editable.id, returnNote || null));
        }}
      />
      <ConfirmDialog
        open={confirm === "publish"}
        title="Publish this version?"
        body="Publishing makes this version the one new enrollments receive. It creates no enrollment, charge, invoice, or message, and existing enrollments keep the exact version they are pinned to."
        confirmLabel="Publish"
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null);
          if (approvedEntry) void runAction(() => api.programs.publish(approvedEntry.id));
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------ progress recorder */

function RecordProgressRow({
  enrollmentId,
  published,
  busy,
  onRecorded,
  announce,
}: {
  enrollmentId: string;
  published: LiveProgramVersionDetail;
  busy: boolean;
  onRecorded: (progressId: string) => void;
  announce: (m: string) => void;
}) {
  const lessons = published.modules.flatMap((m) => m.lessons.map((l) => ({ id: l.id, title: l.title })));
  const [lessonId, setLessonId] = useState(lessons[0]?.id ?? "");
  const [saving, setSaving] = useState(false);

  const record = async (kind: "lesson_completed" | "check_in") => {
    if (saving) return;
    setSaving(true);
    try {
      const res = await api.programs.recordProgress({
        enrollmentId,
        kind,
        lessonId: kind === "lesson_completed" ? lessonId : null,
        payload: kind === "check_in" ? { responseType: "text", note: "Recorded in visit" } : {},
        needsReview: kind === "check_in",
      });
      announce(res.message);
      if (res.progressId) onRecorded(res.progressId);
    } catch (e) {
      announce(errText(e));
    } finally {
      setSaving(false);
    }
  };

  if (lessons.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-hairline-2 pt-2">
      <select
        className="h-7 rounded-[7px] border border-line bg-card px-2 text-[11.5px]"
        value={lessonId}
        onChange={(e) => setLessonId(e.target.value)}
        aria-label="Lesson to mark complete"
        data-testid="progress-lesson"
      >
        {lessons.map((l) => (
          <option key={l.id} value={l.id}>{l.title}</option>
        ))}
      </select>
      <Btn size="sm" disabled={busy || saving || !lessonId} onClick={() => void record("lesson_completed")} data-testid="progress-complete-lesson">
        Mark lesson complete
      </Btn>
      <Btn size="sm" disabled={busy || saving} onClick={() => void record("check_in")} data-testid="progress-check-in">
        Record check-in (flag for review)
      </Btn>
    </div>
  );
}

/* -------------------------------------------------------------- offers */

function OffersPanel({ studio, onChanged }: { studio: LiveProgramStudio; onChanged: () => Promise<void> }) {
  const { announce } = useFeedback();
  const [name, setName] = useState("");
  const [price, setPrice] = useState("0");
  const [duration, setDuration] = useState("");
  const [mode, setMode] = useState<"free" | "manual_comp" | "stripe">("free");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      const res = await api.programs.upsertOffer({
        programId: studio.program.id,
        name: name.trim(),
        priceCents: Math.max(0, Math.round(Number(price) * 100) || 0),
        accessDurationDays: duration ? Number(duration) : null,
        paymentMode: mode,
      });
      announce(res.message);
      setName("");
      setPrice("0");
      setDuration("");
      setMode("free");
      await onChanged();
    } catch (e) {
      announce(errText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="px-4 py-3" data-testid="offers-panel">
      <CardTitle className="mb-2">Offers</CardTitle>
      {studio.offers.length === 0 ? (
        <p className="m-0 text-[12px] text-faint">No offers configured.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {studio.offers.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center gap-2 text-[12.5px]" data-testid={`offer-${o.id}`}>
              <span className="font-semibold text-body">{o.name}</span>
              <span className="text-subtle">
                {(o.priceCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}
                {o.accessDurationDays ? ` · ${o.accessDurationDays} days access` : " · open-ended"}
              </span>
              <span className="inline-flex h-[18px] items-center rounded-full bg-slate-tint px-2 text-[10px] font-bold text-slate-badge">
                {o.paymentMode === "manual_comp" ? "manual comp" : o.paymentMode}
              </span>
              {o.paymentMode === "stripe" && (
                <span
                  className="inline-flex h-[18px] items-center rounded-full bg-warning-tint px-2 text-[10px] font-bold text-warning-deep"
                  data-testid="stripe-not-configured"
                >
                  Stripe: Not configured — cannot enroll
                </span>
              )}
              {!o.enrollmentOpen && <span className="text-[11px] text-faint">enrollment closed</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-hairline-2 pt-2">
        <input
          className={`${INPUT} !w-[180px]`}
          value={name}
          placeholder="Offer name"
          aria-label="Offer name"
          onChange={(e) => setName(e.target.value)}
          data-testid="offer-name"
        />
        <input
          className={`${INPUT} !w-[90px]`}
          value={price}
          inputMode="decimal"
          aria-label="Price in dollars"
          onChange={(e) => setPrice(e.target.value)}
          data-testid="offer-price"
        />
        <input
          className={`${INPUT} !w-[110px]`}
          value={duration}
          placeholder="Days (opt.)"
          inputMode="numeric"
          aria-label="Access duration in days"
          onChange={(e) => setDuration(e.target.value)}
        />
        <select
          className={`${INPUT} !w-auto`}
          value={mode}
          aria-label="Payment mode"
          onChange={(e) => setMode(e.target.value as typeof mode)}
          data-testid="offer-mode"
        >
          <option value="free">Free</option>
          <option value="manual_comp">Manual complimentary</option>
          <option value="stripe">Stripe (Not configured)</option>
        </select>
        <Btn disabled={!name.trim() || saving} onClick={() => void save()} data-testid="offer-save">
          Save offer
        </Btn>
      </div>
      <ClinicalNote className="mt-2">
        Offers store commercial terms only. This application <strong>never processes a payment</strong>;
        a Stripe-mode offer is stored intent and cannot enroll anyone until a verified payment
        integration exists.
      </ClinicalNote>
    </Card>
  );
}
