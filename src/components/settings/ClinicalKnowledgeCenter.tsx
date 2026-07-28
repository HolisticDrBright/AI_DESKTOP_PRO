"use client";

import { useMemo, useState } from "react";
import {
  BadgeCheck,
  Beaker,
  BookOpenCheck,
  CircleAlert,
  CopyPlus,
  FilePenLine,
  Leaf,
  PackageCheck,
  RotateCcw,
  Save,
  ShieldAlert,
} from "lucide-react";
import {
  approveKnowledgeVersion,
  duplicateKnowledgeVersion,
  resetKnowledgeDemo,
  updateKnowledgeDraft,
  useKnowledgePathways,
  type KnowledgePathway,
  type KnowledgePathwayVersion,
} from "@/adapters/clinical-knowledge.mock";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/cn";

const statusStyle: Record<KnowledgePathwayVersion["status"], string> = {
  approved: "border-ok/25 bg-ok-tint text-ok",
  draft: "border-warning/25 bg-warning-tint text-warning-deep",
  superseded: "border-line bg-sunken text-subtle",
  retired: "border-line bg-sunken text-faint",
};

function Lines({
  title,
  icon: Icon,
  lines,
}: {
  title: string;
  icon: typeof Beaker;
  lines: string[];
}) {
  return (
    <section className="border-t border-line py-4 first:border-t-0">
      <h3 className="m-0 mb-2 flex items-center gap-2 text-[12.5px] font-bold text-ink">
        <Icon size={15} className="text-action" aria-hidden />
        {title}
      </h3>
      <ul className="m-0 grid gap-1.5 pl-5 text-[12px] leading-[1.5] text-body">
        {lines.map((line) => <li key={line}>{line}</li>)}
      </ul>
    </section>
  );
}

