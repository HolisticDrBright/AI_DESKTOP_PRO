"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/adapters";
import { AdapterError } from "@/adapters/errors";
import type {
  LivePackageKind,
  LivePlanLibrary,
  LivePlanType,
  LiveStripeStatus,
} from "@/adapters/live-types";
import { Card, CardTitle } from "@/components/ui/bits";
import { Btn } from "@/components/ui/Btn";
import { TableWrap, TD, TH } from "@/components/ui/Table";
import { Field, Select, TextInput } from "@/components/ui/Field";
import { ClinicalError, ClinicalLoading, ClinicalNote } from "@/components/ui/ClinicalStates";
import { useFeedback } from "@/lib/feedback";
import { formatMinor, parseToMinor } from "@/lib/money";
import { cn } from "@/lib/cn";

function errText(e: unknown): string {
  return e instanceof AdapterError ? e.message : "Something went wrong. Try again.";
}

const PACKAGE_KINDS: LivePackageKind[] = [
  "visit_credits", "product_bundle", "lab_bundle", "program_bundle", "mixed",
];

const INTERVALS = [
  { id: "month", count: 1, label: "Monthly" },
  { id: "month", count: 3, label: "Quarterly" },
  { id: "year", count: 1, label: "Annual" },
  { id: "week", count: 1, label: "Weekly (custom)" },
];

function versionTone(status: string): string {
  if (status === "published") return "bg-positive-tint text-positive-deep";
  if (status === "retired") return "bg-slate-tint text-slate-badge";
  return "bg-warning-tint text-warning-deep";
}

/**
 * Packages and memberships: the org's commercial offerings.
 *
 * Terms live on a VERSION. Publishing freezes them, so an accepted plan can
 * never be rewritten under the patient — this screen surfaces that by showing
 * every version and its state rather than a single editable price.
 */
