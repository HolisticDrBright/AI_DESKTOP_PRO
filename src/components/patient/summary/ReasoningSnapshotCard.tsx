"use client";

import {
  ArrowRight,
  CircleCheck,
  CircleX,
  ShieldAlert,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import type {
  Hypothesis,
  ReasoningChange,
  ReasoningSnapshot,
  Tone,
} from "@/adapters/types";
import { useReviewOutcome, type ReviewOutcome } from "@/adapters/session-store";
import { ActionBar } from "@/components/ui/ActionBar";
import { Provenance, ProvenanceBadge } from "@/components/ui/Provenance";
import { Card, CardLink } from "@/components/ui/bits";
import { patientPath } from "@/lib/routes";
import { toneText, toneTint } from "@/lib/tones";

/** Small settled-state pill for a reviewed subject (text + reinforcing color). */
const OUTCOME_PILL: Record<ReviewOutcome, { label: string; tone: Tone }> = {
  approved: { label: "Approved this session", tone: "positive" },
  accepted: { label: "Accepted this session", tone: "positive" },
  reviewed: { label: "Reviewed this session", tone: "positive" },
  resolved: { label: "Resolved this session", tone: "positive" },
  rejected: { label: "Rejected this session", tone: "critical" },
  flagged: { label: "Flagged this session", tone: "warning" },
  snoozed: { label: "Snoozed this session", tone: "slate" },
};

/** Change-direction → text label + tone (text always shown; color reinforces). */
const CHANGE_META: Record<ReasoningChange["direction"], { label: string; tone: Tone }> = {
  new: { label: "New", tone: "action" },
  strengthened: { label: "Stronger", tone: "warning" },
  weakened: { label: "Weaker", tone: "positive" },
  resolved: { label: "Resolved", tone: "positive" },
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

const SNAPSHOT_ACTIONS = [
  "approve",
  "modify",
  "reject",
  "add_to_note",
  "insert_into_report",
  "view_audit",
] as const;

export function ReasoningSnapshotCard({
  reasoning,
  patientId,
  patientName,
}: {
  reasoning: ReasoningSnapshot;
  patientId: string;
  patientName?: string;
}) {
  const evidenceSeeds = reasoning.evidenceFor.slice(0, 3);
  const snapshotKey = `snapshot:${patientId}`;
  const settled = useReviewOutcome(snapshotKey);

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-[10px] px-[18px] pt-[14px]">
        <h2 className="m-0 text-[14px] font-bold">Clinical Reasoning Snapshot</h2>
        <span className="rounded-full bg-sunken-2 px-[9px] py-[3px] text-[10.5px] font-semibold text-muted">
          Updated {reasoning.updatedOn}
        </span>
        <div className="flex-1" />
        {settled ? (
          <span
            className="flex items-center gap-[5px] rounded-full px-[10px] py-[3px] text-[11px] font-semibold"
            style={{
              color: toneText[OUTCOME_PILL[settled].tone],
              background: toneTint[OUTCOME_PILL[settled].tone],
            }}
          >
            {OUTCOME_PILL[settled].label}
          </span>
        ) : reasoning.review.status === "awaiting" ? (
          <span className="flex items-center gap-[5px] rounded-full border border-[rgba(199,126,20,0.22)] bg-warning-tint px-[10px] py-[3px] text-[11px] font-semibold text-warning-deep">
            Awaiting practitioner review
          </span>
        ) : (
          <span className="flex items-center gap-[5px] rounded-full border border-[rgba(31,157,99,0.22)] bg-positive-tint px-[10px] py-[3px] text-[11px] font-semibold text-positive">
            {reasoning.review.label}
          </span>
        )}
      </div>

      {reasoning.provenance && (
        <div className="border-b border-hairline-2 px-[18px] pt-[10px] pb-[12px]">
          <Provenance data={reasoning.provenance} />
        </div>
      )}

      {/* Leading hypotheses — each independently reviewable / actionable */}
      <div className="px-[18px] pt-[14px]">
        <div className="mb-[10px] flex items-center gap-[6px]">
          <Sparkles size={13} strokeWidth={2} className="text-ai" aria-hidden />
          <h3 className="m-0 text-[12px] font-bold text-body-2">Leading hypotheses</h3>
          <span className="text-[10.5px] text-faint">
            Strength = internal evidence weighting, not a medical probability
          </span>
        </div>
        <div className="flex flex-col gap-[10px]">
          {reasoning.hypotheses.map((h, i) => (
            <HypothesisRow
              key={h.name}
              h={h}
              index={i}
              patientId={patientId}
              patientName={patientName}
              seeds={[h.sub, ...evidenceSeeds]}
            />
          ))}
        </div>
      </div>

      {/* Evidence for / against / what changed */}
      <div className="mt-[14px] grid grid-cols-3 border-t border-hairline-2">
        <EvidenceColumn
          title="Key evidence for"
          items={reasoning.evidenceFor}
          icon="check"
          className="border-r border-hairline-2"
        />
        <EvidenceColumn
          title="Key evidence against"
          items={reasoning.evidenceAgainst}
          icon="x"
          className="border-r border-hairline-2"
        />
        <div className="px-[14px] py-3">
          <h3 className="m-0 mb-[10px] text-[12px] font-bold text-body-2">
            What changed since last snapshot
          </h3>
          <div className="flex flex-col gap-[9px]">
            {(reasoning.whatChanged ?? []).map((c) => {
              const m = CHANGE_META[c.direction];
              return (
                <div key={c.text} className="flex items-start gap-2">
                  <span
                    className="mt-[1px] shrink-0 rounded-[4px] px-[5px] py-px text-[9.5px] font-bold"
                    style={{ color: toneText[m.tone], background: toneTint[m.tone] }}
                  >
                    {m.label}
                  </span>
                  <span className="text-[12px] leading-[1.4] text-body">{c.text}</span>
                </div>
              );
            })}
            {!reasoning.whatChanged?.length && (
              <span className="text-[11.5px] text-faint">No prior snapshot to compare.</span>
            )}
          </div>
        </div>
      </div>

      {/* Missing info / safety / next steps */}
      <div className="grid grid-cols-3 border-t border-hairline-2">
        <div className="border-r border-hairline-2 px-[14px] py-3">
          <h3 className="m-0 mb-[10px] flex items-center gap-[5px] text-[12px] font-bold text-body-2">
            <TriangleAlert size={12} strokeWidth={2} className="text-warning" aria-hidden />
            Missing information
          </h3>
          <div className="flex flex-col gap-[9px]">
            {(reasoning.missingInformation ?? []).map((text) => (
              <span key={text} className="flex gap-2 text-[12px] leading-[1.4] text-body">
                <span className="text-warning" aria-hidden>
                  ?
                </span>
                {text}
              </span>
            ))}
            {!reasoning.missingInformation?.length && (
              <span className="text-[11.5px] text-faint">None flagged.</span>
            )}
          </div>
        </div>

        <div className="border-r border-hairline-2 px-[14px] py-3">
          <h3 className="m-0 mb-[10px] flex items-center gap-[5px] text-[12px] font-bold text-body-2">
            <ShieldAlert size={12} strokeWidth={2} className="text-critical" aria-hidden />
            Safety considerations
          </h3>
          <div className="flex flex-col gap-[9px]">
            {(reasoning.safetyConsiderations ?? []).map((text) => (
              <span key={text} className="flex gap-2 text-[12px] leading-[1.4] text-body">
                <span className="mt-[6px] h-[4px] w-[4px] shrink-0 rounded-full bg-critical" aria-hidden />
                {text}
              </span>
            ))}
            {!reasoning.safetyConsiderations?.length && (
              <span className="text-[11.5px] text-faint">None flagged.</span>
            )}
          </div>
        </div>

        <div className="flex flex-col px-[14px] py-3">
          <h3 className="m-0 mb-[10px] text-[12px] font-bold text-body-2">
            Recommended next steps
          </h3>
          <div className="flex flex-1 flex-col gap-[9px]">
            {reasoning.nextSteps.map((step) => (
              <span key={step} className="flex gap-2 text-[12px] leading-[1.4] text-body">
                <ArrowRight size={12} strokeWidth={2} className="mt-[3px] shrink-0 text-faint" aria-hidden />
                {step}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Snapshot-level review actions */}
      <div className="flex flex-wrap items-center gap-[10px] border-t border-hairline bg-[rgba(247,250,252,0.5)] px-[18px] py-[12px]">
        <span className="text-[11px] font-semibold text-muted">Review this snapshot</span>
        <ActionBar
          size="sm"
          actions={[...SNAPSHOT_ACTIONS]}
          context={{
            subjectType: "reasoning snapshot",
            subjectLabel: `Snapshot · ${reasoning.updatedOn}`,
            patientName,
            seeds: evidenceSeeds,
            reviewKey: snapshotKey,
          }}
        />
        <div className="flex-1" />
        <CardLink href={patientPath(patientId, "reasoning")}>View full analysis</CardLink>
      </div>
    </Card>
  );
}

function HypothesisRow({
  h,
  index,
  patientId,
  patientName,
  seeds,
}: {
  h: Hypothesis;
  index: number;
  patientId: string;
  patientName?: string;
  seeds: string[];
}) {
  const reviewKey = `hypothesis:${patientId}:${index}`;
  const settled = useReviewOutcome(reviewKey);

  return (
    <div className="rounded-[11px] border border-line bg-[rgba(248,250,252,0.6)] px-[13px] py-[11px]">
      <div className="flex items-start gap-[10px]">
        <span className="mt-px flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-full bg-number-tint text-[10.5px] font-semibold text-muted">
          {index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-[8px]">
            <span className="text-[13px] leading-[1.3] font-semibold">{h.name}</span>
            {h.provenance && <ProvenanceBadge sourceType={h.provenance.sourceType} />}
            {settled && (
              <span
                className="rounded-full px-[7px] py-px text-[9.5px] font-bold"
                style={{
                  color: toneText[OUTCOME_PILL[settled].tone],
                  background: toneTint[OUTCOME_PILL[settled].tone],
                }}
              >
                {OUTCOME_PILL[settled].label}
              </span>
            )}
          </div>
          <span className="mt-px block text-[11.5px] text-subtle">{h.sub}</span>
          {h.provenance && <Provenance data={h.provenance} className="mt-[7px]" />}
        </div>
        <span className="shrink-0 rounded-[7px] bg-ai-tint px-2 py-[3px] text-[11px] font-bold text-ai-deep">
          {h.strength}
          <span className="ml-[2px] text-[9px] font-semibold text-ai">wt</span>
        </span>
      </div>
      <ActionBar
        size="sm"
        className="mt-[10px] border-t border-hairline-2 pt-[10px]"
        actions={[...HYPOTHESIS_ACTIONS]}
        context={{
          subjectType: "hypothesis",
          subjectLabel: h.name,
          patientName,
          seeds,
          reviewKey,
        }}
      />
    </div>
  );
}

function EvidenceColumn({
  title,
  items,
  icon,
  className,
}: {
  title: string;
  items: string[];
  icon: "check" | "x";
  className?: string;
}) {
  return (
    <div className={className ? `${className} px-[14px] py-3` : "px-[14px] py-3"}>
      <h3 className="m-0 mb-[10px] text-[12px] font-bold text-body-2">{title}</h3>
      <div className="flex flex-col gap-[10px]">
        {items.map((text) => (
          <div key={text} className="flex items-start gap-2">
            {icon === "check" ? (
              <CircleCheck size={14} strokeWidth={2} className="mt-px shrink-0 text-positive-bright" aria-hidden />
            ) : (
              <CircleX size={14} strokeWidth={2} className="mt-px shrink-0 text-critical" aria-hidden />
            )}
            <span className="text-[12px] leading-[1.4] text-body">{text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
