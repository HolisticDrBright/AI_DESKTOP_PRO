import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/PageHeader";
import { PlansWorkspace } from "@/components/plans/PlansWorkspace";

export const metadata: Metadata = { title: "Plans — AI Longevity Pro" };
export const dynamic = "force-dynamic";

/**
 * Packages and memberships. Commercial terms live on a version, and
 * publishing freezes them, so a plan a patient accepted is never rewritten.
 */
export default function PlansSettingsPage() {
  return (
    <section data-screen-label="Plans" className="mx-auto max-w-[1100px] px-[22px] pt-[18px] pb-8">
      <PageHeader
        crumb="Settings / Plans"
        title="Packages & memberships"
        sub="What the practice sells on an ongoing basis, and the credit rules that go with it."
      />
      <PlansWorkspace />
    </section>
  );
}
