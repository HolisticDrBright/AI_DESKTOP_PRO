"use client";

import { CONTEXT_BREADTH_LABEL, type NoteTemplateSection, type PracticeNoteStyle }
  from "@/contracts/noteTemplates";

/**
 * The practitioner's own note layout, and the house style a draft is written in.
 *
 * Rendered from props so each state is testable. Four things it must get right.
 *
 * It shows what the draft will actually be asked for — the sections in order, with the
 * clinician's own guidance — because a template nobody can see is a setting nobody trusts.
 *
 * It says plainly that the boundary outranks the template. A clinician who believed guidance
 * could make a draft state something the visit did not would stop reading the draft.
 *
 * A published version is never edited. The screen offers a new draft rather than pretending
 * version 2 can be amended, because a note that cites version 2 has to keep meaning something.
 *
 * Widening what a draft may see is presented as the disclosure it is, and when it cannot be
 * supplied the screen says so rather than leaving the choice looking honoured.
 */
export type NoteTemplateDraft = { name: string; sections: NoteTemplateSection[] };
export type NoteTemplateState = {
  publishedVersion: number | null;
  templateId: string | null;
  /** The saved draft's digest. Publishing sends it back, so a draft edited meanwhile is refused. */
  draftDigest: string | null;
  draft: NoteTemplateDraft;
  style: PracticeNoteStyle;
  /** Whether a breadth wider than `none` can actually be supplied. */
  contextAvailable: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;
  onDraft: (patch: Partial<NoteTemplateDraft>) => void;
  onStyle: (patch: Partial<PracticeNoteStyle>) => void;
  onSave: () => void;
  onPublish: () => void;
  onPublishStyle: () => void;
};

const keyValid = (key: string) => /^[A-Za-z][A-Za-z0-9_]{0,7}$/.test(key);
const CHOICES: { [K in keyof PracticeNoteStyle]?: { value: string; label: string }[] } = {
  verbosity: [{ value: "terse", label: "Terse" }, { value: "standard", label: "Standard" }, { value: "detailed", label: "Detailed" }],
  person: [{ value: "third", label: "Third person" }, { value: "first", label: "First person" }],
  tense: [{ value: "past", label: "Past" }, { value: "present", label: "Present" }],
  headingCase: [{ value: "title", label: "Title Case" }, { value: "upper", label: "UPPER CASE" }, { value: "sentence", label: "Sentence case" }],
};
const CHOICE_LABEL: Record<string, string> = { verbosity: "Length", person: "Point of view", tense: "Tense", headingCase: "Heading capitalisation" };

