"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, BookOpenCheck, RefreshCw, ShieldAlert, Sparkles } from "lucide-react";
import { Card } from "@/components/ui/bits";

/**
 * Differential questions + clinical lens engine panel (Milestone 2).
 *
 * QUESTION-FOCUSED: this panel surfaces questions, considerations, missing
 * information, conflicts, and safety observations — never diagnoses,
 * treatment plans, dosing, or patient-facing recommendations.
 *
 * The INVARIANT CORE section renders only from the evaluation's invariant
 * core and is identical under every paradigm; a lens changes framing and
 * the ranking of NON-urgent material only. Urgency and status are always
 * conveyed with words and icons, never color alone. Model confidence is
 * never displayed as a clinical probability — only deterministic validation
 * results are shown. Accepting a question NEVER writes into a note;
 * "Add to note" is the separate, explicit, audited action.
 */

interface ParadigmInfo {
  code: string;
  name: string;
  description: string;
  isComposite: boolean;
  composedOf: string[];
}
interface DomainInfo {
  code: string;
  version: number;
  name: string;
}
interface KnowledgeSource {
  id: string;
  code: string;
  revision: number;
  citation: string;
  publisher: string | null;
  releaseDate: string | null;
  intendedPurpose: string | null;
  intendedPopulation: string | null;
  logicSummary: string | null;
  knownLimitations: string | null;
  outOfScopeUses: string | null;
  validationStatus: string;
  fundingConflicts: string | null;
}
interface AiStatus {
  mode: "fixture" | "live";
  available: boolean;
  liveConfigured: boolean;
  reason: string | null;
}

interface RedFlag {
  code: string;
  label: string;
  urgent: boolean;
  domainCode: string;
}
interface InvariantCore {
  objectiveFacts?: { fact: string; sourceRef: string }[];
  provenance?: unknown[];
  missingInformation?: string[];
  conflicts?: { description: string }[];
  allergies?: { allergen: string; reaction: string | null; severity: string | null }[];
  interactions?: { pair: [string, string]; concern: string }[];
  criticalLabs?: { name: string; value: string; concern: string }[];
  redFlags?: RedFlag[];
  emergencyConsiderations?: string[];
  evidenceQuality?: Record<string, string>;
  limitations?: string[];
}
interface LensFraming {
  paradigm?: string;
  ranking?: { domainCode: string; sourceLens: string; note?: string }[];
  terminology?: { term: string; framedAs: string; note: string }[];
  framingNotes?: string[];
  compositionConflicts?: {
    domainCode: string;
    positions: { lens: string; rank: number }[];
    resolution: string;
  }[];
}

interface LensQuestion {
  id: string;
  domainCode: string;
  questionText: string;
  rationale: string;
  distinguishes: unknown[];
  safetyRelation: string | null;
  priority: string;
  answerType: string;
  patientSources: unknown[];
  knowledgeSourceIds: string[];
  missingDataAssumptions: unknown[];
  generationMethod: string;
  generationVersion: string;
  status: string;
  statusReason: string | null;
}
interface SafetyBlock {
  id: string;
  ruleCode: string;
  detail: Record<string, unknown>;
  createdAt: string;
  reviewedAt: string | null;
  resolution: string | null;
}
interface Evaluation {
  evaluationId: string;
  paradigm: string;
  status: "complete" | "blocked";
  invariantCore: InvariantCore;
  lensFraming: LensFraming;
  inputSnapshot: { counts?: Record<string, number>; demographicsPresent?: Record<string, boolean> };
  inputCutoffAt: string;
  ruleSetVersion: string;
  model: string | null;
  provider: string | null;
  promptTemplateVersion: string | null;
  outputSchemaVersion: string;
  outputSha256: string;
  validationResult: Record<string, unknown> | null;
  stale: boolean;
  staleReason: string | null;
  createdAt: string;
  questions: LensQuestion[];
  safetyBlocks: SafetyBlock[];
}
interface Meta {
  paradigms: ParadigmInfo[];
  domains: DomainInfo[];
  knowledgeSources: KnowledgeSource[];
  ai: AiStatus;
}
interface AnswerVersion {
  version: number;
  value: Record<string, unknown>;
  correctsVersion: number | null;
  correctionReason: string | null;
  answeredAt: string;
}

const FEEDBACK_KINDS = ["not_relevant", "incorrect", "duplicate", "unsafe", "other"] as const;
const FEEDBACK_LABEL: Record<string, string> = {
  helpful: "Helpful",
  not_relevant: "Not relevant",
  incorrect: "Incorrect",
  duplicate: "Duplicate",
  unsafe: "Unsafe",
  other: "Other",
};
const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const STATUS_LABEL: Record<string, string> = {
  suggested: "Suggested",
  accepted: "Accepted",
  asked: "Asked",
  answered: "Answered",
  deferred: "Deferred",
  skipped: "Skipped",
  dismissed: "Dismissed",
  superseded: "Superseded",
  stale: "Stale",
};

async function readError(res: Response): Promise<string> {
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  return json.error?.message ?? "Something went wrong. Please try again.";
}

const btn =
  "h-7 cursor-pointer rounded-md border border-line bg-card px-2 text-[11.5px] font-semibold text-body hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action disabled:cursor-not-allowed disabled:opacity-50";