export function PlansWorkspace() {
  const { announce } = useFeedback();
  const [library, setLibrary] = useState<LivePlanLibrary | null>(null);
  const [stripe, setStripe] = useState<LiveStripeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [includeArchived, setIncludeArchived] = useState(false);

  const [planType, setPlanType] = useState<LivePlanType>("package");
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<LivePackageKind>("visit_credits");

  const [versionFor, setVersionFor] = useState<{ id: string; type: LivePlanType; name: string } | null>(null);
  const [price, setPrice] = useState("");
  const [credits, setCredits] = useState("10");
  const [expiresDays, setExpiresDays] = useState("365");
  const [intervalIdx, setIntervalIdx] = useState(0);
  const [trialDays, setTrialDays] = useState("0");
  const [includedCredits, setIncludedCredits] = useState("2");
  const [commitment, setCommitment] = useState("0");
  const [grace, setGrace] = useState("7");
  const [terms, setTerms] = useState("");

  const load = useCallback(async (archived: boolean) => {
    setError(null);
    try {
      const [lib, st] = await Promise.all([
        api.plans.library(archived),
        api.plans.stripeStatus().catch(() => null),
      ]);
      setLibrary(lib);
      setStripe(st);
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  useEffect(() => {
    void load(includeArchived);
  }, [includeArchived, load]);

  const run = useCallback(
    async (fn: () => Promise<unknown>, message: string) => {
      if (busy) return;
      setBusy(true);
      try {
        await fn();
        announce(message);
        await load(includeArchived);
      } catch (e) {
        announce(errText(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, announce, load, includeArchived],
  );

  if (error && !library) {
    return <ClinicalError message={error} onRetry={() => void load(includeArchived)} />;
  }
  if (!library) return <ClinicalLoading label="Loading plans…" />;

  const plans =
    planType === "package"
      ? library.packages.map((p) => ({ ...p, type: "package" as const, kind: p.kind }))
      : library.memberships.map((m) => ({ ...m, type: "membership" as const, kind: null }));

  return (
    <div className="flex flex-col gap-4" data-testid="plans-workspace">
      {stripe && !stripe.configured && (
        <ClinicalNote>
          <span data-testid="stripe-status-note">
            No payment processor is connected ({stripe.problems[0] ?? "not configured"}).
            Packages, memberships, complimentary assignment, and credit redemption all
            work without one — only recurring card collection needs it.
          </span>
        </ClinicalNote>
      )}
      {stripe?.configured && !stripe.liveTransactionExecuted && (
        <ClinicalNote>
          <span data-testid="stripe-status-note">
            Stripe test mode is configured, but no Stripe API transaction has run in
            this deployment yet. Configuration is not proof the integration works.
          </span>
        </ClinicalNote>
      )}

      <Card className="p-[14px]">
        <CardTitle>Create an offering</CardTitle>
        <div className="mt-[10px] flex flex-wrap items-end gap-2">
          <Field label="Type" className="min-w-[150px]">
            <Select
              value={planType}
              data-testid="plan-type"
              onChange={(e) => setPlanType(e.target.value as LivePlanType)}
            >
              <option value="package">Package</option>
              <option value="membership">Membership</option>
            </Select>
          </Field>
          <Field label="Name" className="min-w-[220px]">
            <TextInput
              value={newName}
              data-testid="plan-name"
              onChange={(e) => setNewName(e.target.value)}
            />
          </Field>
          {planType === "package" && (
            <Field label="Bundle kind" className="min-w-[160px]">
              <Select
                value={newKind}
                data-testid="plan-kind"
                onChange={(e) => setNewKind(e.target.value as LivePackageKind)}
              >
                {PACKAGE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k.replace("_", " ")}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Btn
            variant="primary"
            disabled={busy}
            data-testid="plan-create"
            onClick={() => {
              if (!newName.trim()) {
                announce("An offering needs a name.");
                return;
              }
              void run(
                () =>
                  api.plans.upsert({
                    planType,
                    name: newName.trim(),
                    kind: planType === "package" ? newKind : null,
                  }),
                "Offering created. Add a version to set its terms.",
              ).then(() => setNewName(""));
            }}
          >
            Create
          </Btn>
          <label className="mb-[6px] flex items-center gap-[6px] text-[12.5px] font-medium text-body">
            <input
              type="checkbox"
              checked={includeArchived}
              data-testid="plans-include-archived"
              onChange={(e) => setIncludeArchived(e.target.checked)}
            />
            Show archived
          </label>
        </div>
      </Card>

      <Card className="p-[14px]">
        <CardTitle>{planType === "package" ? "Packages" : "Memberships"}</CardTitle>
        <ClinicalNote>
          Commercial terms belong to a version. Publishing freezes them
          permanently, so a plan a patient already accepted can never be
          rewritten. Archiving hides an offering without touching history.
        </ClinicalNote>

        {plans.length === 0 ? (
          <p className="mt-[10px] mb-0 text-[12.5px] text-subtle" data-testid="plans-empty">
            No {planType === "package" ? "packages" : "memberships"} yet.
          </p>
        ) : (
          <TableWrap className="mt-[10px]">
            <thead>
              <tr>
                <TH>Name</TH>
                <TH>Status</TH>
                <TH>Versions</TH>
                <TH>Current terms</TH>
                <TH />
              </tr>
            </thead>
            <tbody data-testid="plans-rows">
              {plans.map((p) => {
                const current = p.versions.find((v) => v.id === p.currentVersionId);
                return (
                  <tr key={p.id}>
                    <TD className="font-medium">{p.name}</TD>
                    <TD className="text-muted">{p.status}</TD>
                    <TD>
                      <div className="flex flex-wrap gap-[4px]">
                        {p.versions.length === 0 ? (
                          <span className="text-[11.5px] text-faint">none</span>
                        ) : (
                          p.versions.map((v) => (
                            <span
                              key={v.id}
                              data-testid={`plan-version-${v.id}`}
                              className={cn(
                                "inline-flex items-center rounded-full px-[7px] py-px text-[11px] font-semibold",
                                versionTone(v.status),
                              )}
                            >
                              v{v.versionNumber} {v.status}
                            </span>
                          ))
                        )}
                      </div>
                    </TD>
                    <TD className="tabular-nums">
                      {current ? (
                        <>
                          {formatMinor(current.priceMinor)}
                          {"creditQuantity" in current && current.creditQuantity
                            ? ` · ${current.creditQuantity} credits`
                            : ""}
                          {"intervalUnit" in current
                            ? ` · every ${current.intervalCount} ${current.intervalUnit}`
                            : ""}
                        </>
                      ) : (
                        <span className="text-[11.5px] text-faint">not published</span>
                      )}
                    </TD>
                    <TD className="text-right">
                      <div className="flex justify-end gap-[6px]">
                        <Btn
                          variant="ghost"
                          size="sm"
                          data-testid={`plan-add-version-${p.id}`}
                          onClick={() =>
                            setVersionFor({ id: p.id, type: p.type, name: p.name })
                          }
                        >
                          New version
                        </Btn>
                        {p.versions.some((v) => v.status === "draft") && (
                          <Btn
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            data-testid={`plan-publish-${p.id}`}
                            onClick={() => {
                              const draft = p.versions.find((v) => v.status === "draft");
                              if (!draft) return;
                              void run(
                                () =>
                                  api.plans.publishVersion({
                                    planType: p.type,
                                    versionId: draft.id,
                                  }),
                                "Version published. Its terms are now frozen.",
                              );
                            }}
                          >
                            Publish draft
                          </Btn>
                        )}
                        {p.status !== "archived" && (
                          <Btn
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            data-testid={`plan-archive-${p.id}`}
                            onClick={() =>
                              void run(
                                () =>
                                  api.plans.upsert({
                                    planType: p.type,
                                    id: p.id,
                                    expectedVersion: p.version,
                                    archive: true,
                                  }),
                                "Offering archived. Past purchases are unchanged.",
                              )
                            }
                          >
                            Archive
                          </Btn>
                        )}
                      </div>
                    </TD>
                  </tr>
                );
              })}
            </tbody>
          </TableWrap>
        )}
      </Card>

      {versionFor && (
        <Card className="p-[14px]" data-testid="plan-version-panel">
          <div className="flex items-start justify-between gap-2">
            <CardTitle>New version — {versionFor.name}</CardTitle>
            <Btn variant="ghost" size="sm" onClick={() => setVersionFor(null)}>
              Close
            </Btn>
          </div>
          <div className="mt-[10px] flex flex-wrap items-end gap-2">
            <Field label="Price" className="min-w-[120px]">
              <TextInput
                value={price}
                placeholder="$0.00"
                data-testid="version-price"
                onChange={(e) => setPrice(e.target.value)}
              />
            </Field>
            {versionFor.type === "package" ? (
              <>
                <Field label="Credits" className="min-w-[100px]">
                  <TextInput
                    type="number"
                    min={0}
                    value={credits}
                    data-testid="version-credits"
                    onChange={(e) => setCredits(e.target.value)}
                  />
                </Field>
                <Field label="Expires after (days)" className="min-w-[140px]">
                  <TextInput
                    type="number"
                    min={1}
                    value={expiresDays}
                    data-testid="version-expires"
                    onChange={(e) => setExpiresDays(e.target.value)}
                  />
                </Field>
              </>
            ) : (
              <>
                <Field label="Interval" className="min-w-[150px]">
                  <Select
                    value={String(intervalIdx)}
                    data-testid="version-interval"
                    onChange={(e) => setIntervalIdx(Number(e.target.value))}
                  >
                    {INTERVALS.map((i, idx) => (
                      <option key={i.label} value={idx}>
                        {i.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Trial days" className="min-w-[100px]">
                  <TextInput
                    type="number"
                    min={0}
                    value={trialDays}
                    data-testid="version-trial"
                    onChange={(e) => setTrialDays(e.target.value)}
                  />
                </Field>
                <Field label="Credits / period" className="min-w-[120px]">
                  <TextInput
                    type="number"
                    min={0}
                    value={includedCredits}
                    data-testid="version-included"
                    onChange={(e) => setIncludedCredits(e.target.value)}
                  />
                </Field>
                <Field label="Commitment periods" className="min-w-[130px]">
                  <TextInput
                    type="number"
                    min={0}
                    value={commitment}
                    data-testid="version-commitment"
                    onChange={(e) => setCommitment(e.target.value)}
                  />
                </Field>
                <Field label="Grace days" className="min-w-[110px]">
                  <TextInput
                    type="number"
                    min={0}
                    value={grace}
                    data-testid="version-grace"
                    onChange={(e) => setGrace(e.target.value)}
                  />
                </Field>
              </>
            )}
            <Field label="Terms summary" className="min-w-[220px]">
              <TextInput
                value={terms}
                data-testid="version-terms"
                onChange={(e) => setTerms(e.target.value)}
              />
            </Field>
            <Btn
              variant="primary"
              disabled={busy}
              data-testid="version-create"
              onClick={() => {
                const priceMinor = parseToMinor(price);
                if (priceMinor === null) {
                  announce("Enter a price for this version.");
                  return;
                }
                const iv = INTERVALS[intervalIdx];
                void run(
                  () =>
                    api.plans.createVersion({
                      planType: versionFor.type,
                      planId: versionFor.id,
                      priceMinor,
                      creditQuantity: Number(credits) || 0,
                      expiresAfterDays: Number(expiresDays) || null,
                      intervalUnit: iv.id,
                      intervalCount: iv.count,
                      trialDays: Number(trialDays) || 0,
                      includedCredits: Number(includedCredits) || 0,
                      minimumCommitmentPeriods: Number(commitment) || 0,
                      gracePeriodDays: Number(grace) || 0,
                      termsSummary: terms || null,
                    }),
                  "Draft version created. Publish it to freeze its terms.",
                ).then(() => {
                  setPrice("");
                  setTerms("");
                  setVersionFor(null);
                });
              }}
            >
              Create draft version
            </Btn>
          </div>
        </Card>
      )}

      <CreditPolicyPanel policy={library.policy} onSaved={() => void load(includeArchived)} />
    </div>
  );
}

/** The org's explicit no-show / late-cancel rule. */
function CreditPolicyPanel({
  policy,
  onSaved,
}: {
  policy: LivePlanLibrary["policy"];
  onSaved: () => void;
}) {
  const { announce } = useFeedback();
  const [busy, setBusy] = useState(false);
  const [noShow, setNoShow] = useState(policy?.no_show_policy ?? "consume");
  const [lateCancel, setLateCancel] = useState(policy?.late_cancel_policy ?? "release");
  const [window, setWindow] = useState(String(policy?.late_cancel_window_hours ?? 24));
  const [consumeOn, setConsumeOn] = useState(policy?.consume_on ?? "completed");

  return (
    <Card className="p-[14px]" data-testid="credit-policy-panel">
      <CardTitle>Credit policy</CardTitle>
      <ClinicalNote>
        What happens to a reserved credit when a visit does not happen is an
        explicit decision, not a default buried in the software.
        {policy ? "" : " This organization has not set one, so the documented defaults apply."}
      </ClinicalNote>
      <div className="mt-[10px] flex flex-wrap items-end gap-2">
        <Field label="No-show" className="min-w-[150px]">
          <Select value={noShow} data-testid="policy-no-show" onChange={(e) => setNoShow(e.target.value as typeof noShow)}>
            <option value="consume">Consume the credit</option>
            <option value="release">Return the credit</option>
            <option value="review">Ask a human</option>
          </Select>
        </Field>
        <Field label="Late cancellation" className="min-w-[150px]">
          <Select
            value={lateCancel}
            data-testid="policy-late-cancel"
            onChange={(e) => setLateCancel(e.target.value as typeof lateCancel)}
          >
            <option value="consume">Consume the credit</option>
            <option value="release">Return the credit</option>
            <option value="review">Ask a human</option>
          </Select>
        </Field>
        <Field label="Late window (hours)" className="min-w-[130px]">
          <TextInput
            type="number"
            min={0}
            value={window}
            data-testid="policy-window"
            onChange={(e) => setWindow(e.target.value)}
          />
        </Field>
        <Field label="Spend the credit on" className="min-w-[150px]">
          <Select
            value={consumeOn}
            data-testid="policy-consume-on"
            onChange={(e) => setConsumeOn(e.target.value as typeof consumeOn)}
          >
            <option value="completed">Visit completed</option>
            <option value="arrived">Patient arrived</option>
          </Select>
        </Field>
        <Btn
          variant="outline"
          disabled={busy}
          data-testid="policy-save"
          onClick={() => {
            setBusy(true);
            api.plans
              .setPolicy({
                noShowPolicy: noShow,
                lateCancelPolicy: lateCancel,
                lateCancelWindowHours: Number(window) || 24,
                consumeOn,
              })
              .then(() => {
                announce("Credit policy saved.");
                onSaved();
              })
              .catch((e: unknown) => announce(errText(e)))
              .finally(() => setBusy(false));
          }}
        >
          Save policy
        </Btn>
      </div>
    </Card>
  );
}
