import { redirect } from "next/navigation";

/** Wearables live inside a patient's Tracking & Experiments tab. */
export default function WearablesRedirect() {
  redirect("/patients");
}
