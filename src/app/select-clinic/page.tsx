import type { Metadata } from "next";
import { Building2 } from "lucide-react";
import { ClinicChooser } from "@/components/onboarding/ClinicChooser";

export const metadata: Metadata = { title: "Choose your clinic — AI Longevity Pro" };

/**
 * The explicit clinic choice after sign-in: reached when the account has several active clinics, or when its clinics
 * could not be read. The list is the account's own discovery, read now by the server; a choice is checked against it
 * again before it is written, and is bound to this account.
 */
export default function SelectClinicPage() {
  return (
    <section data-screen-label="Choose your clinic" className="mx-auto max-w-[560px] px-6 pt-[32px] pb-10">
      <div className="mb-4 flex items-center gap-[8px]">
        <Building2 size={18} strokeWidth={2} className="text-brand" aria-hidden />
        <h1 className="m-0 text-[21px] font-bold tracking-[-0.015em]">Choose your clinic</h1>
      </div>
      <ClinicChooser />
    </section>
  );
}
