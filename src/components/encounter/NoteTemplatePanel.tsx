"use client";

import { useCallback, useEffect, useState } from "react";

import { DEFAULT_PRACTICE_NOTE_STYLE, type NoteTemplateAdminResponse,
  type NoteDraftingContextResponse, type NoteTemplateNoteType, type PracticeNoteStyle }
  from "@/contracts/noteTemplates";

import { NoteTemplateView, type NoteTemplateDraft } from "./NoteTemplateView";

type Resolved = NoteDraftingContextResponse;
type Saved = Extract<NoteTemplateAdminResponse, { action: "save_draft" }>;
type Read = Extract<NoteTemplateAdminResponse, { action: "read" }>;

const STARTING_SECTIONS: Record<NoteTemplateNoteType, NoteTemplateDraft["sections"]> = {
  soap: [{ key: "S", label: "Subjective" }, { key: "O", label: "Objective" },
    { key: "A", label: "Assessment" }, { key: "P", label: "Plan" }],
  adime: [{ key: "A", label: "Assessment" }, { key: "D", label: "Nutrition diagnosis" },
    { key: "I", label: "Intervention" }, { key: "ME", label: "Monitoring & evaluation" }],
  narrative: [{ key: "text", label: "Narrative" }],
  follow_up: [{ key: "text", label: "Follow-up note" }],
  patient_instructions: [{ key: "text", label: "Patient instructions" }],
};

/**
 * One practice template and the house style, for one note type.
 *
 * The published version is loaded through the drafting resolver rather than the admin list,
 * because what a clinician needs to see is exactly what a draft will be given — not a
 * neighbouring row that happens to describe it.
 */
export function NoteTemplatePanel({ noteType }: { noteType: NoteTemplateNoteType }) {
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [publishedVersion, setPublishedVersion] = useState<number | null>(null);
  const [draftDigest, setDraftDigest] = useState<string | null>(null);
  const [draft, setDraft] = useState<NoteTemplateDraft>({ name: "", sections: STARTING_SECTIONS[noteType] });
  const [style, setStyle] = useState<PracticeNoteStyle>(DEFAULT_PRACTICE_NOTE_STYLE);
  const [contextAvailable, setContextAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const post = useCallback(async (surface: "templates" | "drafting_context", request: unknown) => {
    const response = await fetch("/api/live/note-templates", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ surface, request }),
      signal: AbortSignal.timeout(25000),
    });
    const payload = await response.json().catch(() => ({})) as { data?: unknown; error?: string };
    if (!response.ok) throw new Error(payload.error ?? "service_unavailable");
    return payload.data;
  }, []);

  const load = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const resolved = await post("drafting_context", { action: "resolve", noteType }) as Resolved;
      setContextAvailable(resolved.context.available);
      if (resolved.style) setStyle(resolved.style.style);
      if (resolved.template) {
        setTemplateId(resolved.template.templateId);
        setPublishedVersion(resolved.template.version);
        setDraft({ name: resolved.template.name, sections: resolved.template.sections });
        // A published version cannot be edited, so nothing is publishable until a draft is saved.
        setDraftDigest(null);
        const detail = await post("templates", { action: "read", templateId: resolved.template.templateId }) as Read;
        const pending = detail.versions.find(version => version.status === "draft");
        if (pending) { setDraft({ name: detail.name, sections: pending.sections }); setDraftDigest(pending.contentSha256); }
      }
    } catch { setError("Your layout could not be loaded. Nothing has been changed."); }
    finally { setBusy(false); }
  }, [noteType, post]);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async () => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const saved = await post("templates", {
        action: "save_draft", noteType, name: draft.name.trim(),
        sections: draft.sections.map(section => ({ key: section.key, label: section.label.trim(),
          ...(section.guidance?.trim() ? { guidance: section.guidance.trim() } : {}) })),
      }) as Saved;
      setTemplateId(saved.templateId); setDraftDigest(saved.contentSha256);
      setNotice("Draft saved. New drafts still use the version in force until you choose this one.");
    } catch { setError("That could not be saved. Nothing has been changed."); }
    finally { setBusy(false); }
  }, [draft, noteType, post]);

  const publish = useCallback(async () => {
    if (!templateId || !draftDigest) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await post("templates", { action: "publish", templateId, contentSha256: draftDigest });
      setNotice("New drafts will use this layout. Earlier versions stay readable.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error && cause.message === "note_template_refused"
        ? "This draft changed since it was loaded. It has been re-read — look it over and publish again."
        : "That could not be published. The layout in force is unchanged.");
      await load();
    } finally { setBusy(false); }
  }, [draftDigest, load, post, templateId]);

  const publishStyle = useCallback(async () => {
    setBusy(true); setError(null); setNotice(null);
    try {
      await post("templates", { action: "style_publish", style });
      setNotice("Saved. New drafts read this way.");
      await load();
    } catch { setError("That could not be saved. Drafts read the same way as before."); }
    finally { setBusy(false); }
  }, [load, post, style]);

  return <NoteTemplateView state={{
    templateId, publishedVersion, draftDigest, draft, style, contextAvailable, busy, error, notice,
    onDraft: patch => { setDraft(current => ({ ...current, ...patch })); setDraftDigest(null); },
    onStyle: patch => setStyle(current => ({ ...current, ...patch })),
    onSave: () => void save(), onPublish: () => void publish(), onPublishStyle: () => void publishStyle(),
  }} />;
}
