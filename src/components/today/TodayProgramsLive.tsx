"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { GraduationCap } from "lucide-react";
import { api } from "@/adapters";
import { AdapterError } from "@/adapters/errors";
import type { LiveProgramLibrary } from "@/adapters/live-types";
import { Card, CardTitle } from "@/components/ui/bits";

/**
 * Today's Programs summary — sums of PERSISTED enrollment rows across the
 * org's programs, nothing projected or invented. If the read fails, the card
 * says so instead of showing zeros that could read as "no activity".
 */
export function TodayProgramsLive() {
  const [library, setLibrary] = useState<LiveProgramLibrary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setLibrary(await api.programs.library({}));
    } catch (e) {
      setError(e instanceof AdapterError ? e.message : "Programs couldn't load.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = (library?.programs ?? []).reduce(
    (acc, p) => ({
      programs: acc.programs + (p.status === "published" ? 1 : 0),
      active: acc.active + p.enrollment.active,
      paused: acc.paused + p.enrollment.paused,
      invited: acc.invited + p.enrollment.invited,
    }),
    { programs: 0, active: 0, paused: 0, invited: 0 },
  );

  return (
    <Card className="px-4 py-[13px]" data-testid="today-programs">
      <div className="flex items-center gap-2">
        <CardTitle className="mb-0">
          <GraduationCap size={13} strokeWidth={2} className="text-brand" aria-hidden />
          Programs
        </CardTitle>
        <span className="flex-1" />
        <Link href="/programs" className="text-[12px] font-semibold text-action hover:underline">
          Open programs →
        </Link>
      </div>
      {error ? (
        <p className="m-0 mt-2 text-[12px] text-critical">{error}</p>
      ) : !library ? (
        <p className="m-0 mt-2 text-[12px] text-faint">Loading…</p>
      ) : library.programs.length === 0 ? (
        <p className="m-0 mt-2 text-[12px] text-faint">No programs in this organization.</p>
      ) : (
        <p className="m-0 mt-2 text-[12.5px] text-body" data-testid="today-programs-summary">
          {totals.programs} published program{totals.programs === 1 ? "" : "s"} ·{" "}
          {totals.active} active enrollment{totals.active === 1 ? "" : "s"}
          {totals.paused > 0 ? ` · ${totals.paused} paused` : ""}
          {totals.invited > 0 ? ` · ${totals.invited} invited` : ""}
        </p>
      )}
    </Card>
  );
}
