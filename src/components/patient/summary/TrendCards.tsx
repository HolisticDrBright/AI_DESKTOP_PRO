import type {
  ActiveExperiment,
  BiomarkerTrend,
  SleepSummary,
} from "@/adapters/types";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Sparkline } from "@/components/ui/Sparkline";
import { Card, CardLink, CardTitle, ProgressBar } from "@/components/ui/bits";
import { patientPath } from "@/lib/routes";
import { toneBright, toneColor, toneText, toneTint } from "@/lib/tones";

export function BiomarkerTrendsCard({
  biomarkers,
  patientId,
}: {
  biomarkers: BiomarkerTrend[];
  patientId: string;
}) {
  return (
    <Card className="flex flex-col px-4 py-[14px]">
      <div className="mb-[10px] flex flex-wrap items-center justify-between gap-y-[6px]">
        <CardTitle className="whitespace-nowrap">Biomarker Trends</CardTitle>
        <SegmentedControl
          options={["Key Biomarkers", "All Biomarkers"]}
          ariaLabel="Biomarker scope"
        />
      </div>
      <div className="flex flex-1 flex-col">
        {biomarkers.map((bm) => (
          <div
            key={bm.name}
            className="flex items-center gap-[10px] rounded-lg px-[2px] py-[6px] hover:bg-sunken"
          >
            <span className="w-24 shrink-0">
              <span className="block text-[12px] font-semibold">{bm.name}</span>
              <span className="block text-[10px] text-faint">{bm.unit}</span>
            </span>
            <Sparkline
              values={bm.series}
              width={120}
              height={24}
              stroke={toneColor[bm.tone]}
              strokeWidth={1.75}
              label={`${bm.name} trend ${bm.trendWord}`}
              className="min-w-0 flex-1"
            />
            <span className="w-14 shrink-0 text-right">
              <span className="block text-[12.5px] font-bold">{bm.value}</span>
              <span
                className="block text-[10px] font-semibold"
                style={{ color: toneColor[bm.tone] }}
              >
                {bm.status}
              </span>
            </span>
          </div>
        ))}
      </div>
      <CardLink href={patientPath(patientId, "labs")} className="mt-[10px]">
        View All Biomarkers
      </CardLink>
    </Card>
  );
}

export function SleepRecoveryCard({ sleep }: { sleep: SleepSummary }) {
  return (
    <Card className="flex flex-col px-4 py-[14px]">
      <div className="mb-[10px] flex flex-wrap items-center justify-between gap-y-[6px]">
        <CardTitle className="whitespace-nowrap">Sleep &amp; Recovery</CardTitle>
        <SegmentedControl options={["7 Days", "30 Days"]} ariaLabel="Sleep range" />
      </div>
      <div className="flex items-stretch gap-[14px] rounded-xl border border-hairline px-[14px] py-3">
        <div className="shrink-0">
          <div className="text-[11px] font-semibold text-subtle">Sleep Score</div>
          <div className="text-[30px] leading-[1.15] font-bold tracking-[-0.02em]">
            {sleep.score}
          </div>
          <div
            className="text-[11.5px] font-semibold"
            style={{ color: toneColor[sleep.tone] }}
          >
            {sleep.band}
          </div>
        </div>
        <Sparkline
          values={sleep.series}
          width={200}
          height={64}
          stroke={toneBright[sleep.tone]}
          strokeWidth={2}
          label={`Sleep score trend over ${sleep.series.length} nights`}
          className="min-w-0 flex-1 self-center"
        />
      </div>
      <div className="mt-[10px] grid flex-1 grid-cols-4 gap-2">
        {sleep.stats.map((stat) => (
          <div key={stat.label} className="rounded-[10px] bg-sunken px-[9px] py-2">
            <div className="text-[9.5px] font-semibold text-subtle">{stat.label}</div>
            <div className="mt-[2px] text-[13px] font-bold whitespace-nowrap">
              {stat.value}
            </div>
          </div>
        ))}
      </div>
      <CardLink href="/wearables" className="mt-[10px]">
        View Sleep Details
      </CardLink>
    </Card>
  );
}

export function ExperimentsCard({
  experiments,
  patientId,
}: {
  experiments: ActiveExperiment[];
  patientId: string;
}) {
  return (
    <Card className="flex flex-col px-4 py-[14px]">
      <div className="mb-[10px] flex flex-wrap items-center justify-between gap-y-[6px]">
        <CardTitle className="whitespace-nowrap">N-of-1 Experiments</CardTitle>
        <span className="rounded-full bg-ai-tint px-[9px] py-[3px] text-[10.5px] font-semibold whitespace-nowrap text-ai-deep">
          Active Experiments
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-[10px]">
        {experiments.map((ex) => (
          <div key={ex.name} className="rounded-xl border border-hairline px-3 py-[10px]">
            <div className="flex items-baseline justify-between">
              <span className="text-[12.5px] font-semibold">{ex.name}</span>
              <span className="text-[10.5px] whitespace-nowrap text-faint">
                Day {ex.dayText}
              </span>
            </div>
            <div className="mt-px mb-2 text-[11px] text-subtle">{ex.goalLine}</div>
            <div className="flex items-center gap-2">
              <ProgressBar
                pct={ex.pct}
                color="#2563C7"
                className="flex-1"
                label={`${ex.name} ${ex.pct} percent complete`}
              />
              <span className="text-[10.5px] text-faint">{ex.pct}%</span>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-[10.5px] text-subtle">
                Primary Outcome
                <b className="block text-[12px] font-semibold text-ink">
                  {ex.outcomeLabel}
                </b>
              </span>
              <span
                className="rounded-full px-[10px] py-[3px] text-[11.5px] font-bold"
                style={{
                  color: toneText[ex.directionTone],
                  background: toneTint[ex.directionTone],
                }}
              >
                {ex.direction}
              </span>
            </div>
          </div>
        ))}
      </div>
      <CardLink href={patientPath(patientId, "nof1-lab")} className="mt-[10px]">
        View All Experiments
      </CardLink>
    </Card>
  );
}
