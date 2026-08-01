"use client";

import { useCallback, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileUp,
  Loader2,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type {
  LiveKnowledgeImportPreview,
  LiveKnowledgeImportPreviewResult,
} from "@/adapters/live-types";
import { liveClient } from "@/adapters/live-client";
import { cn } from "@/lib/cn";

/**
 * The governed import pipeline: preview, review, resolve, commit.
 *
 * The screen is built around one claim that has to stay visible at every step:
 * A PREVIEW HAS CHANGED NOTHING. Every intermediate state says so, because the
 * moment a reviewer believes the import already happened, the review stops
 * being a review.
 *
 * Commit sends back the counts that were actually on screen. If the staged set
 * moved underneath the reviewer, the server refuses rather than applying a
 * different set of rows than the one they read.
 */

const SOURCE_KINDS = [
  { value: "product_spreadsheet", label: "Product spreadsheet" },
  { value: "affiliate_sheet", label: "Affiliate sheet" },
  { value: "protocol_document", label: "Protocol document" },
  { value: "obsidian_export", label: "Obsidian export" },
  { value: "reference_list", label: "Reference list" },
  { value: "other", label: "Other" },
] as const;

type Phase = "idle" | "previewing" | "reviewing" | "committing" | "committed";

export function KnowledgeImportPreviewPanel({
  onCommitted,
}: {
  onCommitted?: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [sourceKind, setSourceKind] =
    useState<(typeof SOURCE_KINDS)[number]["value"]>("product_spreadsheet");
  const [sourceName, setSourceName] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [items, setItems] = useState<unknown[] | null>(null);
  const [attested, setAttested] = useState(false);
  const [result, setResult] = useState<LiveKnowledgeImportPreviewResult | null>(null);
  const [detail, setDetail] = useState<LiveKnowledgeImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    setPhase("idle");
    setItems(null);
    setFileName(null);
    setFileSize(null);
    setResult(null);
    setDetail(null);
    setError(null);
    setNotice(null);
    setAttested(false);
    if (fileRef.current) fileRef.current.value = "";
  }, []);

  const onFile = useCallback(async (file: File) => {
    setError(null);
    setNotice(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      const list = Array.isArray(parsed)
        ? parsed
        : (parsed as { items?: unknown[] })?.items;
      if (!Array.isArray(list) || list.length === 0) {
        // Named precisely: the operator needs to know which of the two shapes
        // failed, not that "something was wrong with the file".
        setError(
          "This file does not contain an import item array. Expected either a " +
            "JSON array of items, or an object with an `items` array.",
        );
        return;
      }
      setItems(list);
      setFileName(file.name);
      setFileSize(file.size);
      if (!sourceName.trim()) setSourceName(file.name.replace(/\.[^.]+$/, ""));
    } catch {
      setError("This file is not valid JSON. Convert the source before importing.");
    }
  }, [sourceName]);

  const runPreview = useCallback(async () => {
    if (!items || !attested) return;
    setPhase("previewing");
    setError(null);
    try {
      const res = await liveClient.knowledgeImportPreview({
        sourceKind,
        sourceName: sourceName.trim(),
        schemaVersion: "clinical-knowledge-import-v1",
        items,
        attestsNoPhi: true,
        sourceFilename: fileName,
        sourceByteSize: fileSize,
      });
      setResult(res);
      if (res.idempotent) {
        setNotice(res.message);
      }
      setDetail(await liveClient.knowledgeImportDetail(res.batchId));
      setPhase("reviewing");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The preview could not be staged.");
      setPhase("idle");
    }
  }, [items, attested, sourceKind, sourceName, fileName, fileSize]);

  const refreshDetail = useCallback(async (batchId: string) => {
    setDetail(await liveClient.knowledgeImportDetail(batchId));
  }, []);

  const resolve = useCallback(
    async (
      itemId: string,
      resolution: "keep_existing" | "take_incoming" | "skip",
      note: string,
    ) => {
      if (!result) return;
      setError(null);
      try {
        await liveClient.knowledgeImportResolve({ itemId, resolution, note });
        await refreshDetail(result.batchId);
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "The conflict could not be resolved.",
        );
      }
    },
    [result, refreshDetail],
  );

  const commit = useCallback(async () => {
    if (!result || !detail) return;
    setPhase("committing");
    setError(null);
    try {
      const res = await liveClient.knowledgeImportCommit({
        batchId: result.batchId,
        // The numbers actually on screen, not the ones we asked for.
        expectedCounts: {
          added: detail.batch.added,
          changed: detail.batch.changed,
        },
        note: `Reviewed and committed from ${sourceName || "an operator import"}`,
      });
      setNotice(res.message);
      setPhase("committed");
      onCommitted?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The import could not be committed.");
      setPhase("reviewing");
    }
  }, [result, detail, sourceName, onCommitted]);

  const cancel = useCallback(async () => {
    if (!result) return;
    try {
      await liveClient.knowledgeImportCancel({
        batchId: result.batchId,
        reason: "Abandoned during review",
      });
    } finally {
      reset();
    }
  }, [result, reset]);

  const unresolved =
    detail?.items.filter(
      (i) => i.changeKind === "conflict" && i.conflictResolution == null,
    ) ?? [];
  const invalid =
    detail?.items.filter(
      (i) => i.status === "needs_review" && i.validationErrors.length > 0,
    ) ?? [];
  const canCommit =
    phase === "reviewing" && unresolved.length === 0 && invalid.length === 0;

  return (
    <section
      data-testid="import-preview-panel"
      className="mb-4 rounded border border-line bg-surface p-4"
    >
      <header className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[13px] font-semibold text-ink">
            Preview and commit an import
          </h3>
          <p className="mt-1 max-w-[70ch] text-[11.5px] leading-[1.55] text-subtle">
            A preview stages, hashes and classifies every row and{" "}
            <strong className="text-ink">changes nothing</strong>. Content only
            reaches the registry when you commit, and everything committed
            arrives as a non-approved draft.
          </p>
        </div>
        {phase !== "idle" && (
          <button
            type="button"
            onClick={reset}
            className="shrink-0 rounded border border-line px-2 py-1 text-[11px] text-subtle hover:text-ink"
          >
            Start over
          </button>
        )}
      </header>

      {error && (
        <p
          role="alert"
          data-testid="import-error"
          className="mb-3 rounded border border-danger/25 bg-danger-tint px-3 py-2 text-[11.5px] text-danger"
        >
          {error}
        </p>
      )}
      {notice && (
        <p
          data-testid="import-notice"
          className="mb-3 rounded border border-action/25 bg-action-tint px-3 py-2 text-[11.5px] text-ink"
        >
          {notice}
        </p>
      )}

      {(phase === "idle" || phase === "previewing") && (
        <div className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-[11.5px] text-subtle">
              Source kind
              <select
                value={sourceKind}
                onChange={(e) =>
                  setSourceKind(
                    e.target.value as (typeof SOURCE_KINDS)[number]["value"],
                  )
                }
                className="mt-1 w-full rounded border border-line bg-sunken px-2 py-1.5 text-[12px] text-ink"
              >
                {SOURCE_KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[11.5px] text-subtle">
              Source name
              <input
                value={sourceName}
                onChange={(e) => setSourceName(e.target.value)}
                placeholder="e.g. Practitioner product formulary"
                className="mt-1 w-full rounded border border-line bg-sunken px-2 py-1.5 text-[12px] text-ink"
              />
            </label>
          </div>

          <div>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onFile(f);
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="inline-flex items-center gap-2 rounded border border-line px-3 py-1.5 text-[12px] text-ink hover:border-action"
            >
              <FileUp size={14} aria-hidden /> Choose converted import file
            </button>
            {fileName && (
              <span className="ml-3 text-[11.5px] text-subtle">
                {fileName} · {items?.length ?? 0} rows
              </span>
            )}
            <p className="mt-2 max-w-[70ch] text-[11px] leading-[1.5] text-subtle">
              The source spreadsheet or document itself is never uploaded here.
              Convert it on your own machine first — see the operator import
              procedure — so no raw private file leaves it.
            </p>
          </div>

          <label className="flex items-start gap-2 text-[11.5px] leading-[1.5] text-ink">
            <input
              type="checkbox"
              checked={attested}
              onChange={(e) => setAttested(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              I confirm this file contains no patient-identifiable information
              and no copied source text.
            </span>
          </label>

          <div>
            <button
              type="button"
              disabled={!items || !attested || !sourceName.trim() || phase === "previewing"}
              onClick={() => void runPreview()}
              data-testid="run-preview"
              className={cn(
                "inline-flex items-center gap-2 rounded px-3 py-1.5 text-[12px] font-medium",
                !items || !attested || !sourceName.trim()
                  ? "cursor-not-allowed border border-line text-subtle"
                  : "bg-action text-white hover:opacity-90",
              )}
            >
              {phase === "previewing" ? (
                <Loader2 size={14} className="animate-spin" aria-hidden />
              ) : (
                <ShieldCheck size={14} aria-hidden />
              )}
              Preview — writes nothing
            </button>
          </div>
        </div>
      )}

      {detail && (phase === "reviewing" || phase === "committing" || phase === "committed") && (
        <div className="grid gap-3">
          <dl
            data-testid="preview-counts"
            className="grid grid-cols-2 gap-2 sm:grid-cols-5"
          >
            {[
              ["Added", detail.batch.added, "added"],
              ["Changed", detail.batch.changed, "changed"],
              ["Unchanged", detail.batch.unchanged, "unchanged"],
              ["Conflicts", detail.batch.conflicts, "conflicts"],
              ["Removals reported", detail.batch.removals, "removals"],
            ].map(([label, value, key]) => (
              <div
                key={String(key)}
                data-testid={`count-${key}`}
                className="rounded border border-line bg-sunken px-2 py-1.5"
              >
                <dt className="text-[10.5px] uppercase tracking-wide text-subtle">
                  {label}
                </dt>
                <dd className="text-[15px] font-semibold text-ink">{value}</dd>
              </div>
            ))}
          </dl>

          {phase !== "committed" && (
            <p
              data-testid="nothing-written-yet"
              className="rounded border border-warning/25 bg-warning-tint px-3 py-2 text-[11.5px] leading-[1.5] text-warning-deep"
            >
              Nothing has been written yet. These are staged rows only.
            </p>
          )}

          {detail.batch.removals > 0 && (
            <p className="rounded border border-line bg-sunken px-3 py-2 text-[11.5px] leading-[1.5] text-subtle">
              {detail.removalPolicy}
            </p>
          )}

          {invalid.length > 0 && (
            <div
              data-testid="validation-blockers"
              className="rounded border border-danger/25 bg-danger-tint p-3"
            >
              <p className="mb-2 flex items-center gap-2 text-[12px] font-semibold text-danger">
                <AlertTriangle size={14} aria-hidden />
                {invalid.length} row{invalid.length === 1 ? "" : "s"} cannot be
                applied
              </p>
              <ul className="grid gap-1.5">
                {invalid.slice(0, 12).map((i) => (
                  <li key={i.id} className="text-[11.5px] leading-[1.5] text-ink">
                    <span className="font-medium">
                      Row {i.sourceRowNumber ?? "?"} — {i.displayName}
                    </span>
                    <ul className="ml-4 list-disc text-subtle">
                      {i.validationErrors.map((e, n) => (
                        <li key={n}>{e}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] text-danger">
                Fix these in the source and re-import. They are not dropped
                silently, and the commit will refuse while they are staged.
              </p>
            </div>
          )}

          {unresolved.length > 0 && (
            <div
              data-testid="conflict-list"
              className="rounded border border-warning/25 bg-warning-tint p-3"
            >
              <p className="mb-2 text-[12px] font-semibold text-warning-deep">
                {unresolved.length} conflict
                {unresolved.length === 1 ? "" : "s"} need a decision
              </p>
              <ul className="grid gap-2">
                {unresolved.map((i) => (
                  <ConflictRow key={i.id} item={i} onResolve={resolve} />
                ))}
              </ul>
            </div>
          )}

          {phase === "committed" ? (
            <p
              data-testid="commit-result"
              className="flex items-start gap-2 rounded border border-ok/25 bg-ok-tint px-3 py-2 text-[11.5px] leading-[1.5] text-ok"
            >
              <CheckCircle2 size={14} className="mt-0.5 shrink-0" aria-hidden />
              <span>{notice}</span>
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={!canCommit}
                onClick={() => void commit()}
                data-testid="commit-import"
                className={cn(
                  "inline-flex items-center gap-2 rounded px-3 py-1.5 text-[12px] font-medium",
                  canCommit
                    ? "bg-action text-white hover:opacity-90"
                    : "cursor-not-allowed border border-line text-subtle",
                )}
              >
                {phase === "committing" ? (
                  <Loader2 size={14} className="animate-spin" aria-hidden />
                ) : null}
                Commit {detail.batch.added + detail.batch.changed} row
                {detail.batch.added + detail.batch.changed === 1 ? "" : "s"} as
                drafts
              </button>
              <button
                type="button"
                onClick={() => void cancel()}
                className="inline-flex items-center gap-2 rounded border border-line px-3 py-1.5 text-[12px] text-subtle hover:text-ink"
              >
                <Trash2 size={14} aria-hidden /> Discard this batch
              </button>
              {!canCommit && (
                <span
                  data-testid="commit-blocked-reason"
                  className="text-[11px] text-subtle"
                >
                  {unresolved.length > 0
                    ? "Resolve every conflict before committing."
                    : "Fix the validation errors in the source and re-import."}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ConflictRow({
  item,
  onResolve,
}: {
  item: LiveKnowledgeImportPreview["items"][number];
  onResolve: (
    id: string,
    resolution: "keep_existing" | "take_incoming" | "skip",
    note: string,
  ) => void | Promise<void>;
}) {
  const [note, setNote] = useState("");
  return (
    <li className="rounded border border-line bg-surface p-2.5">
      <p className="text-[12px] font-medium text-ink">
        Row {item.sourceRowNumber ?? "?"} — {item.displayName}
      </p>
      <p className="mt-1 text-[11.5px] leading-[1.5] text-subtle">
        {item.conflictReason}
      </p>
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Why is this the right decision?"
        aria-label={`Reason for resolving row ${item.sourceRowNumber ?? ""}`}
        className="mt-2 w-full rounded border border-line bg-sunken px-2 py-1 text-[11.5px] text-ink"
      />
      <div className="mt-2 flex flex-wrap gap-1.5">
        {(
          [
            ["take_incoming", "Use this row"],
            ["keep_existing", "Keep what exists"],
            ["skip", "Skip this row"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            disabled={!note.trim()}
            onClick={() => void onResolve(item.id, value, note.trim())}
            className={cn(
              "rounded border px-2 py-1 text-[11px]",
              note.trim()
                ? "border-line text-ink hover:border-action"
                : "cursor-not-allowed border-line text-subtle",
            )}
          >
            {label}
          </button>
        ))}
        {!note.trim() && (
          <span className="self-center text-[10.5px] text-subtle">
            A reason is required.
          </span>
        )}
      </div>
    </li>
  );
}
