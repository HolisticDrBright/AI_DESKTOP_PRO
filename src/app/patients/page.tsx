import type { Metadata } from "next";
import { LiveClientDirectory } from "@/components/clients/LiveClientDirectory";
import { api } from "@/adapters";
import { isAdapterError } from "@/adapters/errors";
import { ClinicalError } from "@/components/ui/ClinicalStates";
import { getRequestSession } from "@/server/session";
import { withSelectedClinic } from "@/adapters/selected-clinic.server";
import { getRequestSelectedClinic } from "@/server/request-clinic";
import { pageClinicBinding } from "@/server/clinic-fence";
import { ClinicBindingMark } from "@/components/shell/ClinicBindingMark";

export const metadata: Metadata = { title: "Patients — AI Longevity Pro" };

/**
 * Patients directory (renamed from Clients; /clients redirects here).
 * The real, RLS-scoped directory. A failed read renders an honest error —
 * signed-out gets a Sign in action; nothing falls back to fixtures.
 */
export default async function PatientsPage() {
  try {
    const session = await getRequestSession();
    const selection = await getRequestSelectedClinic();
    const entries = await withSelectedClinic(selection, () => api.patients.list(session.token, session.orgId));
    const syntheticOnly =
      process.env.APP_RUNTIME_ENV === "staging" ||
      process.env.CLINICAL_DATA_PLANE === "supabase_staging";
    return (
      <>
        <ClinicBindingMark token={pageClinicBinding(selection)} />
        <LiveClientDirectory entries={entries} syntheticOnly={syntheticOnly} />
      </>
    );
  } catch (e) {
    const code = isAdapterError(e) ? e.code : "unknown";
    const message = isAdapterError(e) ? e.safeMessage : "Unable to load the directory right now.";
    const signedOut = code === "unauthenticated";
    return (
      <section data-screen-label="Patients" className="px-6 pt-[22px] pb-6">
        <ClinicalError
          message={message}
          actionHref={signedOut ? "/login" : "/patients"}
          actionLabel={signedOut ? "Sign in" : "Retry"}
        />
      </section>
    );
  }
}
