"use client";

import { useMemo, useState } from "react";
import {
  CircleCheck,
  CircleX,
  GitBranch,
  ShieldAlert,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import {
  HYPOTHESIS_STATUS_META,
  SOURCE_FILTERS,
  getReasoningWorkspace,
  type ReasoningSourceKind,
  type ReasoningWorkspaceData,
  type WorkspaceHypothesis,
} from "@/adapters/reasoning.mock";
import {
  addSessionQueueItem,
  useReviewOutcome,
  type ReviewOutcome,
} from "@/adapters/session-store";
import type { Tone } from "@/adapters/types";
import { ActionBar } from "@/components/ui/ActionBar";
import { Provenance } from "@/components/ui/Provenance";
import { Card } from "@/components/ui/bits";
import { cn } from "@/lib/cn";
import { useFeedback } from "@/lib/feedback";
import { toneText, toneTint } from "@/lib/tones";

const OUTCOME_PILL: Partial<Record<ReviewOutcome, { label: string; tone: Tone }>> = {
  accepted: { label: "Accepted this session", tone: "positive" },
  approved: { label: "Approved this session", tone: "positive" },
  rejected: { label: "Rejected this session", tone: "critical" },
  flagged: { label: "Flagged this session", tone: "warning" },
};

const CHANGE_META = {
  new: { label: "New", tone: "action" as Tone },
  strengthened: { label: "Stronger", tone: "warning" as Tone },
  weakened: { label: "Weaker", tone: "positive" as Tone },
  resolved: { label: "Resolved", tone: "positive" as Tone },
};

const HYPOTHESIS_ACTIONS = [
  "accept_hypothesis",
  "modify",
  "reject",
  "add_evidence",
  "add_contradiction",
  "request_data",
  "convert_to_task",
  "convert_to_experiment",
  "add_to_note",
] as const;

function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span
      className="rounded-full px-[7px] py-px text-[10px] font-semibold whitespace-nowrap"
      style={{ color: toneText[tone], background: toneTint[tone] }}
    >
      {children}
    </span>
  );
}

