import Link from "next/link";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Activity,
  ClipboardList,
  FlaskConical,
  MoonStar,
  RotateCw,
} from "lucide-react";
import type { PatientSummary } from "@/adapters/types";
import { getWearables } from "@/adapters/tracking.mock";
import { getCarePlan } from "@/adapters/careplan.mock";
import { Card, CardLink, CardTitle, ProgressBar } from "@/components/ui/bits";
import { Pill } from "@/components/ui/Pill";
import { RadarChart } from "@/components/ui/RadarChart";
import { ScoreRing } from "@/components/ui/ScoreRing";
import { Sparkline } from "@/components/ui/Sparkline";
import { patientPath } from "@/lib/routes";
import { toneBright, toneColor, toneTint } from "@/lib/tones";

export function ClinicalOverviewSnapshot({
  summary,
  patientId,
}: {
  summary: PatientSummary;
  patientId: string;
}) {
  const wearables = getWearables(patientId);
  const plans = getCarePlan(patientId);
  const p = (tab: Parameters<typeof patientPath>[1]) => patientPath(patientId, tab);

  return (
    <section className="flex flex-col gap-4" aria-labelledby="clinical-snapshot-title">
      <div className="flex flex-wrap items-end justify-between gap-2 px-[2px]">
        <div>
          <h2 id="clinical-snapshot-title" className="m-0 text-[16px] font-bold text-ink">Clinical overview</h2>
          <p className="m-0 mt-1 text-[11.5px] text-subtle">Health score, systems, labs, wearables, priorities, and active care plan.</p>
        </div>
        <span className="flex items-center gap-1.5 text-[10.5px] text-faint"><RotateCw size={11} aria-hidden /> Data updated {summary.dataUpdated}</span>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-[190px_minmax(250px,1.1fr)_minmax(230px,1fr)_minmax(230px,1fr)]">
        <Card className="flex flex-col items-center px-4 py-[14px]">
          <CardTitle className="w-full">Health score</CardTitle>
          <ScoreRing value={summary.healthScore.value} band={summary.healthScore.band} color={toneBright[summary.healthScore.tone]} />
          <div className="flex items-center gap-1 text-[11px] font-semibold" style={{ color: toneColor[summary.healthScore.delta.tone] }}>
            {summary.healthScore.delta.direction === "up" ? <ArrowUp size={11} aria-hidden /> : <ArrowDown size={11} aria-hidden />}
            {summary.healthScore.delta.text}
          </div>
          <span className="mt-2 text-center text-[9.5px] leading-[1.35] text-faint">Composite trend indicator, not a diagnosis or medical probability.</span>
        </Card>

        <Card className="px-4 py-[14px]">
          <CardTitle>System balance</CardTitle>
          <div className="flex justify-center"><RadarChart axes={summary.systems} /></div>
        </Card>

        <Card className="flex flex-col px-4 py-[14px]">
          <CardTitle className="mb-3">Top priorities</CardTitle>
          <div className="flex flex-1 flex-col gap-2.5">
            {summary.priorities.map((priority, index) => (
              <div key={priority} className="flex items-start gap-2">
                <span className="flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded-full bg-number-tint text-[10px] font-semibold text-muted">{index + 1}</span>
                <span className="text-[11.5px] leading-[1.4] text-body">{priority}</span>
              </div>
            ))}
          </div>
          <CardLink href={`${p("labs")}?view=reasoning`} className="mt-3">Open clinical reasoning</CardLink>
        </Card>

        <Card className="flex flex-col px-4 py-[14px]">
          <CardTitle className="mb-3">Alerts &amp; risk flags</CardTitle>
          <div className="flex flex-1 flex-col gap-2.5">
            {summary.riskFlags.map((flag) => (
              <div key={flag.label} className="flex items-start gap-2">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md" style={{ background: toneTint[flag.tone] }}>
                  <AlertTriangle size={12} style={{ color: toneColor[flag.tone] }} aria-hidden />
                </span>
                <span className="min-w-0"><span className="block text-[11.5px] font-semibold text-ink">{flag.label}</span><span className="block text-[10.5px] text-subtle">{flag.action}</span></span>
              </div>
            ))}
          </div>
          <CardLink href={p("labs")} className="mt-3">Review labs and risks</CardLink>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,0.9fr)]">
        <Card className="flex flex-col px-4 py-[14px]">
          <div className="mb-2 flex items-center gap-2"><FlaskConical size={14} className="text-action" aria-hidden /><CardTitle className="flex-1">Recent labs &amp; biomarkers</CardTitle><Pill tone="slate">Latest reviewed</Pill></div>
          <div className="flex flex-1 flex-col">
            {summary.biomarkers.slice(0, 5).map((marker) => (
              <Link key={marker.name} href={p("labs")} className="grid grid-cols-[100px_minmax(90px,1fr)_70px] items-center gap-3 border-b border-hairline py-[6px] last:border-b-0 hover:bg-sunken focus-visible:outline-2 focus-visible:outline-action">
                <span><span className="block text-[11.5px] font-semibold text-ink">{marker.name}</span><span className="block text-[9.5px] text-faint">{marker.unit}</span></span>
                <Sparkline values={marker.series} width={145} height={24} stroke={toneColor[marker.tone]} strokeWidth={1.7} label={`${marker.name} ${marker.trendWord}`} className="min-w-0" />
                <span className="text-right"><span className="block text-[12px] font-bold text-ink">{marker.value}</span><span className="block text-[9.5px] font-semibold" style={{ color: toneColor[marker.tone] }}>{marker.status}</span></span>
              </Link>
            ))}
          </div>
          <CardLink href={p("labs")} className="mt-3">Open all labs</CardLink>
        </Card>

        <Card className="flex flex-col px-4 py-[14px]">
          <div className="mb-2 flex items-center gap-2"><MoonStar size={14} className="text-ai-deep" aria-hidden /><CardTitle className="flex-1">Wearables &amp; recovery</CardTitle>{wearables.devices[0] && <Pill tone="teal">{wearables.devices[0].status}</Pill>}</div>
          {wearables.alerts[0] && (
            <div className="mb-2 rounded-md bg-critical-tint px-3 py-2 text-[10.5px] text-critical"><span className="font-bold">{wearables.alerts[0].title}</span> · {wearables.alerts[0].detail}</div>
          )}
          <div className="grid flex-1 grid-cols-2 gap-2">
            {wearables.series.slice(0, 4).map((series) => (
              <div key={series.id} className="rounded-md border border-hairline px-3 py-2">
                <span className="block text-[10px] font-semibold text-subtle">{series.label}</span>
                <div className="mt-1 flex items-end justify-between gap-2"><span className="text-[17px] font-bold text-ink">{series.current}<small className="ml-1 text-[9px] font-medium text-faint">{series.unit}</small></span><Sparkline values={series.series} width={72} height={24} stroke={toneColor[series.tone]} strokeWidth={1.7} label={`${series.label} trend`} /></div>
                <span className="mt-1 block text-[9.5px] text-faint">Baseline {series.baseline}</span>
              </div>
            ))}
          </div>
          <CardLink href={`${p("tracking")}?view=wearables`} className="mt-3">Open wearable details</CardLink>
        </Card>

        <Card className="flex flex-col px-4 py-[14px]">
          <div className="mb-2 flex items-center gap-2"><ClipboardList size={14} className="text-positive" aria-hidden /><CardTitle className="flex-1">Active plan &amp; experiments</CardTitle></div>
          <div className="flex flex-col gap-2">
            {plans.slice(0, 2).map((plan) => (
              <Link key={plan.id} href={p("protocol")} className="rounded-md border border-hairline px-3 py-2 hover:border-line-hover-2 focus-visible:outline-2 focus-visible:outline-action">
                <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold text-ink">{plan.name}</span><Pill tone={plan.status === "active" ? "positive" : "warning"}>{plan.status === "active" ? "Active" : "Review"}</Pill></div>
                {plan.adherencePct != null && <><ProgressBar pct={plan.adherencePct} color={toneColor[plan.adherencePct >= 75 ? "positive" : "warning"]} className="mt-2" label={`${plan.adherencePct}% adherence`} /><span className="mt-1 block text-[9.5px] text-faint">{plan.adherencePct}% adherence · {plan.phase}</span></>}
              </Link>
            ))}
            {summary.experiments.slice(0, 2).map((experiment) => (
              <Link key={experiment.name} href={`${p("tracking")}?view=experiments`} className="rounded-md bg-sunken px-3 py-2 focus-visible:outline-2 focus-visible:outline-action">
                <div className="flex items-center gap-2"><Activity size={11} className="text-ai-deep" aria-hidden /><span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-body">{experiment.name}</span><span className="text-[10px] font-bold text-positive">{experiment.direction}</span></div>
                <span className="mt-1 block text-[9.5px] text-faint">Day {experiment.dayText} · {experiment.outcomeLabel}</span>
              </Link>
            ))}
          </div>
          <div className="mt-auto flex gap-3 pt-3 text-[10.5px] font-semibold"><Link href={p("protocol")} className="text-action">Protocol</Link><Link href={p("nutrition")} className="text-action">Nutrition</Link><Link href={p("supplements")} className="text-action">Supplements</Link></div>
        </Card>
      </div>
    </section>
  );
}
