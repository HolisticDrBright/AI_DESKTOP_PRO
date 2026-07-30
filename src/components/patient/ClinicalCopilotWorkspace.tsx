"use client";

import { useEffect, useState } from "react";
import { BrainCircuit, LockKeyhole } from "lucide-react";
import type { KnowledgePathway } from "@/adapters/clinical-knowledge.types";
import { liveClient } from "@/adapters/live-client";
import { cn } from "@/lib/cn";
import { Card } from "@/components/ui/bits";
import { Pill } from "@/components/ui/Pill";

function LiveClinicalRegistryPreview() {
  const [pathways, setPathways] = useState<KnowledgePathway[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  const load = async () => {
    setState("loading");
    try {
      const rows = await liveClient.listKnowledgePathways();
      setPathways(rows);
      setSelectedId((current) => current || rows[0]?.id || "");
      setState("ready");
    } catch {
      setState("error");
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const selected = pathways.find((item) => item.id === selectedId) ?? pathways[0];
  const approved = selected?.versions.find((version) => version.status === "approved");
  const approvedCount = pathways.filter((pathway) =>
    pathway.versions.some((version) => version.status === "approved")).length;

  return (
    <section className="pb-8" data-screen-label="Governed clinical copilot">
      <div className="mb-4 border-b border-line pb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <BrainCircuit size={18} className="text-ai" aria-hidden />
              <h1 className="m-0 text-[19px] font-bold text-ink">Governed clinical copilot</h1>
              <Pill tone="ai">Registry review</Pill>
            </div>
            <p className="m-0 mt-1 max-w-[820px] text-[11.5px] leading-[1.5] text-subtle">
              Inspect approved practice knowledge without sending this patient&apos;s chart to an AI provider.
            </p>
          </div>
          <div className="rounded border border-ok/25 bg-ok-tint px-3 py-2 text-right">
            <div className="text-[13px] font-bold text-ok">{approvedCount} approved pathways</div>
            <div className="text-[10.5px] text-body">Authenticated organization registry</div>
          </div>
        </div>
      </div>

      <div className="mb-4 flex items-start gap-2 rounded border border-ai/20 bg-ai-tint px-3 py-2.5 text-[11.5px] leading-[1.5] text-ai-deep">
        <LockKeyhole size={14} className="mt-0.5 shrink-0" aria-hidden />
        <span>
          Patient-specific inference remains disabled until an approved provider and audit gate are configured.
          Registry reads are live; no patient data is transmitted by this view.
        </span>
      </div>

      {state === "loading" ? (
        <Card className="px-5 py-10 text-center text-[12px] text-subtle">Loading approved practice knowledge...</Card>
      ) : state === "error" ? (
        <Card className="px-5 py-8 text-center text-[12px] text-critical">
          The clinical registry could not be loaded. <button className="font-bold underline" onClick={() => void load()}>Try again</button>
        </Card>
      ) : !selected || !approved ? (
        <Card className="px-5 py-10 text-center">
          <div className="text-[13px] font-bold text-ink">No approved pathways</div>
          <div className="mt-1 text-[11.5px] text-subtle">Stage and approve practice knowledge in Settings before using it here.</div>
        </Card>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
          <Card className="overflow-hidden">
            <div className="border-b border-line bg-sunken px-4 py-3 text-[11px] font-bold uppercase text-faint">Approved pathways</div>
            <div className="p-2">
              {pathways.map((pathway) => {
                const version = pathway.versions.find((item) => item.status === "approved");
                if (!version) return null;
                return (
                  <button
                    key={pathway.id}
                    onClick={() => setSelectedId(pathway.id)}
                    className={cn(
                      "mb-1 w-full rounded px-3 py-2.5 text-left hover:bg-sunken",
                      pathway.id === selected.id && "bg-action-tint",
                    )}
                  >
                    <span className="block text-[12px] font-bold text-ink">{pathway.name}</span>
                    <span className="mt-0.5 flex justify-between text-[10.5px] text-subtle">
                      <span>{pathway.domain}</span><span>v{version.version}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </Card>

          <div className="min-w-0 border-t border-line">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line py-4">
              <div>
                <h2 className="m-0 text-[16px] font-bold text-ink">{selected.name}</h2>
                <p className="mt-1 mb-0 text-[11.5px] leading-[1.5] text-subtle">{selected.description}</p>
              </div>
              <Pill tone="positive">Approved v{approved.version}</Pill>
            </div>
            {[
              ["Differentiating questions", approved.content.differentiatingQuestions],
              ["Lab strategy", approved.content.labStrategy.map((lab) => `${lab.panel} · ${lab.vendor}: ${lab.purpose}`)],
              ["Safety stops", approved.content.safetyStops],
            ].map(([label, values]) => (
              <div key={label as string} className="border-b border-line py-4">
                <h3 className="m-0 text-[12.5px] font-bold text-ink">{label}</h3>
                <ul className="mb-0 mt-2 grid gap-1.5 pl-5 text-[11.5px] leading-[1.5] text-body">
                  {(values as string[]).map((value) => <li key={value}>{value}</li>)}
                </ul>
              </div>
            ))}
            <div className="py-4">
              <h3 className="m-0 text-[12.5px] font-bold text-ink">Exact product candidates</h3>
              <p className="mt-1 mb-2 text-[10.5px] text-warning-deep">Candidates only. Current exact labels and patient eligibility still require verification.</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {approved.content.productCandidates.map((product) => (
                  <div key={`${product.brand}-${product.name}`} className="rounded border border-line px-3 py-2">
                    <div className="text-[11.5px] font-bold text-ink">{product.name}</div>
                    <div className="text-[10.5px] text-subtle">{product.brand} · {product.role}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Clinical copilot tab — CLINICAL.
 *
 * Renders the governed registry preview: approved knowledge pathways read
 * live from the Desktop-owned boundary. The adaptive intake/draft generator
 * is demo-only until AI generation is configured with governed inputs — that
 * workflow lives in the demo repository, not here.
 */
export function ClinicalCopilotWorkspace(props: { patientId: string; patientName: string }) {
  void props;
  return <LiveClinicalRegistryPreview />;
}
