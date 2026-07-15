import { ArrowRight, KeyRound, ListChecks, Database, Info } from "lucide-react";
import type { SurfaceSpec, SurfaceStatus } from "@/lib/surfaces";
import type { Tone } from "@/adapters/types";
import { Card } from "@/components/ui/bits";
import { toneText, toneTint } from "@/lib/tones";

const STATUS_TONE: Record<SurfaceStatus, Tone> = {
  Spec: "slate",
  "In design": "action",
  "Backend pending": "warning",
};

/**
 * Spec-style screen for navigable-but-unbuilt system-of-record surfaces.
 * Renders the surface's intended workflow, required permissions, honest data
 * source, and next action — deliberately not marketing copy, so navigation
 * never implies a capability that isn't there.
 */
export function SurfaceScreen({ spec }: { spec: SurfaceSpec }) {
  const statusTone = STATUS_TONE[spec.status];

  return (
    <section
      data-screen-label={`${spec.label} (spec)`}
      className="relative mx-auto max-w-[880px] px-6 pt-[26px] pb-8"
    >
      <div className="mb-1 flex items-center gap-2 text-[11.5px] font-semibold text-faint">
        <span>{spec.group}</span>
        <span aria-hidden>/</span>
        <span
          className="rounded-full px-[9px] py-[2px] text-[10.5px] font-bold"
          style={{ color: toneText[statusTone], background: toneTint[statusTone] }}
        >
          {spec.status}
        </span>
      </div>
      <h1 className="m-0 text-[22px] font-bold tracking-[-0.015em]">{spec.label}</h1>
      <p className="mt-[6px] mb-5 max-w-[640px] text-[13.5px] leading-[1.5] text-body">
        {spec.purpose}
      </p>

      <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-4">
        <Card className="p-[18px]">
          <h2 className="m-0 mb-[13px] flex items-center gap-[7px] text-[13px] font-bold">
            <ListChecks size={15} strokeWidth={2} className="text-action" aria-hidden />
            Intended workflow
          </h2>
          <ol className="m-0 flex list-none flex-col gap-[11px] p-0">
            {spec.workflow.map((step, i) => (
              <li key={step} className="flex items-start gap-[10px]">
                <span className="mt-px flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-full bg-number-tint text-[10.5px] font-semibold text-muted">
                  {i + 1}
                </span>
                <span className="text-[12.5px] leading-[1.45] text-body">{step}</span>
              </li>
            ))}
          </ol>
        </Card>

        <div className="flex flex-col gap-4">
          <Card className="p-[16px]">
            <h2 className="m-0 mb-[11px] flex items-center gap-[7px] text-[13px] font-bold">
              <KeyRound size={14} strokeWidth={2} className="text-brand" aria-hidden />
              Required permissions
            </h2>
            <div className="flex flex-col gap-[7px]">
              {spec.permissions.map((p) => (
                <span
                  key={p}
                  className="rounded-[7px] bg-sunken-2 px-[9px] py-[6px] text-[11.5px] font-medium text-body-2"
                >
                  {p}
                </span>
              ))}
            </div>
          </Card>

          <Card className="p-[16px]">
            <h2 className="m-0 mb-[9px] flex items-center gap-[7px] text-[13px] font-bold">
              <Database size={14} strokeWidth={2} className="text-muted" aria-hidden />
              Data source
            </h2>
            <p className="m-0 text-[11.5px] leading-[1.5] text-subtle">{spec.dataSource}</p>
          </Card>
        </div>
      </div>

      <div className="mt-4 flex items-start gap-[10px] rounded-[12px] border border-[rgba(37,99,199,0.25)] bg-action-tint px-[16px] py-[13px]">
        <ArrowRight size={16} strokeWidth={2} className="mt-px shrink-0 text-action" aria-hidden />
        <div>
          <div className="text-[11px] font-bold tracking-[0.04em] text-action-deep uppercase">
            Next action
          </div>
          <div className="mt-[2px] text-[12.5px] leading-[1.45] text-body">{spec.nextAction}</div>
        </div>
      </div>

      <p className="mt-4 flex items-center gap-[6px] text-[11px] text-faint">
        <Info size={12} strokeWidth={2} aria-hidden />
        This surface is part of the navigation map. It shows its planned workflow and does
        not display or persist patient data yet.
      </p>
    </section>
  );
}