function VersionDetail({
  pathway,
  version,
  onApprove,
}: {
  pathway: KnowledgePathway;
  version: KnowledgePathwayVersion;
  onApprove: () => void;
}) {
  const [summary, setSummary] = useState(version.changeSummary);
  const [questions, setQuestions] = useState(version.content.differentiatingQuestions.join("\n"));
  const [sources, setSources] = useState(version.sourceRefs.join("\n"));
  const [saved, setSaved] = useState(false);
  const isDraft = version.status === "draft";

  const save = () => {
    updateKnowledgeDraft(pathway.id, version.id, {
      changeSummary: summary.trim(),
      sourceRefs: sources.split("\n").map((line) => line.trim()).filter(Boolean),
      content: {
        ...version.content,
        differentiatingQuestions: questions.split("\n").map((line) => line.trim()).filter(Boolean),
      },
    });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  };

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="m-0 text-[16px] font-bold text-ink">{pathway.name}</h2>
            <span className={cn("rounded border px-2 py-0.5 text-[10.5px] font-bold uppercase", statusStyle[version.status])}>
              v{version.version} · {version.status}
            </span>
          </div>
          <p className="mt-1 mb-0 max-w-[760px] text-[12px] leading-[1.5] text-subtle">{pathway.description}</p>
        </div>
        <div className="flex items-center gap-2">
          {!isDraft && (
            <button
              onClick={() => duplicateKnowledgeVersion(pathway.id)}
              className="inline-flex h-8 items-center gap-1.5 rounded border border-line bg-card px-3 text-[11.5px] font-semibold text-body hover:border-line-hover"
            >
              <CopyPlus size={14} aria-hidden /> New version
            </button>
          )}
          {isDraft && (
            <>
              <button
                onClick={save}
                className="inline-flex h-8 items-center gap-1.5 rounded border border-line bg-card px-3 text-[11.5px] font-semibold text-body hover:border-line-hover"
              >
                <Save size={14} aria-hidden /> {saved ? "Saved" : "Save draft"}
              </button>
              <button
                onClick={onApprove}
                className="inline-flex h-8 items-center gap-1.5 rounded border-0 bg-action px-3 text-[11.5px] font-semibold text-white hover:bg-action-deep"
              >
                <BadgeCheck size={14} aria-hidden /> Approve
              </button>
            </>
          )}
        </div>
      </div>

      <div className="grid gap-4 border-b border-line py-4 md:grid-cols-3">
        <div>
          <div className="text-[10.5px] font-bold uppercase text-faint">Domain</div>
          <div className="mt-1 text-[12px] font-semibold text-ink">{pathway.domain}</div>
        </div>
        <div>
          <div className="text-[10.5px] font-bold uppercase text-faint">Created by</div>
          <div className="mt-1 text-[12px] font-semibold text-ink">{version.createdBy}</div>
        </div>
        <div>
          <div className="text-[10.5px] font-bold uppercase text-faint">Approval</div>
          <div className="mt-1 text-[12px] font-semibold text-ink">
            {version.approvedBy ? `${version.approvedBy} · ${new Date(version.approvedAt!).toLocaleDateString()}` : "Awaiting administrator"}
          </div>
        </div>
      </div>

      {isDraft ? (
        <div className="grid gap-4 border-b border-line py-4 lg:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[11px] font-bold text-body">Change summary</span>
            <input value={summary} onChange={(event) => setSummary(event.target.value)} className="h-9 w-full rounded border border-line bg-card px-3 text-[12px] outline-none focus:border-action" />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-bold text-body">Sources, one per line</span>
            <textarea value={sources} onChange={(event) => setSources(event.target.value)} rows={3} className="w-full resize-y rounded border border-line bg-card px-3 py-2 text-[12px] leading-[1.5] outline-none focus:border-action" />
          </label>
          <label className="block lg:col-span-2">
            <span className="mb-1 block text-[11px] font-bold text-body">Differentiating questions, one per line</span>
            <textarea value={questions} onChange={(event) => setQuestions(event.target.value)} rows={5} className="w-full resize-y rounded border border-line bg-card px-3 py-2 text-[12px] leading-[1.5] outline-none focus:border-action" />
          </label>
        </div>
      ) : (
        <div className="border-b border-line py-4">
          <div className="mb-2 text-[10.5px] font-bold uppercase text-faint">Governed sources</div>
          <div className="flex flex-wrap gap-2">
            {version.sourceRefs.map((source) => (
              <span key={source} className="rounded border border-line bg-sunken px-2 py-1 text-[10.5px] text-body">{source}</span>
            ))}
          </div>
        </div>
      )}

      <Lines title="Differentiating questions" icon={CircleAlert} lines={version.content.differentiatingQuestions} />
      <section className="border-t border-line py-4">
        <h3 className="m-0 mb-2 flex items-center gap-2 text-[12.5px] font-bold text-ink">
          <Beaker size={15} className="text-action" aria-hidden /> Lab strategy
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[11.5px]">
            <thead><tr className="border-y border-line bg-sunken text-faint"><th className="px-3 py-2">Panel</th><th className="px-3 py-2">Vendor</th><th className="px-3 py-2">Clinical purpose</th></tr></thead>
            <tbody>{version.content.labStrategy.map((lab) => <tr key={`${lab.vendor}-${lab.panel}`} className="border-b border-line"><td className="px-3 py-2 font-semibold text-ink">{lab.panel}</td><td className="px-3 py-2 text-body">{lab.vendor}</td><td className="px-3 py-2 text-body">{lab.purpose}</td></tr>)}</tbody>
          </table>
        </div>
      </section>
      <section className="border-t border-line py-4">
        <h3 className="m-0 mb-2 flex items-center gap-2 text-[12.5px] font-bold text-ink">
          <PackageCheck size={15} className="text-action" aria-hidden /> Exact product candidates
        </h3>
        <div className="grid gap-2 lg:grid-cols-2">
          {version.content.productCandidates.map((product) => (
            <div key={`${product.brand}-${product.name}`} className="rounded border border-line px-3 py-2">
              <div className="text-[12px] font-bold text-ink">{product.name}</div>
              <div className="text-[11px] text-subtle">{product.brand}</div>
              <div className="mt-1 text-[11px] leading-[1.45] text-body">{product.role}</div>
              <div className="mt-1.5 text-[10px] font-semibold text-warning-deep">Exact current label must be verified before patient selection</div>
            </div>
          ))}
        </div>
      </section>
      <Lines title="Nutrition guidance" icon={Leaf} lines={version.content.nutrition} />
      <Lines title="Lifestyle guidance" icon={BookOpenCheck} lines={version.content.lifestyle} />
      <Lines title="Safety stops" icon={ShieldAlert} lines={version.content.safetyStops} />
    </div>
  );
}

