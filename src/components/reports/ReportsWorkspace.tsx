"use client";

import { useMemo, useState } from "react";
import { Download, LockKeyhole } from "lucide-react";
import {
  DEFAULT_FILTERS,
  REPORTS,
  reportCsv,
  setViewRole,
  useViewRole,
  visibleReports,
  type ReportDef,
  type ReportFiltersState,
  type ReportGroup,
  type ViewRole,
} from "@/adapters/reports.mock";
import { useSessionInvoices } from "@/adapters/billing.mock";
import { useFeedback } from "@/lib/feedback";
import { cn } from "@/lib/cn";
import { Card, CardTitle } from "@/components/ui/bits";
import { Btn } from "@/components/ui/Btn";
import { Field, Select } from "@/components/ui/Field";
import { PageHeader } from "@/components/ui/PageHeader";
import { Tag } from "@/components/ui/Pill";
import { TableWrap, TD, TH } from "@/components/ui/Table";
import { DemoNote } from "@/components/ui/DemoNote";

const GROUPS: ReportGroup[] = [
  "Appointments & retention",
  "Patients",
  "Billing & sales",
  "Labs & clinical",
  "Programs",
  "Research (de-identified)",
];

function downloadCsv(def: ReportDef, filters: ReportFiltersState) {
  const blob = new Blob([reportCsv(def, filters)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${def.id}-demo.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function ReportsWorkspace({ initialReport }: { initialReport?: string }) {
  useSessionInvoices(); // billing-backed reports update after checkout
  const { announce } = useFeedback();
  const role = useViewRole();
  const catalog = visibleReports(role);
  const hidden = REPORTS.length - catalog.length;
  const [selectedId, setSelectedId] = useState<string>(
    catalog.some((r) => r.id === initialReport) ? (initialReport as string) : catalog[0]?.id,
  );
  const [filters, setFilters] = useState<ReportFiltersState>(DEFAULT_FILTERS);
  const selected = catalog.find((r) => r.id === selectedId) ?? catalog[0];
  const rows = useMemo(() => (selected ? selected.rows(filters) : []), [selected, filters]);

  const set = <K extends keyof ReportFiltersState>(k: K, v: ReportFiltersState[K]) =>
    setFilters((f) => ({ ...f, [k]: v }));

  return (
    <section data-screen-label="Reports" className="mx-auto max-w-[1560px] px-[22px] pt-[18px] pb-6">
      <PageHeader
        crumb="Business / Reports"
        title="Reports"
        sub="Practice reporting over demo data — filters and exports work; every number is synthetic."
        actions={
          <Field label="Viewing as (role scope preview)">
            <Select value={role} onChange={(e) => setViewRole(e.target.value as ViewRole)} aria-label="Report role scope">
              <option>Owner</option>
              <option>Practitioner</option>
              <option>Front desk</option>
            </Select>
          </Field>
        }
      />

      <Card className="mb-4 px-4 py-3">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Date range">
            <Select value={filters.range} onChange={(e) => set("range", e.target.value as ReportFiltersState["range"])}>
              <option value="30d">Last 30 days</option>
              <option value="90d">Last 90 days</option>
              <option value="qtd">Quarter to date</option>
              <option value="ytd">Year to date</option>
            </Select>
          </Field>
          <Field label="Location">
            <Select value={filters.location} onChange={(e) => set("location", e.target.value as ReportFiltersState["location"])}>
              <option>All locations</option>
              <option>Main Studio</option>
              <option>Telehealth</option>
            </Select>
          </Field>
          <Field label="Practitioner">
            <Select value={filters.practitioner} onChange={(e) => set("practitioner", e.target.value as ReportFiltersState["practitioner"])}>
              <option>All practitioners</option>
              <option>Dr. Sarah Mitchell</option>
              <option>Dr. James Okafor</option>
              <option>Rachel Nguyen, RD</option>
            </Select>
          </Field>
          <Field label="Status">
            <Select value={filters.status} onChange={(e) => set("status", e.target.value as ReportFiltersState["status"])}>
              <option>All statuses</option>
              <option>Open</option>
              <option>Settled</option>
            </Select>
          </Field>
          {hidden > 0 && (
            <span className="ml-auto flex items-center gap-1 text-[11.5px] font-medium text-subtle">
              <LockKeyhole size={12} aria-hidden /> {hidden} report{hidden === 1 ? "" : "s"} hidden for the {role} role
            </span>
          )}
        </div>
      </Card>

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
        <Card className="max-h-[70vh] overflow-y-auto px-2 py-2">
          {GROUPS.map((g) => {
            const inGroup = catalog.filter((r) => r.group === g);
            if (inGroup.length === 0) return null;
            return (
              <div key={g} className="mb-2">
                <p className="m-0 px-2 pt-2 pb-1 text-[10px] font-bold tracking-[0.07em] text-faint uppercase">{g}</p>
                {inGroup.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => setSelectedId(r.id)}
                    aria-current={selected?.id === r.id ? "true" : undefined}
                    className={cn(
                      "block w-full cursor-pointer rounded-lg px-2 py-[6px] text-left text-[12.5px] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-action",
                      selected?.id === r.id ? "bg-nav-active font-semibold text-action-deep" : "font-medium text-body-2 hover:bg-sunken",
                    )}
                  >
                    {r.title}
                  </button>
                ))}
              </div>
            );
          })}
        </Card>

        {selected && (
          <div className="flex min-w-0 flex-col gap-3">
            <Card className="px-4 py-3">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <CardTitle>{selected.title}</CardTitle>
                  <p className="m-0 mt-[2px] text-[12px] text-subtle">{selected.description}</p>
                </div>
                <Tag>{selected.roles.join(" · ")}</Tag>
                <Btn
                  onClick={() => {
                    downloadCsv(selected, filters);
                    announce("Demo CSV exported — synthetic data, labeled as such in the file.");
                  }}
                >
                  <Download size={13} aria-hidden /> Export CSV (demo)
                </Btn>
              </div>
            </Card>
            <TableWrap>
              <thead>
                <tr>
                  {selected.columns.map((c) => (
                    <TH key={c}>{c}</TH>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    {r.map((cell, j) => (
                      <TD key={j} className={typeof cell === "number" ? "tabular-nums" : undefined}>
                        {cell}
                      </TD>
                    ))}
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <TD colSpan={selected.columns.length} className="py-6 text-center text-faint">
                      No rows for these filters.
                    </TD>
                  </tr>
                )}
              </tbody>
            </TableWrap>
            {selected.footnote && <DemoNote>{selected.footnote}</DemoNote>}
          </div>
        )}
      </div>
    </section>
  );
}
