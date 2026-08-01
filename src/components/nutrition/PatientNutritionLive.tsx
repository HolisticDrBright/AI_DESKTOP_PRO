"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/adapters";
import { AdapterError } from "@/adapters/errors";
import type {
  LiveNutritionAdherenceSummary,
  LiveNutritionCopilotDraft,
  LiveNutritionPlan,
  LiveNutritionPlanVersion,
  LiveNutritionTemplateLibrary,
  LiveNutritionVersionContent,
  LivePatientNutrition,
} from "@/adapters/live-types";
import { Card, CardTitle } from "@/components/ui/bits";
import { Btn } from "@/components/ui/Btn";
import { Metric } from "@/components/ui/Metric";
import { TableWrap, TD, TH } from "@/components/ui/Table";
import { Field, Select, TextInput } from "@/components/ui/Field";
import {
  ClinicalEmpty,
  ClinicalError,
  ClinicalLoading,
  ClinicalNote,
} from "@/components/ui/ClinicalStates";
import { useFeedback } from "@/lib/feedback";
import { cn } from "@/lib/cn";

function errText(e: unknown): string {
  return e instanceof AdapterError ? e.message : "Something went wrong. Try again.";
}

function fmtDate(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const STATUS_TONE: Record<string, string> = {
  draft: "bg-slate-tint text-slate-badge",
  in_review: "bg-action-tint text-action-deep",
  approved: "bg-action-tint text-action-deep",
  active: "bg-positive-tint text-positive-deep",
  paused: "bg-warning-tint text-warning-deep",
  completed: "bg-slate-tint text-slate-badge",
  discontinued: "bg-slate-tint text-slate-badge",
  superseded: "bg-slate-tint text-slate-badge",
};

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-xs font-medium",
        STATUS_TONE[status] ?? "bg-slate-tint text-slate-badge",
      )}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

/**
 * A patient's nutrition: assessment, plan versions, the safety review, and
 * adherence.
 *
 * Two things this screen deliberately does not do. It does not decide whether
 * a plan may be approved — it asks, and the database answers, so a refusal is
 * a real refusal rather than a disabled button. And it never fills in a number
 * the practitioner did not enter: a day with no check-in is shown as missing,
 * not as zero adherence.
 */
