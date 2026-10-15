"use client";

import { useState } from "react";
import { ConsultRequestBoard } from "./ConsultRequestBoard";
import { ConsultRequestQueue } from "./ConsultRequestQueue";

/** The consult requests as a list (the default, unchanged) or as the leads board: the same rows either way. */
export function ConsultRequestsView() {
  const [view, setView] = useState<"list" | "board">("list");
  return (
    <div>
      <div className="mb-2 flex gap-2" role="tablist" aria-label="Consult requests view">
        {(["list", "board"] as const).map(v => <button key={v} type="button" role="tab" aria-selected={view === v} data-testid={`consult-view-${v}`}
          onClick={() => setView(v)} className={`rounded-md border px-3 py-1 text-[12.5px] ${view === v ? "border-action font-semibold" : "border-hairline"}`}>{v === "list" ? "List" : "Board"}</button>)}
      </div>
      {view === "list" ? <ConsultRequestQueue /> : <ConsultRequestBoard />}
    </div>
  );
}
