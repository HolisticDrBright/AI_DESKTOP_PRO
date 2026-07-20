"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  CheckCircle2,
  ClipboardList,
  FileText,
  FlaskConical,
  Layers,
  Send,
  ShieldAlert,
  UserRound,
} from "lucide-react";

import {
  attemptApproveProtocolDraft,
  createInvitation,
  createProtocolDraft,
  recordLabDecision,
  SCENARIO_LABELS,
  simulatePatientProgress,
  simulatePatientSubmission,
  useAssessmentsState,
  REGISTRY_META,
  TOTAL_QUESTIONS,
  type AssessmentSubmission,
  type LabDecisionKind,
  type ProtocolDraft,
  type SimulationScenario,
} from "@/adapters/assessments.mock";
import { listPatients } from "@/adapters/patients.mock";
import type { Tone } from "@/adapters/types";
import { Card, CardTitle, ProgressBar } from "@/components/ui/bits";
import { ClinicalEmpty } from "@/components/ui/ClinicalStates";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import {
  CONSENTS,
  INTAKE_MODULES,
  LAB_CATALOG,
  LAB_RULES,
  listDraftableProducts,
  PROTOCOL_TEMPLATES,
  QUESTIONNAIRE,
  SCREENING_DISCLAIMER,
  type CategoryScreeningScore,
} from "@/lib/registry";
import { patientPath } from "@/lib/routes";
import { toneText, toneTint } from "@/lib/tones";

/* --------------------------------------------------------------- helpers */

function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span
      className="w-fit rounded-full px-[7px] py-px text-[10px] font-semibold whitespace-nowrap"
      style={{ color: toneText[tone], background: toneTint[tone] }}
    >
      {children}
    </span>
  );
}

/** Compact action button (house outline style, but inline-width + onClick). */
function Btn({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg border border-line-btn bg-card px-2.5 py-1.5 text-[12px] font-semibold text-action hover:bg-[#F7FAFD] focus-visible:outline-2 focus-visible:outline-action"
    >
      {children}
    </button>
  );
}

function PanelTitle({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <CardTitle className="mb-2">
      <span className="text-ink-3">{icon}</span>
      {title}
    </CardTitle>
  );
}

const BAND_LABEL: Record<CategoryScreeningScore["band"], string> = {
  elevated: "Elevated",
  moderate: "Moderate",
  "below-threshold": "Below threshold",
  insufficient_data: "Needs more answers",
};

const BAND_TONE: Record<CategoryScreeningScore["band"], Tone> = {
  elevated: "critical",
  moderate: "warning",
  "below-threshold": "positive",
  insufficient_data: "slate",
};

function ProvenanceStrip({ sub }: { sub?: AssessmentSubmission }) {
  const meta = sub ?? REGISTRY_META;
  const hash = "contentHash" in meta ? meta.contentHash : REGISTRY_META.contentHash;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[10.5px] text-ink-3">
      <Pill tone="slate">{`questionnaire ${"questionnaireVersion" in meta ? meta.questionnaireVersion : ""}`}</Pill>
      <Pill tone="slate">{`scoring ${"scoringVersion" in meta ? meta.scoringVersion : ""}`}</Pill>
      {sub && <Pill tone="slate">{`rules ${sub.ruleVersion}`}</Pill>}
      <Pill tone="slate">{`registry ${"registryVersion" in meta ? meta.registryVersion : ""}`}</Pill>
      <span className="font-mono">content {hash.slice(0, 12)}…</span>
    </div>
  );
}

/* ---------------------------------------------------------- invitations */

