import type { Metadata } from "next";
import { PatientDirectory } from "@/components/patients/PatientDirectory";
import { LiveClientDirectory } from "@/components/clients/LiveClientDirectory";
import { api } from "@/adapters";
import { isAdapterError } from "@/adapters/errors";
import { USE_LIVE_API } from "@/adapters/mode";
import { ClinicalError } from "@/components/ui/ClinicalStates";
import { getRequestSession } from "@/server/session";

export const metadata: Metadata = { title: "Patients — AI Longevity Pro" };

/**
 * Patients directory (renamed from Clients; /clients redirects here).
 * LIVE: the real, RLS-scoped directory. Demo: the searchable mock
 * directory. A failed live read renders an honest error — signed-out gets
 * a Sign in action; nothing falls back to mock.
 */
export default async function PatientsPage() {
  if (!USE_LIVE_API) return <PatientDirectory />;

  try {
    const session = await getRequestSession();
    const entries = await api.patients.list(session.token, session.orgId);
    return <LiveClientDirectory entries={entries} />;
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
