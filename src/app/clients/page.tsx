import { ClientDirectory } from "@/components/clients/ClientDirectory";
import { LiveClientDirectory } from "@/components/clients/LiveClientDirectory";
import { api } from "@/adapters";
import { isAdapterError } from "@/adapters/errors";
import { USE_LIVE_API } from "@/adapters/mode";
import { ClinicalError } from "@/components/ui/ClinicalStates";
import { getRequestSession } from "@/server/session";

/**
 * LIVE: the real, RLS-scoped patient directory (also the root landing page).
 * Demo: the showcase directory, unchanged. A failed live read renders an
 * honest error — signed-out gets a Sign in action; nothing falls back to mock.
 */
export default async function ClientsPage() {
  if (!USE_LIVE_API) return <ClientDirectory />;

  try {
    const entries = await api.patients.list((await getRequestSession()).token);
    return <LiveClientDirectory entries={entries} />;
  } catch (e) {
    const code = isAdapterError(e) ? e.code : "unknown";
    const message = isAdapterError(e) ? e.safeMessage : "Unable to load the directory right now.";
    const signedOut = code === "unauthenticated";
    return (
      <section data-screen-label="Clients" className="px-6 pt-[22px] pb-6">
        <ClinicalError
          message={message}
          actionHref={signedOut ? "/login" : "/clients"}
          actionLabel={signedOut ? "Sign in" : "Retry"}
        />
      </section>
    );
  }
}
