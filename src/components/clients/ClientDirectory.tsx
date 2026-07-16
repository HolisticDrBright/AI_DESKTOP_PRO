"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Columns3, Download, Search, Users, X } from "lucide-react";
import { getClientRows, type ClientRow } from "@/adapters/clients.mock";
import { recordAuditEntry } from "@/adapters/session-store";
import type { Tone } from "@/adapters/types";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Popover, PopoverDemoNote, PopoverHeader } from "@/components/ui/Popover";
import { Card, InitialsAvatar } from "@/components/ui/bits";
import { cn } from "@/lib/cn";
import { useComposerOptional } from "@/lib/composer";
import { useFeedback } from "@/lib/feedback";
import { patientPath } from "@/lib/routes";
import { toneText, toneTint } from "@/lib/tones";

const RISK_TONE: Record<ClientRow["risk"], Tone> = {
  Low: "positive",
  Moderate: "warning",
  Elevated: "critical",
};
const STATUS_TONE: Record<ClientRow["status"], Tone> = {
  Active: "positive",
  Onboarding: "action",
  Paused: "slate",
};

const SAVED_FILTERS = [
  { id: "all", label: "All clients" },
  { id: "elevated", label: "Elevated risk" },
  { id: "low-adherence", label: "Low adherence" },
  { id: "paused", label: "Paused" },
  { id: "experiments", label: "In experiment" },
] as const;

type SavedFilter = (typeof SAVED_FILTERS)[number]["id"];

const OPTIONAL_COLUMNS = ["Last lab", "Adherence", "Experiment", "Next appt", "Tasks"] as const;

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

