"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/adapters";
import { AdapterError } from "@/adapters/errors";
import type {
  LiveEntitlement,
  LiveMembershipStatus,
  LivePatientEntitlements,
  LivePlanLibrary,
  LivePlanType,
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
import { formatMinor } from "@/lib/money";
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

const STATUS_TONE: Record<LiveMembershipStatus, string> = {
  incomplete: "bg-slate-tint text-slate-badge",
  incomplete_expired: "bg-slate-tint text-slate-badge",
  trialing: "bg-action-tint text-action-deep",
  active: "bg-positive-tint text-positive-deep",
  past_due: "bg-warning-tint text-warning-deep",
  unpaid: "bg-critical-tint text-critical",
  paused: "bg-slate-tint text-slate-badge",
  canceled: "bg-slate-tint text-slate-badge",
  expired: "bg-slate-tint text-slate-badge",
};

/**
 * A patient's plans: memberships, entitlement balances, and the full ledger.
 *
 * Every quantity on this screen came from the database. The component adds
 * nothing up — the accounting identity is enforced there, so a balance shown
 * here is a balance that actually exists.
 */
export function PatientPlansLive({ patientId }: { patientId: string }) {
  const { announce } = useFeedback();
  const [data, setData] = useState<LivePatientEntitlements | null>(null);
  const [library, setLibrary] = useState<LivePlanLibrary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openLedger, setOpenLedger] = useState<string | null>(null);

  const [sellVersionId, setSellVersionId] = useState("");
  const [compType, setCompType] = useState<LivePlanType>("package");
  const [compVersionId, setCompVersionId] = useState("");
  const [compReason, setCompReason] = useState("");
  const [restoreFor, setRestoreFor] = useState<string | null>(null);
  const [restoreReason, setRestoreReason] = useState("");
  const [cancelReason, setCancelReason] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      const [d, lib] = await Promise.all([
        api.plans.forPatient(patientId),
        api.plans.library(false).catch(() => null),
      ]);
      setData(d);
      setLibrary(lib);
    } catch (e) {
      setError(errText(e));
    }
  }, [patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (fn: () => Promise<unknown>, message: string) => {
      if (busy) return;
      setBusy(true);
      try {
        await fn();
        announce(message);
        await load();
      } catch (e) {
        announce(errText(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, announce, load],
  );

  if (error && !data) return <ClinicalError message={error} onRetry={() => void load()} />;
  if (!data) return <ClinicalLoading label="Loading plans…" />;

  const publishedPackages = (library?.packages ?? []).flatMap((p) =>
    p.versions.filter((v) => v.status === "published").map((v) => ({ plan: p, version: v })),
  );
  const publishedForComp =
    compType === "package"
      ? publishedPackages.map((x) => ({ id: x.version.id, label: `${x.plan.name} v${x.version.versionNumber}` }))
      : (library?.memberships ?? []).flatMap((m) =>
          m.versions
            .filter((v) => v.status === "published")
            .map((v) => ({ id: v.id, label: `${m.name} v${v.versionNumber}` })),
        );

  const totalRemaining = data.entitlements.reduce((s, e) => s + e.remainingQuantity, 0);
  const totalReserved = data.entitlements.reduce((s, e) => s + e.reservedQuantity, 0);

  return (
    <div className="flex flex-col gap-4 pt-4" data-testid="patient-plans">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Metric label="Credits available" value={totalRemaining} />
        <Metric label="Credits held for bookings" value={totalReserved} />
        <Metric label="Entitlements" value={data.entitlements.length} />
        <Metric label="Memberships" value={data.memberships.length} />
      </div>

      <Card className="p-[14px]">
        <CardTitle>Memberships</CardTitle>
        {data.memberships.length === 0 ? (
          <p className="mt-2 mb-0 text-[12.5px] text-subtle" data-testid="no-memberships">
            No memberships.
          </p>
        ) : (
          <TableWrap className="mt-[10px]">
            <thead>
              <tr>
                <TH>Plan</TH>
                <TH>Status</TH>
                <TH>Origin</TH>
                <TH>Renews / ends</TH>
                <TH />
              </tr>
            </thead>
            <tbody data-testid="membership-rows">
              {data.memberships.map((m) => (
                <tr key={m.id}>
                  <TD className="font-medium">{m.membershipName ?? "—"}</TD>
                  <TD>
                    <span
                      data-testid={`membership-status-${m.id}`}
                      className={cn(
                        "inline-flex items-center rounded-full px-[7px] py-px text-[11px] font-semibold",
                        STATUS_TONE[m.status],
                      )}
                    >
                      {m.status.replace("_", " ")}
                      {m.cancelAtPeriodEnd ? " · ending" : ""}
                    </span>
                  </TD>
                  <TD className="text-muted">
                    {m.origin === "complimentary" ? (
                      <span
                        className="inline-flex items-center rounded-full bg-action-tint px-[7px] py-px text-[11px] font-semibold text-action-deep"
                        data-testid={`membership-comp-${m.id}`}
                        title={m.complimentaryReason ?? undefined}
                      >
                        Complimentary
                      </span>
                    ) : (
                      "Purchased"
                    )}
                  </TD>
                  <TD className="text-muted">{fmtDate(m.currentPeriodEnd)}</TD>
                  <TD className="text-right">
                    <div className="flex flex-wrap justify-end gap-[6px]">
                      {(m.status === "active" || m.status === "trialing") && (
                        <Btn
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          data-testid={`membership-pause-${m.id}`}
                          onClick={() =>
                            void run(
                              () =>
                                api.plans.membershipLifecycle({
                                  patientMembershipId: m.id,
                                  action: "pause",
                                  expectedVersion: m.version,
                                }),
                              "Membership paused.",
                            )
                          }
                        >
                          Pause
                        </Btn>
                      )}
                      {m.status === "paused" && (
                        <Btn
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          data-testid={`membership-resume-${m.id}`}
                          onClick={() =>
                            void run(
                              () =>
                                api.plans.membershipLifecycle({
                                  patientMembershipId: m.id,
                                  action: "resume",
                                  expectedVersion: m.version,
                                }),
                              "Membership resumed.",
                            )
                          }
                        >
                          Resume
                        </Btn>
                      )}
                      {(m.status === "active" || m.status === "trialing") && !m.cancelAtPeriodEnd && (
                        <Btn
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          data-testid={`membership-cancel-end-${m.id}`}
                          onClick={() => {
                            const reason = cancelReason.trim();
                            if (!reason) {
                              announce("Cancelling a membership needs a reason.");
                              return;
                            }
                            void run(
                              () =>
                                api.plans.membershipLifecycle({
                                  patientMembershipId: m.id,
                                  action: "cancel_at_period_end",
                                  expectedVersion: m.version,
                                  reason,
                                }),
                              "Membership will end at the period close.",
                            ).then(() => setCancelReason(""));
                          }}
                        >
                          End at period
                        </Btn>
                      )}
                    </div>
                  </TD>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
        {data.memberships.length > 0 && (
          <div className="mt-[10px]">
            <Field label="Reason (required to cancel)" className="max-w-[320px]">
              <TextInput
                value={cancelReason}
                placeholder="Required"
                data-testid="membership-cancel-reason"
                onChange={(e) => setCancelReason(e.target.value)}
              />
            </Field>
          </div>
        )}
      </Card>

      <Card className="p-[14px]">
        <CardTitle>Credits &amp; entitlements</CardTitle>
        <ClinicalNote>
          Every figure here is the database&rsquo;s. A credit is a commercial
          right to be billed a certain way — it never implies clinical
          eligibility or medical necessity.
        </ClinicalNote>

        {data.entitlements.length === 0 ? (
          <div className="mt-[10px]">
            <ClinicalEmpty
              title="No credits"
              message="This patient holds no package or membership credits. Selling a package creates an invoice; credits appear once that invoice is paid."
            />
          </div>
        ) : (
          <TableWrap className="mt-[10px]">
            <thead>
              <tr>
                <TH>Plan</TH>
                <TH>Source</TH>
                <TH className="text-right">Available</TH>
                <TH className="text-right">Held</TH>
                <TH className="text-right">Used</TH>
                <TH>Expires</TH>
                <TH />
              </tr>
            </thead>
            <tbody data-testid="entitlement-rows">
              {data.entitlements.map((e) => (
                <EntitlementRow
                  key={e.id}
                  entitlement={e}
                  open={openLedger === e.id}
                  busy={busy}
                  onToggle={() => setOpenLedger(openLedger === e.id ? null : e.id)}
                  onRestore={() => setRestoreFor(e.id)}
                />
              ))}
            </tbody>
          </TableWrap>
        )}

        {restoreFor && (
          <div className="mt-[12px] border-t border-hairline pt-[12px]" data-testid="restore-panel">
            <ClinicalNote>
              Restoring spent credit is a correction. It needs the refund
              permission and a recorded reason, and it appends to the ledger
              rather than rewriting it.
            </ClinicalNote>
            <div className="mt-[10px] flex flex-wrap items-end gap-2">
              <Field label="Reason" className="min-w-[240px]">
                <TextInput
                  value={restoreReason}
                  placeholder="Required"
                  data-testid="restore-reason"
                  onChange={(e) => setRestoreReason(e.target.value)}
                />
              </Field>
              <Btn
                variant="outline"
                disabled={busy}
                data-testid="restore-submit"
                onClick={() => {
                  const reason = restoreReason.trim();
                  if (!reason) {
                    announce("A manual restoration needs a reason.");
                    return;
                  }
                  void run(
                    () =>
                      api.plans.restoreCredit({
                        entitlementId: restoreFor,
                        quantity: 1,
                        reason,
                      }),
                    "Credit restored and recorded.",
                  ).then(() => {
                    setRestoreFor(null);
                    setRestoreReason("");
                  });
                }}
              >
                Restore one credit
              </Btn>
              <Btn variant="ghost" onClick={() => setRestoreFor(null)}>
                Cancel
              </Btn>
            </div>
          </div>
        )}
      </Card>

      <Card className="p-[14px]">
        <CardTitle>Sell or grant a plan</CardTitle>
        <div className="mt-[10px] flex flex-wrap items-end gap-2">
          <Field label="Package to sell" className="min-w-[240px]">
            <Select
              value={sellVersionId}
              data-testid="sell-version"
              onChange={(e) => setSellVersionId(e.target.value)}
            >
              <option value="">Choose a published package…</option>
              {publishedPackages.map(({ plan, version }) => (
                <option key={version.id} value={version.id}>
                  {plan.name} v{version.versionNumber} — {formatMinor(version.priceMinor)}
                </option>
              ))}
            </Select>
          </Field>
          <Btn
            variant="primary"
            disabled={busy || !sellVersionId}
            data-testid="sell-submit"
            onClick={() =>
              void run(
                () =>
                  api.plans.purchase({ patientId, packageVersionId: sellVersionId }),
                "Purchase invoice drafted. Credits appear once it is paid.",
              ).then(() => setSellVersionId(""))
            }
          >
            Create purchase invoice
          </Btn>
        </div>

        <div className="mt-[14px] border-t border-hairline pt-[12px]">
          <ClinicalNote>
            Complimentary care needs a specific permission and a reason, and is
            recorded as an explicit zero-amount invoice so it is visible in the
            financial record rather than invisible.
          </ClinicalNote>
          <div className="mt-[10px] flex flex-wrap items-end gap-2">
            <Field label="Type" className="min-w-[130px]">
              <Select
                value={compType}
                data-testid="comp-type"
                onChange={(e) => {
                  setCompType(e.target.value as LivePlanType);
                  setCompVersionId("");
                }}
              >
                <option value="package">Package</option>
                <option value="membership">Membership</option>
              </Select>
            </Field>
            <Field label="Plan version" className="min-w-[240px]">
              <Select
                value={compVersionId}
                data-testid="comp-version"
                onChange={(e) => setCompVersionId(e.target.value)}
              >
                <option value="">Choose a published version…</option>
                {publishedForComp.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Reason" className="min-w-[220px]">
              <TextInput
                value={compReason}
                placeholder="Required"
                data-testid="comp-reason"
                onChange={(e) => setCompReason(e.target.value)}
              />
            </Field>
            <Btn
              variant="outline"
              disabled={busy}
              data-testid="comp-submit"
              onClick={() => {
                if (!compVersionId) {
                  announce("Choose a plan version to grant.");
                  return;
                }
                const reason = compReason.trim();
                if (!reason) {
                  announce("A complimentary assignment needs a reason.");
                  return;
                }
                void run(
                  () =>
                    api.plans.assignComplimentary({
                      patientId,
                      planType: compType,
                      versionId: compVersionId,
                      reason,
                    }),
                  "Complimentary plan assigned and recorded.",
                ).then(() => {
                  setCompVersionId("");
                  setCompReason("");
                });
              }}
            >
              Assign complimentary
            </Btn>
          </div>
        </div>
      </Card>
    </div>
  );
}

function EntitlementRow({
  entitlement: e,
  open,
  busy,
  onToggle,
  onRestore,
}: {
  entitlement: LiveEntitlement;
  open: boolean;
  busy: boolean;
  onToggle: () => void;
  onRestore: () => void;
}) {
  return (
    <>
      <tr>
        <TD className="font-medium">{e.planName ?? "—"}</TD>
        <TD className="text-muted">
          {e.source === "complimentary" ? (
            <span
              className="inline-flex items-center rounded-full bg-action-tint px-[7px] py-px text-[11px] font-semibold text-action-deep"
              data-testid={`entitlement-comp-${e.id}`}
            >
              Complimentary
            </span>
          ) : (
            e.source.replace("_", " ")
          )}
        </TD>
        <TD className="text-right tabular-nums font-semibold" data-testid={`entitlement-remaining-${e.id}`}>
          {e.remainingQuantity}
        </TD>
        <TD className="text-right tabular-nums">{e.reservedQuantity}</TD>
        <TD className="text-right tabular-nums">{e.consumedQuantity}</TD>
        <TD className="text-muted">{fmtDate(e.expiresAt)}</TD>
        <TD className="text-right">
          <div className="flex justify-end gap-[6px]">
            <Btn variant="ghost" size="sm" onClick={onToggle} data-testid={`entitlement-ledger-${e.id}`}>
              {open ? "Hide ledger" : "Ledger"}
            </Btn>
            {e.consumedQuantity + e.expiredQuantity > 0 && (
              <Btn
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={onRestore}
                data-testid={`entitlement-restore-${e.id}`}
              >
                Restore
              </Btn>
            )}
          </div>
        </TD>
      </tr>
      {open && (
        <tr>
          <TD colSpan={7} className="bg-sunken">
            <ul
              className="m-0 flex list-none flex-col gap-[4px] p-0"
              data-testid={`ledger-entries-${e.id}`}
            >
              {e.ledger.length === 0 ? (
                <li className="text-[12px] text-faint">No movements.</li>
              ) : (
                e.ledger.map((l, i) => (
                  <li key={`${l.at}-${i}`} className="text-[12px] text-subtle">
                    <span className="font-semibold text-body">{l.kind}</span> ×{l.quantity}
                    {l.reason ? ` · ${l.reason}` : ""}
                    {l.refType ? ` · ${l.refType}` : ""}
                    {" · "}
                    {new Date(l.at).toLocaleString("en-US")}
                  </li>
                ))
              )}
            </ul>
          </TD>
        </tr>
      )}
    </>
  );
}
