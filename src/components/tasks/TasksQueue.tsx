"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Inbox, Search, X } from "lucide-react";
import {
  CATEGORY_LABEL,
  CATEGORY_TONE,
  PRACTITIONER_SELF,
  QUEUE_CATEGORIES,
  getTaskQueue,
  type QueueCategory,
  type QueueItem,
} from "@/adapters/tasks.mock";
import { useReviewOutcomes, type ReviewOutcome } from "@/adapters/session-store";
import type { Priority, Tone } from "@/adapters/types";
import { ActionBar } from "@/components/ui/ActionBar";
import { Provenance } from "@/components/ui/Provenance";
import { Card } from "@/components/ui/bits";
import { cn } from "@/lib/cn";
import { patientPath } from "@/lib/routes";
import { toneText, toneTint } from "@/lib/tones";

const PRIORITY_TONE: Record<Priority, Tone> = {
  High: "critical",
  Medium: "warning",
  Low: "slate",
};

const ROW_ACTIONS = [
  "resolve",
  "add_to_note",
  "request_data",
  "schedule_appointment",
  "assign",
  "change_priority",
  "snooze",
  "open_source",
  "view_audit",
] as const;

type StatusFilter = "all" | "open" | "resolved";
type ScopeFilter = "mine" | "all";

function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span
      className="rounded-full px-[8px] py-[2px] text-[10.5px] font-semibold whitespace-nowrap"
      style={{ color: toneText[tone], background: toneTint[tone] }}
    >
      {children}
    </span>
  );
}