const btnPrimary =
  "h-7 cursor-pointer rounded-md border-none bg-action px-2 text-[11.5px] font-semibold text-white hover:bg-action-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-50";
const chip =
  "rounded-md border border-line px-[6px] py-[1px] text-[10px] font-bold tracking-[0.03em] uppercase";

export function LensPanel({
  encounterId,
  activeDraftNoteId,
  onAddToNote,
}: {
  encounterId: string;
  /** The open draft/ready note that explicit add-to-note may write into (null = none). */
  activeDraftNoteId: string | null;
  onAddToNote: (payload: { questionId: string; text: string; label: string }) => void;
}) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [paradigm, setParadigm] = useState("western_conventional");
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [loadingEval, setLoadingEval] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expandedWhy, setExpandedWhy] = useState<string | null>(null);
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({});
  const [correcting, setCorrecting] = useState<Record<string, { value: string; reason: string }>>({});
  const [answerHistory, setAnswerHistory] = useState<Record<string, AnswerVersion[]>>({});
  const [dismissFor, setDismissFor] = useState<string | null>(null);
  const [dismissKind, setDismissKind] = useState<string>("not_relevant");
  const [dismissComment, setDismissComment] = useState("");
  const [blockResolution, setBlockResolution] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const liveRegion = useRef<HTMLParagraphElement | null>(null);

  const domainName = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of meta?.domains ?? []) m.set(d.code, d.name);
    return m;
  }, [meta]);
  const sourceById = useMemo(() => {
    const m = new Map<string, KnowledgeSource>();
    for (const s of meta?.knowledgeSources ?? []) m.set(s.id, s);
    return m;
  }, [meta]);

  useEffect(() => {
    let alive = true;
    fetch("/api/live/lens/meta")
      .then(async (res) => {
        if (!res.ok) throw new Error(await readError(res));
        return res.json() as Promise<{ data: Meta }>;
      })
      .then((json) => {
        if (alive) setMeta(json.data);
      })
      .catch((e: Error) => {
        if (alive) setMetaError(e.message);
      });
    return () => {
      alive = false;
    };
  }, []);

  const loadEvaluation = useCallback(
    async (p: string) => {
      setLoadingEval(true);
      setError(null);
      try {
        const res = await fetch(`/api/live/lens/evaluation?encounterId=${encounterId}&paradigm=${p}`);
        if (!res.ok) {
          setError(await readError(res));
          setEvaluation(null);
          return;
        }
        const json = (await res.json()) as { data: Evaluation | null };
        setEvaluation(json.data);
      } catch {
        setError("The lens service is unreachable right now.");
      } finally {
        setLoadingEval(false);
      }
    },
    [encounterId],
  );

  useEffect(() => {
    void loadEvaluation(paradigm);
  }, [paradigm, loadEvaluation]);

  const runEvaluation = async () => {
    setRunning(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/live/lens/evaluation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ encounterId, paradigm }),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      const json = (await res.json()) as { data: { status: string; questionsInserted?: number; blockedRules?: number } };
      setNotice(
        json.data.status === "blocked"
          ? `Evaluation blocked by ${json.data.blockedRules ?? 0} safety rule(s) — output withheld for review.`
          : `Evaluation complete — ${json.data.questionsInserted ?? 0} question(s) generated.`,
      );
      await loadEvaluation(paradigm);
    } catch {
      setError("The lens service is unreachable right now.");
    } finally {
      setRunning(false);
    }
  };

  const questionAction = async (body: Record<string, unknown>, failLabel: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/live/lens/question", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(await readError(res));
        return false;
      }
      await loadEvaluation(paradigm);
      return true;
    } catch {
      setError(`${failLabel} — the lens service is unreachable.`);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const setStatus = (questionId: string, to: string) =>
    void questionAction({ action: "status", questionId, to }, "Could not update the question");

  const submitAnswer = async (q: LensQuestion) => {
    const text = (answerDrafts[q.id] ?? "").trim();
    if (!text) return;
    const ok = await questionAction(
      { action: "answer", questionId: q.id, value: { text } },
      "Could not record the answer",
    );
    if (ok) {
      setAnswerDrafts((d) => ({ ...d, [q.id]: "" }));
      setNotice("Answer recorded as a versioned observation.");
    }
  };

  const submitCorrection = async (q: LensQuestion) => {
    const c = correcting[q.id];
    if (!c || !c.value.trim()) return;
    const ok = await questionAction(
      { action: "correctAnswer", questionId: q.id, value: { text: c.value.trim() }, reason: c.reason.trim() || undefined },
      "Could not correct the answer",
    );
    if (ok) {
      setCorrecting((m) => {
        const next = { ...m };
        delete next[q.id];
        return next;
      });
      setAnswerHistory((h) => {
        const next = { ...h };
        delete next[q.id];
        return next;
      });
      setNotice("Correction recorded — the original answer version is preserved.");
    }
  };

  const loadAnswers = async (questionId: string) => {
    try {
      const res = await fetch(`/api/live/lens/question?questionId=${questionId}`);
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      const json = (await res.json()) as { data: AnswerVersion[] };
      setAnswerHistory((h) => ({ ...h, [questionId]: json.data }));
    } catch {
      setError("Could not load the answer history.");
    }
  };

  const confirmDismiss = async () => {
    if (!dismissFor) return;
    const ok = await questionAction(
      { action: "dismiss", questionId: dismissFor, feedbackKind: dismissKind, comment: dismissComment.trim() || undefined },
      "Could not dismiss the question",
    );
    if (ok) {
      setDismissFor(null);
      setDismissComment("");
      setDismissKind("not_relevant");
      setNotice("Question dismissed — feedback recorded.");
    }
  };

  const addToNote = async (q: LensQuestion) => {
    if (!activeDraftNoteId) return;
    const ok = await questionAction(
      { action: "noteUse", questionId: q.id, noteId: activeDraftNoteId },
      "Could not record the note use",
    );
    if (!ok) return;
    const latest = answerHistory[q.id]?.[answerHistory[q.id].length - 1];
    const answerText = latest ? String((latest.value as { text?: string }).text ?? "") : "";
    const text = `Differential question (${paradigmLabel(q)} · ${domainName.get(q.domainCode) ?? q.domainCode}): ${q.questionText}${answerText ? `\nAnswer: ${answerText}` : ""}`;
    onAddToNote({
      questionId: q.id,
      text,
      label: `Differential question — ${q.questionText.slice(0, 80)}`,
    });
    setNotice("Added to the open draft note (audited).");
  };

  const paradigmLabel = (q: LensQuestion) =>
    q.generationMethod === "ai_assisted" ? "AI-assisted" : evaluation?.paradigm ?? paradigm;

  const reviewBlock = async (blockId: string) => {
    const resolution = (blockResolution[blockId] ?? "").trim();
    if (!resolution) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/live/lens/safety", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ blockId, resolution }),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      setNotice("Safety block reviewed.");
      await loadEvaluation(paradigm);
    } catch {
      setError("Could not review the safety block.");
    } finally {
      setBusy(false);
    }
  };

  const core = evaluation?.invariantCore ?? null;
  const framing = evaluation?.lensFraming ?? null;
  const selectedParadigm = meta?.paradigms.find((p) => p.code === paradigm) ?? null;
  const urgentFlags = (core?.redFlags ?? []).filter((f) => f.urgent);
  const nonUrgentFlags = (core?.redFlags ?? []).filter((f) => !f.urgent);
  const sortedQuestions = useMemo(
    () =>
      [...(evaluation?.questions ?? [])].sort(
        (a, b) => (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9),
      ),
    [evaluation],
  );

  return (
    <Card className="mt-3 px-4 py-[14px] print:hidden">
      <div data-testid="lens-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <BookOpenCheck size={14} strokeWidth={2.2} aria-hidden className="text-brand" />
          <span className="text-[13px] font-bold text-ink">Differential questions & clinical lens</span>
        </div>
        <span className="text-[10.5px] font-semibold tracking-[0.02em] text-subtle uppercase">
          Questions & considerations only — no diagnoses, no treatment, no dosing
        </span>
      </div>

      {metaError && (
        <p role="alert" className="m-0 mt-2 rounded-lg bg-critical-tint px-3 py-[6px] text-[12px] font-medium text-critical">
          {metaError}
        </p>
      )}

      {/* paradigm + run controls */}
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor="lens-paradigm" className="mb-[4px] block text-[10px] font-bold tracking-[0.04em] text-faint uppercase">
            Clinical lens (paradigm)
          </label>
          <select
            id="lens-paradigm"
            data-testid="lens-paradigm"
            value={paradigm}
            onChange={(e) => {
              setParadigm(e.target.value);
              setNotice(null);
            }}
            className="h-8 rounded-lg border border-line bg-card px-2 text-[12px] text-body outline-none focus-visible:outline-2 focus-visible:outline-action"
          >
            {(meta?.paradigms ?? [{ code: "western_conventional", name: "Western conventional", description: "", isComposite: false, composedOf: [] }]).map((p) => (
              <option key={p.code} value={p.code}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          data-testid="run-evaluation"
          disabled={running || loadingEval}
          onClick={() => void runEvaluation()}
          className="flex h-8 cursor-pointer items-center gap-[6px] rounded-lg border-none bg-action px-3 text-[12px] font-semibold text-white hover:bg-action-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw size={12} strokeWidth={2.2} aria-hidden />
          {running ? "Running…" : evaluation ? "Re-run evaluation" : "Run evaluation"}
        </button>
        {selectedParadigm?.isComposite && (
          <span className="text-[11px] text-subtle">
            Transparent composition of: {selectedParadigm.composedOf.join(", ") || "member lenses"}.
          </span>
        )}
      </div>

      {/* AI posture — explicit, so the fixture can never pass as production AI */}
      {meta && (
        <p className="m-0 mt-2 flex items-start gap-[6px] text-[11.5px] text-body" data-testid="lens-ai-status">
          <Sparkles size={12} strokeWidth={2.2} aria-hidden className="mt-[2px] shrink-0 text-subtle" />
          <span>
            AI assistance: <strong>{meta.ai.mode}</strong>
            {meta.ai.available
              ? " — deterministic test provider (fixture-lens-1); runs through the same safety gates as every rule. Not the production AI."
              : ` — unavailable. ${meta.ai.reason ?? ""}`}
          </span>
        </p>
      )}

      {error && (
        <p role="alert" className="m-0 mt-2 rounded-lg bg-critical-tint px-3 py-[6px] text-[12px] font-semibold text-critical">
          {error}
        </p>
      )}
      {notice && (
        <p ref={liveRegion} role="status" className="m-0 mt-2 rounded-lg bg-positive-tint px-3 py-[6px] text-[12px] font-medium text-ink" data-testid="lens-notice">
          {notice}
        </p>
      )}

      {loadingEval && <p className="m-0 mt-3 text-[12px] text-subtle">Loading evaluation…</p>}

      {!loadingEval && !evaluation && (
        <p className="m-0 mt-3 text-[12.5px] text-subtle" data-testid="lens-empty">
          No evaluation has been run under this lens yet. Running one evaluates the chart, transcript,
          and labs deterministically and suggests differential questions for your review.
        </p>
      )}

      {evaluation && (
        <div className="mt-3">
          {/* stale banner — words + icon, never color alone */}
          {evaluation.stale && (
            <p
              role="status"
              data-testid="lens-stale"
              className="m-0 mb-2 flex items-start gap-[6px] rounded-lg border border-line bg-panel px-3 py-[8px] text-[12px] font-semibold text-body"
            >
              <AlertTriangle size={13} strokeWidth={2.2} aria-hidden className="mt-[1px] shrink-0" />
              <span>
                STALE — a supporting source changed ({evaluation.staleReason ?? "source updated"}) after this run.
                The output below is retained unchanged; re-run the evaluation to reflect the current record.
              </span>
            </p>
          )}

          {/* blocked banner */}
          {evaluation.status === "blocked" && (
            <p
              role="alert"
              data-testid="lens-blocked"
              className="m-0 mb-2 flex items-start gap-[6px] rounded-lg bg-critical-tint px-3 py-[8px] text-[12px] font-semibold text-critical"
            >
              <ShieldAlert size={13} strokeWidth={2.2} aria-hidden className="mt-[1px] shrink-0" />
              <span>
                BLOCKED — this evaluation failed one or more safety rules. Its question output was withheld
                (nothing was silently removed); review each failure below.
              </span>
            </p>
          )}

          {/* ---- invariant clinical core: identical under every lens ---- */}
          <section data-testid="lens-core" className="rounded-[12px] border border-line bg-panel p-3">
            <h3 className="m-0 text-[11px] font-bold tracking-[0.04em] text-faint uppercase">
              Invariant clinical core — identical under every lens
            </h3>
            <p className="m-0 mt-1 text-[11px] text-subtle">
              Computed before any paradigm framing. Guideline-oriented safety findings are always shown here,
              whichever lens is selected.
            </p>

            {urgentFlags.length > 0 && (
              <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0" data-testid="core-red-flags">
                {urgentFlags.map((f) => (
                  <li key={f.code} className="flex items-start gap-[6px] rounded-lg bg-critical-tint px-2 py-[6px] text-[12px] font-semibold text-critical">
                    <AlertTriangle size={13} strokeWidth={2.2} aria-hidden className="mt-[1px] shrink-0" />
                    <span>URGENT — {f.label}</span>
                  </li>
                ))}
              </ul>
            )}
            {nonUrgentFlags.map((f) => (
              <p key={f.code} className="m-0 mt-1 flex items-start gap-[6px] text-[12px] font-medium text-body">
                <AlertTriangle size={12} strokeWidth={2.2} aria-hidden className="mt-[2px] shrink-0 text-subtle" />
                <span>Safety context — {f.label}</span>
              </p>
            ))}
            {(core?.emergencyConsiderations ?? []).length > 0 && (
              <div className="mt-2">
                <div className="text-[10px] font-bold tracking-[0.04em] text-faint uppercase">Emergency considerations</div>
                <ul className="m-0 mt-1 list-disc pl-4 text-[11.5px] text-body">
                  {(core?.emergencyConsiderations ?? []).map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mt-2 grid grid-cols-2 gap-2 max-[900px]:grid-cols-1">
              {(core?.criticalLabs ?? []).length > 0 && (
                <div>
                  <div className="text-[10px] font-bold tracking-[0.04em] text-faint uppercase">Critical labs</div>
                  <ul className="m-0 mt-1 list-disc pl-4 text-[11.5px] text-body">
                    {(core?.criticalLabs ?? []).map((c, i) => (
                      <li key={i}>
                        <strong>{c.name} {c.value}</strong> — {c.concern}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {(core?.conflicts ?? []).length > 0 && (
                <div data-testid="core-conflicts">
                  <div className="text-[10px] font-bold tracking-[0.04em] text-faint uppercase">Conflicting chart data</div>
                  <ul className="m-0 mt-1 list-disc pl-4 text-[11.5px] text-body">
                    {(core?.conflicts ?? []).map((c, i) => (
                      <li key={i}>{c.description}</li>
                    ))}
                  </ul>
                </div>
              )}
              {(core?.interactions ?? []).length > 0 && (
                <div data-testid="core-interactions">
                  <div className="text-[10px] font-bold tracking-[0.04em] text-faint uppercase">Interaction cautions</div>
                  <ul className="m-0 mt-1 list-disc pl-4 text-[11.5px] text-body">
                    {(core?.interactions ?? []).map((c, i) => (
                      <li key={i}>
                        <strong>{c.pair[0]} + {c.pair[1]}</strong> — {c.concern}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {(core?.allergies ?? []).length > 0 && (
                <div>
                  <div className="text-[10px] font-bold tracking-[0.04em] text-faint uppercase">Allergies on record</div>
                  <ul className="m-0 mt-1 list-disc pl-4 text-[11.5px] text-body">
                    {(core?.allergies ?? []).map((a, i) => (
                      <li key={i}>
                        {a.allergen}
                        {a.reaction ? ` — ${a.reaction}` : ""}
                        {a.severity ? ` (${a.severity})` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {(core?.missingInformation ?? []).length > 0 && (
              <div className="mt-2" data-testid="core-missing">
                <div className="text-[10px] font-bold tracking-[0.04em] text-faint uppercase">Missing information</div>
                <ul className="m-0 mt-1 list-disc pl-4 text-[11.5px] text-body">
                  {(core?.missingInformation ?? []).map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                </ul>
              </div>
            )}

            <details className="mt-2">
              <summary className="cursor-pointer text-[11px] font-semibold text-action">
                Objective facts ({(core?.objectiveFacts ?? []).length}), evidence quality & limitations
              </summary>
              <ul className="m-0 mt-1 list-disc pl-4 text-[11.5px] text-body">
                {(core?.objectiveFacts ?? []).map((f, i) => (
                  <li key={i}>{f.fact}</li>
                ))}
              </ul>
              {Object.entries(core?.evidenceQuality ?? {}).map(([k, v]) => (
                <p key={k} className="m-0 mt-1 text-[11px] text-subtle">
                  <strong>{k}:</strong> {v}
                </p>
              ))}
              <ul className="m-0 mt-1 list-disc pl-4 text-[11px] text-subtle">
                {(core?.limitations ?? []).map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </details>
          </section>

          {/* ---- lens framing (non-urgent ranking + terminology only) ---- */}
          <section data-testid="lens-framing" className="mt-2 rounded-[12px] border border-line bg-card p-3">
            <h3 className="m-0 text-[11px] font-bold tracking-[0.04em] text-faint uppercase">
              Lens framing — {selectedParadigm?.name ?? evaluation.paradigm}
            </h3>
            {selectedParadigm?.description && (
              <p className="m-0 mt-1 text-[11px] text-subtle">{selectedParadigm.description}</p>
            )}
            <ol className="m-0 mt-2 flex list-none flex-col gap-[3px] p-0" data-testid="lens-ranking">
              {(framing?.ranking ?? []).map((r, i) => (
                <li key={r.domainCode} className="flex flex-wrap items-center gap-[6px] text-[11.5px] text-body">
                  <span className="w-4 text-right font-bold text-subtle">{i + 1}.</span>
                  <span className="font-semibold">{domainName.get(r.domainCode) ?? r.domainCode}</span>
                  <span className={chip} data-source-lens={r.sourceLens}>
                    {r.sourceLens === "invariant-core" ? "URGENT — pinned by core" : `from ${r.sourceLens}`}
                  </span>
                  {r.note && <span className="text-[10.5px] text-subtle">{r.note}</span>}
                </li>
              ))}
            </ol>
            {(framing?.terminology ?? []).length > 0 && (
              <div className="mt-2">
                <div className="text-[10px] font-bold tracking-[0.04em] text-faint uppercase">Terminology framing</div>
                {(framing?.terminology ?? []).map((t, i) => (
                  <p key={i} className="m-0 mt-1 text-[11.5px] text-body">
                    <strong>{t.term}</strong> framed as {t.framedAs} — {t.note}
                  </p>
                ))}
              </div>
            )}
            {(framing?.compositionConflicts ?? []).length > 0 && (
              <div className="mt-2" data-testid="composition-conflicts">
                <div className="text-[10px] font-bold tracking-[0.04em] text-faint uppercase">
                  Member-lens disagreements (resolved openly)
                </div>
                {(framing?.compositionConflicts ?? []).map((c, i) => (
                  <p key={i} className="m-0 mt-1 text-[11.5px] text-body">
                    <strong>{domainName.get(c.domainCode) ?? c.domainCode}:</strong>{" "}
                    {c.positions.map((p) => `${p.lens} ranks it #${p.rank + 1}`).join("; ")}. {c.resolution}
                  </p>
                ))}
              </div>
            )}
            {(framing?.framingNotes ?? []).map((n, i) => (
              <p key={i} className="m-0 mt-1 text-[10.5px] text-subtle">{n}</p>
            ))}
          </section>

          {/* ---- safety blocks (reviewable failures) ---- */}
          {evaluation.safetyBlocks.length > 0 && (
            <section className="mt-2" data-testid="safety-blocks">
              {evaluation.safetyBlocks.map((b) => (
                <div key={b.id} className="mt-1 rounded-[12px] border border-[rgba(191,70,52,0.4)] bg-critical-tint p-3" data-testid="safety-block">
                  <p className="m-0 flex items-start gap-[6px] text-[12px] font-bold text-critical">
                    <ShieldAlert size={13} strokeWidth={2.2} aria-hidden className="mt-[1px] shrink-0" />
                    <span>Safety rule failed: {b.ruleCode}</span>
                  </p>
                  <pre className="m-0 mt-1 overflow-x-auto rounded-md bg-card p-2 text-[10.5px] leading-[1.5] text-body">
                    {JSON.stringify(b.detail, null, 1)}
                  </pre>
                  {b.resolution ? (
                    <p className="m-0 mt-1 text-[11.5px] font-medium text-body" data-testid="block-reviewed">
                      Reviewed{b.reviewedAt ? ` ${new Date(b.reviewedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}` : ""} — {b.resolution}
                    </p>
                  ) : (
                    <div className="mt-1 flex flex-wrap items-center gap-[6px]">
                      <label className="sr-only" htmlFor={`resolve-${b.id}`}>Resolution</label>
                      <input
                        id={`resolve-${b.id}`}
                        data-testid="block-resolution-input"
                        value={blockResolution[b.id] ?? ""}
                        onChange={(e) => setBlockResolution((m) => ({ ...m, [b.id]: e.target.value }))}
                        placeholder="How was this failure reviewed/resolved?"
                        className="h-7 min-w-0 flex-1 rounded-md border border-line bg-card px-2 text-[11.5px] text-body outline-none focus-visible:outline-2 focus-visible:outline-action"
                      />
                      <button
                        type="button"
                        data-testid="review-block-btn"
                        disabled={busy || !(blockResolution[b.id] ?? "").trim()}
                        onClick={() => void reviewBlock(b.id)}
                        className={btn}
                      >
                        Record review
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </section>
          )}

          {/* ---- differential questions ---- */}
          <section className="mt-2">
            <h3 className="m-0 text-[11px] font-bold tracking-[0.04em] text-faint uppercase">
              Suggested questions ({sortedQuestions.length})
            </h3>
            {sortedQuestions.length === 0 && (
              <p className="m-0 mt-1 text-[12px] text-subtle" data-testid="no-questions">
                {evaluation.status === "blocked"
                  ? "No questions were released — the evaluation is blocked pending safety review."
                  : "No questions were generated for the current record."}
              </p>
            )}
            <ul className="m-0 mt-1 flex list-none flex-col gap-2 p-0">
              {sortedQuestions.map((q) => {
                const src = q.knowledgeSourceIds.map((id) => sourceById.get(id) ?? null);
                const answers = answerHistory[q.id];
                const correction = correcting[q.id];
                const terminal = ["dismissed", "superseded", "skipped"].includes(q.status);
                return (
                  <li
                    key={q.id}
                    data-testid="question-card"
                    data-status={q.status}
                    data-priority={q.priority}
                    className={`rounded-[12px] border p-3 ${
                      q.priority === "urgent" ? "border-[rgba(191,70,52,0.5)] border-l-4" : "border-line"
                    } ${terminal ? "opacity-70" : ""} bg-card`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="m-0 min-w-0 flex-1 text-[12.5px] leading-[1.5] font-semibold text-ink">
                        {q.priority === "urgent" && (
                          <span className="mr-1 inline-flex items-center gap-[3px] font-bold text-critical">
                            <AlertTriangle size={12} strokeWidth={2.4} aria-hidden />
                            URGENT —
                          </span>
                        )}
                        {q.questionText}
                      </p>
                      <span className={chip} data-testid="question-status">
                        {STATUS_LABEL[q.status] ?? q.status}
                      </span>
                    </div>
                    <p className="m-0 mt-1 flex flex-wrap gap-2 text-[10.5px] font-semibold text-subtle">
                      <span>{domainName.get(q.domainCode) ?? q.domainCode}</span>
                      <span>Priority: {q.priority}</span>
                      {q.safetyRelation && <span>Safety: {q.safetyRelation.replace(/_/g, " ")}</span>}
                      <span>
                        {q.generationMethod === "ai_assisted"
                          ? `AI-assisted (${q.generationVersion})`
                          : `Deterministic rules (${q.generationVersion})`}
                      </span>
                    </p>

                    <details
                      open={expandedWhy === q.id}
                      onToggle={(e) => setExpandedWhy((e.target as HTMLDetailsElement).open ? q.id : null)}
                      className="mt-1"
                    >
                      <summary className="cursor-pointer text-[11px] font-semibold text-action" data-testid="why-appeared">
                        Why this appeared
                      </summary>
                      <div className="mt-1 rounded-lg bg-panel p-2 text-[11.5px] leading-[1.5] text-body">
                        <p className="m-0"><strong>Rationale:</strong> {q.rationale}</p>
                        {q.distinguishes.length > 0 && (
                          <p className="m-0 mt-1"><strong>Helps distinguish:</strong> {q.distinguishes.map(String).join(" vs ")}</p>
                        )}
                        <p className="m-0 mt-1" data-testid="patient-evidence">
                          <strong>Patient evidence:</strong>{" "}
                          {q.patientSources.length > 0
                            ? q.patientSources
                                .map((s) => {
                                  const src2 = s as { ref?: string; label?: string };
                                  return src2.label ?? src2.ref ?? "record";
                                })
                                .join("; ")
                            : "none — general question"}
                        </p>
                        {q.missingDataAssumptions.length > 0 && (
                          <p className="m-0 mt-1"><strong>Assumes:</strong> {q.missingDataAssumptions.map(String).join(" ")}</p>
                        )}
                        <div className="mt-1" data-testid="knowledge-basis">
                          <strong>Knowledge basis:</strong>
                          {src.length === 0 && <span> unknown</span>}
                          {src.map((s, i) =>
                            s ? (
                              <p key={i} className="m-0 mt-[2px] text-[11px]">
                                {s.citation} · publisher: {s.publisher ?? "unknown"} · validation: {s.validationStatus}
                                {s.knownLimitations ? ` · limitations: ${s.knownLimitations}` : " · limitations: unknown"}
                                {s.fundingConflicts ? ` · funding: ${s.fundingConflicts}` : " · funding: unknown"}
                              </p>
                            ) : (
                              <p key={i} className="m-0 mt-[2px] text-[11px]">unknown source</p>
                            ),
                          )}
                        </div>
                      </div>
                    </details>

                    {/* answers */}
                    {q.status === "asked" && (
                      <div className="mt-2 flex flex-wrap items-center gap-[6px]">
                        <label className="sr-only" htmlFor={`answer-${q.id}`}>Answer</label>
                        <input
                          id={`answer-${q.id}`}
                          data-testid="answer-input"
                          value={answerDrafts[q.id] ?? ""}
                          onChange={(e) => setAnswerDrafts((d) => ({ ...d, [q.id]: e.target.value }))}
                          placeholder="Record the patient's answer…"
                          className="h-7 min-w-0 flex-1 rounded-md border border-line bg-card px-2 text-[11.5px] text-body outline-none focus-visible:outline-2 focus-visible:outline-action"
                        />
                        <button type="button" data-testid="save-answer" disabled={busy || !(answerDrafts[q.id] ?? "").trim()} onClick={() => void submitAnswer(q)} className={btnPrimary}>
                          Save answer
                        </button>
                      </div>
                    )}

                    {q.status === "answered" && (
                      <div className="mt-2 rounded-lg bg-panel p-2" data-testid="answer-block">
                        {!answers ? (
                          <button type="button" data-testid="show-answers" onClick={() => void loadAnswers(q.id)} className={btn}>
                            Show answer & versions
                          </button>
                        ) : (
                          <>
                            <ul className="m-0 flex list-none flex-col gap-1 p-0" data-testid="answer-versions">
                              {answers.map((a) => (
                                <li key={a.version} className="text-[11.5px] text-body">
                                  <strong>v{a.version}</strong>
                                  {a.correctsVersion !== null && (
                                    <span className="ml-1 text-[10.5px] font-semibold text-subtle">
                                      (corrects v{a.correctsVersion}
                                      {a.correctionReason ? ` — ${a.correctionReason}` : ""})
                                    </span>
                                  )}
                                  : {String((a.value as { text?: string }).text ?? JSON.stringify(a.value))}
                                </li>
                              ))}
                            </ul>
                            <p className="m-0 mt-1 text-[10.5px] text-faint">
                              Corrections add versions — the original answer is never changed.
                            </p>
                            {!correction ? (
                              <button
                                type="button"
                                data-testid="correct-answer"
                                onClick={() => setCorrecting((m) => ({ ...m, [q.id]: { value: "", reason: "" } }))}
                                className={`${btn} mt-1`}
                              >
                                Correct answer…
                              </button>
                            ) : (
                              <div className="mt-1 flex flex-wrap items-center gap-[6px]">
                                <label className="sr-only" htmlFor={`correct-${q.id}`}>Corrected answer</label>
                                <input
                                  id={`correct-${q.id}`}
                                  data-testid="correction-input"
                                  value={correction.value}
                                  onChange={(e) => setCorrecting((m) => ({ ...m, [q.id]: { ...correction, value: e.target.value } }))}
                                  placeholder="Corrected answer…"
                                  className="h-7 min-w-0 flex-1 rounded-md border border-line bg-card px-2 text-[11.5px] text-body outline-none focus-visible:outline-2 focus-visible:outline-action"
                                />
                                <label className="sr-only" htmlFor={`correct-reason-${q.id}`}>Correction reason</label>
                                <input
                                  id={`correct-reason-${q.id}`}
                                  data-testid="correction-reason"
                                  value={correction.reason}
                                  onChange={(e) => setCorrecting((m) => ({ ...m, [q.id]: { ...correction, reason: e.target.value } }))}
                                  placeholder="Reason"
                                  className="h-7 w-32 rounded-md border border-line bg-card px-2 text-[11.5px] text-body outline-none focus-visible:outline-2 focus-visible:outline-action"
                                />
                                <button type="button" data-testid="save-correction" disabled={busy || !correction.value.trim()} onClick={() => void submitCorrection(q)} className={btnPrimary}>
                                  Save correction
                                </button>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )}

                    {/* lifecycle actions (DB transition map 0024) */}
                    <div className="mt-2 flex flex-wrap gap-[6px]">
                      {(q.status === "suggested" || q.status === "stale" || q.status === "deferred" || q.status === "skipped") && (
                        <button type="button" data-testid="q-accept" disabled={busy} onClick={() => setStatus(q.id, "accepted")} className={btnPrimary}>
                          Accept
                        </button>
                      )}
                      {(q.status === "accepted" || q.status === "deferred") && (
                        <button type="button" data-testid="q-ask" disabled={busy} onClick={() => setStatus(q.id, "asked")} className={btn}>
                          Mark asked
                        </button>
                      )}
                      {(q.status === "accepted" || q.status === "asked") && (
                        <button type="button" data-testid="q-defer" disabled={busy} onClick={() => setStatus(q.id, "deferred")} className={btn}>
                          Defer
                        </button>
                      )}
                      {(q.status === "accepted" || q.status === "deferred") && (
                        <button type="button" data-testid="q-skip" disabled={busy} onClick={() => setStatus(q.id, "skipped")} className={btn}>
                          Skip
                        </button>
                      )}
                      {["suggested", "accepted", "deferred", "stale"].includes(q.status) && (
                        <button type="button" data-testid="q-dismiss" disabled={busy} onClick={() => setDismissFor(q.id)} className={btn}>
                          Dismiss…
                        </button>
                      )}
                      {(q.status === "accepted" || q.status === "answered") && (
                        <button
                          type="button"
                          data-testid="q-add-to-note"
                          disabled={busy || !activeDraftNoteId}
                          title={activeDraftNoteId ? undefined : "Open a draft note first — questions are never inserted automatically."}
                          onClick={() => void addToNote(q)}
                          className={btn}
                        >
                          Add to note
                        </button>
                      )}
                    </div>

                    {/* dismiss-with-feedback */}
                    {dismissFor === q.id && (
                      <div className="mt-2 rounded-lg border border-line bg-panel p-2" data-testid="dismiss-form">
                        <div className="text-[10px] font-bold tracking-[0.04em] text-faint uppercase">
                          Dismiss with feedback (required)
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-[6px]">
                          <label className="sr-only" htmlFor={`dismiss-kind-${q.id}`}>Feedback kind</label>
                          <select
                            id={`dismiss-kind-${q.id}`}
                            data-testid="dismiss-kind"
                            value={dismissKind}
                            onChange={(e) => setDismissKind(e.target.value)}
                            className="h-7 rounded-md border border-line bg-card px-1 text-[11.5px] text-body outline-none focus-visible:outline-2 focus-visible:outline-action"
                          >
                            {FEEDBACK_KINDS.map((k) => (
                              <option key={k} value={k}>{FEEDBACK_LABEL[k]}</option>
                            ))}
                          </select>
                          <label className="sr-only" htmlFor={`dismiss-comment-${q.id}`}>Comment</label>
                          <input
                            id={`dismiss-comment-${q.id}`}
                            data-testid="dismiss-comment"
                            value={dismissComment}
                            onChange={(e) => setDismissComment(e.target.value)}
                            placeholder="Optional comment"
                            className="h-7 min-w-0 flex-1 rounded-md border border-line bg-card px-2 text-[11.5px] text-body outline-none focus-visible:outline-2 focus-visible:outline-action"
                          />
                          <button type="button" data-testid="confirm-dismiss" disabled={busy} onClick={() => void confirmDismiss()} className={btnPrimary}>
                            Dismiss question
                          </button>
                          <button type="button" onClick={() => setDismissFor(null)} className={btn}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          {/* ---- run snapshot & provenance ---- */}
          <details className="mt-2" data-testid="run-snapshot">
            <summary className="cursor-pointer text-[11px] font-semibold text-action">
              Run snapshot & provenance
            </summary>
            <div className="mt-1 rounded-lg bg-panel p-2 text-[11px] leading-[1.6] text-body">
              <p className="m-0">Run at {new Date(evaluation.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} · input cutoff {new Date(evaluation.inputCutoffAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</p>
              <p className="m-0">Rule set {evaluation.ruleSetVersion} · output schema {evaluation.outputSchemaVersion}</p>
              <p className="m-0" data-testid="snapshot-provider">
                Generation:{" "}
                {evaluation.provider
                  ? `${evaluation.provider} · model ${evaluation.model ?? "unknown"} · prompt template ${evaluation.promptTemplateVersion ?? "unknown"}`
                  : "deterministic rules only (no AI provider participated)"}
              </p>
              <p className="m-0">Output hash {evaluation.outputSha256.slice(0, 16)}…</p>
              <p className="m-0">
                Known inputs:{" "}
                {Object.entries(evaluation.inputSnapshot.counts ?? {})
                  .map(([k, v]) => `${k} ${v}`)
                  .join(" · ") || "none recorded"}
              </p>
              {evaluation.validationResult && (
                <p className="m-0">
                  Output checks: {evaluation.validationResult.schemaValid === true ? "schema valid" : "schema FAILED"} ·{" "}
                  {Array.isArray(evaluation.validationResult.rulesRun) ? `${(evaluation.validationResult.rulesRun as unknown[]).length} safety rules run` : "safety rules run"}
                </p>
              )}
              <p className="m-0 text-[10.5px] text-subtle">
                Validation results are deterministic checks — they are not clinical probabilities or model confidence.
              </p>
            </div>
          </details>
        </div>
      )}
      </div>
    </Card>
  );
}
