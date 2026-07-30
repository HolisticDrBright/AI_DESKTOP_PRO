"use client";

/**
 * Today's REAL appointment status list.
 *
 * This reads the Desktop-owned calendar RPC for the current day and shows the
 * appointment statuses that actually exist in the database. It computes no
 * aggregate that has no source: there is no "arrivals vs expected" score, no
 * unread-message count, no wearable alert roll-up, and no billing figure —
 * those domains have no live backend, and the Today page says so separately
 * rather than inventing a morning brief.
 *
 * Every count here is a count of rows returned by the RPC for today. If the
 * RPC is unavailable, the panel says it is unavailable; it never falls back to
 * a template day.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/adapters";
import { isAdapterError } from "@/adapters/errors";
import type { LiveAppointment } from "@/adapters/live-types";
import { ClinicalError, ClinicalLoading } from "@/components/ui/ClinicalStates";

/** Database status vocabulary → front-desk label. Unknown values pass through. */
const STATUS_LABEL: Record<string, string> = {
  scheduled: "Scheduled",
  confirmed: "Confirmed",
  arrived: "Arrived",
  in_encounter: "In room",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No-show",
};

const STATUS_TINT: Record<string, string> = {
  scheduled: "bg-slate-tint text-slate-badge",
  confirmed: "bg-action-tint text-action-deep",
  arrived: "bg-teal-tint text-teal",
  in_encounter: "bg-ai-tint text-ai-deep",
  completed: "bg-positive-tint text-positive",
  cancelled: "bg-slate-tint text-subtle",
  no_show: "bg-warning-tint text-warning-deep",
};

/** Local day bounds as ISO instants — "today" is the viewer's calendar day. */
function todayRangeIso(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return { from: from.toISOString(), to: to.toISOString() };
}

function fmtTime(iso: string | null): string {
  if (!iso) return "Time not recorded";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Time not recorded";
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(d);
}

type LoadState = "loading" | "ready" | "error";

export function TodayScheduleLive() {
  const [state, setState] = useState<LoadState>("loading");
  const [rows, setRows] = useState<LiveAppointment[]>([]);
  const [error, setError] = useState<{ message: string; signedOut: boolean } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let live = true;
    setState("loading");
    const { from, to } = todayRangeIso();
    api.schedule
      .getWeek(from, to)
      .then((cal) => {
        if (!live) return;
        const sorted = [...cal.appointments].sort((a, b) =>
          (a.startsAt ?? "").localeCompare(b.startsAt ?? ""),
        );
        setRows(sorted);
        setState("ready");
      })
      .catch((e: unknown) => {
        if (!live) return;
        setError({
          message: isAdapterError(e) ? e.safeMessage : "Today's schedule could not be loaded.",
          signedOut: isAdapterError(e) && e.code === "unauthenticated",
        });
        setState("error");
      });
    return () => {
      live = false;
    };
  }, [reloadKey]);

  if (state === "loading") return <ClinicalLoading label="Loading today's schedule…" />;

  if (state === "error") {
    return (
      <ClinicalError
        message={error?.message ?? "Today's schedule could not be loaded."}
        onRetry={reload}
        actionHref={error?.signedOut ? "/login" : undefined}
        actionLabel={error?.signedOut ? "Sign in" : undefined}
      />
    );
  }

  // Counts of REAL rows only — no expected/target/percentage is invented.
  const counts = rows.reduce<Record<string, number>>((acc, a) => {
    acc[a.status] = (acc[a.status] ?? 0) + 1;
    return acc;
  }, {});
  const active = rows.filter(
    (a) => a.status !== "cancelled" && a.status !== "no_show" && a.status !== "completed",
  ).length;

  return (
    <section
      data-testid="today-schedule"
      className="overflow-hidden rounded-[14px] border border-line bg-card"
    >
      <div className="flex items-center justify-between gap-3 border-b border-hairline px-4 py-3">
        <div>
          <h2 className="m-0 text-[13.5px] font-bold text-ink">Today&apos;s schedule</h2>
          <p className="m-0 mt-[2px] text-[11.5px] text-subtle">
            Real appointment records for today, with their current front-desk status.
          </p>
        </div>
        <Link
          href="/calendar"
          className="shrink-0 text-[12px] font-semibold text-action hover:underline"
        >
          Open calendar →
        </Link>
      </div>

      {rows.length === 0 ? (
        <p
          data-testid="today-schedule-empty"
          className="m-0 px-4 py-8 text-center text-[12.5px] leading-[1.55] text-subtle"
        >
          No appointments are scheduled for today in this organization. This is the real schedule —
          an empty day is shown as empty.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2 border-b border-hairline px-4 py-[10px]">
            <span
              data-testid="today-count-open"
              className="rounded-full bg-card px-[9px] py-[3px] text-[11px] font-semibold text-body ring-1 ring-line"
            >
              {active} still open · {rows.length} total
            </span>
            {Object.entries(counts).map(([status, n]) => (
              <span
                key={status}
                data-testid={`today-count-${status}`}
                className={`rounded-full px-[9px] py-[3px] text-[11px] font-semibold ${STATUS_TINT[status] ?? "bg-slate-tint text-slate-badge"}`}
              >
                {STATUS_LABEL[status] ?? status} {n}
              </span>
            ))}
          </div>
          <ul className="m-0 list-none p-0">
            {rows.map((a) => (
              <li
                key={a.id}
                data-testid="today-appointment"
                data-status={a.status}
                className="flex items-center gap-3 border-b border-hairline px-4 py-[9px] last:border-b-0"
              >
                <span className="w-[68px] shrink-0 text-[12px] font-semibold text-body tabular-nums">
                  {fmtTime(a.startsAt)}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">
                  {a.patientId ? (
                    <Link href={`/patients/${a.patientId}`} className="font-semibold hover:underline">
                      {a.patientName ?? "Patient name not available"}
                    </Link>
                  ) : (
                    <span className="font-semibold">{a.patientName ?? "Patient not linked"}</span>
                  )}
                  {a.practitionerName && (
                    <span className="text-subtle"> · {a.practitionerName}</span>
                  )}
                </span>
                <span
                  className={`shrink-0 rounded-full px-[9px] py-[3px] text-[10.5px] font-bold ${STATUS_TINT[a.status] ?? "bg-slate-tint text-slate-badge"}`}
                >
                  {STATUS_LABEL[a.status] ?? a.status}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
