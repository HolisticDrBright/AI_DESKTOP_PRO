import { ArrowDown, ArrowUp, RotateCw, TriangleAlert } from "lucide-react";
import type { PatientSummary } from "@/adapters/types";
import { RadarChart } from "@/components/ui/RadarChart";
import { ScoreRing } from "@/components/ui/ScoreRing";
import { Card, CardTitle, OutlineButton } from "@/components/ui/bits";
import { patientPath } from "@/lib/routes";
import { toneBright, toneColor, toneTint } from "@/lib/tones";
import { BiomarkerTrendsCard, ExperimentsCard, SleepRecoveryCard } from "./TrendCards";
import { ReasoningSnapshotCard } from "./ReasoningSnapshotCard";

export function SummaryTab({
  summary,
  patientId,
  patientName,
}: {
  summary: PatientSummary;
  patientId: string;
  patientName?: string;
}) {
  return (
    <div data-screen-label="Patient Summary" className="flex flex-col gap-4">
      <div className="grid grid-cols-[210px_minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,1fr)] gap-4">
        <HealthScoreCard summary={summary} />
        <SystemBalanceCard summary={summary} />
        <TopPrioritiesCard summary={summary} patientId={patientId} />
        <RiskFlagsCard summary={summary} patientId={patientId} />
      </div>

      <div className="grid grid-cols-[minmax(0,1.25fr)_minmax(0,1.1fr)_minmax(0,1fr)] gap-4">
        <BiomarkerTrendsCard biomarkers={summary.biomarkers} patientId={patientId} />
        <SleepRecoveryCard sleep={summary.sleep} />
        <ExperimentsCard experiments={summary.experiments} patientId={patientId} />
      </div>

      <ReasoningSnapshotCard
        reasoning={summary.reasoning}
        patientId={patientId}
        patientName={patientName}
      />

      <div className="flex items-center justify-between px-[2px] text-[11.5px] text-faint">
        <span className="flex items-center gap-[6px]">
          <span className="h-[7px] w-[7px] rounded-full bg-positive-bright" aria-hidden />
          All systems operational
        </span>
        <span className="flex items-center gap-[6px]">
          Data updated: {summary.dataUpdated}
          <RotateCw size={12} strokeWidth={2} aria-hidden />
        </span>
      </div>
    </div>
  );
}

function HealthScoreCard({ summary }: { summary: PatientSummary }) {
  const { healthScore } = summary;
  const DeltaArrow = healthScore.delta.direction === "up" ? ArrowUp : ArrowDown;
  return (
    <Card className="flex flex-col items-center px-4 py-[14px]">
      <CardTitle info className="w-full">
        Health Score
      </CardTitle>
      <ScoreRing
        value={healthScore.value}
        band={healthScore.band}
        color={toneBright[healthScore.tone]}
      />
      <div
        className="flex items-center gap-[5px] text-[11.5px] font-semibold"
        style={{ color: toneColor[healthScore.delta.tone] }}
      >
        <DeltaArrow size={11} strokeWidth={2.25} aria-hidden />
        {healthScore.delta.text}
      </div>
    </Card>
  );
}

function SystemBalanceCard({ summary }: { summary: PatientSummary }) {
  return (
    <Card className="px-4 py-[14px]">
      <CardTitle info>System Balance</CardTitle>
      <div className="flex justify-center">
        <RadarChart axes={summary.systems} />
      </div>
    </Card>
  );
}

function TopPrioritiesCard({
  summary,
  patientId,
}: {
  summary: PatientSummary;
  patientId: string;
}) {
  return (
    <Card className="flex flex-col px-4 py-[14px]">
      <CardTitle className="mb-[11px]">Top Priorities</CardTitle>
      <div className="flex flex-1 flex-col gap-[10px]">
        {summary.priorities.map((priority, i) => (
          <div key={priority} className="flex items-baseline gap-[10px]">
            <span className="flex h-[19px] w-[19px] shrink-0 translate-y-[3px] items-center justify-center rounded-full bg-number-tint text-[10.5px] font-semibold text-muted">
              {i + 1}
            </span>
            <span className="text-[12.5px] leading-[1.4] text-body">{priority}</span>
          </div>
        ))}
      </div>
      <OutlineButton href={patientPath(patientId, "reasoning")}>View All Priorities</OutlineButton>
    </Card>
  );
}

function RiskFlagsCard({
  summary,
  patientId,
}: {
  summary: PatientSummary;
  patientId: string;
}) {
  return (
    <Card className="flex flex-col px-4 py-[14px]">
      <CardTitle info className="mb-[11px]">
        Risk Flags
      </CardTitle>
      <div className="flex flex-1 flex-col gap-[11px]">
        {summary.riskFlags.map((flag) => (
          <div key={flag.label} className="flex items-start gap-[9px]">
            <span
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px]"
              style={{ background: toneTint[flag.tone] }}
            >
              <TriangleAlert
                size={12}
                strokeWidth={2}
                style={{ color: toneColor[flag.tone] }}
                aria-hidden
              />
            </span>
            <span className="min-w-0">
              <span className="block text-[12.5px] leading-[1.3] font-semibold">
                {flag.label}
              </span>
              <span className="mt-px block text-[11px] text-subtle">{flag.action}</span>
            </span>
          </div>
        ))}
      </div>
      <OutlineButton href={patientPath(patientId, "labs")}>View All Risks</OutlineButton>
    </Card>
  );
}
