"use client";

import { useState } from "react";

import type { NoteTemplateNoteType } from "@/contracts/noteTemplates";

import { NoteTemplatePanel } from "./NoteTemplatePanel";

/**
 * One layout per note type, chosen here.
 *
 * Only these five exist because the drafting contract accepts only these five: offering a sixth
 * would be offering a layout no draft could ever be requested in.
 */
const NOTE_TYPES: { value: NoteTemplateNoteType; label: string }[] = [
  { value: "soap", label: "SOAP" },
  { value: "adime", label: "ADIME" },
  { value: "narrative", label: "Narrative" },
  { value: "follow_up", label: "Follow-up" },
  { value: "patient_instructions", label: "Patient instructions" },
];

export function NoteTemplateWorkspace() {
  const [noteType, setNoteType] = useState<NoteTemplateNoteType>("soap");
  return (
    <div data-testid="note-template-workspace">
      <div className="flex flex-wrap gap-2">
        {NOTE_TYPES.map(type => (
          <button key={type.value} type="button" data-testid={`note-template-type-${type.value}`}
            aria-pressed={noteType === type.value} onClick={() => setNoteType(type.value)}
            className={`rounded-lg border px-3 py-2 text-sm ${noteType === type.value ? "font-semibold" : ""}`}>
            {type.label}
          </button>
        ))}
      </div>
      {/* Keyed so switching note type starts a fresh load rather than showing the last layout. */}
      <div className="mt-3"><NoteTemplatePanel key={noteType} noteType={noteType} /></div>
    </div>
  );
}
