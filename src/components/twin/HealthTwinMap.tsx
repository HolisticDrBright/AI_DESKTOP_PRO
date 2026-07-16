"use client";

import { useState } from "react";
import Link from "next/link";
import { Activity, ArrowDownRight, ArrowRight, ArrowUpRight, History } from "lucide-react";
import {
  SYSTEM_STATUS_META,
  getHealthTwin,
  type HealthTwinData,
  type TwinSystemNode,
} from "@/adapters/twin.mock";
import { addSessionQueueItem } from "@/adapters/session-store";
import type { Tone } from "@/adapters/types";
import { ActionBar } from "@/components/ui/ActionBar";
import { Provenance } from "@/components/ui/Provenance";
import { Card } from "@/components/ui/bits";
import { cn } from "@/lib/cn";
import { useFeedback } from "@/lib/feedback";
import { patientPath } from "@/lib/routes";
import { toneText, toneTint } from "@/lib/tones";

const TREND_ICON = {
  improving: { Icon: ArrowUpRight, label: "Improving", tone: "positive" as Tone },
  stable: { Icon: ArrowRight, label: "Stable", tone: "slate" as Tone },
  worsening: { Icon: ArrowDownRight, label: "Worsening", tone: "critical" as Tone },
};

function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span
      className="w-fit rounded-full px-[7px] py-px text-[10px] font-semibold whitespace-nowrap"
      style={{ color: toneText[tone], background: toneTint[tone] }}
    >
      {children}
    </span>
  );
}

