"use client";

import { useState } from "react";
import { BookOpenCheck, Files, Layers, PackageSearch } from "lucide-react";
import { ClinicalKnowledgeCenter } from "./ClinicalKnowledgeCenter";
import { KnowledgeImportCenter } from "./KnowledgeImportCenter";
import { ProductCatalogCenter } from "./ProductCatalogCenter";
import { ProtocolTemplateCenter } from "./ProtocolTemplateCenter";
import { cn } from "@/lib/cn";

type Tab = "pathways" | "catalog" | "templates" | "imports";

const TABS: Array<{ id: Tab; label: string; Icon: typeof BookOpenCheck }> = [
  { id: "pathways", label: "Pathways", Icon: BookOpenCheck },
  { id: "catalog", label: "Product catalog", Icon: PackageSearch },
  { id: "templates", label: "Protocol templates", Icon: Layers },
  { id: "imports", label: "Import review", Icon: Files },
];

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
      {/*
        One panel per tab, each labelled by its own tab, so a screen reader
        announces which view it landed in rather than an unnamed region.
      */}
      <div
        role="tabpanel"
        id={`knowledge-panel-${tab}`}
        aria-labelledby={`knowledge-tab-${tab}`}
      >
        {tab === "pathways" ? <ClinicalKnowledgeCenter /> : null}
        {tab === "catalog" ? <ProductCatalogCenter /> : null}
        {tab === "templates" ? <ProtocolTemplateCenter /> : null}
        {tab === "imports" ? <KnowledgeImportCenter /> : null}
      </div>
    </div>
  );
}