export function ReasoningWorkspace({
  patientId,
  patientName,
}: {
  patientId: string;
  patientName: string;
}) {
  const [ws] = useState<ReasoningWorkspaceData>(() => getReasoningWorkspace(patientId));
  const [sources, setSources] = useState<Set<ReasoningSourceKind>>(new Set());
  const [selectedId, setSelectedId] = useState<string>(ws.hypotheses[0]?.id ?? "");

  const selected = ws.hypotheses.find((h) => h.id === selectedId) ?? null;

  const timeline = useMemo(
    () =>
      sources.size === 0
        ? ws.timeline
        : ws.timeline.filter((t) => sources.has(t.source)),
    [ws.timeline, sources],
  );

  const toggleSource = (s: ReasoningSourceKind) =>
    setSources((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  return (
    <section data-screen-label="Clinical Reasoning Workspace" className="relative pb-6">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="flex items-center gap-[7px]">
            <GitBranch size={17} strokeWidth={2} className="text-ai" aria-hidden />
            <h1 className="m-0 text-[19px] font-bold tracking-[-0.015em]">Clinical Reasoning</h1>
          </div>
          <p className="mt-[3px] mb-0 text-[11.5px] text-subtle">
            Updated {ws.updatedOn} · {ws.dateRange} · Strength = internal evidence weighting,
            not a medical probability. AI-assembled; requires practitioner review.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-[220px_minmax(0,1fr)_330px] items-start gap-4">
        {/* Left: filters + timeline + what changed */}
        <div className="flex flex-col gap-3">
          <Card className="p-[13px]">
            <h2 className="m-0 mb-[8px] text-[12px] font-bold text-body-2">Date range</h2>
            <div className="rounded-[8px] bg-sunken-2 px-[9px] py-[6px] text-[11px] font-semibold text-muted">
              {ws.dateRange}
            </div>
            <h2 className="m-0 mt-[12px] mb-[7px] text-[12px] font-bold text-body-2">Sources</h2>
            <div className="flex flex-col gap-[4px]" role="group" aria-label="Source filters">
              {SOURCE_FILTERS.map((s) => {
                const active = sources.has(s.id);
                return (
                  <button
                    key={s.id}
                    onClick={() => toggleSource(s.id)}
                    aria-pressed={active}
                    className={cn(
                      "flex items-center justify-between rounded-[7px] border px-[9px] py-[5px] text-left text-[11.5px] font-semibold focus-visible:outline-2 focus-visible:outline-action",
                      active
                        ? "border-action bg-action-tint text-action-deep"
                        : "border-transparent text-body-2 hover:bg-sunken",
                    )}
                  >
                    {s.label}
                    <span className="text-[10px] text-faint">
                      {ws.timeline.filter((t) => t.source === s.id).length}
                    </span>
                  </button>
                );
              })}
            </div>
          </Card>

          <Card className="p-[13px]">
            <h2 className="m-0 mb-[9px] text-[12px] font-bold text-body-2">Timeline</h2>
            {timeline.length === 0 ? (
              <p className="m-0 text-[11.5px] text-faint">
                No events match the selected sources — clear a filter to see more.
              </p>
            ) : (
              <ol className="m-0 flex list-none flex-col gap-[9px] p-0">
                {timeline.map((t) => (
                  <li key={t.id} className="flex gap-[8px]">
                    <span className="w-[38px] shrink-0 text-[10px] font-bold text-faint">{t.date}</span>
                    <span className="min-w-0">
                      <span className="block text-[11.5px] leading-[1.4] text-body">{t.text}</span>
                      <span className="text-[9.5px] text-faint capitalize">{t.source.replace("-", " ")}</span>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Card>

          <Card className="p-[13px]">
            <h2 className="m-0 mb-[9px] text-[12px] font-bold text-body-2">What changed</h2>
            <div className="flex flex-col gap-[8px]">
              {ws.whatChanged.map((c) => (
                <div key={c.text} className="flex items-start gap-[6px]">
                  <span
                    className="mt-px shrink-0 rounded-[4px] px-[5px] py-px text-[9px] font-bold"
                    style={{ color: toneText[CHANGE_META[c.direction].tone], background: toneTint[CHANGE_META[c.direction].tone] }}
                  >
                    {CHANGE_META[c.direction].label}
                  </span>
                  <span className="text-[11px] leading-[1.4] text-body">{c.text}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* Center: hypothesis cards */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-[6px] px-1">
            <Sparkles size={13} strokeWidth={2} className="text-ai" aria-hidden />
            <span className="text-[11px] font-bold text-body-2">
              Ranked hypotheses ({ws.hypotheses.length})
            </span>
            <span className="text-[10.5px] text-faint">
              — internal evidence weighting, not a medical probability
            </span>
          </div>
          {ws.hypotheses.map((h) => (
            <HypothesisCard
              key={h.id}
              h={h}
              patientId={patientId}
              patientName={patientName}
              selected={h.id === selectedId}
              onSelect={() => setSelectedId(h.id)}
            />
          ))}
        </div>

        {/* Right: evidence inspector */}
        <EvidenceInspector h={selected} patientId={patientId} />
      </div>
    </section>
  );
}

function HypothesisCard({
  h,
  patientId,
  patientName,
  selected,
  onSelect,
}: {
  h: WorkspaceHypothesis;
  patientId: string;
  patientName: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const reviewKey = `hypo:${patientId}:${h.id}`;
  const outcome = useReviewOutcome(reviewKey);
  const status = HYPOTHESIS_STATUS_META[h.status];
  const pill = outcome ? OUTCOME_PILL[outcome] : null;

  return (
    <Card
      className={cn(
        "p-[13px] transition-colors",
        selected && "border-action shadow-[0_2px_10px_rgba(37,99,199,0.1)]",
      )}
    >
      <div className="flex items-start gap-[10px]">
        <button
          onClick={onSelect}
          aria-pressed={selected}
          aria-label={`Inspect ${h.name}`}
          className="min-w-0 flex-1 cursor-pointer text-left focus-visible:outline-2 focus-visible:outline-action"
        >
          <div className="flex flex-wrap items-center gap-[7px]">
            <span className="text-[13.5px] font-bold text-ink">{h.name}</span>
            <Pill tone={status.tone}>{status.label}</Pill>
            {pill && <Pill tone={pill.tone}>{pill.label}</Pill>}
          </div>
          <p className="mt-[3px] mb-0 text-[11.5px] leading-[1.45] text-subtle">{h.summary}</p>
        </button>
        <span className="shrink-0 rounded-[7px] bg-ai-tint px-2 py-[3px] text-[12px] font-bold text-ai-deep">
          {h.strength}
          <span className="ml-[2px] text-[9px] font-semibold text-ai">wt</span>
        </span>
      </div>

      <div className="mt-[8px] flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-subtle">
        <span className="flex items-center gap-[4px]">
          <CircleCheck size={11} strokeWidth={2} className="text-positive-bright" aria-hidden />
          {h.evidenceFor.length} for
        </span>
        <span className="flex items-center gap-[4px]">
          <CircleX size={11} strokeWidth={2} className="text-critical" aria-hidden />
          {h.evidenceAgainst.length} against
        </span>
        <span className="flex items-center gap-[4px]">
          <TriangleAlert size={11} strokeWidth={2} className="text-warning" aria-hidden />
          {h.contradictions.length} contradiction{h.contradictions.length === 1 ? "" : "s"}
        </span>
        <span>{h.missingInformation.length} missing</span>
        <span aria-hidden>·</span>
        <span>Changed {h.lastChanged}</span>
      </div>

      <ActionBar
        size="sm"
        className="mt-[9px] border-t border-hairline-2 pt-[9px]"
        actions={[...HYPOTHESIS_ACTIONS]}
        context={{
          subjectType: "hypothesis",
          subjectLabel: h.name,
          patientName,
          seeds: h.seeds,
          reviewKey,
        }}
        onExecuted={(kind) => {
          if (kind === "convert_to_task") {
            addSessionQueueItem({
              title: `Review hypothesis: ${h.name}`,
              patientName,
              patientId,
              category: "reasoning-review",
              priority: "Medium",
              seeds: h.seeds,
            });
          }
        }}
      />
    </Card>
  );
}

function EvidenceInspector({
  h,
  patientId,
}: {
  h: WorkspaceHypothesis | null;
  patientId: string;
}) {
  const { announce } = useFeedback();
  const outcome = useReviewOutcome(h ? `hypo:${patientId}:${h.id}` : "");

  if (!h) {
    return (
      <Card className="px-5 py-[50px] text-center">
        <p className="m-0 text-[12.5px] text-subtle">Select a hypothesis to inspect its evidence.</p>
      </Card>
    );
  }

  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div className="border-t border-hairline-2 px-[14px] py-[11px] first:border-t-0">
      <h3 className="m-0 mb-[7px] text-[10.5px] font-bold tracking-[0.04em] text-faint uppercase">{title}</h3>
      {children}
    </div>
  );

  const List = ({ items, empty }: { items: string[]; empty: string }) =>
    items.length === 0 ? (
      <p className="m-0 text-[11px] text-faint">{empty}</p>
    ) : (
      <ul className="m-0 flex list-none flex-col gap-[6px] p-0">
        {items.map((t) => (
          <li key={t} className="text-[11.5px] leading-[1.45] text-body">{t}</li>
        ))}
      </ul>
    );

  return (
    <Card className="sticky top-[6px] overflow-hidden">
      <div className="border-b border-hairline px-[14px] pt-[12px] pb-[10px]">
        <div className="flex items-start justify-between gap-2">
          <h2 className="m-0 text-[13.5px] font-bold">{h.name}</h2>
          <span className="shrink-0 rounded-[7px] bg-ai-tint px-2 py-[2px] text-[11px] font-bold text-ai-deep">
            {h.strength} <span className="text-[9px] font-semibold text-ai">wt</span>
          </span>
        </div>
        {outcome && OUTCOME_PILL[outcome] && (
          <div className="mt-[6px]">
            <Pill tone={OUTCOME_PILL[outcome]!.tone}>{OUTCOME_PILL[outcome]!.label}</Pill>
          </div>
        )}
        <div className="mt-[8px]">
          <Provenance data={h.provenance} onOpenSource={() => announce("Opened source (demo — no document).")} />
        </div>
      </div>

      <div className="max-h-[560px] overflow-y-auto">
        <Section title="Evidence for">
          <ul className="m-0 flex list-none flex-col gap-[7px] p-0">
            {h.evidenceFor.map((e) => (
              <li key={e.text} className="flex items-start gap-[6px]">
                <CircleCheck size={12} strokeWidth={2} className="mt-[2px] shrink-0 text-positive-bright" aria-hidden />
                <span className="min-w-0">
                  <span className="block text-[11.5px] leading-[1.4] text-body">{e.text}</span>
                  <span className="text-[9.5px] text-faint">{e.source}</span>
                </span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Evidence against">
          {h.evidenceAgainst.length === 0 ? (
            <p className="m-0 text-[11px] text-faint">None recorded.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-[7px] p-0">
              {h.evidenceAgainst.map((e) => (
                <li key={e.text} className="flex items-start gap-[6px]">
                  <CircleX size={12} strokeWidth={2} className="mt-[2px] shrink-0 text-critical" aria-hidden />
                  <span className="min-w-0">
                    <span className="block text-[11.5px] leading-[1.4] text-body">{e.text}</span>
                    <span className="text-[9.5px] text-faint">{e.source}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Contradictions">
          <List items={h.contradictions} empty="No unresolved contradictions." />
        </Section>

        <Section title="Missing information">
          <List items={h.missingInformation} empty="Nothing flagged." />
        </Section>

        <Section title="Safety considerations">
          {h.safetyConsiderations.length === 0 ? (
            <p className="m-0 text-[11px] text-faint">None flagged.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-[6px] p-0">
              {h.safetyConsiderations.map((t) => (
                <li key={t} className="flex items-start gap-[6px] text-[11.5px] leading-[1.45] text-body">
                  <ShieldAlert size={12} strokeWidth={2} className="mt-[2px] shrink-0 text-critical" aria-hidden />
                  {t}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Practitioner notes">
          <List items={h.practitionerNotes} empty="No notes yet — use Add to note to draft one." />
        </Section>

        <Section title="Audit trail">
          <p className="m-0 text-[11px] leading-[1.5] text-subtle">
            Session actions on this hypothesis are recorded in the demo audit log
            (see System → Audit Log). Backend audit history lands with the tRPC layer.
          </p>
        </Section>
      </div>
    </Card>
  );
}
