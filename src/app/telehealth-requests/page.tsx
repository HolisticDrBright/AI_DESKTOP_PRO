import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/PageHeader";
import { ConsultRequestQueue } from "@/components/consult/ConsultRequestQueue";
import { ConsultRetentionPanel } from "@/components/consult/ConsultRetentionPanel";
import { TelehealthRequestQueue } from "@/components/schedule/TelehealthRequestQueue";

export const metadata: Metadata = { title: "Telehealth requests — AI Longevity Pro" };
export const dynamic = "force-dynamic";

/**
 * Two queues, deliberately side by side and deliberately labelled differently.
 *
 * The lower one is existing patients asking for an appointment from inside the app. The upper
 * one is people who are not patients yet and reached the clinic through a public link: they
 * have no account, no chart and no consent, so they cannot be scheduled from here at all —
 * they are accepted or declined first.
 *
 * The retention panel sits with the upper queue because that is the only queue it applies to: an
 * enquirer who never became a patient has no account to ask for an erasure from, so erasing their
 * contact details is the clinic's to do.
 */
export default function TelehealthRequestsPage() {
  return (
    <section className="mx-auto max-w-[1000px] px-[22px] pt-[18px] pb-8">
      <PageHeader crumb="Workspace / Inbox / Telehealth" title="Requests"
        sub="New enquiries from your public consult link, and existing patients waiting for scheduling. Meeting links remain pending until an approved video provider is active." />
      <ConsultRequestQueue />
      <div className="mt-4">
        <ConsultRetentionPanel />
      </div>
      <div className="mt-4">
        <TelehealthRequestQueue />
      </div>
    </section>
  );
}
