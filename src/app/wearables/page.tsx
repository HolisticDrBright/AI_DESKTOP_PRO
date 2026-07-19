import { redirect } from "next/navigation";
import { DEFAULT_PATIENT_ID } from "@/adapters";
import { USE_LIVE_API } from "@/adapters/mode";
import { patientPath } from "@/lib/routes";

/** Wearables live inside a patient's Tracking & Experiments tab now. */
export default function WearablesRedirect() {
  if (USE_LIVE_API) redirect("/patients");
  redirect(`${patientPath(DEFAULT_PATIENT_ID, "tracking")}?view=wearables`);
}
