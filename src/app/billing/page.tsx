import type { Metadata } from "next";
import { USE_LIVE_API } from "@/adapters/mode";
import { BillingWorkspace } from "@/components/billing/BillingWorkspace";
import { ClinicalEmpty } from "@/components/ui/ClinicalStates";

export const metadata: Metadata = { title: "Billing — AI Longevity Pro" };

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const s = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);

  if (USE_LIVE_API) {
    return (
      <section data-screen-label="Billing" className="mx-auto max-w-[900px] px-6 pt-[22px] pb-6">
        <ClinicalEmpty
          title="Billing isn't live yet"
          message="The POS and ledger are Stripe test-mode UI over demo data. They stay hidden in live mode until a real payments adapter exists — nothing pretends to charge."
        />
      </section>
    );
  }
  return (
    <BillingWorkspace
      tab={s("tab") ?? "overview"}
      patientId={s("patient")}
      apptId={s("appt")}
      serviceId={s("service")}
    />
  );
}
