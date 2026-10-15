import type { Metadata } from "next";
import { ClipboardCheck } from "lucide-react";
import { ApplicantJourney } from "@/components/onboarding/ApplicantJourney";

export const metadata: Metadata = { title: "Your clinic application — AI Longevity Pro" };

/**
 * A signed-in practitioner's own application to join a clinic or to propose one. Creating an account, confirming an
 * email address or setting up MFA never grants access to patients; only a clinic's approval does, and only through
 * current clinic-membership sign-in. Each step below says what the server answered, or that there was no one to ask.
 */
export default function ApplyPage() {
  return (
    <section data-screen-label="Clinic application" className="mx-auto max-w-[560px] px-6 pt-[32px] pb-10">
      <div className="mb-4 flex items-center gap-[8px]">
        <ClipboardCheck size={18} strokeWidth={2} className="text-brand" aria-hidden />
        <h1 className="m-0 text-[21px] font-bold tracking-[-0.015em]">Your clinic application</h1>
      </div>
      <ApplicantJourney />
    </section>
  );
}
