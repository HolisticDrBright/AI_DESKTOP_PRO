"use client";

import { useMemo } from "react";
import {
  AlertTriangle,
  BrainCircuit,
  Check,
  CheckCircle2,
  ClipboardList,
  FilePlus2,
  FlaskConical,
  Info,
  LockKeyhole,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { api } from "@/adapters";
import {
  CONCERNS,
  getAdaptiveQuestions,
  resetClinicalCopilot,
  runClinicalCopilot,
  updateCopilotSession,
  useCopilotSession,
  type CopilotConcern,
  type CopilotProductCandidate,
} from "@/adapters/clinical-copilot.mock";
import { createProtocolFromCopilot } from "@/adapters/careplan.mock";
import { USE_LIVE_API } from "@/adapters/mode";
import { addSessionQueueItem, recordAuditEntry } from "@/adapters/session-store";
import { useComposerOptional } from "@/lib/composer";
import { useFeedback } from "@/lib/feedback";
import { patientPath } from "@/lib/routes";
import { cn } from "@/lib/cn";
import { Btn, BtnLink } from "@/components/ui/Btn";
import { Card } from "@/components/ui/bits";
import { Select } from "@/components/ui/Field";
import { Pill, Tag } from "@/components/ui/Pill";

const CONSIDERATION_TONE = {
  routine: "slate",
  priority: "warning",
  urgent: "critical",
} as const;

function StepLabel({
  number,
  label,
  complete,
}: {
  number: number;
  label: string;
  complete: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span
        className={cn(
          "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[10.5px] font-bold",
          complete
            ? "border-positive bg-positive-tint text-positive"
            : "border-line bg-card text-subtle",
        )}
      >
        {complete ? <Check size={12} aria-hidden /> : number}
      </span>
      <span className="truncate text-[11.5px] font-semibold text-body">{label}</span>
    </div>
  );
}

export function ClinicalCopilotWorkspace({
  patientId,
  patientName,
}: {
  patientId: string;
  patientName: string;
}) {
  const session = useCopilotSession(patientId);
  const { announce } = useFeedback();
  const composer = useComposerOptional();
  const concern = CONCERNS.find((item) => item.id === session.concern) ?? CONCERNS[0];
  const questions = useMemo(
    () => getAdaptiveQuestions(session.concern, session.symptoms),
    [session.concern, session.symptoms],
  );
  const unanswered = questions.filter(
    (question) => question.required && !session.answers[question.id],
  );
  const eligibleProducts =
    session.result?.products.filter((item) => item.eligibility === "eligible-after-review") ?? [];
  const allEligibleLabelsVerified =
    eligibleProducts.length === 0
    || eligibleProducts.every((item) => session.verifiedProductIds.includes(item.id));
  const canCreateProtocol = Boolean(
    session.result
    && session.reviewed
    && session.result.safetyBlocks.length === 0
    && session.result.missingInformation.length === 0
    && allEligibleLabelsVerified,
  );

  const updateConcern = (next: CopilotConcern) => {
    updateCopilotSession(patientId, (current) => ({
      ...current,
      concern: next,
      symptoms: [],
      answers: {},
      result: undefined,
      reviewed: false,
      verifiedProductIds: [],
      createdProtocolId: undefined,
    }));
  };

  const toggleSymptom = (symptom: string) => {
    updateCopilotSession(patientId, (current) => ({
      ...current,
      symptoms: current.symptoms.includes(symptom)
        ? current.symptoms.filter((item) => item !== symptom)
        : [...current.symptoms, symptom],
      result: undefined,
      reviewed: false,
      verifiedProductIds: [],
    }));
  };

  const answer = (questionId: string, value: string) => {
    updateCopilotSession(patientId, (current) => ({
      ...current,
      answers: { ...current.answers, [questionId]: value },
      result: undefined,
      reviewed: false,
      verifiedProductIds: [],
    }));
  };

  const run = () => {
    const result = runClinicalCopilot(patientId, patientName);
    if (!result) {
      announce("Clinical copilot is not configured in live mode.");
      return;
    }
    recordAuditEntry({
      kind: "mark_reviewed",
      subjectType: "clinical copilot run",
      subjectLabel: result.title,
      patientName,
      reviewed: false,
    });
    announce("Draft clinical copilot output created. Practitioner review is required.");
  };

  const toggleLabelVerification = (product: CopilotProductCandidate) => {
    if (product.eligibility !== "eligible-after-review") return;
    updateCopilotSession(patientId, (current) => ({
      ...current,
      verifiedProductIds: current.verifiedProductIds.includes(product.id)
        ? current.verifiedProductIds.filter((id) => id !== product.id)
        : [...current.verifiedProductIds, product.id],
    }));
  };

  const markReviewed = () => {
    if (!session.result) return;
    updateCopilotSession(patientId, (current) => ({ ...current, reviewed: true }));
    recordAuditEntry({
      kind: "mark_reviewed",
      subjectType: "clinical copilot run",
      subjectLabel: session.result.title,
      patientName,
      reviewed: true,
      outcome: "reviewed",
    });
    announce("Copilot output marked reviewed. This does not activate or send a plan.");
  };

  const addLab = (panelId: string, name: string) => {
    void api.labOrders.addPanelToDraft(patientId, panelId).then((result) => {
      announce(`${name}: ${result.message}`);
    });
  };

  const createReviewTask = () => {
    if (!session.result) return;
    addSessionQueueItem({
      title: `Review copilot draft: ${session.result.title}`,
      patientId,
      patientName,
      category: "reasoning-review",
      priority: session.result.safetyBlocks.length ? "High" : "Medium",
      seeds: [
        session.result.summary,
        ...session.result.missingInformation,
        ...session.result.safetyBlocks,
      ],
    });
    recordAuditEntry({
      kind: "create_task",
      subjectType: "clinical copilot run",
      subjectLabel: session.result.title,
      patientName,
      reviewed: true,
    });
    announce("Clinical review task added to the session queue.");
  };

  const addToNote = () => {
    if (!session.result || !composer) {
      announce("The note composer is unavailable on this screen.");
      return;
    }
    composer.openComposer("reasoning-summary", {
      patientName,
      subjectType: "governed clinical copilot",
      subjectLabel: session.result.title,
      seeds: [
        "Draft only. Practitioner-authored pathway; not a diagnosis or final treatment plan.",
        session.result.summary,
        ...session.result.considerations.map((item) => `${item.label}: ${item.rationale}`),
        ...session.result.followUpQuestions.map((item) => `Question to confirm: ${item}`),
        ...session.result.labs.map((item) => `Lab candidate: ${item.name} — ${item.rationale}`),
        ...session.result.missingInformation.map((item) => `Missing: ${item}`),
        ...session.result.safetyBlocks.map((item) => `Safety block: ${item}`),
      ],
    });
  };

  const createProtocol = () => {
    if (!session.result || !canCreateProtocol) return;
    const verified = session.result.products.filter(
      (item) =>
        item.eligibility === "eligible-after-review"
        && session.verifiedProductIds.includes(item.id),
    );
    const protocol = createProtocolFromCopilot(patientId, {
      name: `${session.result.title} protocol draft`,
      summary: `${session.result.summary} This draft was generated from a governed practice pathway and requires full practitioner approval before activation.`,
      products: verified.map((item) => ({
        label: `${item.productName} · ${item.brand}`,
        detail: `${item.role}. Exact label marked verified this session; dose, timing, interactions, and patient eligibility still require protocol approval.`,
      })),
      nutritionDraft: session.result.nutritionDraft,
      lifestyleDrafts: session.result.lifestyleDrafts,
      labs: session.result.labs.map((item) => ({
        name: item.name,
        rationale: item.rationale,
      })),
      safetyBlocks: session.result.safetyBlocks,
      missingInformation: session.result.missingInformation,
      knowledgeVersion: session.result.knowledgeVersion,
    });
    updateCopilotSession(patientId, (current) => ({
      ...current,
      createdProtocolId: protocol.id,
    }));
    recordAuditEntry({
      kind: "create_task",
      subjectType: "protocol draft",
      subjectLabel: protocol.name,
      patientName,
      reviewed: true,
    });
    announce("Review-gated protocol draft created. Nothing was activated or sent.");
  };

  if (USE_LIVE_API) {
    return (
      <section className="pb-8" data-screen-label="Governed clinical copilot">
        <Card className="border-ai/20 p-5">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-ai-tint text-ai">
              <BrainCircuit size={20} aria-hidden />
            </span>
            <div>
              <h1 className="m-0 text-[18px] font-bold text-ink">Clinical copilot not configured</h1>
              <p className="m-0 mt-1 max-w-[720px] text-[12px] leading-[1.55] text-subtle">
                Live patient data was not sent to a fixture or unapproved model. Configure an approved provider,
                governed knowledge registry, and backend audit procedures before enabling this workflow.
              </p>
              <div className="mt-3 flex items-center gap-2 text-[11px] font-semibold text-ai-deep">
                <LockKeyhole size={13} aria-hidden /> Fail-closed live boundary
              </div>
            </div>
          </div>
        </Card>
      </section>
    );
  }

  return (
    <section className="pb-8" data-screen-label="Governed clinical copilot">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <BrainCircuit size={18} className="text-ai" aria-hidden />
            <h1 className="m-0 text-[19px] font-bold text-ink">Governed clinical copilot</h1>
            <Pill tone="ai">Draft only</Pill>
          </div>
          <p className="m-0 mt-1 max-w-[820px] text-[11.5px] leading-[1.5] text-subtle">
            Adaptive intake → differentiating questions → lab candidates → exact-product protocol draft.
            Practitioner review is required at every clinical action.
          </p>
        </div>
        <Btn
          size="sm"
          onClick={() => {
            resetClinicalCopilot(patientId);
            announce("Clinical copilot workspace reset for this session.");
          }}
        >
          <RefreshCcw size={12} aria-hidden /> Reset
        </Btn>
      </header>

      <Card className="mb-4 px-4 py-3">
        <div className="grid gap-3 sm:grid-cols-4">
          <StepLabel number={1} label="Intake context" complete={session.symptoms.length > 0} />
          <StepLabel number={2} label="Safety questions" complete={unanswered.length === 0} />
          <StepLabel number={3} label="Review output" complete={session.reviewed} />
          <StepLabel number={4} label="Create drafts" complete={Boolean(session.createdProtocolId)} />
        </div>
      </Card>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card className="overflow-hidden">
            <div className="border-b border-hairline bg-sunken px-5 py-3">
              <h2 className="m-0 text-[13.5px] font-bold text-ink">1. Intake context</h2>
              <p className="m-0 mt-1 text-[11px] text-subtle">Choose the primary question and current symptoms. This changes the follow-up questions below.</p>
            </div>
            <div className="p-5">
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {CONCERNS.map((item) => {
                  const active = item.id === session.concern;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => updateConcern(item.id)}
                      className={cn(
                        "rounded-lg border px-3 py-3 text-left focus-visible:outline-2 focus-visible:outline-action",
                        active ? "border-ai bg-ai-tint" : "border-line bg-card hover:border-line-hover-2",
                      )}
                    >
                      <span className="block text-[12.5px] font-bold text-ink">{item.label}</span>
                      <span className="mt-1 block text-[10.5px] leading-[1.4] text-subtle">{item.description}</span>
                    </button>
                  );
                })}
              </div>
              <h3 className="m-0 mt-5 mb-2 text-[11px] font-bold text-faint uppercase">Current symptoms or signals</h3>
              <div className="flex flex-wrap gap-2">
                {concern.symptoms.map((symptom) => {
                  const selected = session.symptoms.includes(symptom);
                  return (
                    <button
                      key={symptom}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => toggleSymptom(symptom)}
                      className={cn(
                        "rounded-full border px-3 py-[6px] text-[11.5px] font-semibold focus-visible:outline-2 focus-visible:outline-action",
                        selected
                          ? "border-action bg-action-tint text-action-deep"
                          : "border-line bg-card text-body hover:border-line-hover-2",
                      )}
                    >
                      {selected && <Check size={11} className="mr-1 inline" aria-hidden />}
                      {symptom}
                    </button>
                  );
                })}
              </div>
            </div>
          </Card>

          <Card className="overflow-hidden">
            <div className="border-b border-hairline bg-sunken px-5 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="m-0 text-[13.5px] font-bold text-ink">2. Adaptive safety and differentiation questions</h2>
                  <p className="m-0 mt-1 text-[11px] text-subtle">
                    {questions.length} questions based on {concern.label.toLowerCase()}
                    {session.symptoms.length ? ` and ${session.symptoms.length} selected signal${session.symptoms.length === 1 ? "" : "s"}` : ""}.
                  </p>
                </div>
                <Pill tone={unanswered.length ? "warning" : "positive"}>
                  {unanswered.length ? `${unanswered.length} unanswered` : "Ready to evaluate"}
                </Pill>
              </div>
            </div>
            <div className="divide-y divide-hairline">
              {questions.map((question) => (
                <label key={question.id} className="grid gap-2 px-5 py-3 lg:grid-cols-[minmax(0,1fr)_230px] lg:items-center">
                  <span>
                    <span className="block text-[12px] font-semibold leading-[1.45] text-ink">{question.label}</span>
                    <span className="mt-1 block text-[10.5px] leading-[1.4] text-subtle">
                      Why this appears: {question.reason}
                    </span>
                  </span>
                  <Select
                    value={String(session.answers[question.id] ?? "")}
                    onChange={(event) => answer(question.id, event.target.value)}
                    aria-label={question.label}
                  >
                    {question.options.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </Select>
                </label>
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline bg-sunken px-5 py-3">
              <p className="m-0 text-[10.5px] text-subtle">
                Deterministic demo. It does not diagnose, prescribe, or use an external AI provider.
              </p>
              <Btn variant="ai" onClick={run} disabled={unanswered.length > 0 || session.symptoms.length === 0}>
                <Sparkles size={13} aria-hidden /> Build review draft
              </Btn>
            </div>
          </Card>

          {session.result && (
            <div className="flex flex-col gap-4" aria-live="polite">
              {(session.result.safetyBlocks.length > 0 || session.result.missingInformation.length > 0) && (
                <Card className="overflow-hidden border-warning">
                  <div className="flex items-center gap-2 border-b border-warning/20 bg-warning-tint px-4 py-3">
                    <AlertTriangle size={15} className="text-warning-deep" aria-hidden />
                    <h2 className="m-0 text-[13px] font-bold text-warning-deep">Safety and missing-information gate</h2>
                  </div>
                  <div className="grid gap-4 p-4 lg:grid-cols-2">
                    <BulletSection title="Safety blocks" items={session.result.safetyBlocks} empty="No urgent safety block detected." warning />
                    <BulletSection title="Missing before protocol creation" items={session.result.missingInformation} empty="Core safety information is present." />
                  </div>
                </Card>
              )}

              <Card className="overflow-hidden">
                <div className="border-b border-hairline bg-ai-tint px-5 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <h2 className="m-0 text-[16px] font-bold text-ink">{session.result.title}</h2>
                        <Pill tone={session.reviewed ? "positive" : "warning"}>
                          {session.reviewed ? "Practitioner reviewed" : "Awaiting practitioner review"}
                        </Pill>
                      </div>
                      <p className="m-0 mt-1 max-w-[760px] text-[11.5px] leading-[1.5] text-body">{session.result.summary}</p>
                    </div>
                    <span className="text-[10px] text-ai-deep">Rules: {session.result.knowledgeVersion}</span>
                  </div>
                </div>

                <ResultSection title="Clinical considerations" icon={<BrainCircuit size={14} />}>
                  <div className="grid gap-2 lg:grid-cols-2">
                    {session.result.considerations.map((item) => (
                      <div key={item.label} className="rounded-lg border border-line px-3 py-3">
                        <div className="flex items-start gap-2">
                          <span className="min-w-0 flex-1 text-[12px] font-bold text-ink">{item.label}</span>
                          <Pill tone={CONSIDERATION_TONE[item.urgency]}>{item.urgency}</Pill>
                        </div>
                        <p className="m-0 mt-2 text-[10.8px] leading-[1.5] text-subtle">{item.rationale}</p>
                      </div>
                    ))}
                  </div>
                </ResultSection>

                <ResultSection title="Differentiating questions" icon={<ClipboardList size={14} />}>
                  <ol className="m-0 flex list-decimal flex-col gap-2 pl-5 text-[11.5px] leading-[1.5] text-body">
                    {session.result.followUpQuestions.map((item) => <li key={item}>{item}</li>)}
                  </ol>
                </ResultSection>

                <ResultSection title="Confirming-data candidates" icon={<FlaskConical size={14} />}>
                  <div className="flex flex-col gap-2">
                    {session.result.labs.map((lab) => (
                      <div key={lab.panelId} className="rounded-lg border border-line px-3 py-3">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-[12px] font-bold text-ink">{lab.name}</span>
                              <Tag>{lab.vendor}</Tag>
                            </div>
                            <p className="m-0 mt-1 text-[10.8px] leading-[1.5] text-body">{lab.rationale}</p>
                            <p className="m-0 mt-2 text-[10px] text-warning-deep">
                              Confirm before ordering: {lab.missingBeforeOrder.join(" · ")}
                            </p>
                          </div>
                          <Btn size="sm" onClick={() => addLab(lab.panelId, lab.name)}>
                            <FlaskConical size={12} aria-hidden /> Add to order draft
                          </Btn>
                        </div>
                      </div>
                    ))}
                  </div>
                </ResultSection>

                <ResultSection title="Exact-product candidates" icon={<ShieldCheck size={14} />}>
                  <div className="mb-3 rounded-lg border border-ai/20 bg-ai-tint px-3 py-2 text-[10.8px] leading-[1.45] text-ai-deep">
                    Affiliate links are intentionally hidden at this stage. A product can enter the protocol draft only after clinical eligibility and current-label verification.
                  </div>
                  <div className="flex flex-col gap-2">
                    {session.result.products.map((product) => {
                      const canVerify = product.eligibility === "eligible-after-review";
                      const verified = session.verifiedProductIds.includes(product.id);
                      return (
                        <div key={product.id} className="rounded-lg border border-line px-3 py-3">
                          <div className="flex flex-wrap items-start gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-[12px] font-bold text-ink">{product.productName}</span>
                                <Tag>{product.brand}</Tag>
                                <Pill tone={canVerify ? "warning" : product.eligibility === "blocked" ? "critical" : "slate"}>
                                  {product.eligibility.replaceAll("-", " ")}
                                </Pill>
                              </div>
                              <p className="m-0 mt-1 text-[10.8px] text-body">{product.role}</p>
                              <p className="m-0 mt-1 text-[10px] leading-[1.45] text-subtle">{product.eligibilityReason}</p>
                            </div>
                            <label className={cn(
                              "flex max-w-[260px] items-start gap-2 rounded-md border px-3 py-2 text-[10.5px] leading-[1.4]",
                              canVerify ? "cursor-pointer border-line bg-card text-body" : "border-hairline bg-sunken text-faint",
                            )}>
                              <input
                                type="checkbox"
                                checked={verified}
                                disabled={!canVerify}
                                onChange={() => toggleLabelVerification(product)}
                                className="mt-[2px]"
                              />
                              I verified the current exact product, formulation, ingredients, serving size, and manufacturer label.
                            </label>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </ResultSection>

                <ResultSection title="Draft plan structure" icon={<FilePlus2 size={14} />}>
                  <div className="grid gap-4 lg:grid-cols-2">
                    <BulletSection title="Nutrition" items={session.result.nutritionDraft ? [session.result.nutritionDraft] : []} empty="No nutrition pathway added." />
                    <BulletSection title="Lifestyle" items={session.result.lifestyleDrafts} empty="No lifestyle pathway added." />
                    <BulletSection title="Mandatory interaction checks" items={session.result.interactionChecks} empty="No checks configured." warning />
                    <BulletSection title="Missing information" items={session.result.missingInformation} empty="Core safety information present." />
                  </div>
                </ResultSection>
              </Card>
            </div>
          )}
        </div>

        <aside className="sticky top-3 flex flex-col gap-3">
          <Card className="overflow-hidden">
            <div className="border-b border-hairline bg-sunken px-4 py-3">
              <h2 className="m-0 text-[12.5px] font-bold text-ink">Review and action</h2>
              <p className="m-0 mt-1 text-[10.5px] text-subtle">No action is automatic or patient-facing.</p>
            </div>
            <div className="flex flex-col gap-2 p-4">
              <Btn
                variant="primary"
                disabled={!session.result || session.reviewed}
                onClick={markReviewed}
                className="w-full"
              >
                <CheckCircle2 size={13} aria-hidden />
                {session.reviewed ? "Reviewed this session" : "Mark output reviewed"}
              </Btn>
              <Btn disabled={!session.result} onClick={addToNote} className="w-full">
                <FilePlus2 size={13} aria-hidden /> Add to note draft
              </Btn>
              <Btn disabled={!session.result} onClick={createReviewTask} className="w-full">
                <ClipboardList size={13} aria-hidden /> Create review task
              </Btn>
              <Btn
                variant="ai"
                disabled={!canCreateProtocol}
                onClick={createProtocol}
                className="w-full"
              >
                <Sparkles size={13} aria-hidden /> Create protocol draft
              </Btn>
              {session.createdProtocolId && (
                <BtnLink href={patientPath(patientId, "protocol")} variant="outline" className="w-full">
                  Open protocol draft
                </BtnLink>
              )}
              {!canCreateProtocol && session.result && (
                <p className="m-0 rounded-md bg-warning-tint px-3 py-2 text-[10.5px] leading-[1.45] text-warning-deep">
                  To create a protocol: review the output, resolve safety and missing-information gates, and verify every clinically eligible product label.
                </p>
              )}
              <BtnLink href={`${patientPath(patientId, "labs")}?view=orders`} variant="ghost" className="w-full">
                Open lab order draft
              </BtnLink>
            </div>
          </Card>

          <Card className="p-4">
            <div className="flex items-center gap-2">
              <Info size={13} className="text-ai" aria-hidden />
              <h2 className="m-0 text-[12px] font-bold text-ink">Evidence and version record</h2>
            </div>
            {session.result ? (
              <ul className="m-0 mt-3 flex list-none flex-col gap-3 p-0">
                {session.result.sources.map((item) => (
                  <li key={item.id} className="border-b border-hairline pb-2 last:border-b-0 last:pb-0">
                    <span className="block text-[10.8px] font-semibold text-body">{item.label}</span>
                    <span className="mt-1 block text-[9.8px] text-faint">{item.version} · {item.status.replaceAll("-", " ")}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-0 mt-2 text-[10.5px] leading-[1.45] text-subtle">
                Sources, versions, and review status appear after a draft is built.
              </p>
            )}
          </Card>

          <div className="rounded-lg border border-line bg-sunken px-3 py-3 text-[10.2px] leading-[1.5] text-subtle">
            <strong className="text-body">Demo boundary:</strong> session-only deterministic rules using synthetic chart context.
            Nothing is diagnosed, prescribed, ordered, activated, billed, or sent.
          </div>
        </aside>
      </div>
    </section>
  );
}

function ResultSection({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-hairline px-5 py-4 last:border-b-0">
      <div className="mb-3 flex items-center gap-2 text-ai">
        {icon}
        <h3 className="m-0 text-[12.5px] font-bold text-ink">{title}</h3>
      </div>
      {children}
    </section>
  );
}

function BulletSection({
  title,
  items,
  empty,
  warning = false,
}: {
  title: string;
  items: string[];
  empty: string;
  warning?: boolean;
}) {
  return (
    <div>
      <h3 className="m-0 mb-2 text-[9.8px] font-bold text-faint uppercase">{title}</h3>
      {items.length ? (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {items.map((item) => (
            <li key={item} className="flex items-start gap-2 text-[10.8px] leading-[1.45] text-body">
              {warning
                ? <AlertTriangle size={12} className="mt-[2px] shrink-0 text-warning" aria-hidden />
                : <Check size={12} className="mt-[2px] shrink-0 text-positive" aria-hidden />}
              {item}
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-[10.8px] text-subtle">{empty}</p>
      )}
    </div>
  );
}
