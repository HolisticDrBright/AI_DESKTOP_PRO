import { redirect } from "next/navigation";

/** Nutrition lives inside a patient's Care Plan tab; pick a patient first. */
export default function NutritionRedirect() {
  redirect("/patients");
}
