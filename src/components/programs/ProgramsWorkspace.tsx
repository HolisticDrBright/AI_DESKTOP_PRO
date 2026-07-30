"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { BookOpen, GraduationCap, Plus } from "lucide-react";
import { api } from "@/adapters";
import { AdapterError } from "@/adapters/errors";
import type {
  LiveProgramLibrary,
  LiveProgramListItem,
  LiveProgramTemplate,
} from "@/adapters/live-types";
import { Card, CardTitle } from "@/components/ui/bits";
import { Btn } from "@/components/ui/Btn";
import { ClinicalEmpty, ClinicalError, ClinicalLoading, ClinicalNote } from "@/components/ui/ClinicalStates";
import { useFeedback } from "@/lib/feedback";

const INPUT =
  "h-8 rounded-lg border border-line bg-card px-3 text-[12.5px] text-body outline-none focus-visible:outline-2 focus-visible:outline-action";

function errText(e: unknown): string {
  return e instanceof AdapterError ? e.message : "Something went wrong. Try again.";
}

function StatusPill({ item }: { item: LiveProgramListItem }) {
  const tone =
    item.status === "published"
      ? "bg-positive-tint text-positive-deep"
      : item.status === "archived"
        ? "bg-slate-tint text-slate-badge"
        : "bg-warning-tint text-warning-deep";
  return (
    <span className={`inline-flex h-[20px] items-center rounded-full px-2 text-[10.5px] font-bold ${tone}`}>
      {item.status}
    </span>
  );
}

/**
 * The program library: real org-scoped rows, searchable and filterable.
 * Enrollment numbers are counts of persisted enrollment rows — engagement,
 * revenue, and completion-rate metrics are absent because no honest source
 * for them exists.
 */
