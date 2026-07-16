import { redirect } from "next/navigation";
import { DEFAULT_PATIENT_ID } from "@/adapters";
import { USE_LIVE_API } from "@/adapters/mode";
import { patientPath } from "@/lib/routes";

/**
 * Entry point. LIVE mode never lands on a synthetic patient — the signed-in
 * practitioner starts at the real, RLS-scoped directory. The demo keeps its
 * showcase patient as the front door.
 */
export default function Home() {
  if (USE_LIVE_API) redirect("/clients");
  redirect(patientPath(DEFAULT_PATIENT_ID));
}
