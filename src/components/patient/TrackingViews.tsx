"use client";

import Link from "next/link";
import { ArrowDown, ArrowRight, ArrowUp, Brain, Watch } from "lucide-react";
import {
  getAssessments,
  getMindCognition,
  getTwinLongitudinal,
  getWearables,
} from "@/adapters/tracking.mock";
import { toneColor } from "@/lib/tones";
import { Card, CardTitle } from "@/components/ui/bits";
import { Pill, Tag } from "@/components/ui/Pill";
import { Sparkline } from "@/components/ui/Sparkline";
import { DemoNote } from "@/components/ui/DemoNote";
import { TableWrap, TD, TH } from "@/components/ui/Table";

/* ------------------------------------------------ twin: trajectories view */

/**
 * The longitudinal half of the systems model: per-system composite
 * trajectories across snapshots with intervention markers — how the whole
 * system MOVES, not another static overview.
 */
export function TwinTrajectories({ patientId }: { patientId: string }) {
  const data = getTwinLongitudinal(patientId);
  return (
    <Card className="px-4 py-[14px]">
      <div className="mb-1 flex items-center gap-2">
        <CardTitle className="flex-1">System trajectories ({data.snapshotLabels[0]} → {data.snapshotLabels[data.snapshotLabels.length - 1]})</CardTitle>
        <span className="text-[11px] text-faint">Composite 0–100 per system, per snapshot</span>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {data.trajectories.map((t) => {
          const delta = t.series[t.series.length - 1] - t.series[0];
          return (
            <div key={t.system} className="rounded-lg border border-hairline bg-sunken px-3 py-[10px]">
              <div className="flex items-center gap-2">
                <span className="flex-1 text-[12.5px] font-semibold text-ink">{t.system}</span>
                <span className="text-[13px] font-bold tabular-nums" style={{ color: toneColor[t.tone] }}>
                  {t.current}
                </span>
                <span className={delta >= 0 ? "text-positive" : "text-critical"} aria-label={delta >= 0 ? "improving" : "declining"}>
                  {delta >= 0 ? <ArrowUp size={12} aria-hidden /> : <ArrowDown size={12} aria-hidden />}
                </span>
              </div>
              <Sparkline values={t.series} width={240} height={34} stroke={toneColor[t.tone]} strokeWidth={2} label={`${t.system} trajectory`} className="mt-1" />
              <p className="m-0 mt-1 text-[11.5px] leading-[1.4] text-subtle">{t.note}</p>
              <p className="m-0 mt-1 text-[10.5px] text-faint">Drivers: {t.drivers.join(" · ")}</p>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-bold tracking-[0.05em] text-faint uppercase">Interventions</span>
        {data.markers.map((m) => (
          <Tag key={m.label}>
            {data.snapshotLabels[m.atIndex]}: {m.label}
          </Tag>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-bold tracking-[0.05em] text-faint uppercase">System links</span>
        {data.connections.map((c) => (
          <span key={`${c.from}-${c.to}`} className="inline-flex items-center gap-1 rounded-md border border-line bg-card px-[7px] py-[2px] text-[11px] text-body">
            {c.from} <ArrowRight size={10} aria-hidden className="text-faint" /> {c.to}
            <span className="text-faint">— {c.note}</span>
          </span>
        ))}
      </div>
    </Card>
  );
}

/* -------------------------------------------------------------- wearables */

export function WearablesView({ patientId }: { patientId: string }) {
  const { devices, series, alerts } = getWearables(patientId);
  return (
    <div className="flex flex-col gap-4">
      {alerts.length > 0 && (
        <Card className="border-[rgba(214,84,74,0.35)] px-4 py-[10px]">
          {alerts.map((a) => (
            <div key={a.id} className="flex items-center gap-2 border-b border-hairline py-[5px] last:border-b-0">
              <Pill tone={a.severity === "critical" ? "critical" : "warning"}>{a.severity === "critical" ? "Critical" : "Warning"}</Pill>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-semibold text-ink">{a.title}</span>
                <span className="block text-[11.5px] text-subtle">{a.detail} · {a.atLabel}</span>
              </span>
            </div>
          ))}
        </Card>
      )}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {series.map((s) => (
          <Card key={s.id} className="px-4 py-[12px]">
            <div className="flex items-baseline gap-2">
              <span className="flex-1 text-[12.5px] font-semibold text-ink">{s.label}</span>
              <span className="text-[15px] font-bold tabular-nums" style={{ color: toneColor[s.tone] }}>
                {s.current} {s.unit}
              </span>
            </div>
            <p className="m-0 text-[11px] text-faint">Baseline {s.baseline}</p>
            <Sparkline values={s.series} width={280} height={36} stroke={toneColor[s.tone]} strokeWidth={2} label={`${s.label} trend`} className="mt-1" />
          </Card>
        ))}
        {series.length === 0 && (
          <Card className="px-4 py-8 text-center text-[12.5px] text-faint lg:col-span-2">
            No wearable streams for this patient in the demo dataset.
          </Card>
        )}
      </div>
      <Card className="px-4 py-[12px]">
        <CardTitle className="mb-2">Devices</CardTitle>
        {devices.length === 0 ? (
          <p className="m-0 text-[12px] text-faint">No devices.</p>
        ) : (
          devices.map((d) => (
            <div key={d.id} className="flex items-center gap-2 border-b border-hairline py-[6px] last:border-b-0">
              <Watch size={13} className="text-navy" aria-hidden />
              <span className="flex-1 text-[12.5px] text-body">{d.name} · {d.streams.join(", ")}</span>
              <span className="text-[11.5px] text-subtle">{d.lastSyncLabel}</span>
              <Pill tone="navy">{d.status}</Pill>
            </div>
          ))
        )}
        <DemoNote className="mt-2">
          Demo streams — no device or vendor API is connected. Connection states live in
          Integrations, honestly labeled.
        </DemoNote>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------- mind & cognition */

export function MindView({ patientId }: { patientId: string }) {
  const { series, scores, interventions } = getMindCognition(patientId);
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {series.map((s) => (
          <Card key={s.id} className="px-4 py-[12px]">
            <div className="flex items-baseline gap-2">
              <span className="flex-1 text-[12.5px] font-semibold text-ink">{s.label}</span>
              <span className="text-[15px] font-bold tabular-nums" style={{ color: toneColor[s.tone] }}>{s.current}</span>
            </div>
            <Sparkline values={s.series} width={280} height={36} stroke={toneColor[s.tone]} strokeWidth={2} label={`${s.label} trend`} className="mt-1" />
            <p className="m-0 mt-1 text-[11px] text-faint">{s.note}</p>
          </Card>
        ))}
      </div>
      {scores.length > 0 && (
        <Card className="px-4 py-[12px]">
          <div className="mb-2 flex items-center gap-2">
            <Brain size={14} className="text-ai-deep" aria-hidden />
            <CardTitle className="flex-1">Cognitive & stress scores</CardTitle>
          </div>
          {scores.map((s) => (
            <div key={s.name} className="flex items-center gap-2 border-b border-hairline py-[6px] last:border-b-0">
              <span className="min-w-0 flex-1">
                <span className="block text-[12.5px] font-medium text-ink">{s.name}</span>
                <span className="block text-[11.5px] text-subtle">{s.atLabel} · {s.note}</span>
              </span>
              <span className="text-[12.5px] font-semibold text-body tabular-nums">{s.score}</span>
              <Pill tone={s.trend === "improving" ? "positive" : s.trend === "declining" ? "warning" : "slate"}>{s.trend}</Pill>
            </div>
          ))}
        </Card>
      )}
      {interventions.length > 0 && (
        <Card className="px-4 py-[12px]">
          <CardTitle className="mb-2">Interventions</CardTitle>
          {interventions.map((iv) => (
            <div key={iv.name} className="flex items-center gap-2 border-b border-hairline py-[6px] last:border-b-0">
              <span className="flex-1 text-[12.5px] text-body">{iv.name}</span>
              <span className="text-[11.5px] text-subtle">since {iv.startedLabel}</span>
              {iv.linkedExperiment && <Tag>N-of-1: {iv.linkedExperiment}</Tag>}
              <Pill tone={iv.status === "active" ? "positive" : "slate"}>{iv.status}</Pill>
            </div>
          ))}
        </Card>
      )}
      <DemoNote>
        Mind &amp; Cognition tracks patient-reported indices, app-based cognitive tasks, and
        validated questionnaire scores over time. It makes no diagnostic claims, and nothing
        here is a medical device output.
      </DemoNote>
    </div>
  );
}

/* ------------------------------------------------------------ assessments */

export function AssessmentsView({ patientId }: { patientId: string }) {
  const rows = getAssessments(patientId);
  return (
    <div className="flex flex-col gap-4">
      <TableWrap>
        <thead>
          <tr>
            <TH>Assessment</TH>
            <TH>Kind</TH>
            <TH>Status</TH>
            <TH>Latest</TH>
            <TH>Score</TH>
            <TH>Longitudinal</TH>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id}>
              <TD className="font-medium text-ink">{a.name}</TD>
              <TD className="capitalize">{a.kind}</TD>
              <TD>
                <Pill tone={a.status === "complete" ? "positive" : a.status === "overdue" ? "critical" : "slate"}>
                  {a.status === "complete" ? "Complete" : a.status === "overdue" ? "Overdue" : a.status === "assigned" ? "Assigned" : "In progress"}
                </Pill>
                {a.dueLabel && <span className="ml-2 text-[11px] text-subtle">{a.dueLabel}</span>}
              </TD>
              <TD>{a.lastLabel}</TD>
              <TD className="tabular-nums">{a.score ?? "—"}</TD>
              <TD>
                {a.series ? (
                  <span className="flex items-center gap-2">
                    <Sparkline values={a.series} width={90} height={22} stroke={toneColor.action} strokeWidth={1.5} label={`${a.name} score history`} className="w-[90px]" />
                    <span className="text-[10.5px] text-faint">{a.seriesNote}</span>
                  </span>
                ) : (
                  "—"
                )}
              </TD>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <TD colSpan={6} className="py-6 text-center text-faint">
                No assessments assigned.
              </TD>
            </tr>
          )}
        </tbody>
      </TableWrap>
      <p className="m-0 text-[12px] text-subtle">
        Assessment templates (intake forms, validated questionnaires, scored outcomes) live in the{" "}
        <Link href="/templates?type=assessment" className="font-semibold text-action">
          template library
        </Link>
        . Assigning one creates a portal task for the patient (demo).
      </p>
    </div>
  );
}