export function HealthTwinMap({
  patientId,
  patientName,
}: {
  patientId: string;
  patientName: string;
}) {
  const [twin] = useState<HealthTwinData>(() => getHealthTwin(patientId));
  const [snapIdx, setSnapIdx] = useState(twin.snapshots.length - 1);
  const [selectedId, setSelectedId] = useState("inflammation");
  const { announce } = useFeedback();

  const snapshot = twin.snapshots[snapIdx];
  const isLatest = snapIdx === twin.snapshots.length - 1;
  const node = snapshot.nodes.find((n) => n.id === selectedId) ?? snapshot.nodes[0];
  const detail = twin.details[node.id];

  return (
    <section data-screen-label="Health Twin" className="relative pb-6">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-[7px]">
            <Activity size={17} strokeWidth={2} className="text-brand" aria-hidden />
            <h1 className="m-0 text-[19px] font-bold tracking-[-0.015em]">Health Twin — system map</h1>
          </div>
          <p className="mt-[3px] mb-0 text-[11.5px] text-subtle">
            Status per body system with data completeness (coverage, not certainty).
            Adaptive model output — practitioner review governs any action.
          </p>
        </div>
        {/* State replay */}
        <div className="flex items-center gap-[6px]" role="group" aria-label="State replay">
          <History size={13} strokeWidth={2} className="text-faint" aria-hidden />
          {twin.snapshots.map((s, i) => (
            <button
              key={s.date}
              onClick={() => setSnapIdx(i)}
              aria-pressed={i === snapIdx}
              className={cn(
                "h-7 cursor-pointer rounded-lg border px-[10px] text-[11px] font-semibold focus-visible:outline-2 focus-visible:outline-action",
                i === snapIdx
                  ? "border-action bg-action-tint text-action-deep"
                  : "border-line bg-card text-body-2 hover:border-line-hover",
              )}
            >
              {s.date}
            </button>
          ))}
        </div>
      </div>

      {!isLatest && (
        <div className="mb-3 rounded-[10px] border border-[rgba(199,126,20,0.28)] bg-warning-tint px-[13px] py-[8px] text-[11.5px] font-semibold text-warning-deep">
          Viewing historical state · {snapshot.date}, 2026 — inspector shows current details;
          return to {twin.snapshots[twin.snapshots.length - 1].date} for the live picture.
        </div>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)_340px] items-start gap-4">
        {/* Node map */}
        <div className="grid grid-cols-3 gap-3" role="group" aria-label="Body systems">
          {snapshot.nodes.map((n) => (
            <SystemNode
              key={n.id}
              n={n}
              selected={n.id === node.id}
              onSelect={() => setSelectedId(n.id)}
            />
          ))}
        </div>

        {/* Inspector */}
        <Card className="sticky top-[6px] overflow-hidden">
          <div className="border-b border-hairline px-[14px] pt-[12px] pb-[10px]">
            <div className="flex items-start justify-between gap-2">
              <h2 className="m-0 text-[13.5px] font-bold">{node.name}</h2>
              <Pill tone={SYSTEM_STATUS_META[node.status].tone}>{SYSTEM_STATUS_META[node.status].label}</Pill>
            </div>
            <div className="mt-[7px]">
              <Provenance data={detail.provenance} />
            </div>
          </div>

          <div className="max-h-[520px] overflow-y-auto">
            <InspectorSection title="Current facts" items={detail.facts} empty="No findings in the current window." />
            <div className="border-t border-hairline-2 px-[14px] py-[10px]">
              <h3 className="m-0 mb-[6px] text-[10.5px] font-bold tracking-[0.04em] text-faint uppercase">Relevant biomarkers</h3>
              {detail.biomarkers.length === 0 ? (
                <p className="m-0 text-[11px] text-faint">None linked yet.</p>
              ) : (
                <div className="flex flex-col gap-[5px]">
                  {detail.biomarkers.map((b) => (
                    <div key={b.name} className="flex items-baseline justify-between gap-2 text-[11.5px]">
                      <span className="font-semibold text-body">{b.name}</span>
                      <span className="text-right text-muted">{b.value} <span className="text-[10px] text-faint">— {b.note}</span></span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <InspectorSection title="Symptoms" items={detail.symptoms} empty="None reported." />
            <InspectorSection title="Contributing factors" items={detail.contributing} empty="None identified." />
            <InspectorSection title="Interventions" items={detail.interventions} empty="None active." />
            <InspectorSection title="Historical response" items={detail.historicalResponse} empty="No prior comparisons." />
            <InspectorSection title="Missing information" items={detail.missingInformation} empty="Nothing flagged." />
            <InspectorSection title="Active hypotheses" items={detail.activeHypotheses} empty="None linked." />
            <InspectorSection title="Practitioner comments" items={detail.practitionerComments} empty="No comments yet." />
          </div>

          <div className="shrink-0 border-t border-hairline bg-[rgba(247,250,252,0.6)] px-[14px] py-[10px]">
            <ActionBar
              size="sm"
              actions={["add_to_note", "convert_to_task", "request_data", "view_audit"]}
              context={{
                subjectType: "body system",
                subjectLabel: node.name,
                patientName,
                seeds: [...detail.facts, ...detail.biomarkers.map((b) => `${b.name} ${b.value} (${b.note})`)],
              }}
              onExecuted={(kind) => {
                if (kind === "convert_to_task" && detail.missingInformation.length > 0) {
                  addSessionQueueItem({
                    title: `Missing data — ${node.name}: ${detail.missingInformation[0]}`,
                    patientName,
                    patientId,
                    category: "overdue-followup",
                    priority: "Medium",
                    seeds: detail.missingInformation,
                  });
                  announce("Missing-information task added to the review queue (session).");
                }
              }}
            />
            <div className="mt-[8px] flex flex-wrap gap-x-3 gap-y-1 text-[11px] font-semibold">
              <Link href={patientPath(patientId, "reasoning")} className="text-action hover:text-action-deep focus-visible:outline-2 focus-visible:outline-action">Open reasoning</Link>
              <Link href={patientPath(patientId, "labs")} className="text-action hover:text-action-deep focus-visible:outline-2 focus-visible:outline-action">Open labs</Link>
              <Link href={patientPath(patientId, "supplements")} className="text-action hover:text-action-deep focus-visible:outline-2 focus-visible:outline-action">Open supplements</Link>
            </div>
          </div>
        </Card>
      </div>
    </section>
  );
}

function SystemNode({
  n,
  selected,
  onSelect,
}: {
  n: TwinSystemNode;
  selected: boolean;
  onSelect: () => void;
}) {
  const status = SYSTEM_STATUS_META[n.status];
  const trend = TREND_ICON[n.trend];
  return (
    <button
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`${n.name}: ${status.label}, ${trend.label}, ${n.completeness}% data completeness`}
      className={cn(
        "flex cursor-pointer flex-col gap-[7px] rounded-[13px] border bg-card p-[13px] text-left transition-colors focus-visible:outline-2 focus-visible:outline-action",
        selected ? "border-action shadow-[0_2px_10px_rgba(37,99,199,0.12)]" : "border-line hover:border-line-hover",
      )}
    >
      <div className="flex w-full items-start justify-between gap-2">
        <span className="text-[12.5px] leading-[1.25] font-bold text-ink">{n.name}</span>
        <trend.Icon size={14} strokeWidth={2} style={{ color: toneText[trend.tone] }} aria-hidden />
      </div>
      <div className="flex flex-wrap items-center gap-[5px]">
        <Pill tone={status.tone}>{status.label}</Pill>
        <Pill tone={trend.tone}>{trend.label}</Pill>
      </div>
      <div className="flex w-full items-center gap-[7px]">
        <span
          className="h-[4px] flex-1 overflow-hidden rounded-full bg-track"
          role="img"
          aria-label={`Data completeness ${n.completeness} percent`}
        >
          <span
            className="block h-full rounded-full"
            style={{
              width: `${n.completeness}%`,
              background: n.completeness >= 70 ? toneText.positive : n.completeness >= 40 ? toneText.warning : toneText.critical,
            }}
          />
        </span>
        <span className="text-[10px] font-semibold text-muted">{n.completeness}%</span>
      </div>
      <div className="flex w-full items-center justify-between text-[10px] text-faint">
        <span>{n.observations} obs · {n.contradictions} contradiction{n.contradictions === 1 ? "" : "s"}</span>
        <span>{n.lastUpdate}</span>
      </div>
    </button>
  );
}

function InspectorSection({
  title,
  items,
  empty,
}: {
  title: string;
  items: string[];
  empty: string;
}) {
  return (
    <div className="border-t border-hairline-2 px-[14px] py-[10px] first:border-t-0">
      <h3 className="m-0 mb-[6px] text-[10.5px] font-bold tracking-[0.04em] text-faint uppercase">{title}</h3>
      {items.length === 0 ? (
        <p className="m-0 text-[11px] text-faint">{empty}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-[5px] p-0">
          {items.map((t) => (
            <li key={t} className="text-[11.5px] leading-[1.45] text-body">{t}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
