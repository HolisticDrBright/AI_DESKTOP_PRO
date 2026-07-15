"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CircleAlert, FileText, Plus, RotateCw, Save, X } from "lucide-react";
import { api } from "@/adapters";
import type { ComposerContext } from "@/adapters/composer.mock";
import { DRAFT_KINDS } from "@/adapters/composer.mock";
import type { ComposerDraft, DraftKind, ProvenanceData } from "@/adapters/types";
import { cn } from "@/lib/cn";
import { useFeedback } from "@/lib/feedback";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Provenance } from "@/components/ui/Provenance";

/**
 * Practitioner note / report composer.
 *
 * Opens as a right-hand drawer from any review action (Add to note, Insert
 * into report, Message patient). Drafts are produced by the MOCK generator
 * (`api.composer.generate`) and are **never final** — approval is an explicit
 * step, and patient-facing drafts require a confirmation before they could be
 * sent. No real persistence: Save/Approve announce their outcome only.
 */

interface ComposerValue {
  openComposer: (kind: DraftKind, context: ComposerContext) => void;
}

const Ctx = createContext<ComposerValue | null>(null);

export function ComposerProvider({ children }: { children: ReactNode }) {
  const { announce } = useFeedback();
  const [open, setOpen] = useState(false);
  const [context, setContext] = useState<ComposerContext | null>(null);
  const [kind, setKind] = useState<DraftKind>("soap-note");
  const [draft, setDraft] = useState<ComposerDraft | null>(null);
  const [bodyText, setBodyText] = useState("");
  const [loading, setLoading] = useState(false);
  const [approved, setApproved] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const generate = useCallback(
    async (k: DraftKind, ctx: ComposerContext) => {
      setLoading(true);
      setApproved(false);
      const d = await api.composer.generate(k, ctx);
      setDraft(d);
      setBodyText(d.body);
      setLoading(false);
    },
    [],
  );

  const openComposer = useCallback(
    (k: DraftKind, ctx: ComposerContext) => {
      setContext(ctx);
      setKind(k);
      setOpen(true);
      void generate(k, ctx);
    },
    [generate],
  );

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    headingRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const changeKind = (k: DraftKind) => {
    if (!context) return;
    setKind(k);
    void generate(k, context);
  };

  const insertEvidence = () => {
    setBodyText(
      (t) =>
        t +
        `\n\n[Evidence inserted ${new Date().toISOString().slice(0, 10)}]\n  • Supporting finding to confirm against source record.`,
    );
    announce("Evidence block inserted into the draft.");
  };

  const doApprove = () => {
    setApproved(true);
    setConfirming(false);
    announce(
      draft?.patientFacing
        ? `Approved for release — ${draft?.title}. (demo — not persisted)`
        : `Draft approved — ${draft?.title}. (demo — not persisted)`,
    );
  };

  const onApproveClick = () => {
    if (draft?.patientFacing) setConfirming(true);
    else doApprove();
  };

  const value = useMemo(() => ({ openComposer }), [openComposer]);

  const provenance: ProvenanceData | null = draft
    ? {
        sourceType: "ai-inference",
        sourceName: "Draft generated for review",
        dateRange: draft.dateRange,
        review: approved ? "reviewed" : "not-reviewed",
      }
    : null;

  return (
    <Ctx.Provider value={value}>
      {children}
      {open && (
        <aside
          role="dialog"
          aria-label="Note and report composer"
          className="glass-overlay animate-fade-up fixed top-3 right-3 bottom-3 z-[95] flex w-[452px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-[20px] border border-[rgba(255,255,255,0.7)] bg-[rgba(255,255,255,0.94)] shadow-[0_20px_56px_rgba(24,42,61,0.2)] outline-1 outline-[rgba(203,214,224,0.6)]"
        >
          <div className="h-[3px] shrink-0 bg-[linear-gradient(90deg,#2563C7,#5B8AD9)]" />

          <div className="flex items-start gap-[9px] border-b border-hairline px-4 pt-[14px] pb-3">
            <span className="mt-px flex h-7 w-7 items-center justify-center rounded-lg bg-action-tint">
              <FileText size={14} strokeWidth={1.75} className="text-action" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <h2
                ref={headingRef}
                tabIndex={-1}
                className="m-0 text-[14px] font-bold outline-none"
              >
                Composer
              </h2>
              <div className="truncate text-[11px] text-subtle">
                {context ? `${context.patientName} · ${context.subjectLabel}` : "Draft"}
              </div>
            </div>
            <button
              onClick={close}
              aria-label="Close composer"
              className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg border-none bg-transparent text-faint hover:bg-[rgba(90,107,126,0.1)] hover:text-ink focus-visible:outline-2 focus-visible:outline-action"
            >
              <X size={14} strokeWidth={2} aria-hidden />
            </button>
          </div>

          {/* Draft-type selector */}
          <div className="shrink-0 border-b border-hairline px-3 py-[10px]">
            <div className="mb-[7px] px-1 text-[10.5px] font-bold tracking-[0.05em] text-faint uppercase">
              Draft type
            </div>
            <div
              className="flex flex-wrap gap-[5px]"
              role="group"
              aria-label="Draft type"
            >
              {DRAFT_KINDS.map((d) => {
                const active = d.kind === kind;
                return (
                  <button
                    key={d.kind}
                    onClick={() => changeKind(d.kind)}
                    aria-pressed={active}
                    title={d.blurb}
                    className={cn(
                      "flex items-center gap-[5px] rounded-[7px] border px-[9px] py-[5px] text-[11px] font-semibold focus-visible:outline-2 focus-visible:outline-action",
                      active
                        ? "border-action bg-action-tint text-action-deep"
                        : "border-line bg-card text-body-2 hover:border-line-hover",
                    )}
                  >
                    {d.label}
                    {d.patientFacing && (
                      <span className="rounded-[3px] bg-teal-tint px-[4px] py-px text-[8.5px] font-bold text-teal">
                        Patient
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-[13px]">
            {/* Status: never final until approved */}
            <div className="mb-[10px] flex items-center gap-2">
              <span
                className={cn(
                  "rounded-full px-[9px] py-[2px] text-[10.5px] font-bold",
                  approved
                    ? "bg-positive-tint text-positive"
                    : "bg-warning-tint text-warning-deep",
                )}
              >
                {approved ? "Approved (demo)" : "Draft — not final"}
              </span>
              <span className="text-[10.5px] text-faint">
                AI-drafted · requires practitioner review
              </span>
            </div>

            {provenance && <Provenance data={provenance} className="mb-[11px]" />}

            {/* Sources + missing info */}
            {draft && (
              <div className="mb-[11px] grid grid-cols-2 gap-3">
                <div>
                  <div className="mb-[5px] text-[10px] font-bold tracking-[0.05em] text-faint uppercase">
                    Sources
                  </div>
                  <ul className="m-0 flex list-none flex-col gap-1 p-0">
                    {draft.sources.map((s) => (
                      <li key={s} className="text-[11px] leading-[1.35] text-muted">
                        {s}
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <div className="mb-[5px] text-[10px] font-bold tracking-[0.05em] text-faint uppercase">
                    Missing / to confirm
                  </div>
                  <ul className="m-0 flex list-none flex-col gap-1 p-0">
                    {draft.missingInfo.map((s) => (
                      <li
                        key={s}
                        className="flex items-start gap-[5px] text-[11px] leading-[1.35] text-warning-deep"
                      >
                        <CircleAlert size={11} strokeWidth={2} className="mt-[2px] shrink-0" aria-hidden />
                        {s}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            <label htmlFor="composer-body" className="mb-[5px] block text-[10px] font-bold tracking-[0.05em] text-faint uppercase">
              Draft
            </label>
            <textarea
              id="composer-body"
              value={loading ? "Generating draft…" : bodyText}
              onChange={(e) => setBodyText(e.target.value)}
              disabled={loading}
              spellCheck
              className="h-[280px] w-full resize-none rounded-[10px] border border-line bg-card p-3 font-mono text-[12px] leading-[1.55] text-body outline-none focus-visible:border-action focus-visible:outline-2 focus-visible:outline-action"
            />
          </div>

          <div className="shrink-0 border-t border-hairline bg-[rgba(247,250,252,0.7)] px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => context && generate(kind, context)}
                disabled={loading}
                className="flex h-[30px] cursor-pointer items-center gap-[5px] rounded-lg border border-line bg-card px-[10px] text-[12px] font-semibold text-body hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action disabled:opacity-50"
              >
                <RotateCw size={12} strokeWidth={2} aria-hidden />
                Regenerate
              </button>
              <button
                onClick={insertEvidence}
                disabled={loading}
                className="flex h-[30px] cursor-pointer items-center gap-[5px] rounded-lg border border-line bg-card px-[10px] text-[12px] font-semibold text-body hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action disabled:opacity-50"
              >
                <Plus size={12} strokeWidth={2} aria-hidden />
                Insert evidence
              </button>
              <div className="flex-1" />
              <button
                onClick={() => announce(`Draft saved — ${draft?.title}. (demo — not persisted)`)}
                disabled={loading}
                className="flex h-[30px] cursor-pointer items-center gap-[5px] rounded-lg border border-line bg-card px-[10px] text-[12px] font-semibold text-body hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action disabled:opacity-50"
              >
                <Save size={12} strokeWidth={2} aria-hidden />
                Save draft
              </button>
              <button
                onClick={onApproveClick}
                disabled={loading || approved}
                className="h-[30px] cursor-pointer rounded-lg border-none bg-action px-[14px] text-[12px] font-semibold text-white hover:bg-action-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-50"
              >
                {approved ? "Approved" : draft?.patientFacing ? "Review & approve" : "Approve"}
              </button>
            </div>
          </div>
        </aside>
      )}

      {confirming && (
        <ConfirmDialog
          open
          title="Approve patient-facing content?"
          body="This draft is written for the patient. Approving records your review; it is not sent automatically in this demo."
          confirmLabel="Approve for release"
          onCancel={() => setConfirming(false)}
          onConfirm={doApprove}
        />
      )}
    </Ctx.Provider>
  );
}

export function useComposer(): ComposerValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useComposer must be used within ComposerProvider");
  return ctx;
}

/** Non-throwing variant for components that may render outside the provider. */
export function useComposerOptional(): ComposerValue | null {
  return useContext(Ctx);
}