export function PatientNutritionLive({ patientId }: { patientId: string }) {
  const { announce } = useFeedback();
  const [data, setData] = useState<LivePatientNutrition | null>(null);
  const [library, setLibrary] = useState<LiveNutritionTemplateLibrary | null>(null);
  const [adherence, setAdherence] = useState<LiveNutritionAdherenceSummary | null>(null);
  const [content, setContent] = useState<LiveNutritionVersionContent | null>(null);
  const [draft, setDraft] = useState<LiveNutritionCopilotDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [openVersionId, setOpenVersionId] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [newTemplateVersionId, setNewTemplateVersionId] = useState("");
  const [overrideFor, setOverrideFor] = useState<string | null>(null);
  const [overrideReason, setOverrideReason] = useState("");
  const [reviseReason, setReviseReason] = useState("");
  const [checkinDate, setCheckinDate] = useState("");
  const [checkinAdherence, setCheckinAdherence] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      const [d, lib, adh] = await Promise.all([
        api.nutrition.forPatient(patientId),
        api.nutrition.templates(false).catch(() => null),
        api.nutrition.adherence(patientId, 30).catch(() => null),
      ]);
      setData(d);
      setLibrary(lib);
      setAdherence(adh);
    } catch (e) {
      setError(errText(e));
    }
  }, [patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const activePlan: LiveNutritionPlan | null = useMemo(
    () => data?.plans.find((p) => p.status === "active") ?? data?.plans[0] ?? null,
    [data],
  );
  const currentVersion: LiveNutritionPlanVersion | null = useMemo(() => {
    if (!activePlan) return null;
    return (
      activePlan.versions.find((v) => v.id === activePlan.currentVersionId) ??
      activePlan.versions[0] ??
      null
    );
  }, [activePlan]);

  const openVersion = useMemo(() => {
    if (!data) return null;
    const all = data.plans.flatMap((p) => p.versions);
    return all.find((v) => v.id === openVersionId) ?? null;
  }, [data, openVersionId]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      announce(label);
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function openContent(versionId: string) {
    setOpenVersionId(versionId);
    setContent(null);
    setDraft(null);
    try {
      setContent(await api.nutrition.versionContent({ planVersionId: versionId }));
    } catch (e) {
      setError(errText(e));
    }
  }

  if (error && !data) return <ClinicalError message={error} onRetry={() => void load()} />;
  if (!data) return <ClinicalLoading label="Loading nutrition" />;

  const publishedVersions = (library?.templates ?? []).flatMap((t) =>
    t.versions
      .filter((v) => v.status === "published")
      .map((v) => ({ id: v.id, label: `${t.name} · v${v.versionNumber}` })),
  );

  const blockingOpen =
    openVersion?.safetyFlags.filter(
      (f) => f.severity === "blocking" && (f.status === "open" || f.status === "acknowledged"),
    ) ?? [];

  return (
    <div className="space-y-4">
      {error ? <ClinicalError message={error} onRetry={() => void load()} /> : null}

      {/* ------------------------------------------------ adherence */}
      <Card>
        <CardTitle>Adherence — last 30 days</CardTitle>
        {adherence ? (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Metric label="Days reported" value={String(adherence.daysReported)} />
              <Metric label="Days missing" value={String(adherence.daysMissing)} />
              <Metric
                label="Mean meal-plan adherence"
                value={
                  adherence.meanMealPlanAdherencePct === null
                    ? "Not reported"
                    : `${adherence.meanMealPlanAdherencePct}%`
                }
              />
              <Metric label="Needs follow-up" value={String(adherence.needsFollowup)} />
            </div>
            <ClinicalNote>
              Averages cover only the days a check-in was actually recorded. A day with
              no check-in is counted as missing, never as zero adherence — this screen
              does not turn silence into a finding.
            </ClinicalNote>
          </>
        ) : (
          <ClinicalEmpty title="No adherence data yet" message="Nothing has been reported for this patient in the last 30 days." />
        )}
      </Card>

      {/* ------------------------------------------------ record a check-in */}
      <Card>
        <CardTitle>Record a check-in</CardTitle>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Date observed">
            <TextInput
              type="date"
              value={checkinDate}
              onChange={(e) => setCheckinDate(e.target.value)}
            />
          </Field>
          <Field label="Meal-plan adherence (%)">
            <TextInput
              inputMode="numeric"
              value={checkinAdherence}
              onChange={(e) => setCheckinAdherence(e.target.value)}
              placeholder="Leave blank if not reported"
            />
          </Field>
          <div className="flex items-end">
            <Btn
              disabled={busy || !checkinDate}
              onClick={() =>
                void run("Check-in recorded", () =>
                  api.nutrition.recordCheckin({
                    patientId,
                    observedOn: checkinDate,
                    // Recorded by the practitioner in the room. The source is
                    // stated rather than assumed, because adherence data with
                    // no origin cannot be interpreted later.
                    source: "practitioner_recorded",
                    planVersionId: currentVersion?.id ?? null,
                    mealPlanAdherencePct:
                      checkinAdherence.trim() === "" ? null : Number(checkinAdherence),
                  }),
                )
              }
            >
              Record check-in
            </Btn>
          </div>
        </div>
        <ClinicalNote>
          Recorded as practitioner-reported. Leaving adherence blank records that it
          was not reported, which is different from recording zero.
        </ClinicalNote>
      </Card>

      {/* ------------------------------------------------ start a plan */}
      <Card>
        <CardTitle>Start a nutrition plan</CardTitle>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Plan title">
            <TextInput
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="e.g. Digestive symptom investigation"
            />
          </Field>
          <Field label="Start from a published template">
            <Select
              value={newTemplateVersionId}
              onChange={(e) => setNewTemplateVersionId(e.target.value)}
            >
              <option value="">Blank plan</option>
              {publishedVersions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex items-end">
            <Btn
              disabled={busy || !newTitle.trim()}
              onClick={() =>
                void run("Plan created", async () => {
                  await api.nutrition.createPlan({
                    patientId,
                    title: newTitle,
                    sourceTemplateVersionId: newTemplateVersionId || null,
                  });
                  setNewTitle("");
                  setNewTemplateVersionId("");
                })
              }
            >
              Create draft plan
            </Btn>
          </div>
        </div>
        <ClinicalNote>
          A template is copied into the plan as a snapshot. Editing that template
          later never changes a plan this patient already has.
        </ClinicalNote>
      </Card>

      {/* ------------------------------------------------ plans */}
      {data.plans.length === 0 ? (
        <ClinicalEmpty title="No nutrition plan yet" message="Create a draft plan above to begin." />
      ) : null}

      {data.plans.map((plan) => (
        <Card key={plan.id}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>{plan.title}</CardTitle>
            <StatusPill status={plan.status} />
          </div>

          <TableWrap>
            <thead>
              <tr>
                <TH>Version</TH>
                <TH>Status</TH>
                <TH>Source template</TH>
                <TH>Safety</TH>
                <TH>Approved</TH>
                <TH>Actions</TH>
              </tr>
            </thead>
            <tbody>
              {plan.versions.map((v) => (
                <tr key={v.id}>
                  <TD>v{v.versionNumber}</TD>
                  <TD>
                    <StatusPill status={v.status} />
                  </TD>
                  <TD>
                    {v.sourceTemplateName
                      ? `${v.sourceTemplateName} v${v.sourceTemplateVersion ?? "?"}`
                      : "Authored here"}
                  </TD>
                  <TD>
                    {v.safetyEvaluated
                      ? `${v.safetyFlags.filter((f) => f.severity === "blocking").length} blocking · ${
                          v.safetyFlags.filter((f) => f.severity === "review").length
                        } review`
                      : "Not run"}
                  </TD>
                  <TD>{fmtDate(v.approvedAt)}</TD>
                  <TD>
                    <div className="flex flex-wrap gap-2">
                      <Btn variant="ghost" onClick={() => void openContent(v.id)}>
                        Open
                      </Btn>
                      {v.status === "draft" ? (
                        <>
                          <Btn
                            variant="ghost"
                            disabled={busy}
                            onClick={() =>
                              void run("Safety review run", () =>
                                api.nutrition.evaluateSafety(v.id),
                              )
                            }
                          >
                            Run safety review
                          </Btn>
                          <Btn
                            variant="ghost"
                            disabled={busy}
                            onClick={() =>
                              void run("Submitted for review", () => api.nutrition.submit(v.id))
                            }
                          >
                            Submit
                          </Btn>
                        </>
                      ) : null}
                      {v.status === "in_review" ? (
                        <Btn
                          disabled={busy}
                          onClick={() =>
                            void run("Approved", () =>
                              api.nutrition.approve({ planVersionId: v.id }),
                            )
                          }
                        >
                          Approve
                        </Btn>
                      ) : null}
                      {v.status === "approved" ? (
                        <Btn
                          disabled={busy}
                          onClick={() =>
                            void run("Activated", () => api.nutrition.activate(v.id))
                          }
                        >
                          Activate
                        </Btn>
                      ) : null}
                    </div>
                  </TD>
                </tr>
              ))}
            </tbody>
          </TableWrap>

          {plan.status === "active" ? (
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <Field label="Reason for revision">
                <TextInput
                  value={reviseReason}
                  onChange={(e) => setReviseReason(e.target.value)}
                  placeholder="What changed, and why"
                />
              </Field>
              <Btn
                variant="ghost"
                disabled={busy || !reviseReason.trim() || !plan.currentVersionId}
                onClick={() =>
                  void run("Revision drafted", async () => {
                    await api.nutrition.revise({
                      planVersionId: plan.currentVersionId as string,
                      reason: reviseReason,
                    });
                    setReviseReason("");
                  })
                }
              >
                Revise into a new draft
              </Btn>
              <Btn
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void run("Plan paused", () =>
                    api.nutrition.lifecycle({ planId: plan.id, action: "pause" }),
                  )
                }
              >
                Pause
              </Btn>
            </div>
          ) : null}

          {plan.status === "active" ? (
            <ClinicalNote>
              Revising creates a new draft version. The version this patient is
              following now is never edited or overwritten — it stays readable
              exactly as it was approved.
            </ClinicalNote>
          ) : null}
        </Card>
      ))}

      {/* ------------------------------------------------ open version */}
      {openVersion ? (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Version {openVersion.versionNumber} — safety review</CardTitle>
            <StatusPill status={openVersion.status} />
          </div>

          {!openVersion.safetyEvaluated ? (
            <ClinicalNote>
              Safety review has not been run for this version. It cannot be
              approved until it has — the check is in the database, so it holds
              however this screen behaves.
            </ClinicalNote>
          ) : null}

          {openVersion.safetyFlags.length === 0 ? (
            <ClinicalEmpty title="No safety flags" message="The safety review raised nothing on this version." />
          ) : (
            <TableWrap>
              <thead>
                <tr>
                  <TH>Flag</TH>
                  <TH>Severity</TH>
                  <TH>Detail</TH>
                  <TH>Status</TH>
                  <TH>Actions</TH>
                </tr>
              </thead>
              <tbody>
                {openVersion.safetyFlags.map((f) => (
                  <tr key={f.id}>
                    <TD>{f.kind.replace(/_/g, " ")}</TD>
                    <TD>
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-xs font-medium",
                          f.severity === "blocking"
                            ? "bg-critical-tint text-critical"
                            : "bg-warning-tint text-warning-deep",
                        )}
                      >
                        {f.severity}
                      </span>
                    </TD>
                    <TD>{f.detail}</TD>
                    <TD>
                      {f.status}
                      {f.overrideReason ? (
                        <div className="text-xs text-slate-badge">“{f.overrideReason}”</div>
                      ) : null}
                    </TD>
                    <TD>
                      {f.status === "open" || f.status === "acknowledged" ? (
                        overrideFor === f.id ? (
                          <div className="flex flex-wrap items-end gap-2">
                            <Field label="Reason for override">
                              <TextInput
                                value={overrideReason}
                                onChange={(e) => setOverrideReason(e.target.value)}
                                placeholder="Required — recorded against your name"
                              />
                            </Field>
                            <Btn
                              disabled={busy || !overrideReason.trim()}
                              onClick={() =>
                                void run("Override recorded", async () => {
                                  await api.nutrition.resolveSafetyFlag({
                                    flagId: f.id,
                                    action: "override",
                                    reason: overrideReason,
                                  });
                                  setOverrideFor(null);
                                  setOverrideReason("");
                                  await openContent(openVersion.id);
                                })
                              }
                            >
                              Record override
                            </Btn>
                          </div>
                        ) : (
                          <div className="flex flex-wrap gap-2">
                            <Btn variant="ghost" onClick={() => setOverrideFor(f.id)}>
                              Override with reason
                            </Btn>
                            <Btn
                              variant="ghost"
                              disabled={busy}
                              onClick={() =>
                                void run("Flag resolved", async () => {
                                  await api.nutrition.resolveSafetyFlag({
                                    flagId: f.id,
                                    action: "resolve",
                                  });
                                  await openContent(openVersion.id);
                                })
                              }
                            >
                              Resolve
                            </Btn>
                          </div>
                        )
                      ) : (
                        "—"
                      )}
                    </TD>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}

          {blockingOpen.length > 0 ? (
            <ClinicalNote>
              {blockingOpen.length} blocking flag
              {blockingOpen.length === 1 ? "" : "s"} still unresolved. Approval will be
              refused until each is resolved or overridden with a reason.
              Acknowledging one is not the same as deciding about it.
            </ClinicalNote>
          ) : null}

          {/* --------------------------------- assessment constraints */}
          <div className="mt-4">
            <CardTitle>Assessment</CardTitle>
            {openVersion.constraints.length === 0 ? (
              <ClinicalEmpty title="No assessment recorded" message="Nothing is recorded about allergies, intolerances, access or cooking ability." />
            ) : (
              <ul className="space-y-1 text-sm">
                {openVersion.constraints.map((c) => (
                  <li key={c.id}>
                    <span className="font-medium">{c.kind.replace(/_/g, " ")}:</span> {c.label}
                    {c.severity ? ` (${c.severity})` : ""}{" "}
                    <span className="text-xs text-slate-badge">via {c.source.replace(/_/g, " ")}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* --------------------------------- targets and content */}
          <div className="mt-4">
            <CardTitle>Targets</CardTitle>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Metric
                label="Daily energy"
                value={
                  openVersion.energyTargetValue === null
                    ? "Not set"
                    : `${openVersion.energyTargetValue} ${openVersion.energyTargetUnit ?? ""}`
                }
              />
              <Metric
                label="Protein"
                value={openVersion.proteinG === null ? "Not set" : `${openVersion.proteinG} g`}
              />
              <Metric
                label="Carbohydrate"
                value={
                  openVersion.carbohydrateG === null ? "Not set" : `${openVersion.carbohydrateG} g`
                }
              />
              <Metric
                label="Fat"
                value={openVersion.fatG === null ? "Not set" : `${openVersion.fatG} g`}
              />
            </div>
            <ClinicalNote>
              Every nutrition number on this screen carries its unit. A target that
              was never set reads &ldquo;Not set&rdquo; rather than zero.
            </ClinicalNote>
          </div>

          {content ? (
            <div className="mt-4">
              <CardTitle>Food guidance</CardTitle>
              {content.foodRules.length === 0 ? (
                <ClinicalEmpty title="No food guidance" message="This version carries no food rules yet." />
              ) : (
                <ul className="space-y-1 text-sm">
                  {content.foodRules.map((r) => (
                    <li key={r.id}>
                      <span className="font-medium">{r.disposition}:</span> {r.label}
                      {r.conditionNote ? (
                        <span className="text-xs text-slate-badge"> — {r.conditionNote}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}

          {/* --------------------------------- copilot */}
          <div className="mt-4">
            <CardTitle>Copilot draft</CardTitle>
            <Btn
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void (async () => {
                  setError(null);
                  try {
                    setDraft(
                      await api.nutrition.copilotDraft({
                        planVersionId: openVersion.id,
                        patientId,
                      }),
                    );
                  } catch (e) {
                    setError(errText(e));
                  }
                })()
              }
            >
              Draft suggestions
            </Btn>
            {draft ? (
              <div className="mt-3 space-y-2">
                <ClinicalNote>{draft.disclaimer}</ClinicalNote>
                <ul className="space-y-2 text-sm">
                  {draft.suggestions.map((s, i) => (
                    <li key={`${s.kind}-${i}`} className="rounded border border-line p-2">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{s.title}</span>
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 text-xs",
                            s.severity === "attention"
                              ? "bg-warning-tint text-warning-deep"
                              : "bg-slate-tint text-slate-badge",
                          )}
                        >
                          draft
                        </span>
                      </div>
                      <div className="text-xs text-slate-badge">{s.rationale}</div>
                      <div className="text-xs text-slate-badge">From: {s.derivedFrom}</div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>

          {openVersion.amendments.length > 0 ? (
            <div className="mt-4">
              <CardTitle>Amendments</CardTitle>
              <ul className="space-y-1 text-sm">
                {openVersion.amendments.map((a) => (
                  <li key={a.number}>
                    <span className="font-medium">#{a.number}</span> {a.body}
                    <span className="text-xs text-slate-badge"> — {a.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>
      ) : null}

      {/* ------------------------------------------------ check-ins */}
      <Card>
        <CardTitle>Check-ins</CardTitle>
        {data.checkins.length === 0 ? (
          <ClinicalEmpty title="No check-ins recorded" message="Adherence is only ever what someone reported, so there is nothing to show yet." />
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <TH>Date</TH>
                <TH>Source</TH>
                <TH>Meal-plan adherence</TH>
                <TH>Digestive tolerance</TH>
                <TH>Review</TH>
                <TH>Actions</TH>
              </tr>
            </thead>
            <tbody>
              {data.checkins.map((c) => (
                <tr key={c.id}>
                  <TD>{fmtDate(c.observedOn)}</TD>
                  <TD>{c.source.replace(/_/g, " ")}</TD>
                  <TD>
                    {c.mealPlanAdherencePct === null ? "Not reported" : `${c.mealPlanAdherencePct}%`}
                  </TD>
                  <TD>{c.digestiveTolerance === null ? "Not reported" : c.digestiveTolerance}</TD>
                  <TD>{c.reviewState.replace(/_/g, " ")}</TD>
                  <TD>
                    {c.reviewState === "unreviewed" ? (
                      <div className="flex flex-wrap gap-2">
                        <Btn
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            void run("Marked reviewed", () =>
                              api.nutrition.reviewCheckin({ checkinId: c.id, state: "reviewed" }),
                            )
                          }
                        >
                          Reviewed
                        </Btn>
                        <Btn
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            void run("Flagged for follow-up", () =>
                              api.nutrition.reviewCheckin({
                                checkinId: c.id,
                                state: "needs_followup",
                              }),
                            )
                          }
                        >
                          Follow up
                        </Btn>
                      </div>
                    ) : (
                      "—"
                    )}
                  </TD>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}
