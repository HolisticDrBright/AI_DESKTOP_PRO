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
 * Phase 10A — governed copilot run panel.
 *
 * Draft-only outputs. The provider is DISABLED by default; even in
 * `fixture` mode the fixture provider runs entirely in-process. This
 * panel never sends this patient's chart to any external AI provider,
 * and it never activates, prescribes, orders, publishes, or signs.
 */
type RunEnvelope = Awaited<ReturnType<typeof liveClient.copilotRun>>;

function CopilotRunPanel() {
  const [runType, setRunType] =
    useState<Parameters<typeof liveClient.copilotRun>[0]["runType"]>("practitioner_brief");
  const [lens, setLens] =
    useState<Parameters<typeof liveClient.copilotRun>[0]["lens"]>("western");
  const [envelope, setEnvelope] = useState<RunEnvelope | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");

  const run = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await liveClient.copilotRun({ runType, lens });
      setEnvelope(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-6 flex flex-col gap-3 border-t border-line pt-6">
      <div className="flex items-center gap-2">
        <BrainCircuit size={16} className="text-ai" aria-hidden />
        <h2 className="m-0 text-[14px] font-bold text-ink">Governed copilot run (draft only)</h2>
        <Pill tone="ai">Phase 10A</Pill>
      </div>
      <p className="m-0 text-[11.5px] text-subtle">
        Runs against the disabled provider by default. Fixture mode is refused in deployed
        environments. Every drafted item is a <strong>draft</strong>; accepting does not sign,
        publish, activate, prescribe, order, or message. Safety items are pinned and identical
        across every lens.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-[11.5px] text-body">
          Lens{" "}
          <select
            className="ml-2 rounded border border-line px-2 py-1 text-[11.5px]"
            value={lens}
            onChange={(e) => setLens(e.target.value as typeof lens)}
            data-testid="copilot-lens"
          >
            {["western", "functional", "naturopathy", "tcm", "biohacking", "synergistic"].map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[11.5px] text-body">
          Run type{" "}
          <select
            className="ml-2 rounded border border-line px-2 py-1 text-[11.5px]"
            value={runType}
            onChange={(e) => setRunType(e.target.value as typeof runType)}
            data-testid="copilot-runtype"
          >
            <option value="longitudinal_brief">Longitudinal brief</option>
            <option value="differential_questions">Differential questions</option>
            <option value="lab_suggestions">Lab suggestions</option>
            <option value="protocol_draft">Protocol draft</option>
            <option value="practitioner_brief">Practitioner brief</option>
          </select>
        </label>
        <button
          type="button"
          onClick={run}
          disabled={busy}
          data-testid="copilot-run"
          className="rounded bg-action px-3 py-1 text-[11.5px] font-semibold text-white disabled:opacity-50"
        >
          {busy ? "Running…" : "Run"}
        </button>
      </div>

      {error && (
        <div className="text-[11.5px] text-danger" role="alert" data-testid="copilot-error">
          {error}
        </div>
      )}

      {envelope && (
        <div className="rounded border border-line px-3 py-3" data-testid="copilot-envelope">
          <div className="flex items-center gap-2 text-[11.5px]">
            <span className="font-semibold" data-testid="copilot-status">Status: {envelope.status}</span>
            <span className="text-subtle" data-testid="copilot-provider">
              provider: {envelope.providerName}
              {envelope.providerModel ? ` (${envelope.providerModel})` : ""}
            </span>
          </div>
          <p className="mt-1 text-[11.5px] text-subtle" data-testid="copilot-message">
            {envelope.message}
          </p>
          {envelope.safetyItems.length > 0 && (
            <div className="mt-2" data-testid="copilot-safety">
              <div className="text-[11px] uppercase tracking-wide text-subtle">
                Safety (pinned, lens-agnostic)
              </div>
              <ul className="mt-1 flex flex-col gap-1">
                {envelope.safetyItems.map((s, idx) => (
                  <li
                    key={`${s.category}-${idx}`}
                    className="text-[11.5px]"
                    data-testid={`copilot-safety-${s.category}`}
                  >
                    <strong>[{s.severity}]</strong> {s.category}: {s.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {envelope.rejectedCitations.length > 0 && (
            <p className="mt-2 text-[11px] text-warning-deep" data-testid="copilot-rejected-citations">
              {envelope.rejectedCitations.length} hallucinated citation(s) rejected.
            </p>
          )}
          {envelope.draft && (
            <details className="mt-2 text-[11px] text-subtle">
              <summary>Draft (JSON, structural only)</summary>
              <pre className="mt-1 whitespace-pre-wrap break-words">
                {JSON.stringify(envelope.draft.content, null, 2)}
              </pre>
            </details>
          )}
          <p className="mt-2 text-[10.5px] text-subtle">
            Accepting this run does <strong>not</strong> sign a note, activate a protocol, order a
            lab, prescribe, bill, message, or publish. Every accepted item goes to the practitioner
            review queue.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Clinical copilot tab — CLINICAL.
 *
 * Registry preview + Phase 10A governed copilot run panel. Draft-only.
 * Provider is disabled by default; the workspace surfaces honest
 * unavailable states rather than falling back to any fixture in a
 * deployed environment.
 */
export function ClinicalCopilotWorkspace(props: { patientId: string; patientName: string }) {
  void props;
  return (
    <>
      <LiveClinicalRegistryPreview />
      <CopilotRunPanel />
    </>
  );
}
