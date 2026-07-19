import { redirect } from "next/navigation";
import { DEFAULT_PATIENT_ID } from "@/adapters";
import { USE_LIVE_API } from "@/adapters/mode";
import { patientPath } from "@/lib/routes";

/** Quantum Mind is now Mind & Cognition inside Tracking & Experiments. */
export default function QuantumMindRedirect() {
  if (USE_LIVE_API) redirect("/patients");
  redirect(`${patientPath(DEFAULT_PATIENT_ID, "tracking")}?view=mind`);
}
