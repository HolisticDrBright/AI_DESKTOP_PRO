"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Copy,
  FileDiff,
  FilePlus2,
  Layers,
  RefreshCw,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import type {
  LiveProtocolTemplate,
  LiveProtocolTemplateDetail,
  LiveTemplateComparison,
} from "@/adapters/live-types";
import { liveClient } from "@/adapters/live-client";
import { api } from "@/adapters";
import { cn } from "@/lib/cn";

/**
 * Protocol templates: create, duplicate, review, publish, supersede, compare,
 * and preview what a patient would actually read.
 *
 * TWO THINGS THIS SURFACE REFUSES TO SOFTEN.
 *
 * 1. An unsourced dose blocks publication. The banner says so, and the button
 *    is disabled — but the DATABASE is what refuses, so this is a description
 *    of a real constraint rather than a UI convention. If the button were
 *    somehow enabled, publishing would still fail, loudly.
 *
 * 2. The patient-instruction preview shows only what was recorded. An item
 *    with no dose shows no dose. It is never filled in with something
 *    plausible to make the sheet look finished, because a patient cannot tell
 *    a real instruction from a tidy-looking guess.
 *
 * Superseding is offered instead of deleting. Protocols already started from a
 * template must keep resolving, so a superseded template stays readable and
 * simply stops being offered as a starting point.
 */
