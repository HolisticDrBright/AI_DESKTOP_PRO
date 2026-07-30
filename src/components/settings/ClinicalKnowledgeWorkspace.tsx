"use client";

import { useState } from "react";
import { BookOpenCheck, Files } from "lucide-react";
import { ClinicalKnowledgeCenter } from "./ClinicalKnowledgeCenter";
import { KnowledgeImportCenter } from "./KnowledgeImportCenter";
import { cn } from "@/lib/cn";

export function ClinicalKnowledgeWorkspace() {
  const [tab, setTab] = useState<"pathways" | "imports">("pathways");
  return (
    <div>
      <div className="mb-3 flex items-center gap-1 border-b border-line" role="tablist" aria-label="Clinical knowledge views">
        <button
          role="tab"
          aria-selected={tab === "pathways"}
          onClick={() => setTab("pathways")}
          className={cn(
            "inline-flex h-9 items-center gap-1.5 border-b-2 px-3 text-[11.5px] font-bold",
            tab === "pathways" ? "border-action text-action" : "border-transparent text-subtle hover:text-ink",
          )}
        >
          <BookOpenCheck size={14} aria-hidden /> Pathways
        </button>
        <button
          role="tab"
          aria-selected={tab === "imports"}
          onClick={() => setTab("imports")}
          className={cn(
            "inline-flex h-9 items-center gap-1.5 border-b-2 px-3 text-[11.5px] font-bold",
            tab === "imports" ? "border-action text-action" : "border-transparent text-subtle hover:text-ink",
          )}
        >
          <Files size={14} aria-hidden /> Import review
        </button>
      </div>
      <div role="tabpanel">
        {tab === "pathways" ? <ClinicalKnowledgeCenter /> : <KnowledgeImportCenter />}
      </div>
    </div>
  );
}
