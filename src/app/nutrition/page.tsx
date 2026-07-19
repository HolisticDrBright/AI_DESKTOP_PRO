import { redirect } from "next/navigation";
import { DEFAULT_PATIENT_ID } from "@/adapters";
import { USE_LIVE_API } from "@/adapters/mode";
import { patientPath } from "@/lib/routes";

/** Nutrition lives inside a patient's Care Plan tab now. */
export default function NutritionRedirect() {
  if (USE_LIVE_API) redirect("/patients");
  redirect(`${patientPath(DEFAULT_PATIENT_ID, "care-plan")}?view=nutrition`);
}