export function ProtocolTemplateCenter() {
  const [templates, setTemplates] = useState<LiveProtocolTemplate[] | null>(null);
  const [detail, setDetail] = useState<LiveProtocolTemplateDetail | null>(null);
  const [comparison, setComparison] = useState<LiveTemplateComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");
  const [safetyNote, setSafetyNote] = useState("");
  const [safetyOutcome, setSafetyOutcome] =
    useState<"passed" | "concerns" | "blocked">("passed");
  const [supersedeWith, setSupersedeWith] = useState("");
  const [supersedeReason, setSupersedeReason] = useState("");

  const loadList = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setTemplates(await api.protocols.listTemplates());
    } catch (e) {
      // Named rather than rendered as an empty library: "no templates" and
      // "the backend is unreachable" must never look the same.
      setTemplates(null);
      setError(
        e instanceof Error ? e.message : "The template library could not be loaded.",
      );
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const openDetail = useCallback(async (templateId: string) => {
    setError(null);
    setNotice(null);
    setComparison(null);
    setSafetyNote("");
    setSupersedeWith("");
    setSupersedeReason("");
    try {
      setDetail(await liveClient.protocolTemplateDetail({ templateId }));
    } catch (e) {
      setDetail(null);
      setError(e instanceof Error ? e.message : "That template could not be read.");
    }
  }, []);

  const act = useCallback(
    async (fn: () => Promise<unknown>, ok: string) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        await fn();
        // Refresh BEFORE announcing: `openDetail` clears the notice, so
        // setting it first made the confirmation vanish the instant it
        // appeared.
        await loadList();
        if (detail) await openDetail(detail.templateId);
        setNotice(ok);
      } catch (e) {
        setError(e instanceof Error ? e.message : "That action was refused.");
      } finally {
        setBusy(false);
      }
    },
    [detail, loadList, openDetail],
  );

  const blocked = (detail?.unsourcedDoseCount ?? 0) > 0;

  return (
    <div data-testid="template-center" className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex-1 min-w-[200px]">
          <label
            htmlFor="template-name"
            className="block text-[11px] font-bold text-subtle"
          >
            New template name
          </label>
          <input
            id="template-name"
            data-testid="template-name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="mt-1 h-9 w-full rounded border border-line bg-surface px-2 text-[12px]"
          />
        </div>
        <button
          data-testid="template-create"
          disabled={busy || !newName.trim()}
          onClick={() =>
            void act(async () => {
              await api.protocols.templates.create({ name: newName });
              setNewName("");
            }, "Template created as a draft. Publish it when every dose names a source.")
          }
          className="inline-flex h-9 items-center gap-1.5 rounded bg-action px-3 text-[11.5px] font-bold text-on-action disabled:opacity-50"
        >
          <FilePlus2 size={13} aria-hidden /> Create
        </button>
        <button
          data-testid="template-refresh"
          onClick={() => void loadList()}
          disabled={busy}
          className="inline-flex h-9 items-center gap-1.5 rounded border border-line px-3 text-[11.5px] font-bold disabled:opacity-50"
        >
          <RefreshCw size={13} aria-hidden /> Refresh
        </button>
      </div>

      {error ? (
        <p
          data-testid="template-error"
          role="alert"
          className="rounded border border-danger/25 bg-danger-tint p-3 text-[12px] text-danger"
        >
          {error}
        </p>
      ) : null}
      {notice ? (
        <p
          data-testid="template-notice"
          role="status"
          className="rounded border border-ok/25 bg-ok-tint p-3 text-[12px] text-ok"
        >
          {notice}
        </p>
      ) : null}

      {/*
        Never an unexplained blank. Before this, a pending or hanging load
        rendered nothing at all — no list, no empty state, no error — which
        reads as "there is nothing here" while the truth is "nobody knows yet".
      */}
      {!templates && !error ? (
        <p
          data-testid="template-loading"
          role="status"
          className="rounded border border-line bg-sunken p-4 text-[12px] text-subtle"
        >
          Loading the template library…
        </p>
      ) : null}

      {templates ? (
        templates.length === 0 ? (
          <p
            data-testid="template-empty"
            className="rounded border border-line bg-sunken p-4 text-[12px] text-subtle"
          >
            No protocol templates yet. Templates are authored here — none are
            supplied, because a template nobody wrote is a clinical
            recommendation nobody made.
          </p>
        ) : (
          <ul data-testid="template-rows" className="space-y-1.5">
            {templates.map((t) => (
              <li key={t.id}>
                <button
                  data-template-id={t.id}
                  onClick={() => void openDetail(t.id)}
                  className="flex w-full items-center gap-3 rounded border border-line bg-surface px-3 py-2 text-left hover:border-action"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-bold text-ink">
                      {t.name}
                    </span>
                    <span className="block truncate text-[11px] text-subtle">
                      {t.status}
                    </span>
                  </span>
                  <Layers size={13} aria-hidden className="text-subtle" />
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}

      {detail ? (
        <section
          data-testid="template-detail"
          aria-labelledby="template-detail-heading"
          className="rounded border border-line bg-surface p-4"
        >
          <div className="mb-2 flex items-start justify-between gap-3">
            <h3 id="template-detail-heading" className="text-[13px] font-bold text-ink">
              {detail.name}
              <span className="ml-1.5 text-[11px] font-normal text-subtle">
                {detail.status}
              </span>
            </h3>
            <button
              data-testid="template-close"
              onClick={() => setDetail(null)}
              className="rounded border border-line px-2 py-1 text-[11px] font-bold"
            >
              Close
            </button>
          </div>

          {detail.supersededById ? (
            <p
              data-testid="template-superseded"
              className="mb-3 rounded border border-line bg-sunken p-2.5 text-[11.5px] text-subtle"
            >
              Superseded. Still readable because protocols already started from
              it must keep resolving. Reason: {detail.supersededReason}
            </p>
          ) : null}

          <p
            data-testid="template-safety-notice"
            className={cn(
              "mb-3 flex items-start gap-1.5 rounded border p-2.5 text-[11.5px]",
              blocked
                ? "border-danger/25 bg-danger-tint text-danger"
                : "border-ok/25 bg-ok-tint text-ok",
            )}
          >
            {blocked ? (
              <AlertTriangle size={13} aria-hidden className="mt-px shrink-0" />
            ) : (
              <ShieldCheck size={13} aria-hidden className="mt-px shrink-0" />
            )}
            {detail.safetyNotice}
          </p>

          <section aria-labelledby="template-items-heading" className="mb-3">
            <h4
              id="template-items-heading"
              className="mb-1 text-[11px] font-bold uppercase tracking-wide text-subtle"
            >
              Items
            </h4>
            <ul data-testid="template-items" className="space-y-1">
              {detail.items.map((it) => (
                <li
                  key={it.itemId}
                  className="rounded border border-line px-2.5 py-1.5 text-[11.5px]"
                >
                  <span className="font-bold text-ink">{it.label}</span>
                  <span className="text-subtle"> · {it.kind}</span>
                  <p className="mt-0.5 text-subtle">
                    Dose: {it.dosageText ?? "Unknown"} · Source:{" "}
                    {it.doseSourceKind ? (
                      it.doseSourceRef ?? it.doseSourceKind
                    ) : (
                      <span data-testid={`unsourced-${it.itemId}`} className="text-danger">
                        none recorded
                      </span>
                    )}
                  </p>
                  {it.stoppingRules.length ? (
                    <p className="mt-0.5 text-subtle">
                      Stop if: {it.stoppingRules.join("; ")}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>

          <div className="mb-3 flex flex-wrap gap-2">
            <button
              data-testid="template-duplicate"
              disabled={busy || !detail.currentVersionId}
              onClick={() =>
                void act(
                  () =>
                    api.protocols.templates.create({
                      name: `${detail.name} (copy)`,
                      fromVersionId: detail.currentVersionId,
                    }),
                  "Duplicated. The copy is a separate draft; editing it never changes the original.",
                )
              }
              className="inline-flex h-8 items-center gap-1.5 rounded border border-line px-3 text-[11.5px] font-bold disabled:opacity-50"
            >
              <Copy size={13} aria-hidden /> Duplicate
            </button>
            <button
              data-testid="template-publish"
              disabled={busy || blocked || !detail.currentVersionId}
              onClick={() =>
                void act(
                  () =>
                    api.protocols.templates.approve(detail.currentVersionId!),
                  "Published. The version is now immutable.",
                )
              }
              className="inline-flex h-8 items-center gap-1.5 rounded bg-action px-3 text-[11.5px] font-bold text-on-action disabled:opacity-50"
            >
              <ShieldCheck size={13} aria-hidden /> Publish
            </button>
            {detail.versions.length >= 2 ? (
              <button
                data-testid="template-compare"
                disabled={busy}
                onClick={() =>
                  void (async () => {
                    setError(null);
                    try {
                      setComparison(
                        await liveClient.protocolTemplateCompare({
                          leftVersionId: detail.versions[1].versionId,
                          rightVersionId: detail.versions[0].versionId,
                        }),
                      );
                    } catch (e) {
                      setError(
                        e instanceof Error ? e.message : "Compare was refused.",
                      );
                    }
                  })()
                }
                className="inline-flex h-8 items-center gap-1.5 rounded border border-line px-3 text-[11.5px] font-bold disabled:opacity-50"
              >
                <FileDiff size={13} aria-hidden /> Compare last two
              </button>
            ) : null}
          </div>

          {blocked ? (
            <p
              data-testid="publish-blocked-reason"
              className="mb-3 text-[11.5px] text-danger"
            >
              Publication is blocked while any dose has no recorded source.
              Record an exact product label, a supplied practitioner protocol,
              or a governed reference against each one.
            </p>
          ) : null}

          {comparison ? (
            <section
              data-testid="template-comparison"
              aria-labelledby="comparison-heading"
              className="mb-3 rounded border border-line bg-sunken p-3"
            >
              <h4 id="comparison-heading" className="mb-1 text-[11.5px] font-bold text-ink">
                Comparison
              </h4>
              <p data-testid="dose-change-count" className="text-[11.5px]">
                Dose changes: {comparison.doseChangeCount}
              </p>
              {comparison.changed.map((c) => (
                <p key={c.label} className="mt-1 text-[11.5px] text-subtle">
                  <span className="font-bold text-ink">{c.label}</span>:{" "}
                  {String(c.from.dosageText ?? "Unknown")} →{" "}
                  {String(c.to.dosageText ?? "Unknown")}
                </p>
              ))}
              {comparison.added.map((a) => (
                <p key={a.label} className="mt-1 text-[11.5px] text-ok">
                  Added: {a.label}
                </p>
              ))}
              {comparison.removed.map((r) => (
                <p key={r.label} className="mt-1 text-[11.5px] text-subtle">
                  Removed: {r.label}
                </p>
              ))}
              <p data-testid="comparison-match-note" className="mt-2 text-[11px] text-subtle">
                {comparison.matchNote}
              </p>
            </section>
          ) : null}

          <section aria-labelledby="safety-review-heading" className="mb-3">
            <h4
              id="safety-review-heading"
              className="mb-1 text-[11px] font-bold uppercase tracking-wide text-subtle"
            >
              Safety review
            </h4>
            <ul data-testid="safety-reviews" className="mb-2 space-y-1">
              {detail.safetyReviews.length === 0 ? (
                <li className="text-[11.5px] italic text-subtle">
                  No safety review recorded yet.
                </li>
              ) : (
                detail.safetyReviews.map((s) => (
                  <li
                    key={s.reviewId}
                    className="rounded border border-line px-2.5 py-1.5 text-[11.5px]"
                  >
                    <span className="font-bold text-ink">{s.outcome}</span> ·{" "}
                    {s.unsourcedDoseCount} unsourced at review time
                    <p className="mt-0.5 text-subtle">{s.note}</p>
                  </li>
                ))
              )}
            </ul>
            <label htmlFor="safety-outcome" className="block text-[11px] font-bold text-subtle">
              Outcome
            </label>
            <select
              id="safety-outcome"
              data-testid="safety-outcome"
              value={safetyOutcome}
              onChange={(e) =>
                setSafetyOutcome(e.target.value as "passed" | "concerns" | "blocked")
              }
              className="mt-1 h-8 rounded border border-line bg-surface px-2 text-[12px]"
            >
              <option value="passed">passed</option>
              <option value="concerns">concerns</option>
              <option value="blocked">blocked</option>
            </select>
            <label
              htmlFor="safety-note"
              className="mt-2 block text-[11px] font-bold text-subtle"
            >
              What did you check?
            </label>
            <textarea
              id="safety-note"
              data-testid="safety-note"
              value={safetyNote}
              onChange={(e) => setSafetyNote(e.target.value)}
              rows={2}
              className="mt-1 w-full rounded border border-line bg-surface p-2 text-[12px]"
            />
            <button
              data-testid="safety-record"
              disabled={busy || !safetyNote.trim() || !detail.currentVersionId}
              onClick={() =>
                void act(
                  () =>
                    liveClient.protocolTemplateSafetyReview({
                      versionId: detail.currentVersionId!,
                      outcome: safetyOutcome,
                      note: safetyNote,
                    }),
                  "Safety review recorded. It cannot be edited — a changed conclusion is a new review.",
                )
              }
              className="mt-1.5 inline-flex h-8 items-center gap-1.5 rounded border border-line px-3 text-[11.5px] font-bold disabled:opacity-50"
            >
              <ShieldCheck size={13} aria-hidden /> Record review
            </button>
          </section>

          <section aria-labelledby="supersede-heading" className="mb-3">
            <h4
              id="supersede-heading"
              className="mb-1 text-[11px] font-bold uppercase tracking-wide text-subtle"
            >
              Supersede
            </h4>
            <p className="mb-1.5 text-[11.5px] text-subtle">
              Points this template at a newer one. It is never deleted —
              protocols already started from it have to keep resolving.
            </p>
            <label htmlFor="supersede-with" className="block text-[11px] font-bold text-subtle">
              Successor template id
            </label>
            <input
              id="supersede-with"
              data-testid="supersede-with"
              value={supersedeWith}
              onChange={(e) => setSupersedeWith(e.target.value)}
              className="mt-1 h-8 w-full rounded border border-line bg-surface px-2 text-[12px]"
            />
            <label
              htmlFor="supersede-reason"
              className="mt-2 block text-[11px] font-bold text-subtle"
            >
              Reason
            </label>
            <input
              id="supersede-reason"
              data-testid="supersede-reason"
              value={supersedeReason}
              onChange={(e) => setSupersedeReason(e.target.value)}
              className="mt-1 h-8 w-full rounded border border-line bg-surface px-2 text-[12px]"
            />
            <button
              data-testid="supersede-submit"
              disabled={busy || !supersedeWith.trim() || !supersedeReason.trim()}
              onClick={() =>
                void act(
                  () =>
                    liveClient.protocolTemplateSupersede({
                      templateId: detail.templateId,
                      successorTemplateId: supersedeWith.trim(),
                      reason: supersedeReason,
                    }),
                  "Superseded. The template stays readable and is no longer offered as a starting point.",
                )
              }
              className="mt-1.5 inline-flex h-8 items-center gap-1.5 rounded border border-line px-3 text-[11.5px] font-bold disabled:opacity-50"
            >
              Supersede
            </button>
          </section>

          <section
            data-testid="patient-preview"
            aria-labelledby="patient-preview-heading"
            className="rounded border border-line bg-sunken p-3"
          >
            <h4
              id="patient-preview-heading"
              className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-subtle"
            >
              <UserRound size={12} aria-hidden /> Patient instruction preview
            </h4>
            <p
              data-testid="patient-preview-notice"
              className="mb-2 text-[11.5px] text-subtle"
            >
              {detail.previewNotice}
            </p>
            {detail.patientInstructionPreview.length === 0 ? (
              <p className="text-[11.5px] italic text-subtle">
                Nothing to show yet.
              </p>
            ) : (
              <ul data-testid="patient-preview-rows" className="space-y-1">
                {detail.patientInstructionPreview.map((p) => (
                  <li
                    key={p.label}
                    className="rounded border border-line bg-surface px-2.5 py-1.5 text-[11.5px]"
                  >
                    <span className="font-bold text-ink">{p.label}</span>
                    {/*
                      No dose recorded means no dose shown. Never a plausible
                      default: a patient cannot tell a real instruction from a
                      tidy-looking guess.
                    */}
                    {p.dose ? <span className="text-ink"> — {p.dose}</span> : null}
                    {p.timing ? (
                      <span className="text-subtle"> ({p.timing})</span>
                    ) : null}
                    {p.stopIf.length ? (
                      <p className="mt-0.5 text-subtle">
                        Stop and contact the clinic if: {p.stopIf.join("; ")}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </section>
      ) : null}
    </div>
  );
}
