"use client";

import type { RevisionWorkforceResponse } from "@/contracts/clinicalDisputes";

/**
 * Telling the patients who already hold an older version that a newer one exists.
 *
 * Rendered from props so each state is testable. Three things it must get right.
 *
 * It reports the count before anything is sent, because "this will notify 6 people" and "this
 * will notify nobody" are different decisions.
 *
 * It says plainly that nothing is re-sent. The notice tells them; their copy is untouched.
 * A practitioner who believed publishing swapped the protocol would stop checking.
 *
 * A safety withdrawal cannot be sent without words, and the words are what the patient reads.
 * The button stays disabled rather than sending an empty alarm.
 */
type Preview = Extract<RevisionWorkforceResponse, { action: "preview" }>;

export type RevisionAnnounceState = {
  preview: Preview | null;
  revisionClass: "safety_withdrawal" | "correction" | "enhancement";
  statement: string;
  busy: boolean;
  error: string | null;
  notice: string | null;
  onPreview: () => void;
  onClass: (value: "safety_withdrawal" | "correction" | "enhancement") => void;
  onStatement: (value: string) => void;
  onPublish: () => void;
};

const CLASS_LABEL: Record<RevisionAnnounceState["revisionClass"], string> = {
  safety_withdrawal: "Safety withdrawal — stop something they are taking",
  correction: "Correction — something was wrong",
  enhancement: "Addition — something was added or improved",
};

export function RevisionAnnounceView({ state }: { state: RevisionAnnounceState }) {
  const { preview, revisionClass, statement, busy, error, notice } = state;
  const needsWords = revisionClass === "safety_withdrawal";
  const ready = preview !== null && preview.affected > 0
    && (!needsWords || statement.trim().length > 0);
  const field = "block w-full rounded border p-2 text-sm";
  return (
    <div data-testid="revision-announce" className="rounded-lg border p-3">
      <h3 className="text-sm font-semibold">Tell patients already on an older version</h3>
      <p className="mt-1 text-sm">
        Publishing a new version does not reach anyone. Their copy is never changed underneath them — this sends a
        notice, and you re-share the new version separately if you want them on it.
      </p>
      {error && <p role="alert" data-testid="revision-announce-error" className="mt-2 text-sm text-critical">{error}</p>}
      {notice && <p role="status" data-testid="revision-announce-notice" className="mt-2 text-sm">{notice}</p>}

      <button type="button" data-testid="revision-preview" disabled={busy} onClick={state.onPreview}
        className="mt-2 rounded-lg border px-3 py-2 text-sm font-semibold disabled:opacity-50">
        Who is on an older version?
      </button>

      {preview && (
        preview.affected === 0 ? (
          <p data-testid="revision-none-affected" className="mt-2 text-sm">
            Nobody is holding an older version of this program. There is nothing to announce.
          </p>
        ) : (
          <>
            <p data-testid="revision-affected" className="mt-2 text-sm font-semibold">
              {preview.affected} patient{preview.affected === 1 ? "" : "s"} hold an older version.
            </p>
            <ul className="mt-1 list-none p-0 text-sm">
              {preview.assignments.map(entry => (
                <li key={entry.assignmentId} className="border-t border-hairline py-1">
                  From version {entry.fromVersion} · {entry.itemsRemoved} removed · {entry.itemsChanged} changed
                  · {entry.itemsAdded} added
                </li>
              ))}
            </ul>

            <label className="mt-2 block text-sm">What kind of revision is this?
              <select className={field} data-testid="revision-class" value={revisionClass} disabled={busy}
                onChange={event => state.onClass(event.target.value as RevisionAnnounceState["revisionClass"])}>
                {(Object.keys(CLASS_LABEL) as RevisionAnnounceState["revisionClass"][]).map(value => (
                  <option key={value} value={value}>{CLASS_LABEL[value]}</option>
                ))}
              </select>
            </label>

            <label className="mt-2 block text-sm">
              {needsWords ? "What should they stop, and why? (required)" : "Anything to tell them? (optional)"}
              <textarea className={field} rows={3} data-testid="revision-statement" value={statement} disabled={busy}
                onChange={event => state.onStatement(event.target.value)} maxLength={2000} />
            </label>
            {needsWords && (
              <p data-testid="revision-safety-warning" className="mt-1 text-sm">
                A safety withdrawal asks the patient to confirm they have read it. Until they do, it shows as
                unacknowledged and you should contact them directly.
              </p>
            )}

            <button type="button" data-testid="revision-publish" disabled={busy || !ready} onClick={state.onPublish}
              className="mt-2 rounded-lg border px-3 py-2 text-sm font-semibold disabled:opacity-50">
              {busy ? "Sending…" : `Notify ${preview.affected} patient${preview.affected === 1 ? "" : "s"}`}
            </button>
          </>
        )
      )}
    </div>
  );
}
