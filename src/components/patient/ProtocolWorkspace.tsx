"use client";

import { useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  ClipboardCheck,
  FlaskConical,
  History,
  Leaf,
  ShieldCheck,
  Target,
} from "lucide-react";
import { useCarePlan, type CarePlanProtocol } from "@/adapters/careplan.mock";
import { Card, ProgressBar } from "@/components/ui/bits";
import { Pill } from "@/components/ui/Pill";
import { DemoNote } from "@/components/ui/DemoNote";
import { cn } from "@/lib/cn";
import { patientPath } from "@/lib/routes";
import { toneColor } from "@/lib/tones";
import { ProtocolAuthoring } from "./ProtocolAuthoring";

const STATUS_TONE = {
  active: "positive",
  "pending-approval": "warning",
  completed: "slate",
} as const;

const SAFETY_TONE = {
  cleared: "positive",
  monitor: "warning",
  "needs-review": "critical",
} as const;

function statusLabel(status: CarePlanProtocol["status"]) {
  if (status === "pending-approval") return "Pending approval";
  return status === "active" ? "Active" : "Completed";
}

function Section({
  title,
  icon,
  children,
  action,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="border-b border-hairline px-5 py-4 last:border-b-0">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-action" aria-hidden>{icon}</span>
        <h2 className="m-0 flex-1 text-[13px] font-bold text-ink">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function ProtocolWorkspace({
  patientId,
  patientName,
}: {
  patientId: string;
  patientName: string;
}) {
  const protocols = useCarePlan(patientId);
  const [selectedId, setSelectedId] = useState(protocols[0]?.id ?? "");
  const selected = protocols.find((p) => p.id === selectedId) ?? protocols[0];

  if (!selected) {
    return (
      <div className="flex flex-col gap-3" data-screen-label="Complete protocol">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="m-0 text-[19px] font-bold">Complete protocol</h1>
            <p className="m-0 mt-1 text-[12px] text-subtle">No protocol has been created for {patientName}.</p>
          </div>
          <ProtocolAuthoring patientId={patientId} patientName={patientName} onSelect={setSelectedId} />
        </div>
        <Card className="px-5 py-10 text-center text-[12.5px] text-faint">No active or draft protocols.</Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 pb-6" data-screen-label="Complete protocol">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="m-0 text-[19px] font-bold text-ink">Complete protocol</h1>
            <Pill tone={STATUS_TONE[selected.status]}>{statusLabel(selected.status)}</Pill>
          </div>
          <p className="m-0 mt-1 text-[12px] text-subtle">
            One coordinated plan for nutrition, supplements, lifestyle, labs, monitoring, and follow-up.
          </p>
        </div>
        <ProtocolAuthoring patientId={patientId} patientName={patientName} selected={selected} onSelect={setSelectedId} />
      </header>

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="flex flex-col gap-2" aria-label="Patient protocols">
          {protocols.map((protocol) => {
            const active = protocol.id === selected.id;
            return (
              <button
                key={protocol.id}
                type="button"
                onClick={() => setSelectedId(protocol.id)}
                aria-pressed={active}
                className={cn(
                  "w-full rounded-lg border px-3 py-3 text-left focus-visible:outline-2 focus-visible:outline-action",
                  active ? "border-action bg-action-tint" : "border-line bg-card hover:border-line-hover-2",
                )}
              >
                <div className="flex items-start gap-2">
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12.5px] font-bold text-ink">{protocol.name}</span>
                    <span className="mt-1 block text-[11px] text-subtle">{protocol.phase}</span>
                  </span>
                  <ChevronRight size={14} className={active ? "text-action" : "text-faint"} aria-hidden />
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <Pill tone={STATUS_TONE[protocol.status]}>{statusLabel(protocol.status)}</Pill>
                  <span className="text-[10.5px] text-faint">v{protocol.version}</span>
                </div>
                {protocol.adherencePct != null && (
                  <div className="mt-2">
                    <ProgressBar pct={protocol.adherencePct} color={toneColor[protocol.adherencePct >= 75 ? "positive" : "warning"]} label={`Adherence ${protocol.adherencePct}%`} />
                    <span className="mt-1 block text-[10.5px] text-subtle">{protocol.adherencePct}% adherence</span>
                  </div>
                )}
              </button>
            );
          })}
        </aside>

        <Card className="min-w-0 overflow-hidden">
          <div className="border-b border-hairline bg-[#F7FAFC] px-5 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="m-0 text-[17px] font-bold text-ink">{selected.name}</h2>
                <p className="m-0 mt-1 max-w-[760px] text-[12px] leading-[1.55] text-subtle">{selected.summary}</p>
              </div>
              <div className="text-right text-[10.5px] text-subtle">
                <div className="font-semibold text-body">Version {selected.version}</div>
                <div>{selected.approvedLabel}</div>
                <div>{selected.practitioner}</div>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Metric label="Current phase" value={selected.phase} />
              <Metric label="Next review" value={selected.nextReviewLabel} />
              <Metric label="Interventions" value={String(selected.items.length)} />
              <Metric label="Safety flags" value={String(selected.safety.filter((s) => s.state !== "cleared").length)} />
            </div>
          </div>

          <Section title="Goals and success criteria" icon={<Target size={14} />}>
            <div className="grid gap-4 lg:grid-cols-2">
              <BulletList title="Goals" items={selected.goals} />
              <BulletList title="Success criteria" items={selected.successCriteria} />
            </div>
          </Section>

          <Section title="Protocol phases" icon={<ClipboardCheck size={14} />}>
            <div className="grid gap-2 lg:grid-cols-3">
              {selected.phases.map((phase, index) => (
                <div key={phase.name} className="rounded-md border border-line px-3 py-3">
                  <div className="flex items-center gap-2">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-sunken text-[10px] font-bold text-body">{index + 1}</span>
                    <span className="flex-1 text-[12px] font-bold text-ink">{phase.name}</span>
                    <Pill tone={phase.status === "current" ? "action" : phase.status === "complete" ? "positive" : "slate"}>{phase.status}</Pill>
                  </div>
                  <p className="m-0 mt-2 text-[11px] leading-[1.45] text-subtle">{phase.objective}</p>
                  <span className="mt-2 block text-[10px] text-faint">{phase.duration}</span>
                </div>
              ))}
            </div>
          </Section>

          <Section
            title="Daily and weekly plan"
            icon={<Check size={14} />}
            action={<Link href={patientPath(patientId, "supplements")} className="text-[11px] font-semibold text-action">Open supplement detail</Link>}
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[650px] border-collapse text-left">
                <thead><tr className="border-b border-line text-[9.5px] font-bold text-faint uppercase"><th className="pb-2">Intervention</th><th className="pb-2">Type</th><th className="pb-2">Schedule</th><th className="pb-2">Instructions</th><th className="pb-2">State</th></tr></thead>
                <tbody>
                  {selected.items.map((item) => (
                    <tr key={item.label} className="border-b border-hairline last:border-b-0">
                      <td className="py-2 pr-3 text-[12px] font-semibold text-ink">{item.label}</td>
                      <td className="py-2 pr-3 text-[11px] capitalize text-body">{item.kind}</td>
                      <td className="py-2 pr-3 text-[11px] text-body">{item.schedule ?? "As directed"}</td>
                      <td className="py-2 pr-3 text-[11px] text-subtle">{item.detail}</td>
                      <td className="py-2"><Pill tone={item.status === "active" ? "positive" : item.status === "complete" ? "slate" : "warning"}>{item.status ?? "active"}</Pill></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section
            title="Nutrition plan"
            icon={<Leaf size={14} />}
            action={<Link href={patientPath(patientId, "nutrition")} className="text-[11px] font-semibold text-action">Open diet plan</Link>}
          >
            <p className="m-0 text-[12px] text-body">{selected.linkedNutritionPlan ?? "No diet plan linked."}</p>
          </Section>

          <Section title="Monitoring and linked labs" icon={<FlaskConical size={14} />}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[600px] border-collapse text-left">
                <thead><tr className="border-b border-line text-[9.5px] font-bold text-faint uppercase"><th className="pb-2">Measure</th><th className="pb-2">Baseline</th><th className="pb-2">Target</th><th className="pb-2">Next check</th><th className="pb-2">State</th></tr></thead>
                <tbody>{selected.monitoring.map((m) => <tr key={m.marker} className="border-b border-hairline last:border-b-0"><td className="py-2 pr-3 text-[12px] font-semibold">{m.marker}</td><td className="py-2 pr-3 text-[11px] text-body">{m.baseline}</td><td className="py-2 pr-3 text-[11px] text-body">{m.target}</td><td className="py-2 pr-3 text-[11px] text-body">{m.nextCheck}</td><td className="py-2"><Pill tone={m.status === "on-track" ? "positive" : m.status === "due" ? "warning" : "action"}>{m.status}</Pill></td></tr>)}</tbody>
              </table>
            </div>
            <p className="m-0 mt-3 text-[10.5px] text-faint">Linked sources: {selected.linkedLabs.join(" · ")}</p>
          </Section>

          <Section title="Safety review and stop criteria" icon={<ShieldCheck size={14} />}>
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="flex flex-col gap-2">{selected.safety.map((item) => <div key={item.label} className="flex items-start gap-2"><Pill tone={SAFETY_TONE[item.state]}>{item.state}</Pill><span><span className="block text-[11.5px] font-semibold text-ink">{item.label}</span><span className="block text-[10.5px] text-subtle">{item.detail}</span></span></div>)}</div>
              <BulletList title="Stop and reassess when" items={selected.stopCriteria} warning />
            </div>
          </Section>

          <Section title="Version and approval history" icon={<History size={14} />}>
            <div className="flex flex-col gap-2">{selected.history.map((h) => <div key={`${h.date}-${h.event}`} className="grid grid-cols-[60px_minmax(0,1fr)_160px] gap-3 text-[11px]"><span className="text-faint">{h.date}</span><span className="font-medium text-body">{h.event}</span><span className="text-right text-subtle">{h.by}</span></div>)}</div>
          </Section>
        </Card>
      </div>

      {selected.status === "pending-approval" && (
        <div className="flex items-start gap-2 rounded-md border border-warning bg-warning-tint px-3 py-2 text-[11.5px] text-warning-deep">
          <AlertTriangle size={14} className="mt-[1px] shrink-0" aria-hidden />
          This draft is not active and has not been sent to the patient. Resolve its safety gates in the Review Queue before approval.
        </div>
      )}
      <DemoNote>Protocol data is synthetic and persists for this browser session only. Nothing is prescribed, ordered, signed, or sent from this preview.</DemoNote>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><span className="block text-[9.5px] font-bold text-faint uppercase">{label}</span><span className="mt-1 block truncate text-[11.5px] font-semibold text-body" title={value}>{value}</span></div>;
}

function BulletList({ title, items, warning = false }: { title: string; items: string[]; warning?: boolean }) {
  return (
    <div>
      <h3 className="m-0 mb-2 text-[10px] font-bold text-faint uppercase">{title}</h3>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {items.map((item) => <li key={item} className="flex items-start gap-2 text-[11.5px] leading-[1.45] text-body">{warning ? <AlertTriangle size={12} className="mt-[2px] shrink-0 text-warning" aria-hidden /> : <Check size={12} className="mt-[2px] shrink-0 text-positive" aria-hidden />}{item}</li>)}
      </ul>
    </div>
  );
}
