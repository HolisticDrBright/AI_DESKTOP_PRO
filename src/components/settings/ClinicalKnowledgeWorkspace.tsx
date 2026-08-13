"use client";

import Link from "next/link";
import { useState } from "react";
import { BookOpenCheck, ExternalLink, Files, Layers, PackageSearch } from "lucide-react";
import { ClinicalKnowledgeCenter } from "./ClinicalKnowledgeCenter";
import { ProductCatalogCenter } from "./ProductCatalogCenter";
import { ProtocolTemplateCenter } from "./ProtocolTemplateCenter";
import { cn } from "@/lib/cn";

type Tab = "pathways" | "catalog" | "templates" | "imports";

/**
 * Phase 9E-A retires the duplicate import-review experience that used to
 * live in this workspace. The full curation workflow (source files, preview
 * batches, conflicts, restricted review, provenance) lives at
 * `/settings/imports`. The Import-review tab remains as a signpost so
 * anyone who bookmarked or was directed here is not left staring at a
 * missing surface.
 */
const TABS: Array<{ id: Tab; label: string; Icon: typeof BookOpenCheck }> = [
  { id: "pathways", label: "Pathways", Icon: BookOpenCheck },
  { id: "catalog", label: "Product catalog", Icon: PackageSearch },
  { id: "templates", label: "Protocol templates", Icon: Layers },
  { id: "imports", label: "Import review", Icon: Files },
];

function ImportReviewRedirect() {
  return (
    <div className="mx-auto max-w-[560px] py-8" data-testid="knowledge-imports-redirect">
      <div className="rounded border border-line bg-card px-4 py-4">
        <h2 className="m-0 text-[15px] font-bold">The import review has moved</h2>
        <p className="mt-2 text-[12.5px] leading-[1.55] text-subtle">
          Phase 9E-A consolidated import and curation into one workspace at{" "}
          <Link
            href="/settings/imports"
            className="font-semibold text-action underline underline-offset-2"
            data-testid="knowledge-imports-link"
          >
            Settings · Imports
          </Link>
          . That workspace is where source files are declared, preview batches are staged,
          conflicts are resolved, restricted products are reviewed, and provenance is
          audited. Nothing that used to live here has been removed — it was moved beside
          the other curation surfaces so a reviewer can walk the whole workflow in one
          place instead of jumping between screens.
        </p>
        <Link
          href="/settings/imports"
          className="mt-3 inline-flex h-8 items-center gap-1 rounded border border-action bg-action px-3 text-[12.5px] font-semibold text-white"
          data-testid="knowledge-imports-cta"
        >
          Open the curation workspace <ExternalLink size={12} aria-hidden />
        </Link>
      </div>
    </div>
  );
}

export function ClinicalKnowledgeWorkspace() {
  const [tab, setTab] = useState<Tab>("pathways");
  return (
    <div>
      <div
        className="mb-3 flex items-center gap-1 border-b border-line"
        role="tablist"
        aria-label="Clinical knowledge views"
      >
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            role="tab"
            id={`knowledge-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`knowledge-panel-${id}`}
            onClick={() => setTab(id)}
            className={cn(
              "inline-flex h-9 items-center gap-1.5 border-b-2 px-3 text-[11.5px] font-bold",
              tab === id
                ? "border-action text-action"
                : "border-transparent text-subtle hover:text-ink",
            )}
          >
            <Icon size={14} aria-hidden /> {label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`knowledge-panel-${tab}`}
        aria-labelledby={`knowledge-tab-${tab}`}
      >
        {tab === "pathways" ? <ClinicalKnowledgeCenter /> : null}
        {tab === "catalog" ? <ProductCatalogCenter /> : null}
        {tab === "templates" ? <ProtocolTemplateCenter /> : null}
        {tab === "imports" ? <ImportReviewRedirect /> : null}
      </div>
    </div>
  );
}
