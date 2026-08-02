import type { Metadata } from "next";
import { ImportReviewWorkspace } from "@/components/settings/ImportReviewWorkspace";
import { PageHeader } from "@/components/ui/PageHeader";

export const metadata: Metadata = { title: "Import review — AI Longevity Pro" };

/**
 * The Import Review Workspace.
 *
 * Separate from the Clinical Knowledge Center on purpose. That screen is where
 * governed content is authored and approved; this one is where material from
 * OUTSIDE the system is examined before any of it becomes governed content.
 * Putting them on one screen would blur the only distinction that matters
 * here: whether a human in this organization has looked at the thing yet.
 */
export default function ImportReviewPage() {
  return (
    <section
      data-screen-label="Import review"
      className="mx-auto max-w-[1380px] px-6 pt-[18px] pb-8"
    >
      <PageHeader
        crumb="Settings / Clinical governance"
        title="Import Review"
        sub="Read practitioner spreadsheets and protocol documents, see exactly what each row brings and what it leaves unknown, and decide — row by row — what becomes governed content. Nothing imported is usable until it is reviewed here."
      />
      <div className="mb-4 rounded border border-warning/25 bg-warning-tint px-3 py-2 text-[11.5px] leading-[1.5] text-warning-deep">
        Files are read in this process and never stored. Formulas are never calculated, macros and
        embedded objects are refused, and everything committed enters as a non-approved draft.
      </div>
      <ImportReviewWorkspace />
    </section>
  );
}
