import type { Metadata } from "next";
import { ClipboardCheck } from "lucide-react";
import { ApplicantJourney } from "@/components/onboarding/ApplicantJourney";

export const metadata: Metadata = { title: "Your clinic application — AI Longevity Pro" };
export const dynamic = "force-dynamic";

/**
 * A signed-in practitioner's own way into a clinic: create a new one, or request to join an existing one with its
 * clinic code. Creating an account, confirming an email address or setting up MFA never grants access to patients by
 * itself; a join needs the clinic's approval, and either way access comes only through current clinic-membership
 * sign-in. Each step below says what the server answered, or that there was no one to ask.
 *
 * Until a deployment is both the production clinical runtime and approved for PHI, the page says it holds fictional
 * test records only and asks for a fictional clinic name (fail-closed: any other combination is treated as synthetic).
 */
export default function ApplyPage() {
  const realDataApproved = process.env.APP_RUNTIME_ENV === "production-clinical" && process.env.PHI_ALLOWED === "true";
  return (
    <section data-screen-label="Clinic application" className="mx-auto max-w-[560px] px-6 pt-[32px] pb-10">
      <div className="mb-4 flex items-center gap-[8px]">
        <ClipboardCheck size={18} strokeWidth={2} className="text-brand" aria-hidden />
        <h1 className="m-0 text-[21px] font-bold tracking-[-0.015em]">Your clinic application</h1>
      </div>
      <ApplicantJourney syntheticOnly={!realDataApproved} />
    </section>
  );
}