export function ProgramsWorkspace() {
  const { announce } = useFeedback();
  const [library, setLibrary] = useState<LiveProgramLibrary | null>(null);
  const [templates, setTemplates] = useState<LiveProgramTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string>("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [fromTemplate, setFromTemplate] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [showArchivedTemplates, setShowArchivedTemplates] = useState(false);
  const queryRef = useRef(query);
  queryRef.current = query;

  const loadTemplates = useCallback(async (includeArchived: boolean) => {
    try {
      setTemplates(await api.programs.listTemplates(includeArchived));
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  const templateAction = async (fn: () => Promise<{ message: string }>) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fn();
      announce(res.message);
      await loadTemplates(showArchivedTemplates);
    } catch (e) {
      announce(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const load = useCallback(
    async (q: string, s: string) => {
      setError(null);
      try {
        const [lib, tpls] = await Promise.all([
          api.programs.library({ query: q || null, status: s || null }),
          api.programs.listTemplates(false),
        ]);
        // Ignore stale responses from a superseded search.
        if (queryRef.current === q) {
          setLibrary(lib);
          setTemplates(tpls);
        }
      } catch (e) {
        setError(errText(e));
      }
    },
    [],
  );

  useEffect(() => {
    const t = window.setTimeout(() => void load(query, status), query ? 250 : 0);
    return () => window.clearTimeout(t);
  }, [query, status, load]);

  const create = async () => {
    if (!newName.trim() || busy) return;
    setBusy(true);
    try {
      const res = await api.programs.create({
        name: newName.trim(),
        fromTemplateId: fromTemplate || null,
      });
      announce(res.message);
      setCreating(false);
      setNewName("");
      setFromTemplate("");
      await load(query, status);
    } catch (e) {
      announce(errText(e));
    } finally {
      setBusy(false);
    }
  };

  if (error && !library) return <ClinicalError message={error} onRetry={() => void load(query, status)} />;
  if (!library) return <ClinicalLoading label="Loading the program library…" />;

  const approvedTemplates = (templates ?? []).filter((t) => t.status === "approved");

  return (
    <div className="flex flex-col gap-3" data-testid="programs-workspace">
      <Card className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            className={`${INPUT} w-[240px]`}
            placeholder="Search programs…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search programs"
            data-testid="program-search"
          />
          <select
            className={INPUT}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            aria-label="Filter by status"
            data-testid="program-status-filter"
          >
            <option value="">All statuses</option>
            <option value="draft">Draft</option>
            <option value="published">Published</option>
            <option value="archived">Archived</option>
          </select>
          <span className="flex-1" />
          <Btn variant="primary" onClick={() => setCreating((v) => !v)} data-testid="program-create-toggle">
            <Plus size={13} strokeWidth={2.25} aria-hidden /> New program
          </Btn>
        </div>
        {creating && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-hairline-2 pt-3">
            <input
              className={`${INPUT} w-[260px]`}
              placeholder="Program name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              aria-label="New program name"
              data-testid="program-create-name"
            />
            <select
              className={INPUT}
              value={fromTemplate}
              onChange={(e) => setFromTemplate(e.target.value)}
              aria-label="Start from template"
              data-testid="program-create-template"
            >
              <option value="">Blank program</option>
              {approvedTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  From template: {t.name} (v{t.approvedVersion})
                </option>
              ))}
            </select>
            <Btn
              variant="primary"
              onClick={() => void create()}
              disabled={!newName.trim() || busy}
              data-testid="program-create-submit"
            >
              Create draft
            </Btn>
          </div>
        )}
      </Card>

      {library.programs.length === 0 ? (
        <ClinicalEmpty
          icon={<GraduationCap size={20} strokeWidth={1.75} className="text-slate-badge" aria-hidden />}
          title={query || status ? "No programs match" : "No programs yet"}
          message={
            query || status
              ? "No program in this organization matches the current search and filter."
              : "This organization has no programs. Create a draft to start building a curriculum — nothing synthetic is shown here."
          }
        />
      ) : (
        <ul className="m-0 grid list-none gap-3 p-0 md:grid-cols-2" data-testid="program-list">
          {library.programs.map((p) => (
            <li key={p.id}>
              <Link
                href={`/programs/${p.id}`}
                className="block rounded-2xl focus-visible:outline-2 focus-visible:outline-action"
                data-testid={`program-card-${p.id}`}
              >
                <Card className="h-full px-4 py-[13px] transition-colors hover:border-line-hover">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="mb-0">
                      <BookOpen size={13} strokeWidth={2} className="text-brand" aria-hidden />
                      {p.name}
                    </CardTitle>
                    <StatusPill item={p} />
                  </div>
                  {p.description && (
                    <p className="mt-1 mb-0 line-clamp-2 text-[12px] leading-normal text-subtle">{p.description}</p>
                  )}
                  <p className="mt-2 mb-0 text-[11.5px] text-subtle">
                    {p.publishedVersion ? `Published v${p.publishedVersion}` : "Never published"}
                    {p.draftStatus ? ` · ${p.draftStatus.replace("_", " ")} in progress` : ""}
                  </p>
                  <p className="mt-1 mb-0 text-[11.5px] text-subtle" data-testid="program-enrollment-counts">
                    Enrollments: {p.enrollment.active} active · {p.enrollment.paused} paused ·{" "}
                    {p.enrollment.invited} invited · {p.enrollment.completed} completed
                  </p>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Card className="px-4 py-3" data-testid="templates-panel">
        <div className="flex items-center gap-2">
          <CardTitle className="mb-0">Templates</CardTitle>
          <span className="flex-1" />
          <label className="flex items-center gap-[6px] text-[11.5px] font-semibold text-body-2">
            <input
              type="checkbox"
              checked={showArchivedTemplates}
              onChange={(e) => {
                setShowArchivedTemplates(e.target.checked);
                void loadTemplates(e.target.checked);
              }}
              data-testid="templates-show-archived"
            />
            Show archived
          </label>
        </div>
        {(templates ?? []).length === 0 ? (
          <p className="m-0 mt-2 text-[12px] text-faint" data-testid="templates-empty">
            No templates. Save a published program version as a template from its studio.
          </p>
        ) : (
          <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0" data-testid="template-list">
            {(templates ?? []).map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-2 text-[12.5px]" data-testid={`template-${t.id}`}>
                <span className="font-semibold text-body">{t.name}</span>
                <span className="inline-flex h-[18px] items-center rounded-full bg-slate-tint px-2 text-[10px] font-bold text-slate-badge">
                  {t.status}
                  {t.approvedVersion ? ` v${t.approvedVersion}` : ""}
                </span>
                <span className="flex-1" />
                {t.status === "draft" && t.currentVersionId && (
                  <Btn
                    size="sm"
                    disabled={busy}
                    onClick={() => void templateAction(() => api.programs.templates.approve(t.currentVersionId as string))}
                    data-testid="template-approve"
                  >
                    Approve for use
                  </Btn>
                )}
                {t.status !== "archived" ? (
                  <Btn
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void templateAction(() => api.programs.templates.archive(t.id, true))}
                    data-testid="template-archive"
                  >
                    Archive
                  </Btn>
                ) : (
                  <Btn
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void templateAction(() => api.programs.templates.archive(t.id, false))}
                  >
                    Restore
                  </Btn>
                )}
              </li>
            ))}
          </ul>
        )}
        <ClinicalNote className="mt-2">
          Archiving a template never changes programs already created from it — copies are fully
          detached.
        </ClinicalNote>
      </Card>

      <ClinicalNote>
        Enrollment numbers are counts of persisted enrollment records. Engagement, revenue,
        completion-rate, and &ldquo;at-risk&rdquo; metrics are <strong>not shown</strong> because no
        verified data source computes them.
      </ClinicalNote>
    </div>
  );
}
