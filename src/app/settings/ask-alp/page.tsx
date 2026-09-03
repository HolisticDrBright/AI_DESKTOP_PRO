import type { Metadata } from "next";
import { AskAlpActivation } from "@/components/settings/AskAlpActivation";
import { PageHeader } from "@/components/ui/PageHeader";

export const metadata: Metadata = { title: "Ask ALP Activation — AI Longevity Pro" };

export default function AskAlpActivationPage() {
  return (
    <section data-screen-label="Ask ALP Activation" className="mx-auto max-w-[1000px] px-6 pt-[18px] pb-10">
      <PageHeader
        crumb="Settings / Security & Governance / Ask ALP"
        title="Review and activate Ask ALP"
        sub="This clinical sign-off activates the exact prompt, refusal language, disclosure, consent copy, and fixed emergency responses shown below for synthetic users only."
      />
      <AskAlpActivation />
    </section>
  );
}