export function NoteTemplateView({ state }: { state: NoteTemplateState }) {
  const { draft, style, busy, error, notice } = state;
  const keys = draft.sections.map(s => s.key);
  const sectionsValid = draft.sections.length > 0 && draft.sections.length <= 8
    && draft.sections.every(s => keyValid(s.key) && s.label.trim().length > 0)
    && new Set(keys).size === keys.length;
  const savable = draft.name.trim().length > 0 && sectionsValid;
  const field = "block w-full rounded border p-2 text-sm";
  return (
    <div data-testid="note-template" className="rounded-lg border p-3">
      <h3 className="text-sm font-semibold">Your own note layout</h3>
      <p className="mt-1 text-sm">
        A draft is written into these sections, in this order, with your headings. Your guidance says how you like
        each section written — it never lets a draft state something the visit did not. Anything the guidance asks
        for that the recording does not support comes back as a caution instead.
      </p>
      {error && <p role="alert" data-testid="note-template-error" className="mt-2 text-sm text-critical">{error}</p>}
      {notice && <p role="status" data-testid="note-template-notice" className="mt-2 text-sm">{notice}</p>}

      {state.publishedVersion !== null && (
        <p data-testid="note-template-published" className="mt-2 text-sm font-semibold">
          Version {state.publishedVersion} is in use. Published versions are never edited — this saves a new draft,
          and the old version stays readable for the notes it produced.
        </p>
      )}

      <label className="mt-2 block text-sm">What do you call this layout?
        <input className={field} data-testid="note-template-name" value={draft.name} disabled={busy} maxLength={120}
          onChange={event => state.onDraft({ name: event.target.value })} />
      </label>

      <ul className="mt-2 list-none p-0 text-sm">
        {draft.sections.map((section, index) => (
          <li key={index} data-testid={`note-template-section-${index}`} className="border-t border-hairline py-2">
            <div className="flex gap-2">
              <input className={`${field} w-24`} aria-label={`Section ${index + 1} key`}
                data-testid={`note-template-key-${index}`} value={section.key} disabled={busy} maxLength={8}
                onChange={event => state.onDraft({
                  sections: draft.sections.map((s, i) => i === index ? { ...s, key: event.target.value } : s),
                })} />
              <input className={field} aria-label={`Section ${index + 1} heading`}
                data-testid={`note-template-label-${index}`} value={section.label} disabled={busy} maxLength={80}
                onChange={event => state.onDraft({
                  sections: draft.sections.map((s, i) => i === index ? { ...s, label: event.target.value } : s),
                })} />
            </div>
            <input className={`${field} mt-1`} aria-label={`Section ${index + 1} guidance`}
              data-testid={`note-template-guidance-${index}`} value={section.guidance ?? ""} disabled={busy} maxLength={400}
              placeholder="How you like this section written (optional)"
              onChange={event => state.onDraft({
                sections: draft.sections.map((s, i) => i === index ? { ...s, guidance: event.target.value || null } : s),
              })} />
            <button type="button" data-testid={`note-template-remove-${index}`} disabled={busy || draft.sections.length === 1}
              onClick={() => state.onDraft({ sections: draft.sections.filter((_, i) => i !== index) })}
              className="mt-1 rounded border px-2 py-1 text-xs disabled:opacity-50">Remove</button>
          </li>
        ))}
      </ul>
      {!sectionsValid && (
        <p role="alert" data-testid="note-template-sections-invalid" className="mt-1 text-sm text-critical">
          Every section needs a short key (a letter, then up to seven letters, numbers or underscores) and a heading,
          and no two sections may share a key. A draft is matched to these keys, so a duplicate could not be filled.
        </p>
      )}
      <button type="button" data-testid="note-template-add" disabled={busy || draft.sections.length >= 8}
        onClick={() => state.onDraft({ sections: [...draft.sections, { key: "", label: "", guidance: null }] })}
        className="mt-1 rounded border px-2 py-1 text-xs disabled:opacity-50">
        {draft.sections.length >= 8 ? "Eight sections is the most a draft can fill" : "Add a section"}
      </button>

      <div className="mt-2 flex gap-2">
        <button type="button" data-testid="note-template-save" disabled={busy || !savable} onClick={state.onSave}
          className="rounded-lg border px-3 py-2 text-sm font-semibold disabled:opacity-50">
          {busy ? "Saving…" : "Save draft"}
        </button>
        <button type="button" data-testid="note-template-publish"
          disabled={busy || state.draftDigest === null || state.templateId === null} onClick={state.onPublish}
          className="rounded-lg border px-3 py-2 text-sm font-semibold disabled:opacity-50">
          Use this for new drafts
        </button>
      </div>

      <h3 className="mt-4 text-sm font-semibold">How drafts should read</h3>
      <p className="mt-1 text-sm">
        These are the only choices a house style has. There is nowhere here to write an instruction, which is what
        makes it safe to send with the recording.
      </p>
      {(Object.keys(CHOICES) as (keyof PracticeNoteStyle)[]).map(key => (
        <label key={key} className="mt-2 block text-sm">{CHOICE_LABEL[key]}
          <select className={field} data-testid={`note-style-${key}`} value={String(style[key])} disabled={busy}
            onChange={event => state.onStyle({ [key]: event.target.value } as unknown as Partial<PracticeNoteStyle>)}>
            {CHOICES[key]!.map(choice => (
              <option key={choice.value} value={choice.value}>{choice.label}</option>
            ))}
          </select>
        </label>
      ))}
      <label className="mt-2 block text-sm">
        <input type="checkbox" data-testid="note-style-bullets" checked={style.bullets} disabled={busy}
          onChange={event => state.onStyle({ bullets: event.target.checked })} /> Use bulleted lists
      </label>
      <label className="mt-1 block text-sm">
        <input type="checkbox" data-testid="note-style-quote" checked={style.quotePatientWords} disabled={busy}
          onChange={event => state.onStyle({ quotePatientWords: event.target.checked })} /> Quote the patient&rsquo;s own words
      </label>

      <label className="mt-2 block text-sm">What else may a draft see?
        <select className={field} data-testid="note-style-context" value={style.contextBreadth} disabled={busy}
          onChange={event => state.onStyle({ contextBreadth: event.target.value as PracticeNoteStyle["contextBreadth"] })}>
          {(Object.keys(CONTEXT_BREADTH_LABEL) as PracticeNoteStyle["contextBreadth"][]).map(value => (
            <option key={value} value={value}>{CONTEXT_BREADTH_LABEL[value]}</option>
          ))}
        </select>
      </label>
      {style.contextBreadth !== "none" && (
        <p data-testid="note-style-context-warning" className="mt-1 text-sm">
          This sends more of the chart to the drafting service than the recording itself.
          {state.contextAvailable
            ? " Every draft records what it was given."
            : " It cannot be supplied yet, so drafts will record that this context was withheld."}
        </p>
      )}
      <button type="button" data-testid="note-style-publish" disabled={busy} onClick={state.onPublishStyle}
        className="mt-2 rounded-lg border px-3 py-2 text-sm font-semibold disabled:opacity-50">
        Save how drafts read
      </button>
    </div>
  );
}
