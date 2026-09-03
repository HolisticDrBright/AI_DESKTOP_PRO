import type { Metadata } from "next";
import { CheckCircle2, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";

export const metadata: Metadata = { title: "Ask ALP Status — AI Longevity Pro" };

export default function AskAlpActivationPage() {
  return (
    <section data-screen-label="Ask ALP Status" className="mx-auto max-w-[1000px] px-6 pt-[18px] pb-10">
      <PageHeader
        crumb="Settings / Security & Governance / Ask ALP"
        title="Ask ALP consumer status"
        sub="Ask ALP is a V2 consumer capability. It does not require a Desktop practitioner activation or clinic connection."
      />
      <div className="rounded-xl border border-line bg-card p-5 shadow-sm">
        <div className="flex items-center gap-2 text-positive">
          <CheckCircle2 size={18} aria-hidden />
          <h2 className="m-0 text-[15px] font-bold">Enabled for authenticated V2 consumers</h2>
        </div>
        <p className="mt-3 text-[12px] leading-5 text-subtle">
          The versioned consumer safety policy and fixed emergency responses ship with the V2 backend. There is no confirmation code to enter here, and this Desktop screen does not control whether a consumer can open Ask ALP.
        </p>
        <div className="mt-4 flex items-start gap-2 rounded-lg bg-slate-tint p-3 text-[11.5px] leading-5 text-body">
          <ShieldCheck className="mt-0.5 shrink-0" size={16} aria-hidden />
          <p className="m-0">Each consumer must still consent before health context is used. Real-PHI model processing remains separately blocked until the production contractual, privacy, and security gates are approved.</p>
        </div>
      </div>
    </section>
  );
}
