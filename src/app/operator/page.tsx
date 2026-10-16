import type { Metadata } from "next";
import { ShieldCheck } from "lucide-react";
import { OperatorConsole } from "@/components/operator/OperatorConsole";

export const metadata: Metadata = { title: "Platform operator console — AI Longevity Pro" };

/**
 * The platform operator console: new-clinic proposal review and bootstrapped-clinic suspension, for a platform operator
 * signed in separately (operator pool, TOTP, 15-minute session) and never through a practitioner account. The page
 * renders nothing private; every read and decision goes through /api/operator/*, which are blocked in this build.
 */
export default function OperatorPage() {
  return (
    <section data-screen-label="Platform operator console" className="mx-auto max-w-[720px] px-6 pt-[32px] pb-10">
      <div className="mb-4 flex items-center gap-[8px]">
        <ShieldCheck size={18} strokeWidth={2} className="text-brand" aria-hidden />
        <h1 className="m-0 text-[21px] font-bold tracking-[-0.015em]">Platform operator console</h1>
      </div>
      <OperatorConsole />
    </section>
  );
}