export function TasksQueue({
  initialCategory,
  initialPriority,
}: {
  initialCategory?: string;
  initialPriority?: string;
}) {
  const [items] = useState<QueueItem[]>(() => getTaskQueue());
  const reviews = useReviewOutcomes();

  const [search, setSearch] = useState("");
  const [cats, setCats] = useState<Set<QueueCategory>>(
    () =>
      new Set(
        initialCategory && QUEUE_CATEGORIES.some((c) => c.id === initialCategory)
          ? [initialCategory as QueueCategory]
          : [],
      ),
  );
  const [priority, setPriority] = useState<"All" | Priority>(
    initialPriority === "High" || initialPriority === "Medium" || initialPriority === "Low"
      ? initialPriority
      : "All",
  );
  const [status, setStatus] = useState<StatusFilter>("all");
  const [scope, setScope] = useState<ScopeFilter>("all");

  const outcomeOf = (id: string): ReviewOutcome | undefined => reviews[`queue:${id}`];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((it) => {
      if (cats.size > 0 && !cats.has(it.category)) return false;
      if (priority !== "All" && it.priority !== priority) return false;
      if (scope === "mine" && it.assignee !== PRACTITIONER_SELF) return false;
      const settled = outcomeOf(it.id);
      if (status === "resolved" && settled !== "resolved") return false;
      if (status === "open" && settled === "resolved") return false;
      if (q && !`${it.title} ${it.patientName}`.toLowerCase().includes(q)) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, cats, priority, scope, status, search, reviews]);

  const toggleCat = (c: QueueCategory) =>
    setCats((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });

  const hasFilters =
    cats.size > 0 || priority !== "All" || status !== "all" || scope !== "all" || search.trim() !== "";
  const clearFilters = () => {
    setCats(new Set());
    setPriority("All");
    setStatus("all");
    setScope("all");
    setSearch("");
  };

  const openCount = items.filter((it) => outcomeOf(it.id) !== "resolved").length;

  return (
    <section
      data-screen-label="Tasks & Review Queue"
      className="relative mx-auto max-w-[1180px] px-6 pt-[22px] pb-10"
    >
      <div className="mb-1 text-[11.5px] font-semibold text-faint">Workspace / Tasks</div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="m-0 text-[21px] font-bold tracking-[-0.015em]">Tasks &amp; review queue</h1>
          <p className="mt-[4px] mb-0 text-[12.5px] text-subtle">
            {openCount} open · {items.length} total. Resolving an item records a demo session
            audit event — not backend persistence.
          </p>
        </div>
        <div className="flex items-center gap-2" role="group" aria-label="Task scope">
          {(["all", "mine"] as ScopeFilter[]).map((s) => (
            <button
              key={s}
              onClick={() => setScope(s)}
              aria-pressed={scope === s}
              className={cn(
                "h-8 cursor-pointer rounded-lg border px-3 text-[12px] font-semibold focus-visible:outline-2 focus-visible:outline-action",
                scope === s
                  ? "border-action bg-action-tint text-action-deep"
                  : "border-line bg-card text-body-2 hover:border-line-hover",
              )}
            >
              {s === "mine" ? "My tasks" : "All practice"}
            </button>
          ))}
        </div>
      </div>

      {/* Filters */}
      <Card className="mb-4 p-[14px]">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex h-8 min-w-[220px] flex-1 items-center gap-2 rounded-lg border border-line bg-card px-[10px] focus-within:border-action">
            <Search size={14} strokeWidth={2} className="text-faint" aria-hidden />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tasks or patients…"
              aria-label="Search tasks"
              className="flex-1 border-none bg-transparent text-[12.5px] outline-none placeholder:text-faint"
            />
          </label>

          <div className="flex items-center gap-1" role="group" aria-label="Priority filter">
            {(["All", "High", "Medium", "Low"] as const).map((p) => (
              <button
                key={p}
                onClick={() => setPriority(p)}
                aria-pressed={priority === p}
                className={cn(
                  "h-8 cursor-pointer rounded-lg border px-[10px] text-[11.5px] font-semibold focus-visible:outline-2 focus-visible:outline-action",
                  priority === p
                    ? "border-action bg-action-tint text-action-deep"
                    : "border-line bg-card text-body-2 hover:border-line-hover",
                )}
              >
                {p}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1" role="group" aria-label="Status filter">
            {(
              [
                ["all", "All status"],
                ["open", "Open"],
                ["resolved", "Resolved"],
              ] as [StatusFilter, string][]
            ).map(([s, label]) => (
              <button
                key={s}
                onClick={() => setStatus(s)}
                aria-pressed={status === s}
                className={cn(
                  "h-8 cursor-pointer rounded-lg border px-[10px] text-[11.5px] font-semibold focus-visible:outline-2 focus-visible:outline-action",
                  status === s
                    ? "border-action bg-action-tint text-action-deep"
                    : "border-line bg-card text-body-2 hover:border-line-hover",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Category chips */}
        <div className="mt-[11px] flex flex-wrap gap-[6px]" role="group" aria-label="Category filter">
          {QUEUE_CATEGORIES.map((c) => {
            const count = items.filter((it) => it.category === c.id).length;
            const active = cats.has(c.id);
            return (
              <button
                key={c.id}
                onClick={() => toggleCat(c.id)}
                aria-pressed={active}
                className={cn(
                  "flex items-center gap-[5px] rounded-full border px-[10px] py-[4px] text-[11px] font-semibold focus-visible:outline-2 focus-visible:outline-action",
                  active
                    ? "border-transparent"
                    : "border-line bg-card text-body-2 hover:border-line-hover",
                )}
                style={active ? { color: toneText[c.tone], background: toneTint[c.tone] } : undefined}
              >
                {c.label}
                <span className={cn("text-[10px]", active ? "opacity-80" : "text-faint")}>{count}</span>
              </button>
            );
          })}
        </div>
      </Card>

      {/* Queue */}
      {filtered.length === 0 ? (
        <Card className="flex flex-col items-center gap-[10px] px-6 py-[60px] text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-[13px] bg-slate-tint">
            <Inbox size={20} strokeWidth={1.75} className="text-slate-badge" aria-hidden />
          </span>
          <h2 className="m-0 text-[15px] font-bold">No items match your filters</h2>
          <p className="m-0 max-w-[440px] text-[12.5px] leading-[1.5] text-subtle">
            {items.length} item{items.length === 1 ? "" : "s"} are hidden by the current search,
            category, priority, status, or scope filters.
          </p>
          {hasFilters && (
            <button
              onClick={clearFilters}
              className="mt-1 flex h-8 cursor-pointer items-center gap-[6px] rounded-lg border border-line bg-card px-3 text-[12.5px] font-semibold text-action hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action"
            >
              <X size={13} strokeWidth={2} aria-hidden />
              Clear filters
            </button>
          )}
        </Card>
      ) : (
        <div className="flex flex-col gap-[10px]">
          {filtered.map((it) => (
            <QueueRow key={it.id} item={it} outcome={outcomeOf(it.id)} />
          ))}
        </div>
      )}
    </section>
  );
}

function QueueRow({ item, outcome }: { item: QueueItem; outcome?: ReviewOutcome }) {
  const resolved = outcome === "resolved";
  const dueTone: Tone =
    item.dueInDays < 0 ? "critical" : item.dueInDays === 0 ? "warning" : "slate";
  const actions = [...ROW_ACTIONS, ...(item.extraActions ?? [])];

  return (
    <Card
      className={cn("p-[14px] transition-opacity", resolved && "opacity-60")}
      aria-label={`${CATEGORY_LABEL[item.category]} — ${item.title}`}
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <Pill tone={CATEGORY_TONE[item.category]}>{CATEGORY_LABEL[item.category]}</Pill>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("text-[13.5px] font-semibold text-ink", resolved && "line-through")}>
              {item.title}
            </span>
            {outcome && (
              <Pill tone={outcome === "resolved" ? "positive" : "warning"}>
                {outcome[0].toUpperCase() + outcome.slice(1)} this session
              </Pill>
            )}
          </div>
          <div className="mt-[3px] flex flex-wrap items-center gap-x-[10px] gap-y-1 text-[11.5px] text-subtle">
            <Link
              href={patientPath(item.patientId, "summary")}
              className="font-semibold text-action hover:text-action-deep focus-visible:outline-2 focus-visible:outline-action"
            >
              {item.patientName}
            </Link>
            <span aria-hidden>·</span>
            <span>Assigned {item.assignee}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span
            className="text-[11px] font-semibold"
            style={{ color: toneText[dueTone] }}
          >
            {item.due}
          </span>
          <Pill tone={PRIORITY_TONE[item.priority]}>{item.priority}</Pill>
        </div>
      </div>

      <div className="mt-[9px]">
        <Provenance data={item.provenance} />
      </div>

      <ActionBar
        size="sm"
        className="mt-[10px] border-t border-hairline-2 pt-[10px]"
        actions={actions}
        context={{
          subjectType: CATEGORY_LABEL[item.category].toLowerCase(),
          subjectLabel: item.title,
          patientName: item.patientName,
          seeds: item.seeds,
          reviewKey: `queue:${item.id}`,
        }}
      />
    </Card>
  );
}