export function ClientDirectory() {
  const { announce } = useFeedback();
  const composer = useComposerOptional();
  const [rows] = useState<ClientRow[]>(() => getClientRows());
  const [search, setSearch] = useState("");
  const [saved, setSaved] = useState<SavedFilter>("all");
  const [dense, setDense] = useState(false);
  const [cols, setCols] = useState<Set<string>>(new Set(OPTIONAL_COLUMNS));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmingBulkMsg, setConfirmingBulkMsg] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (saved === "elevated" && r.risk !== "Elevated") return false;
      if (saved === "low-adherence" && r.adherencePct >= 60) return false;
      if (saved === "paused" && r.status !== "Paused") return false;
      if (saved === "experiments" && !r.activeExperiment) return false;
      if (q && !`${r.name} ${r.tags.join(" ")} ${r.program}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, saved, search]);

  const toggleRow = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const bulk = (label: string) => {
    recordAuditEntry({
      kind: "assign",
      subjectType: "clients (bulk)",
      subjectLabel: `${label} — ${selected.size} client(s)`,
      reviewed: true,
    });
    announce(`${label}: ${selected.size} client(s). (demo — not persisted)`);
  };

  const bulkMessage = () => {
    setConfirmingBulkMsg(false);
    const names = rows.filter((r) => selected.has(r.patientId)).map((r) => r.name);
    composer?.openComposer("patient-message", {
      patientName: `${selected.size} selected clients`,
      subjectType: "bulk message",
      subjectLabel: names.join(", "),
      seeds: [`Bulk draft to: ${names.join(", ")} — requires review per recipient`],
    });
  };

  const pad = dense ? "py-[5px]" : "py-[9px]";

  return (
    <section data-screen-label="Client Directory" className="relative mx-auto max-w-[1320px] px-6 pt-[22px] pb-10">
      <div className="mb-1 text-[11.5px] font-semibold text-faint">Workspace / Clients</div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-[7px]">
            <Users size={17} strokeWidth={2} className="text-brand" aria-hidden />
            <h1 className="m-0 text-[21px] font-bold tracking-[-0.015em]">Client directory</h1>
          </div>
          <p className="mt-[4px] mb-0 text-[12.5px] text-subtle">
            {rows.length} clients · all data synthetic.{" "}
            <Link href="/practice" className="font-semibold text-action hover:text-action-deep">Practice dashboard →</Link>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setDense((d) => !d)}
            aria-pressed={dense}
            className="h-8 cursor-pointer rounded-lg border border-line bg-card px-3 text-[12px] font-semibold text-body-2 hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action"
          >
            {dense ? "Comfortable" : "Dense"}
          </button>
          <Popover
            label="Configure columns"
            trigger={({ open, toggle }) => (
              <button
                onClick={toggle}
                aria-haspopup="menu"
                aria-expanded={open}
                className="flex h-8 cursor-pointer items-center gap-[6px] rounded-lg border border-line bg-card px-3 text-[12px] font-semibold text-body-2 hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action"
              >
                <Columns3 size={13} strokeWidth={2} aria-hidden />
                Columns
              </button>
            )}
          >
            {() => (
              <>
                <PopoverHeader title="Optional columns" />
                <div className="flex flex-col px-[13px] py-[8px]">
                  {OPTIONAL_COLUMNS.map((c) => (
                    <label key={c} className="flex items-center gap-2 py-[4px] text-[12px] text-body">
                      <input
                        type="checkbox"
                        checked={cols.has(c)}
                        onChange={() =>
                          setCols((prev) => {
                            const next = new Set(prev);
                            if (next.has(c)) next.delete(c);
                            else next.add(c);
                            return next;
                          })
                        }
                        className="h-[14px] w-[14px] accent-[#2563C7]"
                      />
                      {c}
                    </label>
                  ))}
                </div>
                <PopoverDemoNote>Column preferences are session-only in this demo.</PopoverDemoNote>
              </>
            )}
          </Popover>
          <button
            onClick={() => announce("Export prepared for clients you can access — respects patient-access permissions. (demo — no file)")}
            className="flex h-8 cursor-pointer items-center gap-[6px] rounded-lg border border-line bg-card px-3 text-[12px] font-semibold text-body-2 hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action"
          >
            <Download size={13} strokeWidth={2} aria-hidden />
            Export
          </button>
        </div>
      </div>

      {/* Search + saved filters */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="flex h-8 w-[260px] items-center gap-2 rounded-lg border border-line bg-card px-[10px] focus-within:border-action">
          <Search size={13} strokeWidth={2} className="text-faint" aria-hidden />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search clients, tags, programs…"
            aria-label="Search clients"
            className="flex-1 border-none bg-transparent text-[12px] outline-none placeholder:text-faint"
          />
        </label>
        <div className="flex flex-wrap items-center gap-[6px]" role="group" aria-label="Saved filters">
          {SAVED_FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setSaved(f.id)}
              aria-pressed={saved === f.id}
              className={cn(
                "rounded-full border px-[11px] py-[4px] text-[11.5px] font-semibold focus-visible:outline-2 focus-visible:outline-action",
                saved === f.id
                  ? "border-action bg-action-tint text-action-deep"
                  : "border-line bg-card text-body-2 hover:border-line-hover",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Bulk bar */}
      {selected.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-[11px] border border-action bg-action-tint px-[13px] py-[8px]">
          <span className="text-[12px] font-bold text-action-deep">{selected.size} selected</span>
          <button onClick={() => bulk("Bulk assign to practitioner")} className="h-7 cursor-pointer rounded-lg border border-line bg-card px-[10px] text-[11.5px] font-semibold text-body hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action">Assign</button>
          <button onClick={() => bulk("Bulk enroll in program")} className="h-7 cursor-pointer rounded-lg border border-line bg-card px-[10px] text-[11.5px] font-semibold text-body hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action">Enroll in program</button>
          <button onClick={() => setConfirmingBulkMsg(true)} className="h-7 cursor-pointer rounded-lg border border-line bg-card px-[10px] text-[11.5px] font-semibold text-teal hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action">Message (review-gated)</button>
          <button onClick={() => setSelected(new Set())} className="ml-auto flex h-7 cursor-pointer items-center gap-1 rounded-lg px-[8px] text-[11.5px] font-semibold text-muted hover:bg-[rgba(90,107,126,0.1)] focus-visible:outline-2 focus-visible:outline-action">
            <X size={12} strokeWidth={2} aria-hidden /> Clear
          </button>
        </div>
      )}

      {/* Table */}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <caption className="sr-only">Client directory with program, risk, adherence and task load</caption>
            <thead>
              <tr>
                <th scope="col" className="w-[34px] bg-[#F6F9FC] px-[10px] py-[7px]"><span className="sr-only">Select</span></th>
                {["Client", "Tags", "Program", "Practitioner", "Status", "Risk",
                  "Last contact",
                  ...(cols.has("Last lab") ? ["Last lab"] : []),
                  ...(cols.has("Adherence") ? ["Adherence"] : []),
                  ...(cols.has("Experiment") ? ["Experiment"] : []),
                  ...(cols.has("Next appt") ? ["Next appt"] : []),
                  ...(cols.has("Tasks") ? ["Tasks due"] : []),
                ].map((h) => (
                  <th key={h} scope="col" className="whitespace-nowrap bg-[#F6F9FC] px-[10px] py-[7px] text-left text-[9.5px] font-bold tracking-[0.03em] text-faint uppercase">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={13} className="px-4 py-[36px] text-center text-[12px] text-subtle">
                    No clients match — clear search or choose “All clients”.
                  </td>
                </tr>
              ) : (
                filtered.map((r) => (
                  <tr key={r.patientId} className="border-t border-[#F1F5F9] hover:bg-sunken">
                    <td className={cn("px-[10px]", pad)}>
                      <input
                        type="checkbox"
                        checked={selected.has(r.patientId)}
                        onChange={() => toggleRow(r.patientId)}
                        aria-label={`Select ${r.name}`}
                        className="h-[14px] w-[14px] accent-[#2563C7]"
                      />
                    </td>
                    <th scope="row" className={cn("px-[10px] text-left font-normal", pad)}>
                      <Link
                        href={patientPath(r.patientId, "summary")}
                        className="flex items-center gap-[8px] focus-visible:outline-2 focus-visible:outline-action"
                      >
                        <InitialsAvatar initials={r.initials} size={dense ? 22 : 28} fontSize={dense ? 9 : 10.5} gradient={r.avatarGradient} />
                        <span className="text-[12.5px] font-semibold text-ink hover:text-action">{r.name}</span>
                      </Link>
                    </th>
                    <td className={cn("px-[10px] whitespace-nowrap", pad)}>
                      <span className="flex gap-[4px]">{r.tags.map((t) => <span key={t} className="rounded-[5px] bg-sunken-2 px-[6px] py-px text-[10px] text-muted">{t}</span>)}</span>
                    </td>
                    <td className={cn("px-[10px] whitespace-nowrap text-body", pad)}>{r.program}</td>
                    <td className={cn("px-[10px] whitespace-nowrap text-muted", pad)}>{r.practitioner}</td>
                    <td className={cn("px-[10px]", pad)}><Pill tone={STATUS_TONE[r.status]}>{r.status}</Pill></td>
                    <td className={cn("px-[10px]", pad)}><Pill tone={RISK_TONE[r.risk]}>{r.risk}</Pill></td>
                    <td className={cn("px-[10px] whitespace-nowrap text-muted", pad)}>{r.lastContact}</td>
                    {cols.has("Last lab") && <td className={cn("px-[10px] whitespace-nowrap text-muted", pad)}>{r.lastLab}</td>}
                    {cols.has("Adherence") && (
                      <td className={cn("px-[10px] whitespace-nowrap", pad)}>
                        <span className={cn("font-bold", r.adherencePct >= 70 ? "text-positive" : "text-warning-deep")}>{r.adherencePct}%</span>
                      </td>
                    )}
                    {cols.has("Experiment") && <td className={cn("px-[10px] whitespace-nowrap text-body", pad)}>{r.activeExperiment ?? "—"}</td>}
                    {cols.has("Next appt") && <td className={cn("px-[10px] whitespace-nowrap text-muted", pad)}>{r.nextAppointment}</td>}
                    {cols.has("Tasks") && (
                      <td className={cn("px-[10px] whitespace-nowrap", pad)}>
                        <Link href="/tasks" className="font-semibold text-action hover:text-action-deep focus-visible:outline-2 focus-visible:outline-action">{r.tasksDue}</Link>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {confirmingBulkMsg && (
        <ConfirmDialog
          open
          title={`Draft a message to ${selected.size} client(s)?`}
          body="Bulk patient messages are patient-facing. A draft opens in the composer and requires your review — nothing is sent automatically."
          confirmLabel="Open draft"
          onCancel={() => setConfirmingBulkMsg(false)}
          onConfirm={bulkMessage}
        />
      )}
    </section>
  );
}
