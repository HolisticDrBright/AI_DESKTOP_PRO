"use client";

import { useState } from "react";
import { Pill as PillIcon, ShieldCheck, TriangleAlert } from "lucide-react";
import {
  CONCLUSION_TONE,
  getSupplementWorkspace,
  type StackAuditFlag,
  type SupplementWorkspace as WS,
} from "@/adapters/supplements.mock";
import { useReviewOutcome } from "@/adapters/session-store";
import type { Tone } from "@/adapters/types";
import { ActionBar } from "@/components/ui/ActionBar";
import { Provenance } from "@/components/ui/Provenance";
import { Card } from "@/components/ui/bits";
import { cn } from "@/lib/cn";
import { toneText, toneTint } from "@/lib/tones";

const SEVERITY_TONE: Record<StackAuditFlag["severity"], Tone> = {
  info: "slate",
  caution: "warning",
  warning: "critical",
};

const STACK_ACTIONS = [
  "approve",
  "flag",
  "request_data",
  "order_lab",
  "add_to_note",
  "insert_into_report",
  "convert_to_task",
] as const;

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

export function SupplementsWorkspace({
  patientId,
  patientName,
}: {
  patientId: string;
  patientName: string;
}) {
  const [ws] = useState<WS>(() => getSupplementWorkspace(patientId));
  const stackKey = `stack:${patientId}`;
  const stackOutcome = useReviewOutcome(stackKey);

  return (
    <section data-screen-label="Supplement Intelligence" className="relative flex flex-col gap-4 pb-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="flex items-center gap-[7px]">
            <PillIcon size={17} strokeWidth={2} className="text-brand" aria-hidden />
            <h1 className="m-0 text-[19px] font-bold tracking-[-0.015em]">Supplement Intelligence</h1>
          </div>
          <p className="mt-[3px] mb-0 text-[11.5px] text-subtle">
            Updated {ws.updatedOn} · {ws.stack.length} products · Personal response reflects this
            patient&rsquo;s observed data only — dosing and interactions require practitioner review.
          </p>
        </div>
        {stackOutcome === "approved" && <Pill tone="positive">Stack approved this session</Pill>}
      </div>

      {/* Current stack */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-hairline px-4 py-[11px]">
          <h2 className="m-0 text-[13px] font-bold">Current stack</h2>
          <ActionBar
            size="sm"
            actions={[...STACK_ACTIONS]}
            context={{
              subjectType: "supplement stack",
              subjectLabel: `${patientName} · ${ws.stack.length} products`,
              patientName,
              seeds: ws.stack.map((s) => s.seeds[0]),
              reviewKey: stackKey,
            }}
          />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[11.5px]">
            <caption className="sr-only">Current supplement stack with adherence, evidence, safety and personal response</caption>
            <thead>
              <tr>
                {["Product", "Ingredients", "Dose · schedule", "Purpose", "Started", "Adherence", "Evidence", "Safety", "Personal response", "Approval"].map((h) => (
                  <th key={h} scope="col" className="whitespace-nowrap bg-[#F6F9FC] px-[10px] py-[7px] text-left text-[9.5px] font-bold tracking-[0.03em] text-faint uppercase">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ws.stack.map((s) => (
                <tr key={s.id} className="border-t border-[#F1F5F9] align-top hover:bg-sunken">
                  <th scope="row" className="px-[10px] py-[8px] text-left font-normal">
                    <span className="block text-[12px] font-semibold text-ink">{s.product}</span>
                    <span className="text-[10px] text-faint">{s.brand}</span>
                  </th>
                  <td className="max-w-[180px] px-[10px] py-[8px] text-muted">{s.ingredients.join(" · ")}</td>
                  <td className="whitespace-nowrap px-[10px] py-[8px] text-body">{s.dose} · {s.schedule}</td>
                  <td className="max-w-[160px] px-[10px] py-[8px] text-body">{s.purpose}</td>
                  <td className="whitespace-nowrap px-[10px] py-[8px] text-muted">{s.startDate}</td>
                  <td className="whitespace-nowrap px-[10px] py-[8px]">
                    <span className={cn("font-bold", s.adherencePct >= 80 ? "text-positive" : "text-warning-deep")}>
                      {s.adherencePct}%
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-[10px] py-[8px]"><Pill tone={s.evidence === "Strong" ? "positive" : s.evidence === "Moderate" ? "teal" : "slate"}>{s.evidence}</Pill></td>
                  <td className="whitespace-nowrap px-[10px] py-[8px]"><Pill tone={s.safety === "No flags" ? "positive" : s.safety === "Monitor" ? "warning" : "critical"}>{s.safety}</Pill></td>
                  <td className="whitespace-nowrap px-[10px] py-[8px]"><Pill tone={CONCLUSION_TONE[s.responseConclusion]}>{s.responseConclusion}</Pill></td>
                  <td className="whitespace-nowrap px-[10px] py-[8px]">
                    <Pill tone={s.approved ? "positive" : "warning"}>{s.approved ? "Practitioner-approved" : "Not approved"}</Pill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] items-start gap-4">
        {/* Stack audit */}
        <Card className="p-[14px]">
          <h2 className="m-0 mb-[4px] flex items-center gap-[6px] text-[13px] font-bold">
            <ShieldCheck size={14} strokeWidth={2} className="text-brand" aria-hidden />
            Stack audit
          </h2>
          <p className="mt-0 mb-[11px] text-[11px] text-subtle">
            Deterministic checks across ingredients, exposure, interactions and purpose. Flags are
            review prompts, not directives.
          </p>
          <div className="flex flex-col gap-[9px]">
            {ws.auditFlags.map((f) => (
              <div key={f.id} className="flex items-start gap-[9px] rounded-[10px] border border-line bg-[rgba(248,250,252,0.6)] px-[11px] py-[9px]">
                <TriangleAlert size={13} strokeWidth={2} className="mt-[2px] shrink-0" style={{ color: toneText[SEVERITY_TONE[f.severity]] }} aria-hidden />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-[6px]">
                    <span className="text-[12px] font-semibold text-ink">{f.label}</span>
                    <Pill tone={SEVERITY_TONE[f.severity]}>{f.severity}</Pill>
                  </div>
                  <p className="mt-[2px] mb-0 text-[11px] leading-[1.45] text-body">{f.detail}</p>
                  <span className="mt-[3px] block text-[10px] text-faint">{f.products.join(" · ")}</span>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <div className="flex flex-col gap-4">
          {/* Personal response */}
          <Card className="p-[14px]">
            <h2 className="m-0 mb-[4px] text-[13px] font-bold">Does this work for this patient?</h2>
            <p className="mt-0 mb-[11px] text-[11px] text-subtle">
              Observed association in this patient&rsquo;s data only — never a causal or general
              efficacy claim.
            </p>
            <div className="flex flex-col gap-3">
              {ws.response.map((r) => (
                <div key={r.productId} className="rounded-[10px] border border-line px-[12px] py-[10px]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[12.5px] font-bold text-ink">{r.product}</span>
                    <Pill tone={CONCLUSION_TONE[r.conclusion]}>{r.conclusion}</Pill>
                  </div>
                  <div className="mt-[6px] grid grid-cols-2 gap-x-3 gap-y-[6px] text-[11px]">
                    <span><span className="text-faint">Target</span> <span className="text-body">{r.target}</span></span>
                    <span><span className="text-faint">Adherence</span> <span className="font-semibold text-body">{r.adherencePct}%</span></span>
                    {r.biomarkers.map((b) => (
                      <span key={b.name}><span className="text-faint">{b.name}</span> <span className="text-body">{b.before} → {b.now} {b.direction}</span></span>
                    ))}
                    {r.symptoms.map((s) => (
                      <span key={s.name}><span className="text-faint">{s.name}</span> <span className="text-body">{s.trend}</span></span>
                    ))}
                  </div>
                  <p className="mt-[7px] mb-0 text-[10.5px] leading-[1.5] text-subtle">
                    <span className="font-semibold text-body-2">Confounders:</span> {r.confounders.join("; ")}.{" "}
                    {r.rationale}
                  </p>
                </div>
              ))}
            </div>
          </Card>

          {/* Library + refills */}
          <div className="grid grid-cols-2 gap-4">
            <Card className="p-[13px]">
              <h2 className="m-0 mb-[8px] text-[12.5px] font-bold">Product library</h2>
              <div className="flex flex-col gap-[8px]">
                {ws.libraryPreview.map((p) => (
                  <div key={p.name}>
                    <span className="block text-[11.5px] font-semibold text-ink">{p.name} <span className="font-normal text-faint">· {p.brand}</span></span>
                    <span className="text-[10px] leading-[1.4] text-subtle">{p.note}</span>
                  </div>
                ))}
              </div>
            </Card>
            <Card className="p-[13px]">
              <h2 className="m-0 mb-[8px] text-[12.5px] font-bold">Refills &amp; adherence</h2>
              <div className="flex flex-col gap-[8px]">
                {ws.refills.map((r) => (
                  <div key={r.product} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-[11.5px] text-body">{r.product}</span>
                    <span className="flex shrink-0 items-center gap-[6px]">
                      <span className="text-[10.5px] text-faint">{r.daysLeft} d left</span>
                      <Pill tone={r.status === "OK" ? "positive" : r.status === "Refill soon" ? "warning" : "action"}>{r.status}</Pill>
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </div>
      </div>

      {/* Per-product provenance strip for the flagship item */}
      <Card className="p-[13px]">
        <h2 className="m-0 mb-[7px] text-[12.5px] font-bold">Provenance — {ws.stack[0].product}</h2>
        <Provenance data={ws.stack[0].provenance} />
      </Card>
    </section>
  );
}
