import type { Metadata } from "next";
import { PracticeOutcomePanel } from "@/components/reasoning/PracticeOutcomePanel";

export const metadata: Metadata = { title: "Reports — AI Longevity Pro" };

/**
 * Reports: the practice outcome ledger, counted.
 *
 * This is the one aggregate query that exists. Counts come from the clinic already suppressed —
 * nothing here adds up a total or fills in a withheld cell, and the caveat that this is not
 * evidence of efficacy is part of the report rather than a footnote on the page.
 */
export default function ReportsPage() {
  return (
    <section data-screen-label="Reports" className="mx-auto max-w-[900px] px-6 pt-[22px] pb-6">
      <h1 className="text-lg font-semibold">Practice outcomes</h1>
      <p className="mt-1 text-sm">
        The only report here is what happened to the people you treated, counted in groups. Financial and
        utilisation reporting has no live backend yet.
      </p>
      <div className="mt-4"><PracticeOutcomePanel /></div>
    </section>
  );
}
