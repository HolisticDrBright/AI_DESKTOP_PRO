"use client";

import Link from "next/link";
import { AlertTriangle, ArrowUpRight, CheckCheck, CircleAlert, Sparkles } from "lucide-react";
import type {
  AiAssistanceBrief,
  AiWorkflowPriority,
} from "@/adapters/ai-assistance.mock";
import { useReviewOutcome } from "@/adapters/session-store";
import { cn } from "@/lib/cn";
import { ActionBar } from "@/components/ui/ActionBar";
import { Card } from "@/components/ui/bits";
import { Pill, Tag } from "@/components/ui/Pill";

const PRIORITY: Record<
  AiWorkflowPriority,
  { label: string; tone: "critical" | "warning" | "slate" }
> = {
  now: { label: "Review now", tone: "critical" },
  today: { label: "Today", tone: "warning" },
  routine: { label: "Routine", tone: "slate" },
};

function PanelBody({
  brief,
  compact,
  actions,
}: {
  brief: AiAssistanceBrief;
  compact?: boolean;
  actions?: React.ReactNode;
}) {
  const outcome = useReviewOutcome(brief.reviewKey);
  const sourceById = new Map(brief.sources.map((source) => [source.id, source]));

  return (
    <>
      <div
        className={cn(
          "flex items-start gap-2 border-b border-hairline px-4 py-3",
          compact && "flex-wrap px-3",
        )}
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-ai-tint">
          <Sparkles size={14} strokeWidth={1.8} className="text-ai-deep" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="m-0 text-[10px] font-bold tracking-[0.05em] text-faint uppercase">
            {brief.eyebrow}
          </p>
          <h2 className="m-0 mt-[2px] text-[14px] font-bold text-ink">{brief.title}</h2>
          <p className="m-0 mt-[2px] text-[10.5px] text-subtle">{brief.generatedLabel}</p>
        </div>
        <div
          className={cn(
            "flex flex-col items-end gap-1",
            compact && "ml-9 w-full flex-row flex-wrap items-center",
          )}
        >
          <Tag>{brief.providerLabel}</Tag>
          {brief.status === "not-configured" ? (
            <Pill tone="slate">Not configured</Pill>
          ) : outcome ? (
            <Pill tone={outcome === "dismissed" ? "slate" : "positive"}>
              {outcome === "dismissed" ? "Dismissed this session" : "Reviewed this session"}
            </Pill>
          ) : (
            <Pill tone="warning">Awaiting review</Pill>
          )}
        </div>
      </div>

      <div className={cn("px-4 py-3", compact && "py-[10px]")}>
        <p className="m-0 text-[12px] leading-[1.5] text-body">{brief.summary}</p>

        {brief.items.length > 0 && (
          <div className="mt-3 flex flex-col divide-y divide-hairline border-y border-hairline">
            {brief.items.map((item) => {
              const priority = PRIORITY[item.priority];
              const row = (
                <>
                  <div className="flex min-w-0 flex-1 items-start gap-2">
                    <Pill tone={priority.tone} className="mt-px">{priority.label}</Pill>
                    <div className="min-w-0 flex-1">
                      <p className="m-0 text-[12px] font-semibold text-ink">{item.title}</p>
                      <p className="m-0 mt-[2px] text-[11px] leading-[1.4] text-subtle">{item.detail}</p>
                      <p className="m-0 mt-1 text-[10.5px] leading-[1.4] text-faint">
                        <span className="font-semibold text-subtle">Why:</span> {item.why}
                      </p>
                      {item.sourceIds.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {item.sourceIds.map((sourceId) => {
                            const source = sourceById.get(sourceId);
                            return source ? <Tag key={sourceId}>{source.label}</Tag> : null;
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                  {item.href && <ArrowUpRight size={13} className="mt-1 shrink-0 text-action" aria-hidden />}
                </>
              );
              return item.href ? (
                <Link
                  key={item.id}
                  href={item.href}
                  className="flex items-start gap-2 py-[9px] hover:bg-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-action"
                >
                  {row}
                </Link>
              ) : (
                <div key={item.id} className="flex items-start gap-2 py-[9px]">{row}</div>
              );
            })}
          </div>
        )}

        {brief.sources.length > 0 && (
          <details className="mt-3">
            <summary className="cursor-pointer text-[10.5px] font-bold tracking-[0.04em] text-subtle uppercase focus-visible:outline-2 focus-visible:outline-action">
              Sources used ({brief.sources.length})
            </summary>
            <div className="mt-2 flex flex-col gap-1">
              {brief.sources.map((source) => {
                const content = (
                  <>
                    <span className="font-semibold text-body">{source.label}</span>
                    <span className="text-subtle"> · {source.detail}</span>
                  </>
                );
                return source.href ? (
                  <Link key={source.id} href={source.href} className="text-[10.5px] leading-[1.4] text-action hover:underline">
                    {content}
                  </Link>
                ) : (
                  <p key={source.id} className="m-0 text-[10.5px] leading-[1.4]">{content}</p>
                );
              })}
            </div>
          </details>
        )}

        {brief.missingInformation.length > 0 && (
          <div className="mt-3 rounded-lg border border-[rgba(199,126,20,0.22)] bg-warning-tint px-3 py-2">
            <p className="m-0 flex items-center gap-1 text-[10.5px] font-bold text-warning-deep">
              <CircleAlert size={11} aria-hidden /> Missing or unverified
            </p>
            <ul className="m-0 mt-1 space-y-1 pl-4 text-[10.5px] leading-[1.4] text-body">
              {brief.missingInformation.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </div>
        )}

        <p className="m-0 mt-3 flex items-start gap-1 text-[10.5px] leading-[1.4] text-subtle">
          <AlertTriangle size={11} className="mt-[2px] shrink-0 text-warning-deep" aria-hidden />
          {brief.safetyNotice}
        </p>
      </div>

      {brief.status !== "not-configured" && (
        <div className="flex flex-wrap items-center gap-2 border-t border-hairline bg-sunken px-4 py-[9px]">
          <ActionBar
            size="sm"
            actions={["mark_reviewed", "dismiss"]}
            context={{
              subjectType: "AI assistance",
              subjectLabel: brief.title,
              reviewKey: brief.reviewKey,
              seeds: brief.items.map((item) => `${item.title}: ${item.detail}`),
            }}
          />
          {actions}
          {outcome === "reviewed" && (
            <span className="ml-auto flex items-center gap-1 text-[10.5px] font-semibold text-positive">
              <CheckCheck size={11} aria-hidden /> Review recorded
            </span>
          )}
        </div>
      )}
    </>
  );
}

export function AiAssistancePanel({
  brief,
  compact,
  embedded,
  actions,
  className,
}: {
  brief: AiAssistanceBrief;
  compact?: boolean;
  embedded?: boolean;
  actions?: React.ReactNode;
  className?: string;
}) {
  if (embedded) {
    return (
      <section className={cn("border-y border-hairline", className)} data-testid={brief.id}>
        <PanelBody brief={brief} compact={compact} actions={actions} />
      </section>
    );
  }
  return (
    <div className={className} data-testid={brief.id}>
      <Card className="overflow-hidden">
        <PanelBody brief={brief} compact={compact} actions={actions} />
      </Card>
    </div>
  );
}
