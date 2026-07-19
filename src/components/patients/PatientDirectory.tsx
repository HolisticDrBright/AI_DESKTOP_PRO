"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Search, Users } from "lucide-react";
import { listPatients } from "@/adapters/patients.mock";
import { getProfileExtras } from "@/adapters/patient-profile.mock";
import { patientLedger, useSessionInvoices } from "@/adapters/billing.mock";
import { formatMinor } from "@/lib/money";
import { patientPath } from "@/lib/routes";
import { cn } from "@/lib/cn";
import { InitialsAvatar } from "@/components/ui/bits";
import { PageHeader } from "@/components/ui/PageHeader";
import { TextInput } from "@/components/ui/Field";
import { Pill, Tag } from "@/components/ui/Pill";
import { TableWrap, TD, TH } from "@/components/ui/Table";
import { DemoNote } from "@/components/ui/DemoNote";

type Filter = "all" | "alerts" | "balance" | "upcoming";

/** Searchable, filterable mock directory — every row opens the chart. */
export function PatientDirectory() {
  useSessionInvoices(); // balances update after checkout
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const rows = useMemo(() => {
    return listPatients().map((p) => {
      const extras = getProfileExtras(p.id);
      const ledger = patientLedger(p.id);
      return { p, extras, ledger };
    });
  }, []);
  // Recompute balances on session changes (rows memo keeps identity; ledger
  // is cheap, so re-derive at render for correctness).
  const visible = rows
    .map((r) => ({ ...r, ledger: patientLedger(r.p.id) }))
    .filter(({ p, extras, ledger }) => {
      if (q) {
        const hay = `${p.name} ${p.mrn} ${extras.tags.join(" ")}`.toLowerCase();
        if (!hay.includes(q.toLowerCase())) return false;
      }
      if (filter === "alerts") return extras.medicalAlerts.length > 0;
      if (filter === "balance") return ledger.balanceMinor > 0;
      if (filter === "upcoming") return extras.booking.upcoming > 0;
      return true;
    });

  const chip = (id: Filter, label: string) => (
    <button
      key={id}
      onClick={() => setFilter(id)}
      aria-pressed={filter === id}
      className={cn(
        "h-7 cursor-pointer rounded-full border px-[10px] text-[11.5px] font-semibold focus-visible:outline-2 focus-visible:outline-action",
        filter === id
          ? "border-nav-active-line bg-nav-active text-action-deep"
          : "border-line bg-card text-muted hover:border-line-hover",
      )}
    >
      {label}
    </button>
  );

  return (
    <section data-screen-label="Patients" className="mx-auto max-w-[1560px] px-[22px] pt-[18px] pb-6">
      <PageHeader
        crumb="Workspace / Patients"
        title="Patients"
        sub="Directory of the demo practice — every row opens the patient chart."
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search size={13} className="absolute top-1/2 left-[9px] -translate-y-1/2 text-faint" aria-hidden />
          <TextInput
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, MRN, tag…"
            aria-label="Search patients"
            className="w-[260px] pl-[28px]"
          />
        </div>
        {chip("all", `All (${rows.length})`)}
        {chip("alerts", "Medical alerts")}
        {chip("balance", "Outstanding balance")}
        {chip("upcoming", "Upcoming visits")}
      </div>

      <TableWrap>
        <thead>
          <tr>
            <TH>Patient</TH>
            <TH>Age / sex</TH>
            <TH>Tags & goals</TH>
            <TH>Care team</TH>
            <TH>Last visit</TH>
            <TH>Next</TH>
            <TH className="text-right">Balance</TH>
            <TH>Alerts</TH>
          </tr>
        </thead>
        <tbody>
          {visible.map(({ p, extras, ledger }) => (
            <tr key={p.id} className="hover:bg-sunken">
              <TD>
                <Link
                  href={patientPath(p.id)}
                  className="flex items-center gap-[10px] font-semibold text-ink hover:text-action focus-visible:outline-2 focus-visible:outline-action"
                >
                  <InitialsAvatar initials={p.initials} size={30} fontSize={11} gradient={p.avatarGradient} />
                  <span>
                    <span className="block">{p.name}</span>
                    <span className="block text-[11px] font-normal text-faint">{p.mrn}</span>
                  </span>
                </Link>
              </TD>
              <TD className="whitespace-nowrap">{p.age == null ? "—" : `${p.age}`} · {p.sex}</TD>
              <TD className="max-w-[240px]">
                <span className="flex flex-wrap gap-1">
                  {extras.tags.length > 0
                    ? extras.tags.map((t) => <Tag key={t}>{t}</Tag>)
                    : <span className="truncate text-[12px] text-subtle">{p.primaryGoals}</span>}
                </span>
              </TD>
              <TD className="max-w-[180px] truncate text-subtle">{p.careTeam[0] ?? "—"}</TD>
              <TD className="whitespace-nowrap">{extras.booking.lastVisitLabel}</TD>
              <TD className="max-w-[200px] truncate">{extras.booking.nextAppointmentLabel}</TD>
              <TD className="text-right tabular-nums">
                {ledger.balanceMinor > 0 ? (
                  <span className="font-semibold text-warning-deep">{formatMinor(ledger.balanceMinor)}</span>
                ) : (
                  <span className="text-faint">—</span>
                )}
              </TD>
              <TD>
                {extras.medicalAlerts.length > 0 ? (
                  <Pill tone="critical">{extras.medicalAlerts.length}</Pill>
                ) : (
                  <span className="text-faint">—</span>
                )}
              </TD>
            </tr>
          ))}
          {visible.length === 0 && (
            <tr>
              <TD colSpan={8} className="py-10 text-center">
                <span className="flex flex-col items-center gap-2 text-faint">
                  <Users size={18} aria-hidden />
                  No patients match &quot;{q}&quot; with this filter.
                </span>
              </TD>
            </tr>
          )}
        </tbody>
      </TableWrap>

      <DemoNote className="mt-3">
        Synthetic roster. In live mode this screen lists real, RLS-scoped patient records with
        recorded fields only.
      </DemoNote>
    </section>
  );
}
