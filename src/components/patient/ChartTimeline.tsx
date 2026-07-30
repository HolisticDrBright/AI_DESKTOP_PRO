"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Lock, Search } from "lucide-react";
import {
  getTimeline,
  TIMELINE_KIND_META,
  type TimelineKind,
} from "@/adapters/timeline.mock";
import { toneColor } from "@/lib/tones";
import { cn } from "@/lib/cn";
import { Card } from "@/components/ui/bits";
import { TextInput } from "@/components/ui/Field";
import { Pill } from "@/components/ui/Pill";
import { DemoNote } from "@/components/ui/DemoNote";

const ALL_KINDS = Object.keys(TIMELINE_KIND_META) as TimelineKind[];

/**
 * Chart & Timeline (mock): one filterable longitudinal record — encounters,
 * signed notes, addenda, forms, communications, labs, prescriptions,
 * supplements, protocol changes, wearable alerts, payments, programs.
 * Live mode renders the real EMR timeline instead of this component.
 */
export function ChartTimeline({
  patientId,
  patientName,
}: {
  patientId: string;
  patientName: string;
}) {
  const events = useMemo(() => getTimeline(patientId), [patientId]);
  const [active, setActive] = useState<Set<TimelineKind>>(new Set());
  const [q, setQ] = useState("");

  const visible = events.filter((e) => {
    if (active.size > 0 && !active.has(e.kind)) return false;
    if (q && !`${e.title} ${e.detail}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  const toggle = (k: TimelineKind) => {
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const resolveHref = (href?: string) =>
    !href ? undefined : href.startsWith("/") ? href : `/patients/${patientId}/${href}`;

  const presentKinds = ALL_KINDS.filter((k) => events.some((e) => e.kind === k));

  return (
    <div data-screen-label="Chart & Timeline" className="flex flex-col gap-3">
      <Card className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-[6px]">
          <div className="relative mr-2">
            <Search size={13} className="absolute top-1/2 left-[9px] -translate-y-1/2 text-faint" aria-hidden />
            <TextInput
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={`Search ${patientName.split(" ")[0]}'s record…`}
              aria-label="Search timeline"
              className="w-[220px] pl-[28px]"
            />
          </div>
          <button
            onClick={() => setActive(new Set())}
            className={cn(
              "h-7 cursor-pointer rounded-full border px-[10px] text-[11.5px] font-semibold focus-visible:outline-2 focus-visible:outline-action",
              active.size === 0
                ? "border-nav-active-line bg-nav-active text-action-deep"
                : "border-line bg-card text-muted hover:border-line-hover",
            )}
          >
            All ({events.length})
          </button>
          {presentKinds.map((k) => {
            const meta = TIMELINE_KIND_META[k];
            const count = events.filter((e) => e.kind === k).length;
            const on = active.has(k);
            return (
              <button
                key={k}
                onClick={() => toggle(k)}
                aria-pressed={on}
                className={cn(
                  "h-7 cursor-pointer rounded-full border px-[10px] text-[11.5px] font-semibold focus-visible:outline-2 focus-visible:outline-action",
                  on
                    ? "border-nav-active-line bg-nav-active text-action-deep"
                    : "border-line bg-card text-muted hover:border-line-hover",
                )}
              >
                {meta.label} ({count})
              </button>
            );
          })}
        </div>
      </Card>

      <Card className="overflow-hidden">
        {visible.length === 0 ? (
          <p className="m-0 px-4 py-8 text-center text-[12.5px] text-faint">
            No events match the current filters.
          </p>
        ) : (
          <div className="flex flex-col">
            {visible.map((e) => {
              const href = resolveHref(e.href);
              const body = (
                <>
                  <span
                    aria-hidden
                    className="mt-[3px] h-[10px] w-[10px] shrink-0 rounded-full border-2 border-card"
                    style={{ background: toneColor[e.tone], boxShadow: `0 0 0 1px ${toneColor[e.tone]}` }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-[6px]">
                      <span className="truncate text-[13px] font-semibold text-ink">{e.title}</span>
                      {e.locked && <Lock size={11} strokeWidth={2} className="shrink-0 text-faint" aria-label="Signed / locked" />}
                      <Pill tone={e.tone} className="ml-auto shrink-0">{TIMELINE_KIND_META[e.kind].label.replace(/s$/, "")}</Pill>
                    </span>
                    <span className="mt-[2px] block text-[12px] leading-[1.45] text-body">{e.detail}</span>
                    <span className="mt-[2px] block text-[11px] text-faint">{e.atLabel}</span>
                  </span>
                </>
              );
              const rowClass =
                "flex items-start gap-3 border-b border-hairline px-4 py-[10px] text-left last:border-b-0";
              return href ? (
                <Link key={e.id} href={href} className={cn(rowClass, "hover:bg-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-action")}>
                  {body}
                </Link>
              ) : (
                <div key={e.id} className={rowClass}>
                  {body}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <DemoNote>
        Demo longitudinal record — synthetic events assembled across labs, notes, messages,
        billing, and programs. In live mode this tab renders the real EMR timeline with
        signatures and addenda enforced by the backend.
      </DemoNote>
    </div>
  );
}