export function ClinicalKnowledgeCenter() {
  const pathways = useKnowledgePathways();
  const [selectedPathwayId, setSelectedPathwayId] = useState(pathways[0]?.id ?? "");
  const selected = pathways.find((pathway) => pathway.id === selectedPathwayId) ?? pathways[0];
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [approveTarget, setApproveTarget] = useState<KnowledgePathwayVersion | null>(null);

  const version = useMemo(() => {
    if (!selected) return undefined;
    return selected.versions.find((item) => item.id === selectedVersionId)
      ?? selected.versions.find((item) => item.status === "draft")
      ?? selected.versions.find((item) => item.status === "approved")
      ?? selected.versions[0];
  }, [selected, selectedVersionId]);

  if (!selected || !version) return null;

  return (
    <>
      <div className="grid min-h-[640px] overflow-hidden rounded border border-line bg-card lg:grid-cols-[275px_minmax(0,1fr)]">
        <aside className="border-b border-line bg-sunken lg:border-r lg:border-b-0">
          <div className="border-b border-line px-4 py-3">
            <div className="text-[11px] font-bold uppercase text-faint">Clinical pathways</div>
            <div className="mt-1 text-[11px] text-subtle">{pathways.length} governed pathways</div>
          </div>
          <nav aria-label="Clinical pathways" className="p-2">
            {pathways.map((pathway) => {
              const approved = pathway.versions.find((item) => item.status === "approved");
              const draftCount = pathway.versions.filter((item) => item.status === "draft").length;
              return (
                <button
                  key={pathway.id}
                  onClick={() => {
                    setSelectedPathwayId(pathway.id);
                    setSelectedVersionId(null);
                  }}
                  className={cn(
                    "mb-1 w-full rounded px-3 py-2.5 text-left hover:bg-card",
                    pathway.id === selected.id && "bg-card shadow-sm",
                  )}
                >
                  <span className="block text-[12px] font-bold text-ink">{pathway.name}</span>
                  <span className="mt-0.5 flex items-center justify-between text-[10.5px] text-subtle">
                    <span>{pathway.domain}</span>
                    <span>{draftCount ? `${draftCount} draft` : approved ? `v${approved.version} approved` : "No approved version"}</span>
                  </span>
                </button>
              );
            })}
          </nav>
        </aside>

        <main className="min-w-0 p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
            <div className="flex items-center gap-2">
              <FilePenLine size={16} className="text-action" aria-hidden />
              <span className="text-[11px] font-bold text-body">Version history</span>
              <select
                aria-label="Pathway version"
                value={version.id}
                onChange={(event) => setSelectedVersionId(event.target.value)}
                className="h-8 rounded border border-line bg-card px-2 text-[11.5px] text-body outline-none focus:border-action"
              >
                {selected.versions.map((item) => (
                  <option key={item.id} value={item.id}>v{item.version} · {item.status}</option>
                ))}
              </select>
            </div>
            <button
              onClick={resetKnowledgeDemo}
              className="inline-flex h-8 items-center gap-1.5 rounded border border-line bg-card px-3 text-[11px] font-semibold text-subtle hover:text-ink"
              title="Reset demo registry"
            >
              <RotateCcw size={13} aria-hidden /> Reset demo
            </button>
          </div>
          <VersionDetail
            key={version.id}
            pathway={selected}
            version={version}
            onApprove={() => setApproveTarget(version)}
          />
        </main>
      </div>
      <ConfirmDialog
        open={Boolean(approveTarget)}
        title="Approve this clinical pathway version?"
        body="Approval makes this the only version available to the patient clinical copilot. The approved content becomes immutable; future changes require a new draft."
        confirmLabel="Approve version"
        onCancel={() => setApproveTarget(null)}
        onConfirm={() => {
          if (approveTarget) approveKnowledgeVersion(selected.id, approveTarget.id);
          setApproveTarget(null);
          setSelectedVersionId(null);
        }}
      />
    </>
  );
}