function InvitationsPanel() {
  const { invitations } = useAssessmentsState();
  const patients = listPatients();
  const [patientId, setPatientId] = useState(patients[0]?.id ?? "");
  const [modules, setModules] = useState<string[]>(INTAKE_MODULES.map((m) => m.id));
  const [scenarioFor, setScenarioFor] = useState<string | null>(null);

  const toggleModule = (id: string) =>
    setModules((prev) => (prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]));

  return (
    <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
      <Card className="h-fit p-4">
        <PanelTitle icon={<Send size={15} strokeWidth={1.75} aria-hidden />} title="Invite a patient" />
        <p className="mb-3 text-[12px] leading-5 text-ink-3">
          Sends the governed onboarding: account → consents → concerns & goals → history →
          lifestyle → symptom screening → records upload → review & submit. Demo mode simulates
          the patient side with synthetic answers only.
        </p>
        <label className="mb-1 block text-[11px] font-semibold text-ink-2" htmlFor="invite-patient">
          Patient
        </label>
        <select
          id="invite-patient"
          value={patientId}
          onChange={(e) => setPatientId(e.target.value)}
          className="mb-3 w-full rounded-lg border border-line bg-card px-2.5 py-2 text-[12.5px]"
        >
          {patients.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.mrn}
            </option>
          ))}
        </select>
        <p className="mb-1 text-[11px] font-semibold text-ink-2">Intake modules</p>
        <div className="mb-3 grid gap-1">
          {INTAKE_MODULES.map((m) => (
            <label key={m.id} className="flex items-center gap-2 text-[12px] text-ink-2">
              <input
                type="checkbox"
                checked={modules.includes(m.id)}
                onChange={() => toggleModule(m.id)}
              />
              {m.title}
            </label>
          ))}
        </div>
        <Btn
          onClick={() => {
            if (patientId && modules.length > 0) createInvitation(patientId, modules);
          }}
        >
          Send invitation
        </Btn>
      </Card>

      <div className="grid gap-3">
        {invitations.length === 0 && (
          <ClinicalEmpty
            icon={<Send size={20} strokeWidth={1.75} className="text-slate-badge" aria-hidden />}
            title="No invitations yet"
            message="Invite a patient to start the onboarding → screening → review loop."
          />
        )}
        {invitations.map((inv) => (
          <Card key={inv.id} className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <UserRound size={16} strokeWidth={1.75} className="text-ink-3" aria-hidden />
                <span className="text-[13.5px] font-semibold text-ink-1">{inv.patientName}</span>
                <Pill
                  tone={
                    inv.status === "submitted" ? "positive" : inv.status === "in_progress" ? "warning" : "slate"
                  }
                >
                  {inv.status === "submitted"
                    ? "Submitted"
                    : inv.status === "in_progress"
                      ? "In progress (autosaved)"
                      : "Invitation sent"}
                </Pill>
              </div>
              <span className="text-[11px] text-ink-3">
                {inv.moduleIds.length} modules · sent {new Date(inv.sentAt).toLocaleString()}
              </span>
            </div>

            <div className="mt-3">
              <ProgressBar pct={Math.round((inv.progressAnswered / inv.progressTotal) * 100)} color="#3E7BFA" />
              <p className="mt-1 text-[11px] text-ink-3">
                {inv.progressAnswered} of {inv.progressTotal} questions answered
                {inv.lastSavedAt ? ` · autosaved ${new Date(inv.lastSavedAt).toLocaleTimeString()}` : ""}
              </p>
            </div>

            {inv.status !== "submitted" && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {inv.status === "sent" && (
                  <Btn onClick={() => simulatePatientProgress(inv.id)}>
                    Simulate patient progress
                  </Btn>
                )}
                {scenarioFor === inv.id ? (
                  <div className="flex flex-wrap gap-2">
                    {(Object.keys(SCENARIO_LABELS) as SimulationScenario[]).map((sc) => (
                      <Btn
                        key={sc}
                        onClick={() => {
                          simulatePatientSubmission(inv.id, sc);
                          setScenarioFor(null);
                        }}
                      >
                        {SCENARIO_LABELS[sc]}
                      </Btn>
                    ))}
                  </div>
                ) : (
                  <Btn onClick={() => setScenarioFor(inv.id)}>
                    Simulate submission…
                  </Btn>
                )}
              </div>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- review */

function NoteAction({
  label,
  onSave,
}: {
  label: string;
  onSave: (note: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  if (!open) {
    return <Btn onClick={() => setOpen(true)}>{label}</Btn>;
  }
  return (
    <span className="flex items-center gap-1.5">
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note (recorded with the decision)"
        className="w-56 rounded-lg border border-line bg-card px-2 py-1.5 text-[12px]"
        aria-label={`${label} note`}
      />
      <Btn
        onClick={() => {
          onSave(note.trim());
          setOpen(false);
          setNote("");
        }}
      >
        Save
      </Btn>
    </span>
  );
}

function SubmissionCard({
  sub,
  onDraftProtocol,
}: {
  sub: AssessmentSubmission;
  onDraftProtocol: (sub: AssessmentSubmission) => void;
}) {
  const [confirmDismiss, setConfirmDismiss] = useState<string | null>(null);
  const decide = (labId: string, decision: LabDecisionKind, note: string | null = null) =>
    recordLabDecision(sub.id, labId, decision, note);

  const sortedCategories = useMemo(() => {
    const rank: Record<string, number> = {
      elevated: 0,
      moderate: 1,
      insufficient_data: 2,
      "below-threshold": 3,
    };
    return [...sub.categories].sort(
      (a, b) => rank[a.band] - rank[b.band] || (b.percent ?? 0) - (a.percent ?? 0),
    );
  }, [sub.categories]);

  const decidedByLab = useMemo(() => {
    const m = new Map<string, typeof sub.decisions>();
    for (const d of sub.decisions) {
      m.set(d.labId, [...(m.get(d.labId) ?? []), d]);
    }
    return m;
  }, [sub]);

  return (
    <Card className="p-4" data-testid={`submission-${sub.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-semibold text-ink-1">{sub.patientName}</span>
            <Pill tone={sub.reviewState === "reviewed" ? "positive" : "warning"}>
              {sub.reviewState === "reviewed" ? "Reviewed" : "Pending practitioner review"}
            </Pill>
            <Pill tone="slate">{sub.scenario}</Pill>
          </div>
          <p className="mt-1 text-[11.5px] text-ink-3">
            Submitted {new Date(sub.submittedAt).toLocaleString()} · {sub.answered} rated ·{" "}
            {sub.special} NA/unsure · {sub.unanswered} unanswered
          </p>
          <div className="mt-1.5">
            <ProvenanceStrip sub={sub} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={patientPath(sub.patientId)}
            className="rounded-lg border border-line px-2.5 py-1.5 text-[12px] font-semibold text-action hover:bg-sunken-1"
          >
            Open patient
          </Link>
          <Btn onClick={() => onDraftProtocol(sub)}>Draft protocol…</Btn>
        </div>
      </div>

      {/* Category bands */}
      <div className="mt-3 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
        {sortedCategories.map((c) => (
          <div
            key={c.categoryId}
            className="flex items-center justify-between rounded-lg border border-line bg-sunken-1 px-2.5 py-1.5"
          >
            <div className="min-w-0">
              <p className="truncate text-[12px] font-semibold text-ink-1">{c.categoryName}</p>
              <p className="text-[10.5px] text-ink-3">
                {c.answered}/{c.totalQuestions} answered · completeness{" "}
                {Math.round(c.completeness * 100)}%
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[13px] font-bold tabular-nums text-ink-1">
                {c.rounded === null ? "—" : c.rounded}
              </span>
              <Pill tone={BAND_TONE[c.band]}>{BAND_LABEL[c.band]}</Pill>
            </div>
          </div>
        ))}
      </div>

      {/* Lab candidates */}
      <div className="mt-4">
        <p className="mb-1.5 text-[12px] font-semibold text-ink-2">
          Draft lab candidates ({sub.labs.length}) — deterministic rules {sub.ruleVersion}; nothing
          is ordered without your decision
        </p>
        {sub.labs.length === 0 && (
          <p className="text-[12px] text-ink-3">
            No categories reached the moderate threshold — no lab candidates from the rules.
          </p>
        )}
        <div className="grid gap-2">
          {sub.labs.map((lab) => {
            const history = decidedByLab.get(lab.labId) ?? [];
            const last = history[history.length - 1];
            return (
              <div key={lab.labId} className="rounded-lg border border-line p-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <FlaskConical size={14} strokeWidth={1.75} className="text-ink-3" aria-hidden />
                    <span className="text-[12.5px] font-semibold text-ink-1">{lab.panelName}</span>
                    {lab.vendor && <span className="text-[11px] text-ink-3">{lab.vendor}</span>}
                    <Pill tone={lab.highestBand === "elevated" ? "critical" : "warning"}>
                      from {lab.highestBand}
                    </Pill>
                    <Pill tone={lab.priority === "primary" ? "action" : "slate"}>{lab.priority}</Pill>
                    {lab.orderLinkReviewStatus === "unreviewed" && (
                      <Pill tone="warning">order link unreviewed</Pill>
                    )}
                  </div>
                  {last && (
                    <Pill tone={last.decision === "dismiss" ? "critical" : "positive"}>
                      {last.decision.replace(/_/g, " ")}
                    </Pill>
                  )}
                </div>
                <p className="mt-1 text-[11.5px] leading-4.5 text-ink-2">
                  <span className="font-semibold">Why:</span> {lab.why} · source:{" "}
                  {lab.sourceCategoryIds.join(", ")}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <Btn onClick={() => decide(lab.labId, "approve")}>Approve</Btn>
                  <NoteAction label="Modify…" onSave={(n) => decide(lab.labId, "modify", n || null)} />
                  <NoteAction
                    label="Request more data…"
                    onSave={(n) => decide(lab.labId, "request_data", n || null)}
                  />
                  <Btn onClick={() => decide(lab.labId, "create_order_draft")}>
                    Create order draft
                  </Btn>
                  <Btn onClick={() => setConfirmDismiss(lab.labId)}>Dismiss</Btn>
                </div>
                {history.length > 0 && (
                  <ul className="mt-2 grid gap-0.5 border-t border-line pt-1.5">
                    {history.map((d) => (
                      <li key={d.id} className="text-[10.5px] text-ink-3">
                        {new Date(d.at).toLocaleTimeString()} — {d.decision.replace(/_/g, " ")}
                        {d.note ? ` · “${d.note}”` : ""}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <ConfirmDialog
        open={confirmDismiss !== null}
        title="Dismiss this lab candidate?"
        body="The dismissal is recorded in the decision history (append-only) — it is not silently deleted."
        confirmLabel="Dismiss"
        destructive
        onConfirm={() => {
          if (confirmDismiss) decide(confirmDismiss, "dismiss");
          setConfirmDismiss(null);
        }}
        onCancel={() => setConfirmDismiss(null)}
      />
    </Card>
  );
}

/* -------------------------------------------------------- protocol drafts */

function ProtocolDraftForm({
  forSubmission,
  onClose,
}: {
  forSubmission: AssessmentSubmission;
  onClose: () => void;
}) {
  const products = listDraftableProducts();
  const [name, setName] = useState("Foundational support");
  const [templateId, setTemplateId] = useState<string>("");
  const [selected, setSelected] = useState<string[]>([]);
  const [scheduleSummary, setScheduleSummary] = useState("AM/PM split; with meals where noted");
  const [recheckPlan, setRecheckPlan] = useState("Recheck symptoms at 4 weeks; labs at 90 days");
  const [startCriteria, setStartCriteria] = useState("Start after practitioner review of screening");
  const [stopCriteria, setStopCriteria] = useState("Stop and message the practice on any adverse reaction");
  const [error, setError] = useState<string | null>(null);

  const applyTemplate = (id: string) => {
    setTemplateId(id);
    const t = PROTOCOL_TEMPLATES.find((x) => x.id === id);
    if (t) {
      setName(t.name.replace(" (draft template)", ""));
      setSelected(t.items.map((i) => i.supplementId));
    }
  };

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <Card className="border-action/40 p-4" data-testid="protocol-draft-form">
      <PanelTitle
        icon={<Layers size={15} strokeWidth={1.75} aria-hidden />}
        title={`New protocol draft — ${forSubmission.patientName}`}
      />
      <p className="mb-3 text-[11.5px] leading-4.5 text-ink-3">
        Drafts may use pending-verification products; APPROVAL is blocked until the owner verifies
        them (enforced by the database, mirrored here). Unknown products are rejected outright.
      </p>

      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-[11px] font-semibold text-ink-2" htmlFor="pd-name">
            Protocol name
          </label>
          <input
            id="pd-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-line bg-card px-2.5 py-2 text-[12.5px]"
          />
        </div>
        <div>
          <label className="mb-1 block text-[11px] font-semibold text-ink-2" htmlFor="pd-template">
            Start from template
          </label>
          <select
            id="pd-template"
            value={templateId}
            onChange={(e) => applyTemplate(e.target.value)}
            className="w-full rounded-lg border border-line bg-card px-2.5 py-2 text-[12.5px]"
          >
            <option value="">— none —</option>
            {PROTOCOL_TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <p className="mt-3 mb-1 text-[11px] font-semibold text-ink-2">
        Registry products ({selected.length} selected)
      </p>
      <div className="grid max-h-56 gap-1 overflow-y-auto rounded-lg border border-line p-2 sm:grid-cols-2">
        {products.map((p) => (
          <label key={p.id} className="flex items-start gap-2 text-[12px] text-ink-2">
            <input
              type="checkbox"
              checked={selected.includes(p.id)}
              onChange={() => toggle(p.id)}
              className="mt-0.5"
            />
            <span>
              <span className="font-semibold text-ink-1">{p.name}</span> ({p.brand}) — {p.doseText}{" "}
              <Pill tone="warning">pending verification</Pill>
            </span>
          </label>
        ))}
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {(
          [
            ["Schedule summary", scheduleSummary, setScheduleSummary],
            ["Recheck plan", recheckPlan, setRecheckPlan],
            ["Start criteria", startCriteria, setStartCriteria],
            ["Stop criteria", stopCriteria, setStopCriteria],
          ] as const
        ).map(([label, value, set]) => (
          <div key={label}>
            <label className="mb-1 block text-[11px] font-semibold text-ink-2" htmlFor={`pd-${label}`}>
              {label}
            </label>
            <input
              id={`pd-${label}`}
              value={value}
              onChange={(e) => set(e.target.value)}
              className="w-full rounded-lg border border-line bg-card px-2.5 py-2 text-[12.5px]"
            />
          </div>
        ))}
      </div>

      {error && (
        <p className="mt-2 text-[12px] font-semibold text-critical" role="alert">
          {error}
        </p>
      )}

      <div className="mt-3 flex items-center gap-2">
        <Btn
          onClick={() => {
            try {
              createProtocolDraft({
                patientId: forSubmission.patientId,
                submissionId: forSubmission.id,
                name: name.trim() || "Untitled protocol",
                templateId: templateId || undefined,
                productIds: selected,
                scheduleSummary,
                recheckPlan,
                startCriteria,
                stopCriteria,
              });
              onClose();
            } catch (e) {
              setError(e instanceof Error ? e.message : "Could not create the draft");
            }
          }}
        >
          Create draft
        </Btn>
        <Btn onClick={onClose}>Cancel</Btn>
      </div>
    </Card>
  );
}

function DraftsPanel() {
  const { drafts } = useAssessmentsState();
  const [blockedFor, setBlockedFor] = useState<Record<string, string>>({});

  if (drafts.length === 0) {
    return (
      <ClinicalEmpty
        icon={<Layers size={20} strokeWidth={1.75} className="text-slate-badge" aria-hidden />}
        title="No protocol drafts"
        message="Draft a protocol from a reviewed submission. Drafts stay drafts until every product is owner-verified."
      />
    );
  }

  return (
    <div className="grid gap-3">
      {drafts.map((d: ProtocolDraft) => (
        <Card key={d.id} className="p-4" data-testid={`draft-${d.id}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13.5px] font-semibold text-ink-1">
                {d.name} <span className="text-ink-3">v{d.version}</span>
              </span>
              <Pill tone={d.status === "draft" ? "action" : "slate"}>
                {d.status === "draft" ? "Draft" : `Superseded by v${d.supersededByVersion}`}
              </Pill>
              <span className="text-[11px] text-ink-3">{d.patientName}</span>
            </div>
            <span className="text-[11px] text-ink-3">
              {new Date(d.createdAt).toLocaleString()}
            </span>
          </div>

          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-[12px]">
              <thead>
                <tr className="text-[10.5px] uppercase tracking-wide text-ink-3">
                  <th className="py-1 pr-3">Product</th>
                  <th className="py-1 pr-3">Approval</th>
                  <th className="py-1 pr-3">Dose</th>
                  <th className="py-1 pr-3">Schedule</th>
                  <th className="py-1 pr-3">Duration</th>
                  <th className="py-1">Monitoring</th>
                </tr>
              </thead>
              <tbody>
                {d.items.map((i) => (
                  <tr key={i.productId} className="border-t border-line">
                    <td className="py-1.5 pr-3 font-semibold text-ink-1">
                      {i.name} <span className="font-normal text-ink-3">({i.brand})</span>
                    </td>
                    <td className="py-1.5 pr-3">
                      <Pill tone={i.approvalState === "approved" ? "positive" : "warning"}>
                        {i.approvalState.replace(/_/g, " ")}
                      </Pill>
                    </td>
                    <td className="py-1.5 pr-3">{i.doseText}</td>
                    <td className="py-1.5 pr-3">{i.schedule}</td>
                    <td className="py-1.5 pr-3">{i.durationDays} days</td>
                    <td className="py-1.5">{i.monitoring}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-2 text-[11.5px] text-ink-3">
            <span className="font-semibold text-ink-2">Schedule:</span> {d.scheduleSummary} ·{" "}
            <span className="font-semibold text-ink-2">Recheck:</span> {d.recheckPlan} ·{" "}
            <span className="font-semibold text-ink-2">Start:</span> {d.startCriteria} ·{" "}
            <span className="font-semibold text-ink-2">Stop:</span> {d.stopCriteria}
          </p>

          {d.status === "draft" && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Btn
                onClick={() => {
                  const res = attemptApproveProtocolDraft(d.id);
                  setBlockedFor((prev) => ({ ...prev, [d.id]: res.reason }));
                }}
              >
                Attempt approval
              </Btn>
            </div>
          )}
          {(blockedFor[d.id] ?? d.approvalBlockedReason) && (
            <p
              className="mt-2 flex items-start gap-1.5 rounded-lg bg-sunken-1 p-2 text-[11.5px] font-medium text-warning"
              role="status"
            >
              <ShieldAlert size={14} strokeWidth={1.75} className="mt-0.5 shrink-0" aria-hidden />
              {blockedFor[d.id] ?? d.approvalBlockedReason}
            </p>
          )}
        </Card>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- library */

function LibraryPanel() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="p-4">
        <PanelTitle
          icon={<FileText size={15} strokeWidth={1.75} aria-hidden />}
          title="Questionnaire & scoring"
        />
        <p className="text-[12px] leading-5 text-ink-2">
          {QUESTIONNAIRE.categories.length} sections · {TOTAL_QUESTIONS} questions ·{" "}
          {QUESTIONNAIRE.version} scored by {QUESTIONNAIRE.scoringVersion}. Special answers
          (NA/unsure/prefer-not) and unanswered questions are excluded from both numerator and
          denominator — a category under {Math.round(QUESTIONNAIRE.interpretation.insufficientDataBelowCompleteness * 100)}%
          completeness reports “insufficient data”, never a fabricated score.
        </p>
        <div className="mt-2">
          <ProvenanceStrip />
        </div>
        <p className="mt-2 text-[11px] italic leading-4 text-ink-3">{SCREENING_DISCLAIMER}</p>
      </Card>

      <Card className="p-4">
        <PanelTitle
          icon={<FlaskConical size={15} strokeWidth={1.75} aria-hidden />}
          title={`Lab catalog (${LAB_CATALOG.length}) & rules (${LAB_RULES.rules.length}, ${LAB_RULES.version})`}
        />
        <ul className="grid gap-1">
          {LAB_CATALOG.map((l) => (
            <li key={l.id} className="flex items-center justify-between gap-2 text-[12px]">
              <span className="text-ink-1">
                {l.panelName}
                {l.vendor ? <span className="text-ink-3"> · {l.vendor}</span> : null}
              </span>
              <span className="flex items-center gap-1.5">
                <Pill tone="slate">{l.kind}</Pill>
                {!l.vendorVerified && <Pill tone="warning">vendor unverified</Pill>}
                {l.orderLink.reviewStatus === "unreviewed" && (
                  <Pill tone="warning">link unreviewed</Pill>
                )}
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="p-4">
        <PanelTitle
          icon={<ClipboardList size={15} strokeWidth={1.75} aria-hidden />}
          title="Supplement registry — approval status"
        />
        <p className="mb-2 text-[12px] leading-5 text-ink-2">
          Authoritative list <span className="font-semibold">not found</span> — all 15 products are
          pending verification (see docs/supplement-reconciliation.md). None can enter an APPROVED
          protocol until the owner reconciles the list.
        </p>
        <ul className="grid gap-1 sm:grid-cols-2">
          {listDraftableProducts().map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-2 text-[12px]">
              <span className="truncate text-ink-1">
                {p.name} <span className="text-ink-3">({p.brand})</span>
              </span>
              <Pill tone="warning">pending</Pill>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="p-4">
        <PanelTitle
          icon={<CheckCircle2 size={15} strokeWidth={1.75} aria-hidden />}
          title="Templates & consents"
        />
        <p className="mb-1 text-[11px] font-semibold text-ink-2">Protocol templates</p>
        <ul className="mb-3 grid gap-1">
          {PROTOCOL_TEMPLATES.map((t) => (
            <li key={t.id} className="text-[12px] text-ink-1">
              {t.name} <span className="text-ink-3">· v{t.version} · {t.items.length} items</span>{" "}
              <Pill tone="slate">{t.status}</Pill>
            </li>
          ))}
        </ul>
        <p className="mb-1 text-[11px] font-semibold text-ink-2">Versioned consents</p>
        <ul className="grid gap-1">
          {CONSENTS.map((c) => (
            <li key={c.id} className="text-[12px] text-ink-1">
              {c.title} <span className="text-ink-3">· {c.version}</span>{" "}
              {c.required ? <Pill tone="action">required</Pill> : <Pill tone="slate">optional</Pill>}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------- workspace */

const TABS = ["Review", "Invitations", "Protocol drafts", "Registry library"];

export function AssessmentsWorkspace() {
  const { submissions } = useAssessmentsState();
  const [tab, setTab] = useState(TABS[0]);
  const [draftFor, setDraftFor] = useState<AssessmentSubmission | null>(null);

  return (
    <div className="mx-auto grid w-full max-w-[1200px] gap-4 px-4 pt-4 pb-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[19px] font-bold text-ink-1">Assessments</h1>
          <p className="text-[12px] text-ink-3">
            Governed screening: invitation → onboarding → immutable submission → practitioner
            review → draft recommendations. Demo session, synthetic data only.
          </p>
        </div>
        <ProvenanceStrip />
      </div>

      <SegmentedControl
        options={TABS}
        value={tab}
        onChange={setTab}
        ariaLabel="Assessment workspace sections"
      />

      {tab === "Review" && (
        <div className="grid gap-3">
          {draftFor && (
            <ProtocolDraftForm forSubmission={draftFor} onClose={() => setDraftFor(null)} />
          )}
          {submissions.length === 0 ? (
            <ClinicalEmpty
              icon={
                <ClipboardList size={20} strokeWidth={1.75} className="text-slate-badge" aria-hidden />
              }
              title="No submissions to review"
              message="Send an invitation and simulate the patient submission to see the full review loop."
            />
          ) : (
            submissions.map((sub) => (
              <SubmissionCard key={sub.id} sub={sub} onDraftProtocol={setDraftFor} />
            ))
          )}
        </div>
      )}

      {tab === "Invitations" && <InvitationsPanel />}
      {tab === "Protocol drafts" && <DraftsPanel />}
      {tab === "Registry library" && <LibraryPanel />}
    </div>
  );
}
